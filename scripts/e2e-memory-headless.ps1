<#
.SYNOPSIS
    Headless session-threaded memory + embedding e2e smoke test.

.DESCRIPTION
    Drives the real headless CLI through one logical conversation carried across
    three separate process invocations to exercise the memory recall round-trip:
      1. remember an exact fact   (no session  -> mints a new session id)
      2. recall it back literally (--session <id from step 1>)
      3. recall it by paraphrase  (--session <id>, query omits the marker words)

    Memory is segregated per session: the runtime injects --collection
    <session.memoryCollectionId> into memomcp, so threading --session is what
    makes step 2/3 read the SAME on-disk collection step 1 wrote. The agent only
    actively calls `remember`; `recall` fires automatically at every turn start
    (orchestrator.maybeRecallMemory) and is the embedding round-trip under test.

    Step 3 paraphrases the question so the stored marker words are absent from the
    query — a literal-match store would miss; only embedding similarity recalls it.

    Assertions are on the agent's RESPONSE + exit code, never a fixed sandbox path
    (the workspace + memory collection are partitioned per session into UUIDs).

    Requires VOYAGE_API_KEY (embeddings) and GEMINI_API_KEY (orchestrator), same
    cloud-key dependency as the orchestrator role in models.json.

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

# one run = one process; stderr carries [runtime]/[session] progress, stdout the final answer + tool events
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

Write-Host "== memory + embedding headless session e2e =="

# deterministic, unusual token so recall asserts exact paraphrase-resistant recall, not an LLM guess
$marker = "MEMO_E2E_MARKER_7F3A"

# Step 1 - remember (new session). The agent calls the `remember` tool, which appears in stdout tool events.
$s1 = Invoke-Step @("--run", "Remember this exact fact for later: the project secret marker is $marker")
$session = $null
try { $session = Get-SessionId $s1.Stderr } catch {}
$wroteMemory = $s1.Stdout -match 'tool:\s*remember'
$ok1 = ($s1.ExitCode -eq 0) -and $session -and $wroteMemory
Add-Result "1. remember (mint session)" $ok1 $s1.ExitCode $(if ($session) { "session=$session remember=$wroteMemory" } else { "no session id" })
if (-not $ok1) { throw "Step 1 failed; aborting (cannot thread a session for recall)." }

# Step 2 - literal recall, threaded. Auto-recall at turn start injects the stored memory; the answer must echo the marker.
$s2 = Invoke-Step @("--run", "What is the exact project secret marker I told you to remember earlier?", "--session", $session)
$sameSession2 = (Get-SessionId $s2.Stderr) -eq $session
$recalled2 = $s2.Stdout -match $marker
$ok2 = ($s2.ExitCode -eq 0) -and $sameSession2 -and $recalled2
Add-Result "2. literal recall (--session)" $ok2 $s2.ExitCode "sameSession=$sameSession2 recalledMarker=$recalled2"

# Step 3 - paraphrase recall, threaded. The query omits "marker"/"secret"/the token, so only embedding
# similarity (not literal match) can surface the stored memory.
$s3 = Invoke-Step @("--run", "Earlier I shared a special identifier string for this project. Tell me that string exactly.", "--session", $session)
$sameSession3 = (Get-SessionId $s3.Stderr) -eq $session
$recalled3 = $s3.Stdout -match $marker
$ok3 = ($s3.ExitCode -eq 0) -and $sameSession3 -and $recalled3
Add-Result "3. paraphrase recall (embedding)" $ok3 $s3.ExitCode "sameSession=$sameSession3 recalledMarker=$recalled3"

Write-Host ""
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.Result -eq "FAIL" }).Count
if ($failed -gt 0) { Write-Host "$failed step(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host "All steps PASSED" -ForegroundColor Green
exit 0
