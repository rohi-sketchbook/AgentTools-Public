[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'AgentTools Control Center Tunnel.lnk'

if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Cloudflare Tunnel startup shortcut removed: $shortcutPath"
} else {
    Write-Host "Cloudflare Tunnel startup shortcut is not installed."
}
