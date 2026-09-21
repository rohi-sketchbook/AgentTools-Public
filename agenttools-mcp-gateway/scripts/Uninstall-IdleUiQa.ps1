param(
    [string]$TaskName = 'AgentTools-IdleUiQA'
)

$ErrorActionPreference = 'Stop'
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $Task) {
    Write-Output "Scheduled Task not installed: $TaskName"
    exit 0
}
if ($Task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Start-Sleep -Milliseconds 300
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Removed Scheduled Task: $TaskName"
