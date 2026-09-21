[CmdletBinding()]
param(
    [string]$ConfigPath = "$env:USERPROFILE\.cloudflared\agenttools-control-center.yml"
)

$ErrorActionPreference = 'Stop'

$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Cloudflare Tunnel config was not found: $ConfigPath`nCreate it from cloudflare\config.example.yml after configuring Tunnel + Access."
}

& $cloudflared tunnel --config $ConfigPath ingress validate
if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare Tunnel ingress validation failed."
}

Write-Host "Starting Cloudflare Tunnel with protected local origin http://127.0.0.1:47832"
& $cloudflared tunnel --config $ConfigPath run
exit $LASTEXITCODE
