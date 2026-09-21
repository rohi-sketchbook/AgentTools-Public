param(
    [switch]$Vulkan
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $root 'upstream\kimodo.cpp'
$buildRoot = if ($Vulkan) { Join-Path $root 'results\build-vk-vs-official\Release' } else { Join-Path $sourceRoot 'build\windows-release' }
$cpp = Join-Path $root 'scripts\benchmark_kimodo_embedding.cpp'
$outputDir = Join-Path $root 'results\tools'
$outputName = if ($Vulkan) { 'benchmark_kimodo_embedding_vulkan.exe' } else { 'benchmark_kimodo_embedding.exe' }
$outputExe = Join-Path $outputDir $outputName
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'

if (-not (Test-Path $cpp)) { throw "Benchmark source not found: $cpp" }
if (-not (Test-Path (Join-Path $buildRoot 'kimodo.lib'))) { throw "Kimodo build not found: $buildRoot" }

$vcvars = & $vswhere -products * -find 'VC\Auxiliary\Build\vcvars64.bat' | Select-Object -First 1
$cl = & $vswhere -products * -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($vcvars) -or [string]::IsNullOrWhiteSpace($cl)) { throw 'MSVC tools not found.' }

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$includeDir = Join-Path $sourceRoot 'include'
$args = @(
    '/nologo', '/std:c++latest', '/EHsc', '/O2',
    "/I$includeDir",
    $cpp,
    "/Fe:$outputExe",
    "/link", "/LIBPATH:$buildRoot", 'kimodo.lib'
)
$quotedArgs = ($args | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
$command = 'call "{0}" >nul && "{1}" {2}' -f $vcvars, $cl, $quotedArgs
cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw "Benchmark compile failed with exit code $LASTEXITCODE" }
Write-Host "Built: $outputExe"
