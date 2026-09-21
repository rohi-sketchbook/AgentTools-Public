$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $root 'results\vulkan-shim'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$dumpbin = & $vswhere -products * -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' | Select-Object -First 1
$libexe = & $vswhere -products * -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\lib.exe' | Select-Object -First 1
if (-not $dumpbin -or -not $libexe) { throw 'MSVC dumpbin/lib.exe not found.' }

$vulkanDll = 'C:\Windows\System32\vulkan-1.dll'
if (-not (Test-Path $vulkanDll)) { throw "Vulkan runtime DLL not found: $vulkanDll" }

$exports = & $dumpbin /exports $vulkanDll
$names = foreach ($line in $exports) {
    if ($line -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(vk[A-Za-z0-9_]+)\s*$') {
        $matches[1]
    }
}
$names = $names | Sort-Object -Unique
if ($names.Count -lt 200) { throw "Unexpected Vulkan export count: $($names.Count)" }

$def = Join-Path $outDir 'vulkan-1.def'
$lib = Join-Path $outDir 'vulkan-1.lib'
$content = @('LIBRARY vulkan-1', 'EXPORTS') + ($names | ForEach-Object { "    $_" })
Set-Content -Path $def -Value $content -Encoding Ascii
& $libexe "/def:$def" '/machine:x64' "/out:$lib"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $lib)) { throw 'Failed to create vulkan-1.lib.' }

$unityRoot = 'C:\Program Files\Unity\Hub\Editor'
$glslc = Get-ChildItem $unityRoot -Filter glslc.exe -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*AndroidPlayer*NDK*shader-tools*windows-x86_64*' } |
    Sort-Object FullName -Descending | Select-Object -First 1
$header = Get-ChildItem $unityRoot -Filter vulkan.h -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*AndroidPlayer*NDK*sysroot*usr*include*vulkan*vulkan.h' } |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $glslc -or -not $header) { throw 'Unity NDK Vulkan glslc/header not found.' }
$includeDir = Split-Path (Split-Path $header.FullName -Parent) -Parent

$spirvHeader = Get-ChildItem $unityRoot -Filter spirv.hpp -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*spirv-headers*include*spirv*unified1*spirv.hpp' } |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $spirvHeader) { throw 'Unity NDK SPIRV-Headers not found.' }
$spirvInclude = Split-Path (Split-Path (Split-Path $spirvHeader.FullName -Parent) -Parent) -Parent
$spirvConfigDir = Join-Path $outDir 'spirv-headers-config'
New-Item -ItemType Directory -Force -Path $spirvConfigDir | Out-Null
$spirvIncludeCmake = $spirvInclude -replace '\\','/'
$spirvConfig = @(
    'set("SPIRV-Headers_FOUND" TRUE)',
    ('include_directories("{0}")' -f $spirvIncludeCmake)
)
Set-Content -Path (Join-Path $spirvConfigDir 'SPIRV-HeadersConfig.cmake') -Value $spirvConfig -Encoding Ascii

Write-Host "VULKAN_LIBRARY=$lib"
Write-Host "VULKAN_INCLUDE_DIR=$includeDir"
Write-Host "VULKAN_GLSLC=$($glslc.FullName)"
Write-Host "SPIRV_HEADERS_DIR=$spirvConfigDir"
Write-Host "SPIRV_INCLUDE_DIR=$spirvInclude"
Write-Host "EXPORT_COUNT=$($names.Count)"
