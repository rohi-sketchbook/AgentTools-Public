[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Destination
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$repoPath = [System.IO.Path]::GetFullPath($repoRoot)
$repoPrefix = $repoPath.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$publicIgnorePath = Join-Path $repoRoot '.agenttools-publicignore'
$publicIgnore = if (Test-Path -LiteralPath $publicIgnorePath -PathType Leaf) {
    @(Get-Content -Encoding UTF8 -LiteralPath $publicIgnorePath | ForEach-Object { $_.Trim().Replace('\', '/') } | Where-Object { $_ -and -not $_.StartsWith('#') })
}
else {
    @()
}

function Test-PublicExcluded {
    param([string]$RelativePath)
    $portable = $RelativePath.Replace('\', '/')
    foreach ($entry in $publicIgnore) {
        if ($entry.EndsWith('/')) {
            if ($portable.StartsWith($entry, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        elseif ($portable.Equals($entry, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

if ($destinationPath.Equals($repoPath, [System.StringComparison]::OrdinalIgnoreCase) -or
    $destinationPath.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Public export destination must be outside the AgentTools repository.'
}

$rootLicense = @('LICENSE', 'LICENSE.md', 'COPYING') |
    ForEach-Object { Join-Path $repoRoot $_ } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if ([string]::IsNullOrWhiteSpace([string]$rootLicense)) {
    throw 'Root license is not selected. Add LICENSE or LICENSE.md before creating a public distribution.'
}

$gitStatus = @(& git -C $repoRoot status --porcelain=v1 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw ('git status failed: ' + ($gitStatus -join [Environment]::NewLine))
}
if ($gitStatus.Count -gt 0) {
    throw 'Working tree is not clean. Commit the intended public source first so the export is reproducible.'
}

$auditScript = Join-Path $repoRoot 'agenttools-mcp-gateway\scripts\public-release-audit.js'
$auditOutput = @(& node $auditScript 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw ('Public release audit failed:' + [Environment]::NewLine + ($auditOutput -join [Environment]::NewLine))
}

if (Test-Path -LiteralPath $destinationPath) {
    $existing = @(Get-ChildItem -LiteralPath $destinationPath -Force -ErrorAction Stop)
    if ($existing.Count -gt 0) {
        throw ('Public export destination must be empty: ' + $destinationPath)
    }
}
elseif ($PSCmdlet.ShouldProcess($destinationPath, 'Create public export directory')) {
    [System.IO.Directory]::CreateDirectory($destinationPath) | Out-Null
}

$trackedFiles = @(& git -C $repoRoot -c core.quotepath=false ls-files 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw ('git ls-files failed: ' + ($trackedFiles -join [Environment]::NewLine))
}

$copied = 0
$excluded = 0
foreach ($relative in $trackedFiles) {
    if ([string]::IsNullOrWhiteSpace($relative)) { continue }
    if (Test-PublicExcluded $relative) {
        $excluded++
        continue
    }

    $source = Join-Path $repoRoot ($relative.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw ('Tracked source file is missing: ' + $relative)
    }

    $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
    if ($PSCmdlet.ShouldProcess($target, 'Copy tracked public file')) {
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
        $copied++
    }
}

$head = (& git -C $repoRoot rev-parse HEAD).Trim()
[pscustomobject]@{
    SourceRepository = $repoRoot
    SourceCommit     = $head
    Destination      = $destinationPath
    FilesCopied      = $copied
    FilesExcluded    = $excluded
    GitHistoryCopied = $false
    LocalOverridesCopied = $false
} | Format-List
