$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'upstream\kimodo.cpp'
$build = Join-Path $root 'results\build-vk-vs-official'
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vulkanSdk = 'C:\VulkanSDK\1.4.357.0'

$glslc = Join-Path $vulkanSdk 'Bin\glslc.exe'
$vulkanLib = Join-Path $vulkanSdk 'Lib\vulkan-1.lib'
$vulkanInclude = Join-Path $vulkanSdk 'Include'
$spirvConfig = Join-Path $vulkanSdk 'Lib\cmake\SPIRV-Headers'

foreach ($required in @($glslc, $vulkanLib, (Join-Path $vulkanInclude 'vulkan\vulkan.h'), (Join-Path $spirvConfig 'SPIRV-HeadersConfig.cmake'))) {
    if (-not (Test-Path $required)) { throw "Required Vulkan SDK file not found: $required" }
}
if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found: $vswhere" }

$cmake = & $vswhere -products * -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' | Select-Object -First 1
$vcvars = & $vswhere -products * -find 'VC\Auxiliary\Build\vcvars64.bat' | Select-Object -First 1
if (-not $cmake -or -not $vcvars) { throw 'Visual Studio build tools not found.' }

# Import the x64 MSVC environment into this process. This avoids nested cmd quoting
# and preserves the compiler/linker paths used by child CMake invocations.
$envDump = & cmd.exe /d /c "call `"$vcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'vcvars64.bat failed.' }
$wanted = @('PATH','INCLUDE','LIB','LIBPATH','VCINSTALLDIR','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion','UniversalCRTSdkDir','UCRTVersion')
foreach ($line in $envDump) {
    if ($line -match '^([^=]+)=(.*)$' -and $wanted -contains $matches[1]) {
        Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2]
    }
}

$env:VULKAN_SDK = $vulkanSdk
$env:PATH = "$(Join-Path $vulkanSdk 'Bin');$env:PATH"

$cmakeArgs = @(
    '-S', $source,
    '-B', $build,
    '-G', 'Visual Studio 17 2022',
    '-A', 'x64',
    '-DKIMODO_ENABLE_VULKAN=ON',
    '-DKIMODO_BUILD_TESTS=OFF',
    '-DGGML_BUILD_TESTS=OFF',
    '-DGGML_BUILD_EXAMPLES=OFF',
    '-DGGML_RPC=OFF',
    '-DGGML_VIRTGPU=OFF',
    '-DGGML_VIRTGPU_BACKEND=OFF',
    '-DGGML_BACKEND_DL=OFF',
    '-DGGML_VULKAN_MSVC_MP=OFF',
    "-DVulkan_LIBRARY=$vulkanLib",
    "-DVulkan_INCLUDE_DIR=$vulkanInclude",
    "-DVulkan_GLSLC_EXECUTABLE=$glslc",
    "-DSPIRV-Headers_DIR=$spirvConfig"
)

Write-Host "Vulkan SDK: $vulkanSdk"
Write-Host "glslc: $(& $glslc --version | Select-Object -First 1)"
& $cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { throw "Kimodo Vulkan configure failed with exit code $LASTEXITCODE" }
& $cmake --build $build --config Release --target kimodo kmd-generate kmd-inspect -- /m:4
if ($LASTEXITCODE -ne 0) { throw "Kimodo Vulkan build failed with exit code $LASTEXITCODE" }

Write-Host "Build complete: $build"
