param(
    [string]$Revision = '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $root '.venv\Scripts\python.exe'
$modelDir = Join-Path $root 'models\qwen3-embedding-0.6b'
$expectedModelSha256 = '0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd'

if (-not (Test-Path $python)) {
    throw 'Python environment not found. Run setup_python.ps1 first.'
}
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

Write-Host "Downloading Qwen/Qwen3-Embedding-0.6B at pinned revision $Revision"
& $python -m huggingface_hub.commands.huggingface_cli download Qwen/Qwen3-Embedding-0.6B --revision $Revision --local-dir $modelDir
if ($LASTEXITCODE -ne 0) {
    # huggingface_hub 1.x primarily exposes the `hf` entry point; fall back to it if present.
    $hf = Join-Path $root '.venv\Scripts\hf.exe'
    if (-not (Test-Path $hf)) { throw 'Hugging Face download command failed and hf.exe was not found.' }
    & $hf download Qwen/Qwen3-Embedding-0.6B --revision $Revision --local-dir $modelDir
    if ($LASTEXITCODE -ne 0) { throw "Qwen model download failed with exit code $LASTEXITCODE" }
}

$modelFile = Join-Path $modelDir 'model.safetensors'
if (-not (Test-Path $modelFile)) { throw "model.safetensors not found after download: $modelFile" }
$hash = (Get-FileHash -Algorithm SHA256 -Path $modelFile).Hash.ToLowerInvariant()
if ($hash -ne $expectedModelSha256) {
    throw "Qwen model SHA256 mismatch. expected=$expectedModelSha256 actual=$hash"
}
Write-Host "Qwen model SHA256 OK: $hash"

$pythonFiles = @(Get-ChildItem -Path $modelDir -Recurse -File -Include *.py,*.pyd,*.dll,*.exe)
if ($pythonFiles.Count -gt 0) {
    $list = ($pythonFiles | ForEach-Object FullName) -join [Environment]::NewLine
    throw "Executable/code files unexpectedly present in model snapshot:`n$list"
}
Write-Host 'No executable/Python code files found in the downloaded model snapshot.'
Write-Host "Model ready: $modelDir"
