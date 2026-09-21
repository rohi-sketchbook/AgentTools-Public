[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'AgentTools Control Center.lnk'

if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Startup shortcut removed: $shortcutPath"
} else {
    Write-Host "Startup shortcut is not installed: $shortcutPath"
}
