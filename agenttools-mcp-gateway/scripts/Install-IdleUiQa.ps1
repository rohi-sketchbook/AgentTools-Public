param(
    [string]$TaskName = 'AgentTools-IdleUiQA'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root 'config\idle-ui-qa.json'
$QaScript = Join-Path $Root 'scripts\idle-ui-qa.js'
$HiddenRunner = Join-Path $Root 'scripts\Run-HiddenNode.vbs'
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $QaScript -PathType Leaf)) { throw "Idle UI QA script not found: $QaScript" }
if (-not (Test-Path -LiteralPath $HiddenRunner -PathType Leaf)) { throw "Hidden Node runner not found: $HiddenRunner" }
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Idle UI QA config not found: $ConfigPath" }

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$IntervalMinutes = [Math]::Max(5, [int]$Config.checkIntervalMinutes)

$Action = New-ScheduledTaskAction `
    -Execute $WScript `
    -Argument ('//B //NoLogo "{0}" "{1}" "{2}" "{3}"' -f $HiddenRunner, $Node, $QaScript, $Root) `
    -WorkingDirectory $Root

$StartAt = (Get-Date).AddMinutes(1)
$Trigger = New-ScheduledTaskTrigger `
    -Once `
    -At $StartAt `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$LegacyTaskName = 'AgentTools-AutoDevLoop'
$LegacyTask = Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
if ($null -ne $LegacyTask) {
    if ($LegacyTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
    }
    Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false -ErrorAction Stop
}

$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $ExistingTask -and $ExistingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Start-Sleep -Milliseconds 300
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description 'When VR Avatar Studio development has been idle long enough, inspect recent UI screenshots with a read-only Codex worker and record only new UI/UX findings.' `
    -Force | Out-Null

[pscustomobject]@{
    TaskName = $TaskName
    State = (Get-ScheduledTask -TaskName $TaskName).State
    IntervalMinutes = $IntervalMinutes
    FirstRun = $StartAt
    QaScript = $QaScript
    RetiredLegacyTask = ($null -ne $LegacyTask)
} | Format-List
