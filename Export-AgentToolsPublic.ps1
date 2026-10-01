[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Destination,

    [switch]$UpdateGitRepository
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

$updateExistingGit = $UpdateGitRepository.IsPresent
if ($updateExistingGit) {
    if (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) {
        throw ('Public Git repository destination does not exist: ' + $destinationPath)
    }

    $destinationGitProbe = @(& git -C $destinationPath rev-parse --is-inside-work-tree 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($destinationGitProbe -join '').Trim() -ne 'true') {
        throw ('UpdateGitRepository requires an existing Git work tree: ' + $destinationPath)
    }

    $destinationStatus = @(& git -C $destinationPath status --porcelain=v1 --untracked-files=all 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ('Destination git status failed: ' + ($destinationStatus -join [Environment]::NewLine))
    }
    if ($destinationStatus.Count -gt 0) {
        throw ('Public Git repository working tree must be clean before update: ' + $destinationPath)
    }
}
elseif (Test-Path -LiteralPath $destinationPath) {
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

$publicFiles = [System.Collections.Generic.List[string]]::new()
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
    $publicFiles.Add($relative)
}

$removed = 0
if ($updateExistingGit) {
    $desiredFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in $publicFiles) {
        [void]$desiredFiles.Add($relative.Replace('\', '/'))
    }

    $destinationTrackedFiles = @(& git -C $destinationPath -c core.quotepath=false ls-files 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ('Destination git ls-files failed: ' + ($destinationTrackedFiles -join [Environment]::NewLine))
    }

    foreach ($relative in $destinationTrackedFiles) {
        if ([string]::IsNullOrWhiteSpace($relative)) { continue }
        if ($desiredFiles.Contains($relative.Replace('\', '/'))) { continue }

        $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
        if ((Test-Path -LiteralPath $target -PathType Leaf) -and
            $PSCmdlet.ShouldProcess($target, 'Remove obsolete tracked public file')) {
            Remove-Item -LiteralPath $target -Force
            $removed++
        }
    }
}

$copied = 0
foreach ($relative in $publicFiles) {
    $source = Join-Path $repoRoot ($relative.Replace('/', '\'))
    $target = Join-Path $destinationPath ($relative.Replace('/', '\'))
    if ($PSCmdlet.ShouldProcess($target, 'Copy tracked public file')) {
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
        $copied++
    }
}

$head = (& git -C $repoRoot rev-parse HEAD).Trim()
[pscustomobject]@{
    SourceRepository      = $repoRoot
    SourceCommit          = $head
    Destination           = $destinationPath
    DestinationMode       = if ($updateExistingGit) { 'git-update' } else { 'new-tree' }
    FilesCopied           = $copied
    FilesRemoved          = $removed
    FilesExcluded         = $excluded
    GitHistoryCopied      = $false
    GitHistoryPreserved   = $updateExistingGit
    LocalOverridesCopied  = $false
} | Format-List
