param(
    [string]$Repository = 'https://github.com/localai-org/kimodo.cpp',
    [string]$Ref = 'main'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$upstreamRoot = Join-Path $root 'upstream'
$kimodo = Join-Path $upstreamRoot 'kimodo.cpp'
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { throw 'git.exe was not found. Install Git for Windows or put git on PATH, then retry.' }

New-Item -ItemType Directory -Force -Path $upstreamRoot | Out-Null
if (Test-Path $kimodo) {
    if (-not (Test-Path (Join-Path $kimodo '.git'))) {
        throw "Refusing to overwrite existing non-Git directory: $kimodo"
    }
    Write-Host 'kimodo.cpp checkout already exists; leaving it unchanged.'
    Write-Host 'To update it intentionally, use Git inside upstream\kimodo.cpp.'
    exit 0
}

# This obtains source code and its pinned GGML submodule only. It never fetches model weights.
# Git for Windows on this machine can fail with schannel SEC_E_NO_CREDENTIALS.
# Use OpenSSL only for this invocation; do not change the user's global Git config.
& $git.Source -c http.sslBackend=openssl clone --branch $Ref --single-branch --recurse-submodules $Repository $kimodo
if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }
& $git.Source -C $kimodo rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Could not determine the cloned revision (exit code $LASTEXITCODE)" }
Write-Host "kimodo.cpp: $kimodo"
