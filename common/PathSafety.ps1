Set-StrictMode -Version 2.0

function Assert-AgentToolsNoReparseTraversal {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$FullPath,
        [string]$Label = 'Path'
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@(92, 47))
    $targetFull = [System.IO.Path]::GetFullPath($FullPath)
    $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar

    if ($targetFull -ne $rootFull -and -not $targetFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw ($Label + ' must stay inside WorkspaceRoot: ' + $rootFull)
    }

    $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('WorkspaceRoot cannot be a junction or symbolic link: ' + $rootFull)
    }

    if ($targetFull -eq $rootFull) { return }

    $relative = $targetFull.Substring($prefix.Length)
    $current = $rootFull
    foreach ($segment in $relative.Split([char[]]@(92, 47), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) { break }

        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ($Label + ' cannot traverse a junction or symbolic link: ' + $current)
        }
    }
}

function Resolve-AgentToolsPathInsideWorkspace {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Value,
        [string]$Label = 'Path',
        [switch]$AllowRoot,
        [switch]$AllowGit
    )

    if ([string]::IsNullOrWhiteSpace($Value)) { throw ($Label + ' is required.') }

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@(92, 47))
    $full = if ([System.IO.Path]::IsPathRooted($Value)) {
        [System.IO.Path]::GetFullPath($Value)
    }
    else {
        [System.IO.Path]::GetFullPath((Join-Path $rootFull $Value))
    }

    $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    if ($full -eq $rootFull) {
        if (-not $AllowRoot) { throw ($Label + ' cannot target WorkspaceRoot itself.') }
    }
    elseif (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw ($Label + ' must stay inside WorkspaceRoot: ' + $rootFull)
    }

    if (-not $AllowGit -and $full -ne $rootFull) {
        $relative = $full.Substring($prefix.Length)
        if ($relative -match '^(?i)\.git([\\/]|$)') {
            throw ($Label + ' cannot target .git.')
        }
    }

    Assert-AgentToolsNoReparseTraversal -Root $rootFull -FullPath $full -Label $Label
    return $full
}
