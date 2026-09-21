[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RootPath,
    [Parameter(Mandatory = $true)][string]$TransferDirectory,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$ExpectedTransportSha256,
    [Parameter(Mandatory = $true)][long]$ExpectedTransportBytes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\common\PathSafety.ps1')
Add-Type -AssemblyName System.Drawing

$root = [System.IO.Path]::GetFullPath($RootPath)
$transfer = [System.IO.Path]::GetFullPath($TransferDirectory)
$output = Resolve-AgentToolsPathInsideWorkspace -Root $root -Value $OutputPath -Label 'OutputPath'
if ($ExpectedTransportSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'ExpectedTransportSha256 must be a 64-character hex string.'
}
if ($ExpectedTransportBytes -lt 1 -or $ExpectedTransportBytes -gt 67108864) {
    throw 'ExpectedTransportBytes must be between 1 and 64 MiB.'
}
if (-not (Test-Path -LiteralPath $transfer -PathType Container)) {
    throw "Transfer directory not found: $transfer"
}

$chunks = @(Get-ChildItem -LiteralPath $transfer -File -Filter '*.b64' | Sort-Object Name)
if ($chunks.Count -eq 0) { throw 'No Base64 chunks found.' }
for ($i = 0; $i -lt $chunks.Count; $i++) {
    $expectedName = ('{0:D6}.b64' -f $i)
    if ($chunks[$i].Name -cne $expectedName) {
        throw "Invalid chunk sequence: expected $expectedName, got $($chunks[$i].Name)"
    }
}

$builder = New-Object System.Text.StringBuilder
foreach ($chunk in $chunks) {
    $text = [System.IO.File]::ReadAllText($chunk.FullName)
    $text = [System.Text.RegularExpressions.Regex]::Replace($text, '\s', '')
    [void]$builder.Append($text)
}
$base64 = $builder.ToString()
if ($base64 -notmatch '^[A-Za-z0-9+/]*={0,2}$') { throw 'Invalid Base64 payload.' }
$bytes = [System.Convert]::FromBase64String($base64)
if ($bytes.LongLength -ne $ExpectedTransportBytes) {
    throw "Transport byte count mismatch: expected $ExpectedTransportBytes, got $($bytes.LongLength)"
}
if ($bytes.Length -lt 4 -or $bytes[0] -ne 0xFF -or $bytes[1] -ne 0xD8 -or $bytes[$bytes.Length - 2] -ne 0xFF -or $bytes[$bytes.Length - 1] -ne 0xD9) {
    throw 'Decoded transport payload is not a complete JPEG.'
}

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $actualTransportHash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
} finally {
    $sha.Dispose()
}
if ($actualTransportHash -ne $ExpectedTransportSha256.ToLowerInvariant()) {
    throw "Transport SHA-256 mismatch: expected $ExpectedTransportSha256, got $actualTransportHash"
}

$outputDir = Split-Path -Parent $output
[System.IO.Directory]::CreateDirectory($outputDir) | Out-Null
if (Test-Path -LiteralPath $output -PathType Leaf) {
    throw "Output already exists; refusing overwrite: $output"
}

$stream = New-Object System.IO.MemoryStream(,$bytes)
$image = $null
$bitmap = $null
$imageWidth = 0
$imageHeight = 0
$temp = Join-Path $outputDir ('.' + [System.IO.Path]::GetFileName($output) + '.partial.' + [Guid]::NewGuid().ToString('N') + '.png')
try {
    $image = [System.Drawing.Image]::FromStream($stream, $true, $true)
    $imageWidth = $image.Width
    $imageHeight = $image.Height
    $bitmap = New-Object System.Drawing.Bitmap($image)
    $bitmap.Save($temp, [System.Drawing.Imaging.ImageFormat]::Png)
    [System.IO.File]::Move($temp, $output)
} finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($image) { $image.Dispose() }
    $stream.Dispose()
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}

$pngBytes = [System.IO.File]::ReadAllBytes($output)
$pngSha = [System.Security.Cryptography.SHA256]::Create()
try {
    $pngHash = ([System.BitConverter]::ToString($pngSha.ComputeHash($pngBytes))).Replace('-', '').ToLowerInvariant()
} finally {
    $pngSha.Dispose()
}
Write-Host "[img2blender] Restored reference PNG: $output"
Write-Host "[img2blender] Resolution: ${imageWidth}x${imageHeight}"
Write-Host "[img2blender] Transport SHA256: $actualTransportHash"
Write-Host "[img2blender] PNG SHA256: $pngHash"
