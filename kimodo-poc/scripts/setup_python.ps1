param(
    [string]$Python = 'python',
    [string]$TorchVersion = '2.11.0',
    [string]$TorchIndexUrl = 'https://download.pytorch.org/whl/cu130'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$venv = Join-Path $root '.venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'

if ($Python -eq 'python' -and -not (Get-Command python.exe -ErrorAction SilentlyContinue)) {
    throw 'python.exe is not on PATH. Rerun with -Python C:\full\path\to\python.exe after check_env.ps1 identifies it.'
}
& $Python -c "import sys; assert sys.version_info >= (3, 10) and sys.version_info < (3, 13), sys.version; print(sys.version)"
if ($LASTEXITCODE -ne 0) { throw 'Use CPython 3.10 through 3.12 for this PoC.' }
if (-not (Test-Path $venvPython)) {
    & $Python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the virtual environment.' }
}

$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
& $venvPython -m pip install --only-binary=:all: "torch==$TorchVersion" --index-url $TorchIndexUrl
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
& $venvPython -m pip install --only-binary=:all: -r (Join-Path $root 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
& $venvPython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'pip dependency check failed.' }

Write-Host '=== Python GPU check ==='
& $venvPython -c "import torch; print('torch=', torch.__version__); print('cuda=', torch.version.cuda); print('available=', torch.cuda.is_available()); print('device=', torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)"
if ($LASTEXITCODE -ne 0) { throw 'PyTorch verification failed.' }
Write-Host "Environment ready: $venvPython"
