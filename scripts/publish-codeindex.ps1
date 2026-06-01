<#
.SYNOPSIS
    Publishes a codeindex snapshot for a repository and copies the
    output into src/codemcp/data/ so codemcp can serve it.

.DESCRIPTION
    Workflow:
      1. Prompt for the branch name (defaults to the current git branch).
      2. Prompt for the absolute path of the repository to index
         (defaults to this sandbox repo root). Passed as --root to the CLI.
      3. Resolve the current HEAD SHA of the target repo and remove only that
         SHA's folder from src/codeindex/data/commits/ and
         src/codemcp/data/commits/ (leaves all other repos' folders intact).
      4. Run: node src/codeindex/dist/cli.js --backend file --branch <branch> --root <path> publish
         (--root sets what is indexed; git origin of that repo is used as the repository id)
      5. Copy src/codeindex/data/. into src/codemcp/data/

.PARAMETER Branch
    Optional. When omitted, you are prompted (default = current git branch).

.PARAMETER Repository
    Optional. Absolute path to the repository to index. When omitted, you are
    prompted (default = this sandbox repo root).

.EXAMPLE
    .\scripts\publish-codeindex.ps1

.EXAMPLE
    .\scripts\publish-codeindex.ps1 -Branch main -Repository C:\Users\me\repos\xpo-messaging-backend
#>

[CmdletBinding()]
param(
    [string]$Branch,
    [string]$Repository
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$CliPath       = Join-Path $RepoRoot 'src\codeindex\dist\cli.js'
$CodeIndexData = Join-Path $RepoRoot 'src\codeindex\data'
$CodeMcpData   = Join-Path $RepoRoot 'src\codemcp\data'

if (-not (Test-Path $CliPath)) {
    throw "codeindex CLI not found at $CliPath. Run 'npm install && npm run build' in src/codeindex first."
}

if (-not $Repository) {
    $entered = Read-Host "Repository root (absolute path) [$RepoRoot]"
    if ([string]::IsNullOrWhiteSpace($entered)) {
        $Repository = $RepoRoot
    } else {
        $Repository = $entered.Trim()
    }
}

$Repository = $Repository.TrimEnd('\', '/')

if (-not (Test-Path $Repository -PathType Container)) {
    throw "Repository root not found: $Repository"
}

if (-not $Branch) {
    $defaultBranch = $null
    try {
        $defaultBranch = (& git -C $Repository rev-parse --abbrev-ref HEAD 2>$null).Trim()
    } catch {
        $defaultBranch = $null
    }
    if ([string]::IsNullOrWhiteSpace($defaultBranch)) {
        $defaultBranch = 'main'
    }

    $entered = Read-Host "Branch name [$defaultBranch]"
    if ([string]::IsNullOrWhiteSpace($entered)) {
        $Branch = $defaultBranch
    } else {
        $Branch = $entered.Trim()
    }
}

Write-Step "Repository root : $Repository"
Write-Step "Branch         : $Branch"

# Resolve the HEAD SHA of the target repo so we only clean matching folders.
$headSha = $null
try {
    $headSha = (& git -C $Repository rev-parse HEAD 2>$null).Trim()
} catch {
    $headSha = $null
}

$SourceCommits = Join-Path $CodeIndexData 'commits'
$DestCommits   = Join-Path $CodeMcpData   'commits'

if ($headSha) {
    Write-Step "HEAD SHA: $headSha - removing matching commit folder(s) only"
    foreach ($dir in @($SourceCommits, $DestCommits)) {
        $target = Join-Path $dir $headSha
        if (Test-Path $target) {
            Write-Host "  Removing $target" -ForegroundColor DarkGray
            Remove-Item -Recurse -Force $target
        }
    }
} else {
    Write-Host "  Warning: could not resolve HEAD SHA; skipping pre-clean." -ForegroundColor Yellow
}

Write-Step "Publishing codeindex (backend=file, branch=$Branch, root=$Repository)"
Push-Location $RepoRoot
try {
    & node $CliPath --backend file --branch $Branch --root $Repository publish
    if ($LASTEXITCODE -ne 0) {
        throw "codeindex publish failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

if (-not (Test-Path $CodeMcpData)) {
    New-Item -ItemType Directory -Path $CodeMcpData -Force | Out-Null
}

Write-Step "Copying src/codeindex/data/. -> src/codemcp/data/"
Copy-Item -Path (Join-Path $CodeIndexData '*') -Destination $CodeMcpData -Recurse -Force

Write-Host ""
Write-Step "Done. Indexed snapshot for '$Repository' (branch '$Branch') is now available to codemcp."
$copied = Get-ChildItem -Path $DestCommits -Directory -ErrorAction SilentlyContinue
if ($copied) {
    Write-Host "Commit folders now in src/codemcp/data/commits/:" -ForegroundColor DarkGray
    $copied | ForEach-Object { Write-Host "  $($_.Name)" -ForegroundColor DarkGray }
}
