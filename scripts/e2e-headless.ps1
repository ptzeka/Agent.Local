<#
.SYNOPSIS
    Headless session-threaded e2e smoke test (backlog M4-6).

.DESCRIPTION
    Drives the real headless CLI through one logical conversation carried across
    four separate process invocations:
      1. create hello_world.txt          (no session  -> mints a new session id)
      2. read hello_world.txt content    (--session <id from step 1>)
      3. remove hello_world.txt          (--session <id>)
      4. delay background task + poll     (--session <id>)

    Session continuity is asserted by capturing the `[session <id>]` line the CLI
    writes to STDERR and threading it via --session on every follow-up; the
    positional `{prev-session-id}` form in COMMANDS.md is NOT parsed by cli/args.ts
    and would start a fresh session, so it is deliberately avoided here.

    Assertions are on the agent's RESPONSE + exit code, never a fixed sandbox path
    (the workspace is partitioned per session into UUID subdirs).

.PARAMETER Cli
    Optional. Path to the built CLI entry. Defaults to src/agent/dist/cli/index.js.
#>
[CmdletBinding()]
param(
    [string]$Cli
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Cli) { $Cli = Join-Path $repoRoot "src/agent/dist/cli/index.js" }
if (-not (Test-Path $Cli)) { throw "CLI not built at $Cli - run 'npm run build' first." }

# one run = one process; stderr carries [runtime]/[session] progress, stdout the final answer
function Invoke-Step {
    param([string[]]$CliArgs)
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath "node" -ArgumentList (@($Cli) + $CliArgs) `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        return [pscustomobject]@{
            ExitCode = $proc.ExitCode
            Stdout   = (Get-Content $outFile -Raw)
            Stderr   = (Get-Content $errFile -Raw)
        }
    } finally {
        Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue
    }
}

function Get-SessionId {
    param([string]$Stderr)
    $m = [regex]::Match($Stderr, '\[session\s+([0-9a-fA-F-]{8,})\]')
    if (-not $m.Success) { throw "Could not capture session id from CLI stderr." }
    return $m.Groups[1].Value
}

$results = New-Object System.Collections.Generic.List[object]
function Add-Result {
    param([string]$Name, [bool]$Pass, [int]$ExitCode, [string]$Note)
    $results.Add([pscustomobject]@{ Step = $Name; Result = $(if ($Pass) { "PASS" } else { "FAIL" }); Exit = $ExitCode; Note = $Note })
    if ($Pass) { Write-Host "PASS  $Name" -ForegroundColor Green }
    else       { Write-Host "FAIL  $Name -> $Note" -ForegroundColor Red }
}

Write-Host "== M4-6 headless session e2e =="

# deterministic content so the read step can assert exact recall, not guess LLM-chosen text
$marker = "HELLO_E2E_MARKER"

# Step 1 - create (new session)
$s1 = Invoke-Step @("--run", "create hello_world.txt as background task containing exactly the text $marker")
$session = $null
try { $session = Get-SessionId $s1.Stderr } catch {}
$ok1 = ($s1.ExitCode -eq 0) -and $session
Add-Result "1. create (mint session)" $ok1 $s1.ExitCode $(if ($session) { "session=$session" } else { "no session id" })
if (-not $ok1) { throw "Step 1 failed; aborting (cannot thread a session)." }

# Step 2 - read back, threaded. Explicit imperative: the small orchestrator model
# returns an AWAITING-INPUT clarification (still exit 0) on the awkward COMMANDS.md
# phrasing "read me hello_world.txt content" instead of reading the file
$s2 = Invoke-Step @("--run", "read the file hello_world.txt and show its exact content", "--session", $session)
$sameSession = (Get-SessionId $s2.Stderr) -eq $session
$recalledContent = $s2.Stdout -match $marker
$ok2 = ($s2.ExitCode -eq 0) -and $sameSession -and $recalledContent
Add-Result "2. read (--session)" $ok2 $s2.ExitCode $("sameSession=$sameSession recalledMarker=$recalledContent")

# Step 3 - remove, threaded
$s3 = Invoke-Step @("--run", "delete the file hello_world.txt as a background task", "--session", $session)
$ok3 = ($s3.ExitCode -eq 0) -and ((Get-SessionId $s3.Stderr) -eq $session)
Add-Result "3. remove (--session)" $ok3 $s3.ExitCode "exit+session checked"

# Step 4 - delayed background task + poll, threaded
$s4 = Invoke-Step @("--run", "start a background task that delays for 2 minutes, then poll its status until it reports done", "--session", $session)
$ok4 = ($s4.ExitCode -eq 0) -and ((Get-SessionId $s4.Stderr) -eq $session)
Add-Result "4. delay+poll (--session)" $ok4 $s4.ExitCode "exit+session checked"

Write-Host ""
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.Result -eq "FAIL" }).Count
if ($failed -gt 0) { Write-Host "$failed step(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host "All steps PASSED" -ForegroundColor Green
exit 0
