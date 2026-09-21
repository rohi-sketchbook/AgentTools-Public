[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'dist\AgentToolsControlCenter.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Release build is required first: $exe"
}

$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'AgentTools Control Center.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'DevSpace and AgentTools status monitor'
$shortcut.Save()

Write-Host "Startup shortcut installed: $shortcutPath"
