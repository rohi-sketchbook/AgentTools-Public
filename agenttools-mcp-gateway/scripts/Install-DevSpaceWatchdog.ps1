param(
    [string]$TaskName = 'AgentTools-DevSpaceWatchdog'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$WatchdogScript = Join-Path $Root 'scripts\devspace-watchdog.js'
$HiddenRunner = Join-Path $Root 'scripts\Run-HiddenNode.vbs'
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $WatchdogScript -PathType Leaf)) {
    throw "Watchdog script not found: $WatchdogScript"
}
if (-not (Test-Path -LiteralPath $HiddenRunner -PathType Leaf)) {
    throw "Hidden Node runner not found: $HiddenRunner"
}

$Action = New-ScheduledTaskAction `
    -Execute $WScript `
    -Argument ('//B //NoLogo "{0}" "{1}" "{2}" "{3}"' -f $HiddenRunner, $Node, $WatchdogScript, $Root) `
    -WorkingDirectory $Root

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

function Stop-OwnedWatchdogProcess {
    $LockFile = Join-Path $Root 'state\devspace\watchdog.lock'
    if (-not (Test-Path -LiteralPath $LockFile -PathType Leaf)) { return }

    try {
        $Lock = Get-Content -LiteralPath $LockFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $WatchdogPid = [int]$Lock.pid
    }
    catch {
        return
    }
    if ($WatchdogPid -le 0) { return }

    $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $WatchdogPid" -ErrorAction SilentlyContinue
    if ($null -eq $Process) { return }
    $CommandLine = [string]$Process.CommandLine
    $IsExpectedNode = [string]::Equals([string]$Process.Name, 'node.exe', [System.StringComparison]::OrdinalIgnoreCase)
    $OwnsWatchdogScript = $CommandLine.IndexOf($WatchdogScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $IsExpectedNode -or -not $OwnsWatchdogScript) {
        throw "Refusing to stop PID $WatchdogPid because it is not the registered DevSpace Watchdog process."
    }

    Stop-Process -Id $WatchdogPid -Force -ErrorAction Stop
    for ($Attempt = 0; $Attempt -lt 20; $Attempt += 1) {
        Start-Sleep -Milliseconds 100
        if ($null -eq (Get-Process -Id $WatchdogPid -ErrorAction SilentlyContinue)) { return }
    }
    throw "Watchdog PID $WatchdogPid did not exit during reload."
}

$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $ExistingTask -and $ExistingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Start-Sleep -Milliseconds 500
}
# Run-HiddenNode.vbs launches Node detached from the Scheduled Task host, so
# Stop-ScheduledTask alone may leave the previous watchdog alive. Only stop
# the PID recorded by our lock after verifying its exact watchdog command line.
Stop-OwnedWatchdogProcess

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description 'Monitors local DevSpace health and performs guarded self-recovery independently of ChatGPT.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
    TaskName = $TaskName
    State = $Task.State
    LastRunTime = $Info.LastRunTime
    LastTaskResult = $Info.LastTaskResult
    WScript = $WScript
    Node = $Node
    HiddenRunner = $HiddenRunner
    WatchdogScript = $WatchdogScript
} | Format-List
