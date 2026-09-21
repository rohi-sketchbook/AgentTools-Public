$ErrorActionPreference = 'Continue'

function Write-Check($Name, $Ok, $Value) {
    $status = if ($Ok) { 'OK' } else { 'MISSING' }
    Write-Host ("[{0}] {1}: {2}" -f $status, $Name, $Value)
}

Write-Host '=== Kimodo PoC environment check ==='

function Find-Python {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) { return $launcher.Source }
    foreach ($key in @('HKCU:\SOFTWARE\Python\PythonCore\3.12\InstallPath', 'HKLM:\SOFTWARE\Python\PythonCore\3.12\InstallPath')) {
        try {
            $path = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
            $candidate = Join-Path $path 'python.exe'
            if (Test-Path $candidate) { return $candidate }
        } catch { }
    }
    return $null
}
$python = Find-Python
Write-Check 'Python 3.12' ($null -ne $python) $(if ($python) { & $python --version 2>&1 } else { 'not found on PATH, py launcher, or standard registry key' })

$nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidiaSmi) {
    $gpu = & $nvidiaSmi.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>&1
    Write-Check 'NVIDIA GPU' $true $gpu
} else {
    Write-Check 'NVIDIA GPU' $false 'nvidia-smi not found'
}

$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
    $cl = & $vswhere -products * -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
    $cmake = & $vswhere -products * -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' | Select-Object -First 1
    $ninja = & $vswhere -products * -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe' | Select-Object -First 1
    $vcvars = & $vswhere -products * -find 'VC\Auxiliary\Build\vcvars64.bat' | Select-Object -First 1
    Write-Check 'MSVC cl.exe' (![string]::IsNullOrWhiteSpace($cl)) $cl
    Write-Check 'Visual Studio CMake' (![string]::IsNullOrWhiteSpace($cmake)) $cmake
    Write-Check 'Visual Studio Ninja' (![string]::IsNullOrWhiteSpace($ninja)) $ninja
    Write-Check 'vcvars64.bat' (![string]::IsNullOrWhiteSpace($vcvars)) $vcvars
} else {
    Write-Check 'vswhere' $false $vswhere
}

$vulkanInfo = Get-Command vulkaninfo.exe -ErrorAction SilentlyContinue
Write-Check 'Vulkan runtime' ($null -ne $vulkanInfo) $(if ($vulkanInfo) { $vulkanInfo.Source } else { 'vulkaninfo not found' })

$glslc = Get-Command glslc.exe -ErrorAction SilentlyContinue
if (-not $glslc -and $env:VULKAN_SDK) {
    $candidate = Join-Path $env:VULKAN_SDK 'Bin\glslc.exe'
    if (Test-Path $candidate) { $glslc = Get-Item $candidate }
}
Write-Check 'Vulkan SDK / glslc' ($null -ne $glslc) $(if ($glslc) { $glslc.FullName } else { 'SDK not found; Vulkan runtime alone is insufficient for GGML Vulkan build' })

$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$driveRoot = [IO.Path]::GetPathRoot($rootPath)
try {
    $drive = [IO.DriveInfo]::new($driveRoot)
    $freeGb = [Math]::Round($drive.AvailableFreeSpace / 1GB, 1)
    Write-Check 'Free disk space' ($freeGb -ge 25) ("{0} GB free" -f $freeGb)
} catch { Write-Check 'Free disk space' $false "could not query $driveRoot" }

Write-Host ''
Write-Host 'Recommended: at least 25 GB free before downloading baseline weights and caches.'
