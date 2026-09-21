[CmdletBinding()]
param(
    [string]$TaskName = $env:AGENTTOOLS_DISCORD_TASK_NAME
)

if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = "AgentTools-DiscordBot" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Output "Task: not installed"
    exit 0
}

Write-Output "Task: installed"
Write-Output "TaskName: $TaskName"
Write-Output "TaskState: $($task.State)"
$task.Actions | ForEach-Object {
    Write-Output "Execute: $($_.Execute)"
    Write-Output "Arguments: $($_.Arguments)"
    Write-Output "WorkingDirectory: $($_.WorkingDirectory)"
}

try {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    Write-Output "LastRunTime: $($info.LastRunTime)"
    Write-Output "LastTaskResult: $($info.LastTaskResult)"
}
catch {
    Write-Output "TaskInfo: unavailable"
}

$nodeProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and $_.CommandLine -like "*apps/discord-bot/src/index.ts*"
}
if ($nodeProcesses) {
    $nodeProcesses | ForEach-Object {
        Write-Output "BotProcess: PID=$($_.ProcessId) ParentPID=$($_.ParentProcessId)"
    }
}
else {
    Write-Output "BotProcess: not found"
}
