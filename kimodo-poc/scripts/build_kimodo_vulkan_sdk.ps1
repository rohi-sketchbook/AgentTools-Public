$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'upstream\kimodo.cpp'
$build = Join-Path $root 'results\build-vulkan-nmake'
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$sdkRoot = 'C:\VulkanSDK\1.4.357.0'

if (-not (Test-Path (Join-Path $source 'CMakeLists.txt'))) { throw 'kimodo.cpp source not found.' }
if (-not (Test-Path (Join-Path $sdkRoot 'Bin\glslc.exe'))) { throw "Vulkan SDK not found: $sdkRoot" }

$cmake = & $vswhere -products * -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' | Select-Object -First 1
$ninja = & $vswhere -products * -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe' | Select-Object -First 1
$vcvars = & $vswhere -products * -find 'VC\Auxiliary\Build\vcvars64.bat' | Select-Object -First 1
if (-not $cmake -or -not $ninja -or -not $vcvars) { throw 'Visual Studio build tools not found.' }

$windowsSdkBin = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64'
if (-not (Test-Path (Join-Path $windowsSdkBin 'rc.exe'))) { throw "Windows SDK rc.exe not found: $windowsSdkBin" }

$cmakeArgs = @(
    '-S', $source, '-B', $build, '-G', 'NMake Makefiles',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DKIMODO_ENABLE_VULKAN=ON',
    '-DKIMODO_BUILD_TESTS=OFF',
    '-DGGML_BUILD_TESTS=OFF',
    '-DGGML_BUILD_EXAMPLES=OFF',
    '-DGGML_RPC=OFF',
    '-DGGML_VIRTGPU=OFF',
    '-DGGML_VIRTGPU_BACKEND=OFF',
    '-DGGML_BACKEND_DL=OFF',
    '-DGGML_VULKAN_MSVC_MP=OFF',
    "-DCMAKE_PREFIX_PATH=$sdkRoot"
)
$argumentText = ($cmakeArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
$ninjaDir = Split-Path $ninja -Parent
$command = 'call "{0}" >nul && set "VULKAN_SDK={5}" && set "PATH={6};{7};{5}\Bin;!PATH!" && "{1}" {2} && "{1}" --build "{3}" --config Release --target kimodo kmd-generate kmd-inspect' -f $vcvars, $cmake, $argumentText, $build, 'unused', $sdkRoot, $windowsSdkBin, $ninjaDir

Write-Host "Vulkan SDK: $sdkRoot"
cmd.exe /v:on /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw "Kimodo Vulkan SDK build failed with exit code $LASTEXITCODE" }
Write-Host "Build complete: $build"
