<#
.SYNOPSIS
    Provisions the codemanagermcp MCP server entry in the current user's Cursor mcp.json.

.DESCRIPTION
    Adds (or updates) an entry under "mcpServers" in $HOME/.cursor/mcp.json that
    points node at this repository's tools/codemanagermcp/dist/server.js.
    Existing entries (including other MCP servers) are preserved; only the named
    entry is upserted.

    Run from the root of the repository:
        pwsh -File tools/codemanagermcp/install-mcp.ps1
        # or
        powershell -ExecutionPolicy Bypass -File tools/codemanagermcp/install-mcp.ps1

    Before running, ensure the server is built:
        pushd tools/codemanagermcp; npm install; npm run build; popd

    And that appsettings.json (and optionally release.json) exist next to server.js.
    Copy the example files and fill in real values:
        cp tools/codemanagermcp/appsettings.example.json tools/codemanagermcp/appsettings.json
        cp tools/codemanagermcp/release.example.json     tools/codemanagermcp/release.json
    release.json overlays appsettings.json — only add keys that differ from dev.

.PARAMETER ServerName
    The key to use under mcpServers. Defaults to "codemanagermcp".

.PARAMETER RepoRoot
    Override the resolved repository root. Defaults to two directories above
    this script (i.e. tools/codemanagermcp/../../).

.PARAMETER McpJsonPath
    Override the path to mcp.json. Defaults to $HOME/.cursor/mcp.json.

.PARAMETER SkipBuildCheck
    Skip the existence check for dist/server.js. Useful only if you intend to
    build the project afterwards.
#>

[CmdletBinding()]
param(
    [string]$ServerName = 'codemanagermcp',
    [string]$RepoRoot,
    [string]$McpJsonPath,
    [switch]$SkipBuildCheck
)

$ErrorActionPreference = 'Stop'

function ConvertTo-HashtableRecursive {
    param([Parameter(ValueFromPipeline = $true)] $InputObject)
    process {
        if ($null -eq $InputObject) { return $null }

        if ($InputObject -is [System.Collections.IDictionary]) {
            $h = [ordered]@{}
            foreach ($key in $InputObject.Keys) {
                $h[$key] = ConvertTo-HashtableRecursive $InputObject[$key]
            }
            return $h
        }

        if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
            $h = [ordered]@{}
            foreach ($prop in $InputObject.PSObject.Properties) {
                $h[$prop.Name] = ConvertTo-HashtableRecursive $prop.Value
            }
            return $h
        }

        if ($InputObject -is [System.Collections.IEnumerable] -and -not ($InputObject -is [string])) {
            return @($InputObject | ForEach-Object { ConvertTo-HashtableRecursive $_ })
        }

        return $InputObject
    }
}

if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}

$serverJs       = Join-Path $RepoRoot 'tools/codemanagermcp/dist/server.js'
$mcpToolsDir    = Join-Path $RepoRoot 'tools/codemanagermcp'
$appSettings    = Join-Path $mcpToolsDir 'appsettings.json'
$releaseConfig  = Join-Path $mcpToolsDir 'release.json'

if (-not $SkipBuildCheck -and -not (Test-Path -LiteralPath $serverJs)) {
    throw @"
codemanagermcp server.js was not found at:
  $serverJs

Build it first:
  pushd tools/codemanagermcp; npm install; npm run build; popd

Or re-run with -SkipBuildCheck to provision the entry anyway.
"@
}

if (-not (Test-Path -LiteralPath $appSettings) -and -not (Test-Path -LiteralPath $releaseConfig)) {
    Write-Warning @"
Neither appsettings.json nor release.json was found in:
  $mcpToolsDir

Copy the example files and fill in real values before starting the MCP server:
  cp tools/codemanagermcp/appsettings.example.json tools/codemanagermcp/appsettings.json
  cp tools/codemanagermcp/release.example.json     tools/codemanagermcp/release.json
release.json overlays appsettings.json — only include keys that differ from dev.
"@
}

$absServerJs = if (Test-Path -LiteralPath $serverJs) {
    (Resolve-Path -LiteralPath $serverJs).Path
} else {
    $serverJs
}
$absMcpToolsDir = (Resolve-Path -LiteralPath $mcpToolsDir).Path

$serverJsPathForJson  = $absServerJs    -replace '\\', '/'
$mcpToolsDirForJson   = $absMcpToolsDir -replace '\\', '/'

if (-not $McpJsonPath) {
    $cursorDir = Join-Path $HOME '.cursor'
    if (-not (Test-Path -LiteralPath $cursorDir)) {
        New-Item -ItemType Directory -Path $cursorDir -Force | Out-Null
    }
    $McpJsonPath = Join-Path $cursorDir 'mcp.json'
} else {
    $parent = Split-Path -Parent $McpJsonPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
}

if (Test-Path -LiteralPath $McpJsonPath) {
    $raw = Get-Content -LiteralPath $McpJsonPath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        $config = [ordered]@{}
    } else {
        try {
            $parsed = $raw | ConvertFrom-Json
        } catch {
            throw "Failed to parse existing JSON at '$McpJsonPath': $($_.Exception.Message)"
        }
        $config = ConvertTo-HashtableRecursive $parsed
        if ($null -eq $config) { $config = [ordered]@{} }
    }
} else {
    $config = [ordered]@{}
}

if (-not $config.Contains('mcpServers')) {
    $config['mcpServers'] = [ordered]@{}
} elseif (-not ($config['mcpServers'] -is [System.Collections.IDictionary])) {
    throw "Existing 'mcpServers' in '$McpJsonPath' is not an object."
}

$existed = $config['mcpServers'].Contains($ServerName)

# cwd = tools/codemanagermcp so the server resolves codemanagermcp.config.json next to itself.
$config['mcpServers'][$ServerName] = [ordered]@{
    type    = 'stdio'
    command = 'node'
    args    = @($serverJsPathForJson)
    cwd     = $mcpToolsDirForJson
}

$json = $config | ConvertTo-Json -Depth 32
Set-Content -LiteralPath $McpJsonPath -Value $json -Encoding UTF8

if ($existed) {
    Write-Host "Updated MCP server '$ServerName' in $McpJsonPath"
} else {
    Write-Host "Added MCP server '$ServerName' to $McpJsonPath"
}
Write-Host "  command : node"
Write-Host "  args[0] : $serverJsPathForJson"
Write-Host "  cwd     : $mcpToolsDirForJson"
Write-Host ""
Write-Host "Ensure appsettings.json (and optionally release.json) exist in: $mcpToolsDirForJson"
