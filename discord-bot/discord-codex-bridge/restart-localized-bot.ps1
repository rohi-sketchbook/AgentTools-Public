[CmdletBinding()]
param(
    [string]$TaskName = $env:AGENTTOOLS_DISCORD_TASK_NAME
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = "AgentTools-DiscordBot" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    throw "Scheduled task '$TaskName' is not installed."
}

if ($task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
}

# The scheduled task can already be Ready while the detached supervisor and bot remain alive.
# Stop the supervisor process tree explicitly so the mutex is released and the next start loads new code.
$supervisors = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "powershell.exe" -and
    $_.CommandLine -like "*discord-codex-bridge\run-localized-bot-supervisor.ps1*"
}

foreach ($supervisor in $supervisors) {
    Write-Output "Stopping localized bot supervisor: PID=$($supervisor.ProcessId)"
    & "$env:SystemRoot\System32\taskkill.exe" /PID $supervisor.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to stop localized bot supervisor PID=$($supervisor.ProcessId)."
    }
}

Start-Sleep -Seconds 2

# Stop only the legacy direct launcher. /T also terminates its child bot process.
$directLaunchers = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -match 'bin[\\/]cdc\.js\s+start\s+--direct'
}

foreach ($launcher in $directLaunchers) {
    Write-Output "Stopping legacy direct launcher: PID=$($launcher.ProcessId)"
    & "$env:SystemRoot\System32\taskkill.exe" /PID $launcher.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to stop legacy direct launcher PID=$($launcher.ProcessId)."
    }
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5

$task = Get-ScheduledTask -TaskName $TaskName
$botProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*apps/discord-bot/src/index.ts*"
}

$hookedBot = $botProcesses | Where-Object {
    $_.CommandLine -like "*discord-bot/discord-codex-bridge/jp-hooks.mjs*"
} | Select-Object -First 1

if ($null -eq $hookedBot) {
    $details = if ($botProcesses) {
        ($botProcesses | ForEach-Object { "PID=$($_.ProcessId) CommandLine=$($_.CommandLine)" }) -join [Environment]::NewLine
    }
    else {
        "No Discord bot node process found."
    }

    throw "Bridge-hooked Discord bot did not start.`n$details"
}

Write-Output "TaskState: $($task.State)"
Write-Output "BridgeBot: PID=$($hookedBot.ProcessId) ParentPID=$($hookedBot.ParentProcessId)"
Write-Output "BridgeHook: active"
