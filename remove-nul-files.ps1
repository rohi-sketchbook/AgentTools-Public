#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter()]
    [string]$Root = '',

    [Parameter()]
    [switch]$Delete
)

$ErrorActionPreference = 'Stop'

function Get-ExtendedPath([string]$Path) {
    if ($Path.StartsWith('\\?\')) {
        return $Path
    }
    if ($Path.StartsWith('\\')) {
        return '\\?\UNC\' + $Path.Substring(2)
    }
    return '\\?\' + $Path
}

function Get-NormalPath([string]$ExtendedPath) {
    if ($ExtendedPath.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $ExtendedPath.Substring(8)
    }
    if ($ExtendedPath.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $ExtendedPath.Substring(4)
    }
    return $ExtendedPath
}

function Get-LeafName([string]$Path) {
    $lastSlash = $Path.LastIndexOf('\')
    if ($lastSlash -ge 0) {
        return $Path.Substring($lastSlash + 1)
    }
    return $Path
}

function Get-FileMetadata([string]$ExtendedPath) {
    $stream = [System.IO.File]::Open(
        $ExtendedPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    )
    try {
        $length = $stream.Length
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha.Dispose()
        }

        return [pscustomobject]@{
            Length = $length
            Sha256 = $hash
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-NulCandidates([string]$ExtendedRoot) {
    $results = New-Object System.Collections.Generic.List[object]
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($ExtendedRoot.TrimEnd('\'))

    while ($pending.Count -gt 0) {
        $current = $pending.Pop()

        try {
            $files = [System.IO.Directory]::GetFiles($current)
        }
        catch {
            Write-Warning "Cannot enumerate files: $(Get-NormalPath $current) ($($_.Exception.Message))"
            $files = @()
        }

        foreach ($file in $files) {
            $leaf = Get-LeafName $file
            if (-not $leaf.Equals('NUL', [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }

            try {
                $metadata = Get-FileMetadata $file
                $results.Add([pscustomobject]@{
                    Path         = Get-NormalPath $file
                    ExtendedPath = $file
                    Length       = $metadata.Length
                    Sha256       = $metadata.Sha256
                })
            }
            catch {
                Write-Warning "Found NUL but could not inspect it: $(Get-NormalPath $file) ($($_.Exception.Message))"
            }
        }

        try {
            $directories = [System.IO.Directory]::GetDirectories($current)
        }
        catch {
            Write-Warning "Cannot enumerate directories: $(Get-NormalPath $current) ($($_.Exception.Message))"
            $directories = @()
        }

        foreach ($directory in $directories) {
            try {
                $attributes = [System.IO.File]::GetAttributes($directory)
                if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    Write-Verbose "Skipping reparse point: $(Get-NormalPath $directory)"
                    continue
                }
                $pending.Push($directory)
            }
            catch {
                Write-Warning "Cannot inspect directory: $(Get-NormalPath $directory) ($($_.Exception.Message))"
            }
        }
    }

    return @($results | Sort-Object Path)
}

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($Root)) {
    throw 'Could not determine the script directory. Specify -Root explicitly.'
}

$normalRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
$extendedRoot = Get-ExtendedPath $normalRoot

if (-not [System.IO.Directory]::Exists($extendedRoot)) {
    throw "Root directory not found: $normalRoot"
}

Write-Host "Scanning for files whose basename is exactly NUL..."
Write-Host "Root: $normalRoot"
Write-Host "Reparse points (junctions/symlinks) are skipped."
Write-Host ''

$candidates = @(Get-NulCandidates $extendedRoot)

if ($candidates.Count -eq 0) {
    Write-Host 'No NUL files found.'
    exit 0
}

Write-Host "Found $($candidates.Count) NUL file(s):"
Write-Host ''
for ($i = 0; $i -lt $candidates.Count; $i++) {
    $candidate = $candidates[$i]
    Write-Host "[$($i + 1)] $($candidate.Path)"
    Write-Host "    Size   : $($candidate.Length) bytes"
    Write-Host "    SHA-256: $($candidate.Sha256)"
}

if (-not $Delete) {
    Write-Host ''
    Write-Host 'Scan only. Nothing was deleted.'
    Write-Host 'To review each candidate interactively and decide y/n, rerun with -Delete.'
    exit 0
}

Write-Host ''
Write-Host 'Interactive delete mode.'
Write-Host 'Each file is re-hashed immediately before deletion. A changed file will not be deleted.'
Write-Host "Enter y = delete, n/Enter = keep, q = stop."
Write-Host ''

$deleted = 0
$kept = 0
$changed = 0

foreach ($candidate in $candidates) {
    if (-not [System.IO.File]::Exists($candidate.ExtendedPath)) {
        Write-Host "SKIP (already absent): $($candidate.Path)"
        continue
    }

    while ($true) {
        $answer = (Read-Host "Delete '$($candidate.Path)'? [y/N/q]").Trim().ToLowerInvariant()
        if ($answer -eq '' -or $answer -eq 'n' -or $answer -eq 'no') {
            Write-Host "KEEP: $($candidate.Path)"
            $kept++
            break
        }
        if ($answer -eq 'q' -or $answer -eq 'quit') {
            Write-Host 'Stopped by user.'
            Write-Host "Summary: deleted=$deleted kept=$kept changed=$changed remaining-not-reviewed"
            exit 0
        }
        if ($answer -ne 'y' -and $answer -ne 'yes') {
            Write-Host 'Please enter y, n, or q.'
            continue
        }

        try {
            $current = Get-FileMetadata $candidate.ExtendedPath
        }
        catch {
            Write-Warning "Could not re-check file; not deleting: $($candidate.Path) ($($_.Exception.Message))"
            $changed++
            break
        }

        if ($current.Length -ne $candidate.Length -or $current.Sha256 -ne $candidate.Sha256) {
            Write-Warning "File changed after scan; not deleting: $($candidate.Path)"
            Write-Warning "Scanned: size=$($candidate.Length), sha256=$($candidate.Sha256)"
            Write-Warning "Current: size=$($current.Length), sha256=$($current.Sha256)"
            $changed++
            break
        }

        try {
            [System.IO.File]::Delete($candidate.ExtendedPath)
            if ([System.IO.File]::Exists($candidate.ExtendedPath)) {
                throw 'File still exists after delete call.'
            }
            Write-Host "DELETED: $($candidate.Path)"
            $deleted++
        }
        catch {
            Write-Warning "Delete failed: $($candidate.Path) ($($_.Exception.Message))"
        }
        break
    }
}

Write-Host ''
Write-Host "Done. deleted=$deleted kept=$kept changed=$changed"
