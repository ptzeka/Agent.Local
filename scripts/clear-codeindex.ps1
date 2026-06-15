<#
.SYNOPSIS
    Clears all indexed snapshots from both data trees so the index can be
    rebuilt from scratch.

.DESCRIPTION
    Removes every commit snapshot under:
      src/codeindex/data/commits/  (the publisher's working output)
      src/codemcp/data/commits/    (the copy codemcp serves)

    Use this to reset the index (e.g. after stale per-commit snapshots
    accumulate, since publish never prunes old SHAs). The migration journal
    (schema_versions.json) is preserved unless -IncludeSchema is passed.

.PARAMETER Force
    Skip the confirmation prompt.

.PARAMETER IncludeSchema
    Also delete schema_versions.json from both trees, resetting the migration
    journal so the next publish re-migrates from clean.

.EXAMPLE
    .\scripts\clear-codeindex.ps1

.EXAMPLE
    .\scripts\clear-codeindex.ps1 -Force -IncludeSchema
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$IncludeSchema
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$CodeIndexData = Join-Path $RepoRoot 'src\codeindex\data'
$CodeMcpData   = Join-Path $RepoRoot 'src\codemcp\data'

$DataDirs = @($CodeIndexData, $CodeMcpData)

# Enumerate what would be removed so the prompt is informed.
$targets = New-Object System.Collections.Generic.List[string]
foreach ($data in $DataDirs) {
    $commits = Join-Path $data 'commits'
    if (Test-Path $commits) {
        Get-ChildItem -Path $commits -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { $targets.Add($_.FullName) }
    }
    if ($IncludeSchema) {
        $schema = Join-Path $data 'schema_versions.json'
        if (Test-Path $schema) { $targets.Add($schema) }
    }
}

if ($targets.Count -eq 0) {
    Write-Step "Nothing to clear: no snapshots found under src/codeindex/data or src/codemcp/data."
    return
}

Write-Step "The following will be permanently removed:"
$targets | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

if (-not $Force) {
    $answer = Read-Host "Delete these $($targets.Count) item(s)? [y/N]"
    if ($answer -notmatch '^(y|yes)$') {
        Write-Step "Aborted; nothing removed."
        return
    }
}

foreach ($t in $targets) {
    Remove-Item -Recurse -Force $t
}

Write-Step "Cleared $($targets.Count) item(s). Run scripts/publish-codeindex.ps1 to rebuild the index."
