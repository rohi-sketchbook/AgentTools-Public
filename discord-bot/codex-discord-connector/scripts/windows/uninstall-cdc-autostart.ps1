[CmdletBinding()]
param(
    [string]$TaskName = $env:AGENTTOOLS_DISCORD_TASK_NAME
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = "AgentTools-DiscordBot" }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Output "Scheduled task is not installed: $TaskName"
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Removed scheduled task: $TaskName"
Write-Output "This does not stop an already running supervisor. Use stop-cdc-supervisor.ps1 first when needed."
