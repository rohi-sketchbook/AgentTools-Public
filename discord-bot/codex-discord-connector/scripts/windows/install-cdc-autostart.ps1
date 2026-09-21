[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$bridgeInstaller = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\discord-codex-bridge\install-localized-bot-autostart.ps1"))

if (-not (Test-Path -LiteralPath $bridgeInstaller)) {
    throw "Discord bridge autostart installer was not found: $bridgeInstaller"
}

& $bridgeInstaller
exit $LASTEXITCODE
