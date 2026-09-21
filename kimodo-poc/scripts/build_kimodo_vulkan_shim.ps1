$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'upstream\kimodo.cpp'
$build = Join-Path $root 'results\build-vk-safe'
$shim = Join-Path $root 'results\vulkan-shim\vulkan-1.lib'
$spirvConfigDir = Join-Path $root 'results\vulkan-shim\spirv-headers-config'
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'

if (-not (Test-Path $shim)) { throw 'Vulkan shim library not found. Run build_vulkan_shim.ps1 first.' }
if (-not (Test-Path (Join-Path $spirvConfigDir 'SPIRV-HeadersConfig.cmake'))) { throw 'SPIRV-Headers shim config not found. Run build_vulkan_shim.ps1 first.' }
$cmake = & $vswhere -products * -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' | Select-Object -First 1
$ninja = & $vswhere -products * -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe' | Select-Object -First 1
$vcvars = & $vswhere -products * -find 'VC\Auxiliary\Build\vcvars64.bat' | Select-Object -First 1
if (-not $cmake -or -not $ninja -or -not $vcvars) { throw 'Visual Studio build tools not found.' }

$unityRoot = 'C:\Program Files\Unity\Hub\Editor'
$glslc = Get-ChildItem $unityRoot -Filter glslc.exe -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*AndroidPlayer*NDK*shader-tools*windows-x86_64*' } |
    Sort-Object FullName -Descending | Select-Object -First 1
$header = Get-ChildItem $unityRoot -Filter vulkan.h -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*AndroidPlayer*NDK*sysroot*usr*include*vulkan*vulkan.h' } |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $glslc -or -not $header) { throw 'Unity NDK Vulkan tools not found.' }
$includeDir = Split-Path (Split-Path $header.FullName -Parent) -Parent

$cmakeArgs = @(
    '-S', $source, '-B', $build, '-G', 'Ninja',
    "-DCMAKE_MAKE_PROGRAM=$ninja",
    '-DCMAKE_BUILD_TYPE=Release',
    '-DKIMODO_ENABLE_VULKAN=ON',
    '-DKIMODO_BUILD_TESTS=OFF',
    '-DGGML_BUILD_TESTS=OFF',
    '-DGGML_BUILD_EXAMPLES=OFF',
    '-DGGML_RPC=OFF',
    '-DGGML_VIRTGPU=OFF',
    '-DGGML_VIRTGPU_BACKEND=OFF',
    '-DGGML_BACKEND_DL=OFF',
    "-DVulkan_LIBRARY=$shim",
    "-DVulkan_INCLUDE_DIR=$includeDir",
    "-DVulkan_GLSLC_EXECUTABLE=$($glslc.FullName)",
    "-DSPIRV-Headers_DIR=$spirvConfigDir"
)
$windowsSdkBin = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64'
if (-not (Test-Path (Join-Path $windowsSdkBin 'rc.exe'))) { throw "Windows SDK rc.exe not found: $windowsSdkBin" }

# Import the MSVC environment into this PowerShell process instead of relying on
# fragile nested cmd.exe quoting. Only build-related variables are imported.
$envDump = & cmd.exe /d /c "call `"$vcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'vcvars64.bat failed.' }
$wanted = @('PATH','INCLUDE','LIB','LIBPATH','VCINSTALLDIR','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion','UniversalCRTSdkDir','UCRTVersion')
foreach ($line in $envDump) {
    if ($line -match '^([^=]+)=(.*)$' -and $wanted -contains $matches[1]) {
        Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2]
    }
}
$env:PATH = "$windowsSdkBin;$env:PATH"

Write-Host "Vulkan include: $includeDir"
Write-Host "Vulkan glslc: $($glslc.FullName)"
Write-Host "Vulkan import lib: $shim"
& $cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { throw "Kimodo Vulkan configure failed with exit code $LASTEXITCODE" }
& $cmake --build $build --config Release --target kimodo kmd-generate kmd-inspect
if ($LASTEXITCODE -ne 0) { throw "Kimodo Vulkan build failed with exit code $LASTEXITCODE" }
Write-Host "Build complete: $build"
