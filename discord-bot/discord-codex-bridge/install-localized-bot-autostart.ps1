[CmdletBinding()]
param(
    [string]$TaskName = $env:AGENTTOOLS_DISCORD_TASK_NAME
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = "AgentTools-DiscordBot" }

$bridgeRoot = $PSScriptRoot
$discordRoot = Split-Path -Parent $bridgeRoot
$supervisorScript = Join-Path $bridgeRoot "run-localized-bot-supervisor.ps1"
$hiddenLauncher = Join-Path $bridgeRoot "run-localized-bot-hidden.vbs"
$connectorRoot = Join-Path $discordRoot "codex-discord-connector"
$configPath = Join-Path $connectorRoot ".connect\config.json"

if (-not (Test-Path -LiteralPath $supervisorScript)) {
    throw "Supervisor script was not found: $supervisorScript"
}
if (-not (Test-Path -LiteralPath $hiddenLauncher)) {
    throw "Hidden launcher was not found: $hiddenLauncher"
}
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Connector config was not found: $configPath"
}

$token = [Environment]::GetEnvironmentVariable("DISCORD_TOKEN", "User")
if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Windows user environment variable DISCORD_TOKEN is not configured."
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$wscript = "$env:SystemRoot\System32\wscript.exe"
$arguments = "//B //NoLogo `"$hiddenLauncher`" `"$powershell`" `"$supervisorScript`" `"$bridgeRoot`""

$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $bridgeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts Discord Remote Control / ChatGPT Bridge at user logon using the local codex-discord-connector checkout." `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
Write-Output "Installed scheduled task: $TaskName"
Write-Output "Action: $hiddenLauncher -> $supervisorScript"
Write-Output "Connector: $connectorRoot"
Write-Output "User: $userId"
Write-Output "State: $($task.State)"
Write-Output "The currently running bot was not restarted. The new action is used at the next task start/logon."
