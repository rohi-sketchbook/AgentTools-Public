param(
    [string]$Version = '1.4.357.0'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$downloads = Join-Path $root 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

$fileName = "vulkansdk-windows-X64-$Version.exe"
$url = "https://sdk.lunarg.com/sdk/download/$Version/windows/$fileName"
$destination = Join-Path $downloads $fileName
$temp = "$destination.$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')).download"
$expectedSha256 = '81f474711e9042f4cd22b31b2f7a8870db2e428b21586fb43dd80150be97310d'

if (Test-Path $destination) {
    $existingHash = (Get-FileHash -Algorithm SHA256 -Path $destination).Hash.ToLowerInvariant()
    if ($existingHash -eq $expectedSha256) {
        Write-Host "Using already verified installer: $destination"
    } else {
        throw "Existing installer hash mismatch: $existingHash"
    }
} else {
    Write-Host "Downloading from LunarG official SDK endpoint: $url"
    Invoke-WebRequest -Uri $url -OutFile $temp -UseBasicParsing
    $hash = (Get-FileHash -Algorithm SHA256 -Path $temp).Hash.ToLowerInvariant()
    if ($hash -ne $expectedSha256) {
        throw "Vulkan SDK SHA256 mismatch. expected=$expectedSha256 actual=$hash"
    }
    Move-Item -LiteralPath $temp -Destination $destination
}

$hash = (Get-FileHash -Algorithm SHA256 -Path $destination).Hash.ToLowerInvariant()
Write-Host "SHA256 OK: $hash"

$signature = Get-AuthenticodeSignature -FilePath $destination
if ($signature.Status -ne 'Valid') {
    throw "Authenticode signature is not valid: $($signature.Status)"
}
Write-Host "Authenticode OK: $($signature.SignerCertificate.Subject)"

if (Get-Command Start-MpScan -ErrorAction SilentlyContinue) {
    Write-Host 'Running Microsoft Defender custom scan on installer...'
    Start-MpScan -ScanType CustomScan -ScanPath $destination
    $detections = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object {
        $_.Resources -and ($_.Resources -contains $destination -or ($_.Resources -join ';') -like "*$fileName*")
    })
    if ($detections.Count -gt 0) {
        throw "Microsoft Defender reported $($detections.Count) detection(s) for the Vulkan SDK installer."
    }
    Write-Host 'Microsoft Defender scan completed with no matching detection.'
} else {
    Write-Warning 'Microsoft Defender PowerShell cmdlets are unavailable; installer was not Defender-scanned by this script.'
}

Write-Host "Verified installer ready: $destination"
