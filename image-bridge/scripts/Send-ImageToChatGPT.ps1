[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [ValidateRange(64, 4096)]
    [int]$MaximumWidth = 960,

    [ValidateRange(64, 4096)]
    [int]$MaximumHeight = 960,

    [ValidateRange(10, 100)]
    [int]$JpegQuality = 82,

    [ValidateRange(1024, 32768)]
    [int]$ChunkCharacters = 12000,

    [switch]$KeepPng,
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
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw ('WorkspaceRoot does not exist: ' + $full) }
    return $full
}

function Resolve-InputPath {
    param([string]$Root, [string]$Value)
    $full = Resolve-AgentToolsPathInsideWorkspace -Root $Root -Value $Value -Label 'InputPath'
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw ('Input image not found: ' + $full) }
    return $full
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-JpegCodec {
    return [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' } |
        Select-Object -First 1
}

try {
    Add-Type -AssemblyName System.Drawing
    $workspace = Resolve-WorkspaceRoot $WorkspaceRoot
    $resolvedInput = Resolve-InputPath $workspace $InputPath

    $sourceBytes = [System.IO.File]::ReadAllBytes($resolvedInput)
    if ($sourceBytes.LongLength -gt 67108864) { throw 'Input image exceeds the 64 MiB safety limit.' }

    $sourceStream = New-Object System.IO.MemoryStream(,$sourceBytes)
    $sourceImage = $null
    $previewBitmap = $null
    $graphics = $null
    $outputStream = $null

    try {
        $sourceImage = [System.Drawing.Image]::FromStream($sourceStream, $true, $true)
        $scale = [Math]::Min(1.0, [Math]::Min($MaximumWidth / [double]$sourceImage.Width, $MaximumHeight / [double]$sourceImage.Height))
        $targetWidth = [Math]::Max(1, [int][Math]::Round($sourceImage.Width * $scale))
        $targetHeight = [Math]::Max(1, [int][Math]::Round($sourceImage.Height * $scale))

        $previewBitmap = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $graphics = [System.Drawing.Graphics]::FromImage($previewBitmap)
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Black)
        $graphics.DrawImage($sourceImage, 0, 0, $targetWidth, $targetHeight)

        $outputStream = New-Object System.IO.MemoryStream
        $contentType = 'image/jpeg'
        $extension = '.jpg'
        if ($KeepPng) {
            $previewBitmap.Save($outputStream, [System.Drawing.Imaging.ImageFormat]::Png)
            $contentType = 'image/png'
            $extension = '.png'
        }
        else {
            $codec = Get-JpegCodec
            if ($null -eq $codec) { throw 'JPEG encoder is unavailable.' }
            $encoderParameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
            try {
                $encoderParameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$JpegQuality)
                $previewBitmap.Save($outputStream, $codec, $encoderParameters)
            }
            finally {
                if ($null -ne $encoderParameters.Param[0]) { $encoderParameters.Param[0].Dispose() }
                $encoderParameters.Dispose()
            }
        }

        $previewBytes = $outputStream.ToArray()
        $base64 = [System.Convert]::ToBase64String($previewBytes)
        $chunkCount = [int][Math]::Ceiling($base64.Length / [double]$ChunkCharacters)
        $transferId = 'devspace-image-' + [Guid]::NewGuid().ToString('N')
        $prefix = $workspace.TrimEnd([char[]]@(92, 47)) + [System.IO.Path]::DirectorySeparatorChar
        $manifest = [ordered]@{
            schemaVersion = 1
            transferId = $transferId
            workspaceRoot = $workspace
            sourcePath = $resolvedInput.Substring($prefix.Length)
            sourceWidth = $sourceImage.Width
            sourceHeight = $sourceImage.Height
            previewWidth = $targetWidth
            previewHeight = $targetHeight
            contentType = $contentType
            extension = $extension
            decodedBytes = $previewBytes.LongLength
            sha256 = Get-Sha256Hex $previewBytes
            chunkCharacters = $ChunkCharacters
            chunkCount = $chunkCount
        }

        Write-Output 'CHATGPT_IMAGE_TRANSFER_BEGIN'
        Write-Output ('MANIFEST ' + ($manifest | ConvertTo-Json -Compress))
        for ($index = 0; $index -lt $chunkCount; $index++) {
            $start = $index * $ChunkCharacters
            $length = [Math]::Min($ChunkCharacters, $base64.Length - $start)
            Write-Output ('CHUNK {0:D6} {1}' -f $index, $base64.Substring($start, $length))
        }
        Write-Output 'CHATGPT_IMAGE_TRANSFER_END'
    }
    finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $previewBitmap) { $previewBitmap.Dispose() }
        if ($null -ne $sourceImage) { $sourceImage.Dispose() }
        if ($null -ne $sourceStream) { $sourceStream.Dispose() }
        if ($null -ne $outputStream) { $outputStream.Dispose() }
    }
}
catch {
    [Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)
    exit 1
}
