param(
    [int]$Frames = 30,
    [int]$Steps = 1,
    [int]$Repeats = 1,
    [switch]$Cpu
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$build = Join-Path $root 'results\build-vk-vs-official'
$exe = Join-Path $root 'results\tools\benchmark_kimodo_embedding_vulkan.exe'
$model = Join-Path $root 'models\kimodo-smplx-rp-v1-ggml\models\kimodo-smplx-rp-v1-f32.gguf'

if (-not (Test-Path $exe)) { throw "Benchmark executable not found: $exe" }
if (-not (Test-Path $model)) { throw "Motion GGUF not found: $model" }

$release = Join-Path $build 'Release'
$binRelease = Join-Path $build 'bin\Release'
$env:PATH = "$release;$binRelease;$env:PATH"
if ($Cpu) {
    $env:KIMODO_BACKEND = 'cpu'
} else {
    Remove-Item Env:KIMODO_BACKEND -ErrorAction SilentlyContinue
}

Write-Host "backend=$([string]::Join('', $(if ($Cpu) { 'cpu' } else { 'vulkan' }))) frames=$Frames steps=$Steps repeats=$Repeats"
& $exe $model $Frames $Steps $Repeats
if ($LASTEXITCODE -ne 0) { throw "Kimodo benchmark failed with exit code $LASTEXITCODE" }
