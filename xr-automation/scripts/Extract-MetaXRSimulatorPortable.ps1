[CmdletBinding()]
param(
    [string]$MsiPath,
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'AgentTools\MetaXRSimulator\v205.0')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($MsiPath)) {
    $MsiPath = (Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Temp\AgentTools\xr-automation\meta_xr_simulator_205_*.msi') |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1).FullName
}
if (-not (Test-Path -LiteralPath $MsiPath -PathType Leaf)) {
    throw "Meta XR Simulator MSI not found: $MsiPath"
}

$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.OpenDatabase($MsiPath, 0)

function Read-TableRows {
    param([string]$Sql)
    $view = $db.OpenView($Sql)
    $view.Execute()
    $rows = @()
    while ($record = $view.Fetch()) {
        $rows += $record
    }
    return $rows
}

function Get-LongFileName {
    param([string]$FileName)
    if ($FileName -match '\|') {
        return ($FileName -split '\|', 2)[1]
    }
    return $FileName
}

function Resolve-DirectoryPath {
    param(
        [string]$DirectoryId,
        [hashtable]$Directories,
        [hashtable]$Cache
    )
    if ($Cache.ContainsKey($DirectoryId)) { return $Cache[$DirectoryId] }
    if (-not $Directories.ContainsKey($DirectoryId)) { return '' }
    $entry = $Directories[$DirectoryId]
    $name = Get-LongFileName ([string]$entry.Name)
    if ($DirectoryId -eq 'TARGETDIR' -or $name -eq 'SourceDir') {
        $Cache[$DirectoryId] = ''
        return ''
    }
    $parentPath = ''
    if (-not [string]::IsNullOrWhiteSpace([string]$entry.Parent)) {
        $parentPath = Resolve-DirectoryPath -DirectoryId ([string]$entry.Parent) -Directories $Directories -Cache $Cache
    }
    $path = if ([string]::IsNullOrWhiteSpace($parentPath)) { $name } else { Join-Path $parentPath $name }
    $Cache[$DirectoryId] = $path
    return $path
}

$properties = @{}
$view = $db.OpenView("SELECT ``Property``,``Value`` FROM ``Property``")
$view.Execute()
while ($record = $view.Fetch()) {
    $properties[[string]$record.StringData(1)] = [string]$record.StringData(2)
}
if ($properties['ProductName'] -ne 'MetaXRSimulator' -or $properties['Manufacturer'] -notmatch '^Meta Platforms') {
    throw "Unexpected MSI identity: ProductName=$($properties['ProductName']); Manufacturer=$($properties['Manufacturer'])"
}

$directories = @{}
$view = $db.OpenView("SELECT ``Directory``,``Directory_Parent``,``DefaultDir`` FROM ``Directory``")
$view.Execute()
while ($record = $view.Fetch()) {
    $directories[[string]$record.StringData(1)] = [pscustomobject]@{
        Parent = [string]$record.StringData(2)
        Name = [string]$record.StringData(3)
    }
}
$directoryCache = @{}

$componentDirs = @{}
$view = $db.OpenView("SELECT ``Component``,``Directory_`` FROM ``Component``")
$view.Execute()
while ($record = $view.Fetch()) {
    $componentDirs[[string]$record.StringData(1)] = [string]$record.StringData(2)
}

$files = @{}
$view = $db.OpenView("SELECT ``File``,``FileName``,``Component_``,``FileSize`` FROM ``File``")
$view.Execute()
while ($record = $view.Fetch()) {
    $fileId = [string]$record.StringData(1)
    $component = [string]$record.StringData(3)
    $directoryId = $componentDirs[$component]
    $relativeDirectory = Resolve-DirectoryPath -DirectoryId $directoryId -Directories $directories -Cache $directoryCache
    # Strip MSI machine-install roots. The portable image is rooted at Destination.
    $relativeDirectory = $relativeDirectory -replace '^(PFiles\\)?Meta\\MetaXRSimulator\\?', ''
    $relativeDirectory = $relativeDirectory -replace '^MetaXRSimulator\\?', ''
    $files[$fileId] = [pscustomobject]@{
        Name = Get-LongFileName ([string]$record.StringData(2))
        RelativeDirectory = $relativeDirectory
        Size = [int64]$record.IntegerData(4)
    }
}

$work = Join-Path $env:LOCALAPPDATA 'Temp\AgentTools\xr-automation\portable-extract'
$raw = Join-Path $work 'raw'
New-Item -ItemType Directory -Force -Path $Destination,$work,$raw | Out-Null

$media = @()
$view = $db.OpenView("SELECT ``DiskId``,``Cabinet`` FROM ``Media`` ORDER BY ``DiskId``")
$view.Execute()
while ($record = $view.Fetch()) {
    $cabinet = [string]$record.StringData(2)
    if ($cabinet.StartsWith('#')) { $cabinet = $cabinet.Substring(1) }
    $media += $cabinet
}

$latin1 = [System.Text.Encoding]::GetEncoding(28591)
foreach ($cabinet in $media) {
    $cabPath = Join-Path $work $cabinet
    $view = $db.OpenView("SELECT ``Name``,``Data`` FROM ``_Streams``")
    $view.Execute()
    $found = $false
    while ($record = $view.Fetch()) {
        if ([string]$record.StringData(1) -ne $cabinet) { continue }
        $found = $true
        $stream = [System.IO.File]::Open($cabPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            while ($true) {
                $chunk = $record.ReadStream(2, 1048576, 1)
                if ([string]::IsNullOrEmpty($chunk)) { break }
                $bytes = $latin1.GetBytes([string]$chunk)
                $stream.Write($bytes, 0, $bytes.Length)
            }
        }
        finally {
            $stream.Dispose()
        }
        break
    }
    if (-not $found) { throw "Embedded cabinet stream not found: $cabinet" }
    $cabRaw = Join-Path $raw ([System.IO.Path]::GetFileNameWithoutExtension($cabinet))
    New-Item -ItemType Directory -Force -Path $cabRaw | Out-Null
    $expand = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\expand.exe') -ArgumentList @('-F:*', ('"' + $cabPath + '"'), ('"' + $cabRaw + '"')) -Wait -PassThru -WindowStyle Hidden
    if ($expand.ExitCode -ne 0) { throw "expand.exe failed for $cabinet with exit code $($expand.ExitCode)" }
}

$copied = 0
$missing = @()
foreach ($entry in $files.GetEnumerator()) {
    $fileId = $entry.Key
    $metadata = $entry.Value
    $source = $null
    foreach ($cabinet in $media) {
        $candidate = Join-Path (Join-Path $raw ([System.IO.Path]::GetFileNameWithoutExtension($cabinet))) $fileId
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $source = $candidate
            break
        }
    }
    if ($null -eq $source) {
        $missing += $fileId
        continue
    }
    $targetDir = if ([string]::IsNullOrWhiteSpace([string]$metadata.RelativeDirectory)) { $Destination } else { Join-Path $Destination $metadata.RelativeDirectory }
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $targetDir $metadata.Name) -Force
    $copied++
}

$runtime = Get-ChildItem -LiteralPath $Destination -Filter 'meta_openxr_simulator.json' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
$exe = Get-ChildItem -LiteralPath $Destination -Filter 'MetaXRSimulator.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

[pscustomobject]@{
    ok = ($null -ne $runtime -and $null -ne $exe -and $missing.Count -eq 0)
    productVersion = $properties['ProductVersion']
    destination = $Destination
    copiedFiles = $copied
    expectedFiles = $files.Count
    missingFiles = $missing
    runtimeJson = if ($null -ne $runtime) { $runtime.FullName } else { $null }
    executable = if ($null -ne $exe) { $exe.FullName } else { $null }
} | ConvertTo-Json -Depth 5
