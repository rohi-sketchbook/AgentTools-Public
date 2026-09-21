[CmdletBinding()]
param(
    [int]$CallerWebPid = 0,
    [string]$LockPath,
    [ValidateRange(1024, 65535)]
    [int]$WebPort = 47832,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = Join-Path $root 'web'
$desktopDist = Join-Path $root 'dist'
$webDist = Join-Path $webRoot 'dist'
$desktopExe = Join-Path $desktopDist 'AgentToolsControlCenter.exe'
$webExe = Join-Path $webDist 'AgentToolsControlCenter.Web.exe'
$buildDesktop = Join-Path $root 'Build-Release.ps1'
$buildWeb = Join-Path $webRoot 'Build-Web-Release.ps1'
$runId = [Guid]::NewGuid().ToString('N')
$stageRoot = Join-Path $root "state\update-staging\$runId"
$desktopStage = Join-Path $stageRoot 'desktop'
$webStage = Join-Path $stageRoot 'web'
$desktopBackup = "$desktopDist.update-backup-$runId"
$webBackup = "$webDist.update-backup-$runId"
$desktopWasRunning = $false
$webWasRunning = $false
$desktopSwapped = $false
$webSwapped = $false
$replacementStarted = $false

function Get-ExactExecutableProcesses {
    param([Parameter(Mandatory = $true)][string]$Path)
    $target = [IO.Path]::GetFullPath($Path)
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        try {
            if ($process.Path -and [string]::Equals([IO.Path]::GetFullPath($process.Path), $target, [StringComparison]::OrdinalIgnoreCase)) {
                $process
            }
        }
        catch {
            # Protected/system processes can reject Path access. Ignore them.
        }
    }
}

function Stop-ExactExecutable {
    param([Parameter(Mandatory = $true)][string]$Path)
    $processes = @(Get-ExactExecutableProcesses -Path $Path)
    foreach ($process in $processes) {
        Stop-Process -Id $process.Id -ErrorAction Stop
    }
    $deadline = (Get-Date).AddSeconds(10)
    do {
        if (@(Get-ExactExecutableProcesses -Path $Path).Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    throw "Process did not stop in time: $Path"
}

function Start-ControlCenterProcesses {
    param(
        [bool]$StartDesktop,
        [bool]$StartWeb
    )
    if ($StartDesktop -and (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
        Start-Process -FilePath $desktopExe -WorkingDirectory $root | Out-Null
    }
    if ($StartWeb -and (Test-Path -LiteralPath $webExe -PathType Leaf)) {
        Start-Process -FilePath $webExe -WorkingDirectory $webRoot -WindowStyle Hidden | Out-Null
    }
}

New-Item -ItemType Directory -Path $desktopStage -Force | Out-Null
New-Item -ItemType Directory -Path $webStage -Force | Out-Null

try {
    # Build into staging while the current apps remain available. This keeps the
    # web UI online if compilation fails and avoids locks on the live dist files.
    & $buildDesktop -Output $desktopStage
    if ($LASTEXITCODE -ne 0) { throw "Desktop release build failed with exit code $LASTEXITCODE." }
    & $buildWeb -Output $webStage
    if ($LASTEXITCODE -ne 0) { throw "Web release build failed with exit code $LASTEXITCODE." }

    $stagedDesktopExe = Join-Path $desktopStage 'AgentToolsControlCenter.exe'
    $stagedWebExe = Join-Path $webStage 'AgentToolsControlCenter.Web.exe'
    if (-not (Test-Path -LiteralPath $stagedDesktopExe -PathType Leaf)) { throw 'Staged desktop executable is missing.' }
    if (-not (Test-Path -LiteralPath $stagedWebExe -PathType Leaf)) { throw 'Staged web executable is missing.' }
    if ($ValidateOnly) { return }

    $desktopWasRunning = @(Get-ExactExecutableProcesses -Path $desktopExe).Count -gt 0
    $webWasRunning = @(Get-ExactExecutableProcesses -Path $webExe).Count -gt 0

    # Let the HTTP response reach the browser before the current web process is stopped.
    if ($CallerWebPid -gt 0) { Start-Sleep -Milliseconds 900 }

    $replacementStarted = $true
    Stop-ExactExecutable -Path $desktopExe
    Stop-ExactExecutable -Path $webExe

    if (Test-Path -LiteralPath $desktopDist) {
        Move-Item -LiteralPath $desktopDist -Destination $desktopBackup
    }
    Move-Item -LiteralPath $desktopStage -Destination $desktopDist
    $desktopSwapped = $true

    if (Test-Path -LiteralPath $webDist) {
        Move-Item -LiteralPath $webDist -Destination $webBackup
    }
    Move-Item -LiteralPath $webStage -Destination $webDist
    $webSwapped = $true

    # Normally both processes are persistent services. If either was unexpectedly
    # stopped before this action, do not silently change that operator choice.
    Start-ControlCenterProcesses -StartDesktop:$desktopWasRunning -StartWeb:$webWasRunning

    if ($webWasRunning) {
        $deadline = (Get-Date).AddSeconds(20)
        $healthy = $false
        do {
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/healthz" -TimeoutSec 2
                if ($health.ok -eq $true) { $healthy = $true; break }
            }
            catch {
                Start-Sleep -Milliseconds 300
            }
        } while ((Get-Date) -lt $deadline)
        if (-not $healthy) { throw 'Updated Web Control Center did not become healthy.' }
    }

    if (Test-Path -LiteralPath $desktopBackup) { Remove-Item -LiteralPath $desktopBackup -Recurse -Force }
    if (Test-Path -LiteralPath $webBackup) { Remove-Item -LiteralPath $webBackup -Recurse -Force }
}
catch {
    $failure = $_
    if (-not $replacementStarted) { throw $failure }

    try { Stop-ExactExecutable -Path $desktopExe } catch { }
    try { Stop-ExactExecutable -Path $webExe } catch { }

    if ($desktopSwapped -and (Test-Path -LiteralPath $desktopDist)) {
        Remove-Item -LiteralPath $desktopDist -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $desktopBackup) {
        Move-Item -LiteralPath $desktopBackup -Destination $desktopDist -Force
    }

    if ($webSwapped -and (Test-Path -LiteralPath $webDist)) {
        Remove-Item -LiteralPath $webDist -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $webBackup) {
        Move-Item -LiteralPath $webBackup -Destination $webDist -Force
    }

    Start-ControlCenterProcesses -StartDesktop:$desktopWasRunning -StartWeb:$webWasRunning
    throw $failure
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not [string]::IsNullOrWhiteSpace($LockPath) -and (Test-Path -LiteralPath $LockPath)) {
        Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
    }
}
