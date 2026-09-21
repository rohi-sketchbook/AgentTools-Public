[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RootPath,
    [Parameter(Mandatory = $true)][string]$TransferDirectory,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][long]$ExpectedBytes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\common\PathSafety.ps1')

$root = [System.IO.Path]::GetFullPath($RootPath)
$transfer = [System.IO.Path]::GetFullPath($TransferDirectory)
$output = Resolve-AgentToolsPathInsideWorkspace -Root $root -Value $OutputPath -Label 'OutputPath'
if ($ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'ExpectedSha256 must be a 64-character hex string.'
}
if ($ExpectedBytes -lt 1 -or $ExpectedBytes -gt 67108864) {
    throw 'ExpectedBytes must be between 1 and 64 MiB.'
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
if ($bytes.LongLength -ne $ExpectedBytes) {
    throw "Byte count mismatch: expected $ExpectedBytes, got $($bytes.LongLength)"
}
if ($bytes.Length -lt 8 -or $bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50 -or $bytes[2] -ne 0x4E -or $bytes[3] -ne 0x47 -or $bytes[4] -ne 0x0D -or $bytes[5] -ne 0x0A -or $bytes[6] -ne 0x1A -or $bytes[7] -ne 0x0A) {
    throw 'Decoded payload is not a PNG.'
}

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $actualHash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
} finally {
    $sha.Dispose()
}
if ($actualHash -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "SHA-256 mismatch: expected $ExpectedSha256, got $actualHash"
}

$outputDir = Split-Path -Parent $output
[System.IO.Directory]::CreateDirectory($outputDir) | Out-Null
if (Test-Path -LiteralPath $output -PathType Leaf) {
    throw "Output already exists; refusing overwrite: $output"
}
$temp = Join-Path $outputDir ('.' + [System.IO.Path]::GetFileName($output) + '.partial.' + [Guid]::NewGuid().ToString('N'))
try {
    [System.IO.File]::WriteAllBytes($temp, $bytes)
    [System.IO.File]::Move($temp, $output)
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}

Write-Host "[img2blender] Restored PNG: $output"
Write-Host "[img2blender] Bytes: $($bytes.LongLength)"
Write-Host "[img2blender] SHA256: $actualHash"
