[CmdletBinding()]
param(
    [ValidateSet('Status', 'Finalize', 'SelfTest')]
    [string]$Action = 'Status',

    [string]$TransferId = '',
    [string]$OutputPath = '',
    [string]$ExpectedSha256 = '',
    [Nullable[long]]$ExpectedBytes,
    [switch]$Force,
    [switch]$Cleanup,
    [switch]$Json,

    [ValidateRange(1, 1073741824)]
    [long]$MaxDecodedBytes = 67108864,

    [string]$WorkspaceRoot = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\common\PathSafety.ps1')

function Resolve-WorkspaceRoot {
    param([string]$Value)

    $candidate = $Value
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = $env:AGENTTOOLS_WORKSPACE_ROOT }
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = (Get-Location).Path }

    $full = [System.IO.Path]::GetFullPath($candidate).TrimEnd([char[]]@(92, 47))
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        throw ('WorkspaceRoot does not exist: ' + $full)
    }
    return $full
}

function Assert-TransferId {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'TransferId is required.' }
    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'TransferId must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.'
    }
}

function Get-WorkspacePrefix {
    param([string]$Root)
    return $Root.TrimEnd([char[]]@(92, 47)) + [System.IO.Path]::DirectorySeparatorChar
}

function Resolve-PathInsideWorkspace {
    param([string]$Root, [string]$Value, [string]$Label)
    return Resolve-AgentToolsPathInsideWorkspace -Root $Root -Value $Value -Label $Label
}

function Get-TransferDirectory {
    param([string]$Workspace, [string]$Id)
    return Join-Path (Join-Path $Workspace 'UserData\Temp\ChatGPTImageBridge\inbox') $Id
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-AsciiSha256Hex {
    param([string]$Text)
    return Get-Sha256Hex ([System.Text.Encoding]::ASCII.GetBytes($Text))
}

function Read-Manifest {
    param([string]$TransferDirectory)

    $path = Join-Path $TransferDirectory 'manifest.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        return ([System.IO.File]::ReadAllText($path) | ConvertFrom-Json)
    }
    catch {
        throw ('Invalid manifest.json: ' + $_.Exception.Message)
    }
}

function Get-ManifestValue {
    param([object]$Manifest, [string]$Name)

    if ($null -eq $Manifest) { return $null }
    $property = $Manifest.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-ManifestSchemaVersion {
    param([object]$Manifest)

    if ($null -eq $Manifest) { return 0 }
    $value = Get-ManifestValue $Manifest 'schemaVersion'
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { return 1 }
    try { $version = [int]$value }
    catch { throw 'manifest.schemaVersion must be an integer.' }
    if ($version -ne 1 -and $version -ne 2) { throw ('Unsupported manifest.schemaVersion: ' + $version) }
    return $version
}

function Assert-HexSha256 {
    param([string]$Value, [string]$Label)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[0-9A-Fa-f]{64}$') {
        throw ($Label + ' must be 64 hexadecimal characters.')
    }
}

function Assert-ManifestIdentity {
    param([object]$Manifest, [string]$Id)

    if ($null -eq $Manifest) { return }
    $manifestTransferId = [string](Get-ManifestValue $Manifest 'transferId')
    if (-not [string]::IsNullOrWhiteSpace($manifestTransferId) -and $manifestTransferId -cne $Id) {
        throw ('Manifest transferId mismatch. Directory=' + $Id + ' Manifest=' + $manifestTransferId)
    }
}

function Get-ExpectedChunkCount {
    param([object]$Manifest)

    if ($null -eq $Manifest) { return [Nullable[int]]$null }
    $value = Get-ManifestValue $Manifest 'chunkCount'
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { return [Nullable[int]]$null }
    try { $count = [int]$value }
    catch { throw 'manifest.chunkCount must be an integer.' }
    if ($count -lt 1 -or $count -gt 999999) { throw ('manifest.chunkCount is outside the allowed range: ' + $count) }
    return [Nullable[int]]$count
}

function Get-V2ChunkMetadataMap {
    param([object]$Manifest, [Nullable[int]]$ExpectedCount)

    $map = @{}
    if ($null -eq $Manifest -or (Get-ManifestSchemaVersion $Manifest) -lt 2) { return $map }

    $chunks = Get-ManifestValue $Manifest 'chunks'
    if ($null -eq $chunks) { return $map }
    $items = @($chunks)
    if ($items.Count -eq 0) { return $map }
    if ($null -eq $ExpectedCount) { throw 'Manifest v2 requires chunkCount when chunk metadata is present.' }
    if ($items.Count -ne [int]$ExpectedCount) {
        throw ('Manifest v2 chunks length mismatch. chunkCount=' + [int]$ExpectedCount + ' chunks=' + $items.Count)
    }

    foreach ($item in $items) {
        $indexValue = Get-ManifestValue $item 'index'
        $lengthValue = Get-ManifestValue $item 'encodedLength'
        $shaValue = [string](Get-ManifestValue $item 'sha256')
        if ($null -eq $indexValue -or $null -eq $lengthValue) { throw 'Each manifest v2 chunk requires index and encodedLength.' }

        try { $index = [int]$indexValue }
        catch { throw 'manifest.chunks[].index must be an integer.' }
        try { $encodedLength = [long]$lengthValue }
        catch { throw 'manifest.chunks[].encodedLength must be an integer.' }

        if ($index -lt 0 -or $index -ge [int]$ExpectedCount) { throw ('Manifest chunk index out of range: ' + $index) }
        if ($encodedLength -lt 1) { throw ('Manifest encodedLength must be positive for chunk ' + $index) }
        Assert-HexSha256 $shaValue ('manifest.chunks[' + $index + '].sha256')
        if ($map.ContainsKey($index)) { throw ('Duplicate manifest chunk metadata index: ' + $index) }

        $map[$index] = [pscustomobject]@{
            Index = $index
            EncodedLength = $encodedLength
            Sha256 = $shaValue.ToLowerInvariant()
        }
    }

    for ($i = 0; $i -lt [int]$ExpectedCount; $i++) {
        if (-not $map.ContainsKey($i)) { throw ('Manifest v2 is missing chunk metadata for index ' + $i) }
    }
    return $map
}

function Normalize-ChunkText {
    param([string]$Text, [bool]$AllowDataUriPrefix)

    if ($null -eq $Text) { return '' }
    $builder = New-Object System.Text.StringBuilder $Text.Length
    foreach ($character in $Text.ToCharArray()) {
        if (-not [char]::IsWhiteSpace($character)) { [void]$builder.Append($character) }
    }
    $normalized = $builder.ToString()

    if ($AllowDataUriPrefix -and $normalized.StartsWith('data:', [System.StringComparison]::OrdinalIgnoreCase)) {
        $comma = $normalized.IndexOf(',')
        if ($comma -lt 0) { throw 'Incomplete data URI prefix in first chunk.' }
        $normalized = $normalized.Substring($comma + 1)
    }
    elseif ($normalized.StartsWith('data:', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Data URI prefix is only allowed in the first chunk.'
    }

    return $normalized
}

function Get-ChunkFileMap {
    param([string]$TransferDirectory)

    $chunkDir = Join-Path $TransferDirectory 'chunks'
    $map = @{}
    $unexpected = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $chunkDir -PathType Container)) {
        return [pscustomobject]@{ Directory = $chunkDir; Files = $map; Unexpected = @() }
    }

    foreach ($file in @(Get-ChildItem -LiteralPath $chunkDir -File -Filter '*.b64')) {
        if ($file.Name -notmatch '^(\d{6})\.b64$') {
            $unexpected.Add($file.Name)
            continue
        }
        $index = [int]$Matches[1]
        if ($map.ContainsKey($index)) { throw ('Duplicate chunk index on disk: ' + $index) }
        $map[$index] = $file
    }

    return [pscustomobject]@{
        Directory = $chunkDir
        Files = $map
        Unexpected = @($unexpected)
    }
}

function Compress-IndexRanges {
    param([int[]]$Indices)

    if ($null -eq $Indices -or $Indices.Count -eq 0) { return 'none' }
    $sorted = @($Indices | Sort-Object -Unique)
    $parts = New-Object System.Collections.Generic.List[string]
    $start = $sorted[0]
    $previous = $sorted[0]

    for ($i = 1; $i -lt $sorted.Count; $i++) {
        $current = $sorted[$i]
        if ($current -eq ($previous + 1)) {
            $previous = $current
            continue
        }
        if ($start -eq $previous) { $parts.Add([string]$start) } else { $parts.Add(([string]$start + '-' + [string]$previous)) }
        $start = $current
        $previous = $current
    }

    if ($start -eq $previous) { $parts.Add([string]$start) } else { $parts.Add(([string]$start + '-' + [string]$previous)) }
    return [string]::Join(',', $parts.ToArray())
}

function Get-TransferInspection {
    param([string]$TransferDirectory, [object]$Manifest)

    $schemaVersion = Get-ManifestSchemaVersion $Manifest
    $expectedCount = Get-ExpectedChunkCount $Manifest
    $metadataMap = Get-V2ChunkMetadataMap $Manifest $expectedCount
    $disk = Get-ChunkFileMap $TransferDirectory
    $missing = New-Object System.Collections.Generic.List[int]
    $corrupt = New-Object System.Collections.Generic.List[int]
    $extra = New-Object System.Collections.Generic.List[int]
    $valid = New-Object System.Collections.Generic.List[int]
    [long]$actualEncodedCharacters = 0
    [Nullable[long]]$expectedEncodedCharacters = [Nullable[long]]$null
    $encodedLengthMismatch = $false

    if ($null -ne $Manifest) {
        $manifestBytesValue = Get-ManifestValue $Manifest 'decodedBytes'
        if ($null -ne $manifestBytesValue -and -not [string]::IsNullOrWhiteSpace([string]$manifestBytesValue)) {
            try { $manifestBytes = [long]$manifestBytesValue }
            catch { throw 'manifest.decodedBytes must be an integer.' }
            if ($manifestBytes -lt 1) { throw 'manifest.decodedBytes must be positive.' }
            $expectedEncodedCharacters = [long](4 * [Math]::Ceiling($manifestBytes / 3.0))
        }
    }

    if ($null -ne $expectedCount) {
        for ($i = 0; $i -lt [int]$expectedCount; $i++) {
            if (-not $disk.Files.ContainsKey($i)) {
                $missing.Add($i)
                continue
            }

            try {
                $text = [System.IO.File]::ReadAllText($disk.Files[$i].FullName)
                $normalized = Normalize-ChunkText $text ($i -eq 0)
                if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized -notmatch '^[A-Za-z0-9+/=]+$') {
                    $corrupt.Add($i)
                    continue
                }
                if ($i -lt ([int]$expectedCount - 1) -and $normalized.Contains('=')) {
                    $corrupt.Add($i)
                    continue
                }
                if ($i -eq ([int]$expectedCount - 1) -and $normalized -notmatch '^[A-Za-z0-9+/]*={0,2}$') {
                    $corrupt.Add($i)
                    continue
                }

                $actualEncodedCharacters += $normalized.Length
                if ($metadataMap.Count -gt 0) {
                    $metadata = $metadataMap[$i]
                    if ($normalized.Length -ne $metadata.EncodedLength) {
                        $corrupt.Add($i)
                        continue
                    }
                    if ((Get-AsciiSha256Hex $normalized) -ne $metadata.Sha256) {
                        $corrupt.Add($i)
                        continue
                    }
                }
            }
            catch {
                $corrupt.Add($i)
                continue
            }
            $valid.Add($i)
        }

        foreach ($index in $disk.Files.Keys) {
            if ([int]$index -ge [int]$expectedCount) { $extra.Add([int]$index) }
        }
    }
    else {
        foreach ($index in $disk.Files.Keys) { $valid.Add([int]$index) }
    }

    if ($null -ne $expectedEncodedCharacters -and $missing.Count -eq 0 -and $corrupt.Count -eq 0 -and $extra.Count -eq 0) {
        $encodedLengthMismatch = ($actualEncodedCharacters -ne [long]$expectedEncodedCharacters)
    }

    $state = 'READY'
    if ($null -eq $Manifest) { $state = 'MANIFEST_MISSING' }
    elseif ($disk.Unexpected.Count -gt 0 -or $corrupt.Count -gt 0 -or $extra.Count -gt 0 -or $encodedLengthMismatch) { $state = 'CORRUPT' }
    elseif ($missing.Count -gt 0) { $state = 'INCOMPLETE' }
    elseif ($null -eq $expectedCount -and $disk.Files.Count -eq 0) { $state = 'INCOMPLETE' }
    elseif ($null -ne $expectedCount -and [int]$expectedCount -gt 0 -and $valid.Count -eq [int]$expectedCount) { $state = 'READY' }

    return [pscustomobject]@{
        SchemaVersion = $schemaVersion
        ExpectedCount = $expectedCount
        ReceivedCount = $disk.Files.Count
        Valid = @($valid)
        Missing = @($missing)
        Corrupt = @($corrupt)
        Extra = @($extra)
        Unexpected = @($disk.Unexpected)
        State = $state
        ChunkDirectory = $disk.Directory
        Files = $disk.Files
        Metadata = $metadataMap
        ActualEncodedCharacters = $actualEncodedCharacters
        ExpectedEncodedCharacters = $expectedEncodedCharacters
        EncodedLengthMismatch = $encodedLengthMismatch
        ChunkIntegrity = $(if ($metadataMap.Count -gt 0) { 'per-chunk-sha256' } elseif ($null -ne $expectedEncodedCharacters) { 'whole-image-sha256+encoded-length' } else { 'whole-image-sha256-only' })
    }
}

function Assert-LegacyChunkSequence {
    param([hashtable]$Files, [Nullable[int]]$ExpectedCount)

    if ($Files.Count -eq 0) { throw 'No Base64 chunks found.' }
    $indices = @($Files.Keys | ForEach-Object { [int]$_ } | Sort-Object)
    for ($i = 0; $i -lt $indices.Count; $i++) {
        if ($indices[$i] -ne $i) { throw ('Chunk sequence invalid. Expected index ' + $i + ' but found ' + $indices[$i] + '.') }
    }
    if ($null -ne $ExpectedCount -and $indices.Count -ne [int]$ExpectedCount) {
        throw ('Chunk count mismatch. Expected ' + [int]$ExpectedCount + ' but found ' + $indices.Count + '.')
    }
}

function Get-ImageTypeFromFile {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $header = New-Object byte[] 16
        $read = $stream.Read($header, 0, $header.Length)
    }
    finally {
        $stream.Dispose()
    }

    if ($read -ge 8 -and
        $header[0] -eq 0x89 -and $header[1] -eq 0x50 -and $header[2] -eq 0x4E -and $header[3] -eq 0x47 -and
        $header[4] -eq 0x0D -and $header[5] -eq 0x0A -and $header[6] -eq 0x1A -and $header[7] -eq 0x0A) {
        return [pscustomobject]@{ Extension = '.png'; ContentType = 'image/png'; Label = 'PNG' }
    }
    if ($read -ge 3 -and $header[0] -eq 0xFF -and $header[1] -eq 0xD8 -and $header[2] -eq 0xFF) {
        return [pscustomobject]@{ Extension = '.jpg'; ContentType = 'image/jpeg'; Label = 'JPEG' }
    }
    if ($read -ge 12 -and
        $header[0] -eq 0x52 -and $header[1] -eq 0x49 -and $header[2] -eq 0x46 -and $header[3] -eq 0x46 -and
        $header[8] -eq 0x57 -and $header[9] -eq 0x45 -and $header[10] -eq 0x42 -and $header[11] -eq 0x50) {
        return [pscustomobject]@{ Extension = '.webp'; ContentType = 'image/webp'; Label = 'WebP' }
    }
    if ($read -ge 6) {
        $sig = [System.Text.Encoding]::ASCII.GetString($header, 0, 6)
        if ($sig -eq 'GIF87a' -or $sig -eq 'GIF89a') {
            return [pscustomobject]@{ Extension = '.gif'; ContentType = 'image/gif'; Label = 'GIF' }
        }
    }
    throw 'Decoded payload is not a supported image (PNG/JPEG/WebP/GIF).'
}

function Assert-OutputExtension {
    param([string]$Path, [object]$Type)

    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    $valid = switch ($Type.ContentType) {
        'image/png' { $ext -eq '.png' }
        'image/jpeg' { $ext -eq '.jpg' -or $ext -eq '.jpeg' }
        'image/webp' { $ext -eq '.webp' }
        'image/gif' { $ext -eq '.gif' }
        default { $false }
    }
    if (-not $valid) { throw ('Output extension ' + $ext + ' does not match ' + $Type.Label + '.') }
}

function Move-ValidatedTemporaryFile {
    param([string]$Temporary, [string]$Path, [bool]$AllowOverwrite)

    $exists = Test-Path -LiteralPath $Path -PathType Leaf
    if ($exists -and -not $AllowOverwrite) { throw ('Output already exists. Use -Force: ' + $Path) }

    if ($exists) {
        $backup = $Temporary + '.backup'
        try {
            [System.IO.File]::Replace($Temporary, $Path, $backup, $true)
        }
        finally {
            if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
        }
    }
    else {
        [System.IO.File]::Move($Temporary, $Path)
    }
}

function Convert-ChunksToTemporaryFile {
    param(
        [hashtable]$Files,
        [int[]]$OrderedIndices,
        [string]$TemporaryPath,
        [long]$Limit
    )

    $stream = New-Object System.IO.FileStream($TemporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $carry = ''
    [long]$decodedBytes = 0
    [long]$encodedCharacters = 0

    try {
        for ($position = 0; $position -lt $OrderedIndices.Count; $position++) {
            $index = $OrderedIndices[$position]
            $isFirst = $position -eq 0
            $isLast = $position -eq ($OrderedIndices.Count - 1)
            $raw = [System.IO.File]::ReadAllText($Files[$index].FullName)
            $normalized = Normalize-ChunkText $raw $isFirst
            if ([string]::IsNullOrWhiteSpace($normalized)) { throw ('Base64 chunk is empty: ' + $index) }
            if ($normalized -notmatch '^[A-Za-z0-9+/=]+$') { throw ('Chunk contains invalid Base64 characters: ' + $index) }
            if (-not $isLast -and $normalized.Contains('=')) { throw ('Base64 padding appeared before the final chunk: ' + $index) }

            $encodedCharacters += $normalized.Length
            $combined = $carry + $normalized
            if ($isLast) {
                if (($combined.Length % 4) -ne 0) { throw 'Final Base64 payload length is not divisible by 4.' }
                if ($combined -notmatch '^[A-Za-z0-9+/]*={0,2}$') { throw 'Final Base64 padding is invalid.' }
                $processable = $combined
                $carry = ''
            }
            else {
                $processableLength = $combined.Length - ($combined.Length % 4)
                if ($processableLength -gt 0) { $processable = $combined.Substring(0, $processableLength) } else { $processable = '' }
                $carry = $combined.Substring($processableLength)
            }

            if ($processable.Length -gt 0) {
                try { $decoded = [System.Convert]::FromBase64String($processable) }
                catch { throw ('Base64 decode failed near chunk ' + $index + ': ' + $_.Exception.Message) }

                $decodedBytes += $decoded.LongLength
                if ($decodedBytes -gt $Limit) { throw ('Decoded payload exceeds MaxDecodedBytes: ' + $decodedBytes) }
                $stream.Write($decoded, 0, $decoded.Length)
                if ($decoded.Length -gt 0) { [void]$sha.TransformBlock($decoded, 0, $decoded.Length, $null, 0) }
            }
        }

        if (-not [string]::IsNullOrEmpty($carry)) { throw 'Base64 payload ended with an incomplete quartet.' }
        [void]$sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        $stream.Flush($true)
        $actualSha = ([System.BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLowerInvariant()

        return [pscustomobject]@{
            Bytes = $decodedBytes
            Sha256 = $actualSha
            EncodedCharacters = $encodedCharacters
        }
    }
    finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Complete-Transfer {
    param(
        [string]$Workspace,
        [string]$Id,
        [string]$CommandOutputPath,
        [string]$CommandSha256,
        [Nullable[long]]$CommandBytes,
        [bool]$AllowOverwrite,
        [bool]$RemoveTransfer,
        [long]$Limit
    )

    Assert-TransferId $Id
    $transferDirectory = Get-TransferDirectory $Workspace $Id
    if (-not (Test-Path -LiteralPath $transferDirectory -PathType Container)) {
        throw ('Transfer directory not found: ' + $transferDirectory)
    }

    $manifest = Read-Manifest $transferDirectory
    Assert-ManifestIdentity $manifest $Id
    $schemaVersion = Get-ManifestSchemaVersion $manifest
    $inspection = Get-TransferInspection $transferDirectory $manifest

    if ($null -ne $manifest) {
        if ($inspection.State -ne 'READY') {
            throw ('Transfer is not ready. State=' + $inspection.State +
                ' Missing=' + (Compress-IndexRanges $inspection.Missing) +
                ' Corrupt=' + (Compress-IndexRanges $inspection.Corrupt) +
                ' Extra=' + (Compress-IndexRanges $inspection.Extra) +
                ' EncodedLengthMismatch=' + $inspection.EncodedLengthMismatch)
        }
    }
    else {
        Assert-LegacyChunkSequence $inspection.Files $inspection.ExpectedCount
    }

    $resolvedOutput = $CommandOutputPath
    if ([string]::IsNullOrWhiteSpace($resolvedOutput)) { $resolvedOutput = [string](Get-ManifestValue $manifest 'outputPath') }
    $resolvedOutput = Resolve-PathInsideWorkspace $Workspace $resolvedOutput 'OutputPath'

    $resolvedSha = $CommandSha256
    if ([string]::IsNullOrWhiteSpace($resolvedSha)) { $resolvedSha = [string](Get-ManifestValue $manifest 'sha256') }
    if (-not [string]::IsNullOrWhiteSpace($resolvedSha)) {
        $resolvedSha = $resolvedSha.Trim().ToLowerInvariant()
        Assert-HexSha256 $resolvedSha 'ExpectedSha256'
    }
    elseif ($schemaVersion -ge 2) {
        throw 'Manifest v2 requires a whole-image sha256.'
    }

    $resolvedBytes = $CommandBytes
    if ($null -eq $resolvedBytes) {
        $manifestBytes = Get-ManifestValue $manifest 'decodedBytes'
        if ($null -ne $manifestBytes -and -not [string]::IsNullOrWhiteSpace([string]$manifestBytes)) { $resolvedBytes = [long]$manifestBytes }
    }
    if ($null -ne $resolvedBytes -and ([long]$resolvedBytes -lt 1 -or [long]$resolvedBytes -gt $Limit)) {
        throw ('Expected byte count is outside the allowed range: ' + [long]$resolvedBytes)
    }
    if ($schemaVersion -ge 2 -and $null -eq $resolvedBytes) { throw 'Manifest v2 requires decodedBytes.' }

    $manifestContentType = [string](Get-ManifestValue $manifest 'contentType')
    if ($schemaVersion -ge 2 -and [string]::IsNullOrWhiteSpace($manifestContentType)) { throw 'Manifest v2 requires contentType.' }

    $directory = Split-Path -Parent $resolvedOutput
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    if ((Test-Path -LiteralPath $resolvedOutput -PathType Leaf) -and -not $AllowOverwrite) {
        throw ('Output already exists. Use -Force: ' + $resolvedOutput)
    }

    $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($resolvedOutput) + '.partial.' + [Guid]::NewGuid().ToString('N'))
    try {
        $orderedIndices = @($inspection.Files.Keys | ForEach-Object { [int]$_ } | Sort-Object)
        $decode = Convert-ChunksToTemporaryFile $inspection.Files $orderedIndices $temporary $Limit

        if ($null -ne $resolvedBytes -and $decode.Bytes -ne [long]$resolvedBytes) {
            throw ('Decoded byte count mismatch. Expected ' + [long]$resolvedBytes + ' but found ' + $decode.Bytes + '.')
        }
        if (-not [string]::IsNullOrWhiteSpace($resolvedSha) -and $decode.Sha256 -ne $resolvedSha) {
            throw ('SHA-256 mismatch. Expected ' + $resolvedSha + ' but found ' + $decode.Sha256 + '.')
        }

        $type = Get-ImageTypeFromFile $temporary
        Assert-OutputExtension $resolvedOutput $type
        if (-not [string]::IsNullOrWhiteSpace($manifestContentType) -and
            -not $manifestContentType.Equals($type.ContentType, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw ('Content type mismatch. Manifest=' + $manifestContentType + ' actual=' + $type.ContentType)
        }

        Move-ValidatedTemporaryFile $temporary $resolvedOutput $AllowOverwrite
        if ($RemoveTransfer) { Remove-Item -LiteralPath $transferDirectory -Recurse -Force }

        Write-Host ('[ChatGPTImageBridge] Saved: ' + $resolvedOutput)
        Write-Host ('[ChatGPTImageBridge] Schema=' + $schemaVersion + ' Type=' + $type.Label + ' Bytes=' + $decode.Bytes + ' SHA256=' + $decode.Sha256)
        Write-Host ('[ChatGPTImageBridge] Chunks=' + $orderedIndices.Count + ' EncodedCharacters=' + $decode.EncodedCharacters)

        return [pscustomobject]@{
            OutputPath = $resolvedOutput
            ContentType = $type.ContentType
            Bytes = $decode.Bytes
            Sha256 = $decode.Sha256
            ChunkCount = $orderedIndices.Count
            SchemaVersion = $schemaVersion
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Show-Status {
    param([string]$Workspace, [string]$Id, [bool]$AsJson)

    Assert-TransferId $Id
    $transferDirectory = Get-TransferDirectory $Workspace $Id
    if (-not (Test-Path -LiteralPath $transferDirectory -PathType Container)) {
        $missingResult = [ordered]@{
            transferId = $Id
            workspace = $Workspace
            transferDirectory = $transferDirectory
            manifestPresent = $false
            schemaVersion = 0
            receivedChunks = 0
            expectedChunks = $null
            missing = @()
            corrupt = @()
            extra = @()
            unexpected = @()
            chunkIntegrity = 'unknown'
            actualEncodedCharacters = 0
            expectedEncodedCharacters = $null
            encodedLengthMismatch = $false
            outputPath = $null
            expectedBytes = $null
            state = 'MISSING'
        }
        if ($AsJson) { Write-Output ($missingResult | ConvertTo-Json -Depth 5 -Compress) }
        else {
            Write-Host ('[ChatGPTImageBridge] Workspace: ' + $Workspace)
            Write-Host ('[ChatGPTImageBridge] Transfer: ' + $transferDirectory)
            Write-Host '[ChatGPTImageBridge] State: MISSING'
        }
        return
    }

    $manifest = Read-Manifest $transferDirectory
    Assert-ManifestIdentity $manifest $Id
    $inspection = Get-TransferInspection $transferDirectory $manifest
    $output = $null
    $bytes = $null
    if ($null -ne $manifest) {
        $output = [string](Get-ManifestValue $manifest 'outputPath')
        if ([string]::IsNullOrWhiteSpace($output)) { $output = $null }
        $bytes = Get-ManifestValue $manifest 'decodedBytes'
    }

    $result = [ordered]@{
        transferId = $Id
        workspace = $Workspace
        transferDirectory = $transferDirectory
        manifestPresent = ($null -ne $manifest)
        schemaVersion = $inspection.SchemaVersion
        receivedChunks = $inspection.ReceivedCount
        expectedChunks = $(if ($null -eq $inspection.ExpectedCount) { $null } else { [int]$inspection.ExpectedCount })
        missing = @($inspection.Missing)
        corrupt = @($inspection.Corrupt)
        extra = @($inspection.Extra)
        unexpected = @($inspection.Unexpected)
        chunkIntegrity = $inspection.ChunkIntegrity
        actualEncodedCharacters = $inspection.ActualEncodedCharacters
        expectedEncodedCharacters = $(if ($null -eq $inspection.ExpectedEncodedCharacters) { $null } else { [long]$inspection.ExpectedEncodedCharacters })
        encodedLengthMismatch = $inspection.EncodedLengthMismatch
        outputPath = $output
        expectedBytes = $bytes
        state = $inspection.State
    }

    if ($AsJson) {
        Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
        return
    }

    $expectedText = if ($null -eq $inspection.ExpectedCount) { 'unknown' } else { [string][int]$inspection.ExpectedCount }
    Write-Host ('[ChatGPTImageBridge] Workspace: ' + $Workspace)
    Write-Host ('[ChatGPTImageBridge] Transfer: ' + $transferDirectory)
    Write-Host ('[ChatGPTImageBridge] Manifest: ' + $(if ($null -eq $manifest) { 'missing' } else { 'present' }))
    Write-Host ('[ChatGPTImageBridge] Schema: ' + $inspection.SchemaVersion)
    Write-Host ('[ChatGPTImageBridge] Chunks: ' + $inspection.ReceivedCount + ' / ' + $expectedText)
    Write-Host ('[ChatGPTImageBridge] Missing: ' + (Compress-IndexRanges $inspection.Missing))
    Write-Host ('[ChatGPTImageBridge] Corrupt: ' + (Compress-IndexRanges $inspection.Corrupt))
    Write-Host ('[ChatGPTImageBridge] Extra: ' + (Compress-IndexRanges $inspection.Extra))
    Write-Host ('[ChatGPTImageBridge] ChunkIntegrity: ' + $inspection.ChunkIntegrity)
    if ($null -ne $inspection.ExpectedEncodedCharacters) {
        Write-Host ('[ChatGPTImageBridge] EncodedCharacters: ' + $inspection.ActualEncodedCharacters + ' / ' + [long]$inspection.ExpectedEncodedCharacters)
        Write-Host ('[ChatGPTImageBridge] EncodedLengthMismatch: ' + $inspection.EncodedLengthMismatch)
    }
    if ($inspection.Unexpected.Count -gt 0) { Write-Host ('[ChatGPTImageBridge] Unexpected files: ' + [string]::Join(',', $inspection.Unexpected)) }
    if ($null -ne $output) { Write-Host ('[ChatGPTImageBridge] Output: ' + $output) }
    if ($null -ne $bytes) { Write-Host ('[ChatGPTImageBridge] ExpectedBytes: ' + [string]$bytes) }
    Write-Host ('[ChatGPTImageBridge] State: ' + $inspection.State)
}

function New-V2ChunkMetadata {
    param([string[]]$Parts)

    $items = @()
    for ($i = 0; $i -lt $Parts.Count; $i++) {
        $normalized = Normalize-ChunkText $Parts[$i] ($i -eq 0)
        $items += [ordered]@{
            index = $i
            encodedLength = $normalized.Length
            sha256 = Get-AsciiSha256Hex $normalized
        }
    }
    return $items
}

function Invoke-SelfTest {
    param([string]$Workspace, [long]$Limit)

    $id = 'selftest_' + [Guid]::NewGuid().ToString('N')
    $transferDirectory = Get-TransferDirectory $Workspace $id
    $chunkDirectory = Join-Path $transferDirectory 'chunks'
    $outputRelative = 'UserData\Temp\ChatGPTImageBridge\self-test-' + [Guid]::NewGuid().ToString('N') + '.png'
    $outputFull = Resolve-PathInsideWorkspace $Workspace $outputRelative 'OutputPath'
    $sampleBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2m7sAAAAASUVORK5CYII='
    $sampleBytes = [System.Convert]::FromBase64String($sampleBase64)
    $sampleSha = Get-Sha256Hex $sampleBytes

    try {
        [System.IO.Directory]::CreateDirectory($chunkDirectory) | Out-Null
        $parts = @($sampleBase64.Substring(0, 17), $sampleBase64.Substring(17, 29), $sampleBase64.Substring(46))
        for ($i = 0; $i -lt $parts.Count; $i++) {
            [System.IO.File]::WriteAllText((Join-Path $chunkDirectory ('{0:D6}.b64' -f $i)), $parts[$i], [System.Text.Encoding]::ASCII)
        }

        $manifest = [ordered]@{
            schemaVersion = 2
            transferId = $id
            outputPath = $outputRelative
            contentType = 'image/png'
            width = 1
            height = 1
            decodedBytes = $sampleBytes.LongLength
            sha256 = $sampleSha
            chunkCount = $parts.Count
            chunks = New-V2ChunkMetadata $parts
        }
        [System.IO.File]::WriteAllText((Join-Path $transferDirectory 'manifest.json'), ($manifest | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

        $result = Complete-Transfer $Workspace $id '' '' ([Nullable[long]]$null) $false $true $Limit
        $written = [System.IO.File]::ReadAllBytes($result.OutputPath)
        if ((Get-Sha256Hex $written) -ne $sampleSha) { throw 'Self-test output hash mismatch.' }
        Write-Host '[ChatGPTImageBridge] Self-test passed.'
    }
    finally {
        if (Test-Path -LiteralPath $transferDirectory) { Remove-Item -LiteralPath $transferDirectory -Recurse -Force }
        if (Test-Path -LiteralPath $outputFull) { Remove-Item -LiteralPath $outputFull -Force }
    }
}

try {
    $workspace = Resolve-WorkspaceRoot $WorkspaceRoot
    switch ($Action) {
        'Status' { Show-Status $workspace $TransferId $Json.IsPresent }
        'Finalize' { [void](Complete-Transfer $workspace $TransferId $OutputPath $ExpectedSha256 $ExpectedBytes $Force.IsPresent $Cleanup.IsPresent $MaxDecodedBytes) }
        'SelfTest' { Invoke-SelfTest $workspace $MaxDecodedBytes }
    }
}
catch {
    [Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)
    exit 1
}
