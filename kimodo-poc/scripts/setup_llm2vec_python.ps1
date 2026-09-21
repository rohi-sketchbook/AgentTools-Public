param(
    [string]$Python = 'python',
    [string]$TorchVersion = '2.11.0',
    [string]$TorchIndexUrl = 'https://download.pytorch.org/whl/cu130'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$venv = Join-Path $root '.venv-llm2vec'
$venvPython = Join-Path $venv 'Scripts\python.exe'

& $Python -c "import sys; assert (3,10) <= sys.version_info[:2] < (3,13), sys.version; print(sys.version)"
if ($LASTEXITCODE -ne 0) { throw 'Use CPython 3.10 through 3.12.' }
if (-not (Test-Path $venvPython)) {
    & $Python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create teacher venv.' }
}

$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
& $venvPython -m pip install --only-binary=:all: "torch==$TorchVersion" --index-url $TorchIndexUrl
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
& $venvPython -m pip install --only-binary=:all: bitsandbytes==0.50.1
if ($LASTEXITCODE -ne 0) { throw 'bitsandbytes installation failed.' }
& $venvPython -m pip install llm2vec==0.2.3
if ($LASTEXITCODE -ne 0) { throw 'llm2vec installation failed.' }
& $venvPython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Teacher venv dependency check failed.' }

& $venvPython -c "import torch, bitsandbytes, transformers; print('torch=',torch.__version__); print('cuda=',torch.version.cuda); print('gpu=',torch.cuda.get_device_name(0) if torch.cuda.is_available() else None); print('bitsandbytes=',bitsandbytes.__version__); print('transformers=',transformers.__version__)"
if ($LASTEXITCODE -ne 0) { throw 'Teacher venv verification failed.' }
Write-Host "Teacher environment ready: $venvPython"
