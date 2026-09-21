[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'AgentTools Control Center Web.lnk'

if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Web dashboard startup shortcut removed: $shortcutPath"
} else {
    Write-Host "Web dashboard startup shortcut is not installed."
}
