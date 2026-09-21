[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$clipboard = Get-Clipboard -Raw
if ([string]::IsNullOrWhiteSpace($clipboard)) {
    throw 'Clipboard is empty. Copy the Cloudflare Windows connector command first.'
}

$match = [regex]::Match($clipboard, '(?i)service\s+install\s+(?<token>\S+)')
if (-not $match.Success) {
    throw 'Clipboard does not contain a Cloudflare service install connector command.'
}

$token = $match.Groups['token'].Value.Trim('"', "'")
if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Cloudflare Tunnel token was not found.'
}

$secretRoot = Join-Path $env:LOCALAPPDATA 'AgentTools\secrets'
$secretPath = Join-Path $secretRoot 'cloudflare-agenttools-tunnel.dpapi'
New-Item -ItemType Directory -Path $secretRoot -Force | Out-Null

$secure = ConvertTo-SecureString $token -AsPlainText -Force
$encrypted = ConvertFrom-SecureString $secure
[IO.File]::WriteAllText($secretPath, $encrypted, [Text.UTF8Encoding]::new($false))

try { Set-Clipboard -Value '' } catch { }
$token = $null
$clipboard = $null

Write-Host "AgentTools Tunnel token stored with Windows DPAPI: $secretPath"
