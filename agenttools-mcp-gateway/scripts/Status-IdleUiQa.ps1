param(
    [string]$TaskName = 'AgentTools-IdleUiQA'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Root 'src\cli.js'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$Info = if ($null -ne $Task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }

[pscustomobject]@{
    TaskName = $TaskName
    Installed = $null -ne $Task
    State = if ($null -ne $Task) { $Task.State } else { 'NotInstalled' }
    LastRunTime = if ($null -ne $Info) { $Info.LastRunTime } else { $null }
    LastTaskResult = if ($null -ne $Info) { $Info.LastTaskResult } else { $null }
    NextRunTime = if ($null -ne $Info) { $Info.NextRunTime } else { $null }
} | Format-List

& $Node $Cli uiqa status
