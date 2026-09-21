[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $root 'Start-AgentTools-Tunnel.ps1'
$secretPath = Join-Path $env:LOCALAPPDATA 'AgentTools\secrets\cloudflare-agenttools-tunnel.dpapi'

if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "AgentTools Tunnel start script was not found: $startScript"
}
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "AgentTools Tunnel token is not registered: $secretPath"
}

$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'AgentTools Control Center Tunnel.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'AgentTools Control Center Cloudflare Tunnel (separate from DevSpace cloudflared service)'
$shortcut.Save()

Write-Host "AgentTools Tunnel startup shortcut installed: $shortcutPath"
Write-Host 'Existing Cloudflared Windows services were not modified.'
