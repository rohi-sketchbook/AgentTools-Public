[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'dist\AgentToolsControlCenter.Web.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Release build is required first: $exe"
}

$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'AgentTools Control Center Web.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = Join-Path $root 'dist'
$shortcut.Description = 'Read-only AgentTools Control Center web dashboard on 127.0.0.1'
$shortcut.Save()

Write-Host "Web dashboard startup shortcut installed: $shortcutPath"
