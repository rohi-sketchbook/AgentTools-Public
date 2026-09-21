param(
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release',
    [switch]$CpuOnly
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'upstream\kimodo.cpp'
$build = Join-Path $source (Join-Path 'build' ("windows-{0}" -f $Configuration.ToLowerInvariant()))
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'

function Find-VsTool([string]$Pattern) {
    $result = & $vswhere -products * -find $Pattern | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($result)) { return $null }
    return $result.Trim()
}

if (-not (Test-Path (Join-Path $source 'CMakeLists.txt'))) {
    throw 'kimodo.cpp source not found. Run fetch_upstream.ps1 first.'
}
if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found: $vswhere" }

$cmake = Find-VsTool 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
$ninja = Find-VsTool 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
$vcvars = Find-VsTool 'VC\Auxiliary\Build\vcvars64.bat'
if (-not $cmake) { throw 'CMake bundled with Visual Studio was not found.' }
if (-not $ninja) { throw 'Ninja bundled with Visual Studio was not found.' }
if (-not $vcvars) { throw 'vcvars64.bat was not found.' }

$enableVulkan = -not $CpuOnly
if ($enableVulkan) {
    $glslc = Get-Command glslc.exe -ErrorAction SilentlyContinue
    if (-not $glslc -and $env:VULKAN_SDK) {
        $candidate = Join-Path $env:VULKAN_SDK 'Bin\glslc.exe'
        if (Test-Path $candidate) { $glslc = Get-Item $candidate }
    }
    if (-not $glslc) {
        throw 'Vulkan SDK/glslc not found. No installer was run. Install the SDK manually, then rerun; use -CpuOnly only for an upstream-supported CPU configuration.'
    }
}

# Current upstream exposes KIMODO_ENABLE_VULKAN; it forwards that setting to GGML_VULKAN.
$cmakeArgs = @(
    '-S', $source, '-B', $build, '-G', 'Ninja',
    "-DCMAKE_MAKE_PROGRAM=$ninja",
    "-DCMAKE_BUILD_TYPE=$Configuration",
    "-DKIMODO_ENABLE_VULKAN=$($enableVulkan.ToString().ToUpperInvariant())",
    '-DKIMODO_BUILD_TESTS=OFF',
    '-DGGML_BUILD_TESTS=OFF',
    '-DGGML_BUILD_EXAMPLES=OFF',
    '-DGGML_RPC=OFF',
    '-DGGML_VIRTGPU=OFF',
    '-DGGML_VIRTGPU_BACKEND=OFF',
    '-DGGML_BACKEND_DL=OFF'
)
$argumentText = ($cmakeArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
$targetArgs = if ($CpuOnly) { ' --target kimodo kmd-generate kmd-inspect' } else { '' }
$command = 'call "{0}" && "{1}" {2} && "{1}" --build "{3}" --config {4}{5}' -f $vcvars, $cmake, $argumentText, $build, $Configuration, $targetArgs

Write-Host "Configuring $Configuration build (Vulkan: $enableVulkan)"
cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw "kimodo.cpp build failed with exit code $LASTEXITCODE" }
Write-Host "Build complete: $build"
