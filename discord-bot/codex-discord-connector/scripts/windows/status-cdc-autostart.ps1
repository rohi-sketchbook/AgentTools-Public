[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$bridgeStatus = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\discord-codex-bridge\status-localized-bot-autostart.ps1"))

if (-not (Test-Path -LiteralPath $bridgeStatus)) {
    throw "Discord bridge autostart status script was not found: $bridgeStatus"
}

& $bridgeStatus
exit $LASTEXITCODE
