[CmdletBinding()]
param(
    [int]$SdkVersion = 205,
    [string]$ExistingInstaller,
    [switch]$Passive
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$AppId = '28549923061320041'
$DownloadUrl = "https://www.facebook.com/horizon_devcenter_download?app_id=$AppId&sdk_version=$SdkVersion"
$CacheRoot = Join-Path $env:TEMP 'AgentTools\xr-automation'
$InstallerPath = if ([string]::IsNullOrWhiteSpace($ExistingInstaller)) {
    Join-Path $CacheRoot ("meta_xr_simulator_{0}_{1}.msi" -f $SdkVersion, [guid]::NewGuid().ToString('N'))
}
else {
    [System.IO.Path]::GetFullPath($ExistingInstaller)
}
$ProtocolKey = 'HKCU:\SOFTWARE\Classes\xrsim\shell\open\command'
$MachineProtocolKey = 'HKLM:\SOFTWARE\Classes\xrsim\shell\open\command'

function Get-XRSimulatorInstallState {
    foreach ($keyPath in @($ProtocolKey, $MachineProtocolKey)) {
        if (-not (Test-Path -LiteralPath $keyPath)) { continue }
        try {
            $command = (Get-Item -LiteralPath $keyPath).GetValue('')
            if ([string]::IsNullOrWhiteSpace([string]$command)) { continue }
            $match = [regex]::Match([string]$command, '^\s*"(?<path>[^"]+)"|^\s*(?<path>.+?\.exe)\s')
            if (-not $match.Success) { continue }
            $exe = $match.Groups['path'].Value
            if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { continue }
            $installDir = Split-Path -Parent $exe
            $runtimeJson = Join-Path $installDir 'meta_openxr_simulator.json'
            return [pscustomobject]@{
                installed = $true
                executable = $exe
                installDirectory = $installDir
                runtimeJson = $runtimeJson
                runtimeJsonPresent = Test-Path -LiteralPath $runtimeJson -PathType Leaf
            }
        }
        catch {
            continue
        }
    }

    return [pscustomobject]@{
        installed = $false
        executable = $null
        installDirectory = $null
        runtimeJson = $null
        runtimeJsonPresent = $false
    }
}

$before = Get-XRSimulatorInstallState
if ($before.installed -and $before.runtimeJsonPresent) {
    [pscustomobject]@{
        ok = $true
        alreadyInstalled = $true
        state = $before
    } | ConvertTo-Json -Depth 5
    exit 0
}

New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($ExistingInstaller)) {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -eq $curl) {
        throw 'curl.exe was not found.'
    }
    & $curl.Source --location --fail --silent --show-error --output $InstallerPath $DownloadUrl
    if ($LASTEXITCODE -ne 0) {
        throw "Meta XR Simulator download failed with curl exit code $LASTEXITCODE."
    }
}
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw 'Meta XR Simulator installer download did not produce a file.'
}

$file = Get-Item -LiteralPath $InstallerPath
if ($file.Length -lt 100MB) {
    throw "Downloaded Meta XR Simulator installer is unexpectedly small: $($file.Length) bytes"
}

$installerCom = New-Object -ComObject WindowsInstaller.Installer
$database = $installerCom.OpenDatabase($InstallerPath, 0)
$view = $database.OpenView('SELECT `Property`,`Value` FROM `Property`')
$view.Execute()
$properties = @{}
$wantedProperties = @('ProductName', 'Manufacturer', 'ProductVersion', 'ProductCode')
while ($record = $view.Fetch()) {
    $propertyName = [string]$record.StringData(1)
    if ($wantedProperties -contains $propertyName) {
        $properties[$propertyName] = [string]$record.StringData(2)
    }
}
$productName = [string]$properties['ProductName']
$manufacturer = [string]$properties['Manufacturer']
$productVersion = [string]$properties['ProductVersion']
if ([string]::IsNullOrWhiteSpace($productName) -or $productName -notmatch 'Meta.*XR.*Simulator') {
    throw "Downloaded MSI ProductName was unexpected: $productName"
}
if ([string]::IsNullOrWhiteSpace($manufacturer) -or $manufacturer -notmatch 'Meta|Facebook') {
    throw "Downloaded MSI Manufacturer was unexpected: $manufacturer"
}

$signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
$signerSubject = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and $signerSubject -notmatch 'Meta|Facebook') {
    throw "Meta XR Simulator installer signer was unexpected: $signerSubject"
}

$arguments = @('/i', ('"' + $InstallerPath + '"'), '/norestart')
if ($Passive) {
    $arguments += '/passive'
}

$process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -PassThru -Wait
if ($process.ExitCode -notin @(0, 3010)) {
    throw "Meta XR Simulator installer exited with code $($process.ExitCode)."
}

$after = Get-XRSimulatorInstallState
if (-not $after.installed -or -not $after.runtimeJsonPresent) {
    throw 'Meta XR Simulator installer completed, but xrsim registration/runtime JSON was not detected.'
}

[pscustomobject]@{
    ok = $true
    alreadyInstalled = $false
    installer = $InstallerPath
    productName = $productName
    manufacturer = $manufacturer
    productVersion = $productVersion
    signatureStatus = $signature.Status.ToString()
    signer = $signerSubject
    exitCode = $process.ExitCode
    rebootRequired = $process.ExitCode -eq 3010
    state = $after
} | ConvertTo-Json -Depth 6
