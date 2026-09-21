[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Compatibility entry point. Global Skill registration is centralized so this
# Discord-specific installer cannot reintroduce a large Discord block into
# <UserProfile>\.codex\AGENTS.md.
$sharedInstaller = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\install-agenttools-skills.ps1'))

if (-not (Test-Path -LiteralPath $sharedInstaller -PathType Leaf)) {
    throw ('Shared AgentTools installer was not found: ' + $sharedInstaller)
}

& $sharedInstaller
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Output 'DISCORD_AGENT_TOOL_INSTALLED_VIA_SHARED_INSTALLER'
