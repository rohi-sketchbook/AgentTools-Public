[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$receiver = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\Receive-ChatGPTImage.ps1'))
$sampleBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2m7sAAAAASUVORK5CYII='
$sampleBytes = [System.Convert]::FromBase64String($sampleBase64)

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-AsciiSha256Hex {
    param([string]$Text)
    return Get-Sha256Hex ([System.Text.Encoding]::ASCII.GetBytes($Text))
}

function Invoke-Receiver {
    param([string[]]$Arguments)

    $all = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $receiver) + $Arguments
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& powershell.exe @all 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    $text = ($output | Out-String)
    return [pscustomobject]@{ ExitCode = $exitCode; StdOut = $text; StdErr = $text }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Contains {
    param([string]$Text, [string]$Expected, [string]$Message)
    if ($Text.IndexOf($Expected, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw ($Message + "`nExpected: " + $Expected + "`nActual:`n" + $Text)
    }
}

function New-SyntheticLargeTransfer {
    param([string]$Workspace, [string]$Id, [int]$ByteCount)

    $payload = New-Object byte[] $ByteCount
    [byte[]]$signature = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    [System.Array]::Copy($signature, 0, $payload, 0, $signature.Length)
    for ($i = $signature.Length; $i -lt $payload.Length; $i += 4096) { $payload[$i] = [byte](($i / 4096) % 251) }

    $base64 = [System.Convert]::ToBase64String($payload)
    $chunkCharacters = 12000
    $chunkCount = [int][Math]::Ceiling($base64.Length / [double]$chunkCharacters)
    $transfer = Join-Path (Join-Path $Workspace 'UserData\Temp\ChatGPTImageBridge\inbox') $Id
    $chunksDirectory = Join-Path $transfer 'chunks'
    [System.IO.Directory]::CreateDirectory($chunksDirectory) | Out-Null

    for ($index = 0; $index -lt $chunkCount; $index++) {
        $start = $index * $chunkCharacters
        $length = [Math]::Min($chunkCharacters, $base64.Length - $start)
        [System.IO.File]::WriteAllText((Join-Path $chunksDirectory ('{0:D6}.b64' -f $index)), $base64.Substring($start, $length), [System.Text.Encoding]::ASCII)
    }

    $outputPath = 'output\' + $Id + '.png'
    $manifest = [ordered]@{
        schemaVersion = 2
        transferId = $Id
        outputPath = $outputPath
        contentType = 'image/png'
        decodedBytes = $payload.LongLength
        sha256 = Get-Sha256Hex $payload
        chunkCount = $chunkCount
    }
    [System.IO.File]::WriteAllText((Join-Path $transfer 'manifest.json'), ($manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ TransferDirectory = $transfer; OutputPath = $outputPath; Sha256 = $manifest.sha256; ChunkCount = $chunkCount }
}

function New-Transfer {
    param(
        [string]$Workspace,
        [string]$Id,
        [int]$SchemaVersion = 2,
        [string[]]$Parts = @(),
        [string]$OutputPath = '',
        [string]$ContentType = 'image/png',
        [string]$WholeSha = '',
        [Nullable[long]]$DecodedBytes,
        [switch]$WriteAllChunks
    )

    if ($Parts.Count -eq 0) {
        $Parts = @($sampleBase64.Substring(0, 11), $sampleBase64.Substring(11, 23), $sampleBase64.Substring(34))
    }
    if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = 'output\' + $Id + '.png' }
    if ([string]::IsNullOrWhiteSpace($WholeSha)) { $WholeSha = Get-Sha256Hex $sampleBytes }
    if ($null -eq $DecodedBytes) { $DecodedBytes = $sampleBytes.LongLength }

    $transfer = Join-Path (Join-Path $Workspace 'UserData\Temp\ChatGPTImageBridge\inbox') $Id
    $chunksDirectory = Join-Path $transfer 'chunks'
    [System.IO.Directory]::CreateDirectory($chunksDirectory) | Out-Null

    $countToWrite = if ($WriteAllChunks.IsPresent) { $Parts.Count } else { [Math]::Max(0, $Parts.Count - 1) }
    for ($i = 0; $i -lt $countToWrite; $i++) {
        [System.IO.File]::WriteAllText((Join-Path $chunksDirectory ('{0:D6}.b64' -f $i)), $Parts[$i], [System.Text.Encoding]::ASCII)
    }

    $manifest = [ordered]@{
        schemaVersion = $SchemaVersion
        transferId = $Id
        outputPath = $OutputPath
        contentType = $ContentType
        decodedBytes = [long]$DecodedBytes
        sha256 = $WholeSha
        chunkCount = $Parts.Count
    }
    if ($SchemaVersion -ge 2) {
        $metadata = @()
        for ($i = 0; $i -lt $Parts.Count; $i++) {
            $metadata += [ordered]@{
                index = $i
                encodedLength = $Parts[$i].Length
                sha256 = Get-AsciiSha256Hex $Parts[$i]
            }
        }
        $manifest.width = 1
        $manifest.height = 1
        $manifest.chunks = $metadata
    }

    [System.IO.File]::WriteAllText((Join-Path $transfer 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ TransferDirectory = $transfer; ChunkDirectory = $chunksDirectory; Parts = $Parts; OutputPath = $OutputPath }
}

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('image-bridge-tests-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($root) | Out-Null
$passed = 0

try {
    # 1. Manifest v2: incomplete transfer is diagnosable and Finalize refuses it.
    $case = New-Transfer -Workspace $root -Id 'incomplete-v2'
    $status = Invoke-Receiver @('-Action', 'Status', '-TransferId', 'incomplete-v2', '-WorkspaceRoot', $root)
    Assert-True ($status.ExitCode -eq 0) 'Status should succeed for an incomplete transfer.'
    Assert-Contains $status.StdOut 'State: INCOMPLETE' 'Incomplete state was not reported.'
    Assert-Contains $status.StdOut 'Missing: 2' 'Missing chunk index was not reported.'
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'incomplete-v2', '-WorkspaceRoot', $root)
    Assert-True ($finalize.ExitCode -ne 0) 'Finalize must fail when a v2 chunk is missing.'
    Assert-True (Test-Path -LiteralPath $case.TransferDirectory -PathType Container) 'Failed transfer data must remain for resume.'
    $passed++

    # 2. JSON Status exposes machine-readable resume information.
    $jsonStatus = Invoke-Receiver @('-Action', 'Status', '-TransferId', 'incomplete-v2', '-WorkspaceRoot', $root, '-Json')
    Assert-True ($jsonStatus.ExitCode -eq 0) 'JSON Status should succeed for an incomplete transfer.'
    $jsonObject = $jsonStatus.StdOut.Trim() | ConvertFrom-Json
    Assert-True ($jsonObject.state -eq 'INCOMPLETE') 'JSON Status state mismatch.'
    Assert-True (@($jsonObject.missing).Count -eq 1 -and [int]$jsonObject.missing[0] -eq 2) 'JSON Status missing list mismatch.'
    $passed++

    # 3. Resume by writing only the missing chunk.
    [System.IO.File]::WriteAllText((Join-Path $case.ChunkDirectory '000002.b64'), $case.Parts[2], [System.Text.Encoding]::ASCII)
    $status = Invoke-Receiver @('-Action', 'Status', '-TransferId', 'incomplete-v2', '-WorkspaceRoot', $root)
    Assert-Contains $status.StdOut 'State: READY' 'Transfer should become READY after the missing chunk is supplied.'
    $passed++

    # 4. Idempotent resend of the same chunk remains READY.
    [System.IO.File]::WriteAllText((Join-Path $case.ChunkDirectory '000001.b64'), $case.Parts[1], [System.Text.Encoding]::ASCII)
    $status = Invoke-Receiver @('-Action', 'Status', '-TransferId', 'incomplete-v2', '-WorkspaceRoot', $root)
    Assert-Contains $status.StdOut 'State: READY' 'Identical chunk resend should remain READY.'
    $passed++

    # 5. Different content at the same chunk index is detected as CORRUPT.
    $replacement = if ($case.Parts[1][0] -eq 'A') { 'B' } else { 'A' }
    [System.IO.File]::WriteAllText((Join-Path $case.ChunkDirectory '000001.b64'), ($replacement + $case.Parts[1].Substring(1)), [System.Text.Encoding]::ASCII)
    $status = Invoke-Receiver @('-Action', 'Status', '-TransferId', 'incomplete-v2', '-WorkspaceRoot', $root)
    Assert-Contains $status.StdOut 'State: CORRUPT' 'Changed chunk content should be CORRUPT.'
    Assert-Contains $status.StdOut 'Corrupt: 1' 'Corrupt chunk index was not reported.'
    $passed++

    # 6. Valid v2 transfer finalizes, verifies the whole image, and cleans up only on success.
    $valid = New-Transfer -Workspace $root -Id 'valid-v2' -WriteAllChunks
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'valid-v2', '-WorkspaceRoot', $root, '-Cleanup')
    Assert-True ($finalize.ExitCode -eq 0) ('Valid v2 finalize failed: ' + $finalize.StdErr)
    $writtenPath = Join-Path $root $valid.OutputPath
    Assert-True (Test-Path -LiteralPath $writtenPath -PathType Leaf) 'Valid v2 output was not written.'
    Assert-True ((Get-Sha256Hex ([System.IO.File]::ReadAllBytes($writtenPath))) -eq (Get-Sha256Hex $sampleBytes)) 'Valid v2 output hash mismatch.'
    Assert-True (-not (Test-Path -LiteralPath $valid.TransferDirectory)) 'Cleanup should remove transfer data after success.'
    $passed++

    # 7. Whole-image SHA mismatch fails and preserves the transfer directory.
    $badSha = ('0' * 64)
    $shaCase = New-Transfer -Workspace $root -Id 'bad-whole-sha' -WholeSha $badSha -WriteAllChunks
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'bad-whole-sha', '-WorkspaceRoot', $root, '-Cleanup')
    Assert-True ($finalize.ExitCode -ne 0) 'Finalize must fail on whole-image SHA mismatch.'
    Assert-True (Test-Path -LiteralPath $shaCase.TransferDirectory -PathType Container) 'SHA failure must preserve transfer data.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root $shaCase.OutputPath))) 'SHA failure must not publish an output file.'
    $passed++

    # 8. Content-Type mismatch fails after decoding and does not publish the output.
    $typeCase = New-Transfer -Workspace $root -Id 'bad-content-type' -ContentType 'image/jpeg' -WriteAllChunks
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'bad-content-type', '-WorkspaceRoot', $root)
    Assert-True ($finalize.ExitCode -ne 0) 'Finalize must fail on Content-Type mismatch.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root $typeCase.OutputPath))) 'Content-Type failure must not publish an output file.'
    $passed++

    # 9. Allowed-root enforcement rejects an output path outside WorkspaceRoot.
    $outside = Join-Path ([System.IO.Path]::GetTempPath()) ('outside-' + [Guid]::NewGuid().ToString('N') + '.png')
    $pathCase = New-Transfer -Workspace $root -Id 'outside-root' -OutputPath $outside -WriteAllChunks
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'outside-root', '-WorkspaceRoot', $root)
    Assert-True ($finalize.ExitCode -ne 0) 'Finalize must reject output outside WorkspaceRoot.'
    Assert-True (-not (Test-Path -LiteralPath $outside)) 'Outside-root output must not be created.'
    $passed++

    # 10. Legacy manifest v1 remains compatible with Finalize.
    $legacy = New-Transfer -Workspace $root -Id 'legacy-v1' -SchemaVersion 1 -WriteAllChunks
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'legacy-v1', '-WorkspaceRoot', $root)
    Assert-True ($finalize.ExitCode -eq 0) ('Legacy v1 finalize failed: ' + $finalize.StdErr)
    Assert-True (Test-Path -LiteralPath (Join-Path $root $legacy.OutputPath) -PathType Leaf) 'Legacy v1 output was not written.'
    $passed++

    # 11. 1 MiB payload streams successfully without per-chunk manifest hashes.
    $large1 = New-SyntheticLargeTransfer -Workspace $root -Id 'stream-1m' -ByteCount (1MB)
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'stream-1m', '-WorkspaceRoot', $root, '-Cleanup')
    Assert-True ($finalize.ExitCode -eq 0) ('1 MiB streaming finalize failed: ' + $finalize.StdErr)
    Assert-True ((Get-Sha256Hex ([System.IO.File]::ReadAllBytes((Join-Path $root $large1.OutputPath)))) -eq $large1.Sha256) '1 MiB streaming output hash mismatch.'
    $passed++

    # 12. 5 MiB payload streams successfully without a giant manifest.
    $large5 = New-SyntheticLargeTransfer -Workspace $root -Id 'stream-5m' -ByteCount (5MB)
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'stream-5m', '-WorkspaceRoot', $root, '-Cleanup')
    Assert-True ($finalize.ExitCode -eq 0) ('5 MiB streaming finalize failed: ' + $finalize.StdErr)
    Assert-True ((Get-Sha256Hex ([System.IO.File]::ReadAllBytes((Join-Path $root $large5.OutputPath)))) -eq $large5.Sha256) '5 MiB streaming output hash mismatch.'
    $passed++

    # 13. Historical failure shape: all v1 chunk files exist, but one chunk body is truncated.
    $legacyParts = @($sampleBase64.Substring(0, 24), $sampleBase64.Substring(24, 24), $sampleBase64.Substring(48))
    $legacyParts[2] = $legacyParts[2].Substring(0, $legacyParts[2].Length - 4)
    $truncated = New-Transfer -Workspace $root -Id 'legacy-truncated-body' -SchemaVersion 1 -Parts $legacyParts -WriteAllChunks
    $status = Invoke-Receiver @('-Action', 'Status', '-TransferId', 'legacy-truncated-body', '-WorkspaceRoot', $root, '-Json')
    Assert-True ($status.ExitCode -eq 0) 'Status should diagnose a truncated v1 chunk body.'
    $statusObject = $status.StdOut.Trim() | ConvertFrom-Json
    Assert-True ($statusObject.state -eq 'CORRUPT') 'Truncated v1 payload must not report READY.'
    Assert-True ([bool]$statusObject.encodedLengthMismatch) 'Truncated v1 payload must report encodedLengthMismatch.'
    Assert-True ([long]$statusObject.actualEncodedCharacters -lt [long]$statusObject.expectedEncodedCharacters) 'Truncated v1 payload should report fewer encoded characters than expected.'
    $finalize = Invoke-Receiver @('-Action', 'Finalize', '-TransferId', 'legacy-truncated-body', '-WorkspaceRoot', $root)
    Assert-True ($finalize.ExitCode -ne 0) 'Finalize must refuse a truncated v1 payload before publishing output.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root $truncated.OutputPath))) 'Truncated v1 payload must not publish output.'
    $passed++

    Write-Host ('[ImageBridgeTests] Passed: ' + $passed + '/13')
}
finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
