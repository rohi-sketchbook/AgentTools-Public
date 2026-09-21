[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dll = Join-Path $root 'bin\Release\net10.0-windows\AgentTools.WindowsUi.dll'
$dotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
$hostScript = Join-Path $PSScriptRoot 'InvokeTestHost.ps1'

if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) {
    & (Join-Path $root 'Build-WindowsUi.bat')
    if ($LASTEXITCODE -ne 0) { throw 'Windows UI helper build failed.' }
}

$marker = Join-Path $env:TEMP ('agenttools-windows-ui-' + [Guid]::NewGuid().ToString('N') + '.txt')
$title = 'AgentTools UIA Test ' + [Guid]::NewGuid().ToString('N')
$hostProcess = $null

try {
    $hostProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $hostScript),
        '-MarkerPath', ('"{0}"' -f $marker),
        '-WindowTitle', ('"{0}"' -f $title),
        '-TimeoutSeconds', '20'
    ) -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $windowReady = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $json = & $dotnet $dll windows --process powershell.exe --title $title --limit 5
        if ($LASTEXITCODE -eq 0) {
            $result = ($json -join [Environment]::NewLine) | ConvertFrom-Json
            if ($result.ok -and $result.count -eq 1) {
                $windowReady = $true
                break
            }
        }
        Start-Sleep -Milliseconds 150
    }
    if (-not $windowReady) { throw 'Test window was not discovered through UI Automation.' }

    $previewJson = & $dotnet $dll invoke --process powershell.exe --window $title --controlType Button --name 'Test Invoke'
    if ($LASTEXITCODE -ne 0) { throw 'Invoke dry-run failed.' }
    $preview = ($previewJson -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $preview.ok -or -not $preview.dryRun) { throw 'Invoke did not remain dry-run without --execute.' }
    if (Test-Path -LiteralPath $marker) { throw 'Dry-run unexpectedly activated the button.' }

    $target = $preview.wouldInvoke
    $executeJson = & $dotnet $dll invoke `
        --process powershell.exe `
        --window $title `
        --controlType Button `
        --name 'Test Invoke' `
        --expectedProcessId $target.control.processId `
        --expectedWindowHandle $target.window.nativeWindowHandle `
        --expectedControlHandle $target.control.nativeWindowHandle `
        --execute
    if ($LASTEXITCODE -ne 0) { throw 'Invoke execution failed.' }
    $executed = ($executeJson -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $executed.ok -or $executed.dryRun) { throw 'Execute result did not report a real invoke.' }

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $marker)) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $marker)) { throw 'Test button was not invoked.' }
    if ([System.IO.File]::ReadAllText($marker) -ne 'invoked') { throw 'Test marker content is invalid.' }

    Write-Output 'WINDOWS_UI_AUTOMATION_TEST_OK'
}
finally {
    if ($hostProcess -and -not $hostProcess.HasExited) {
        Stop-Process -Id $hostProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}
