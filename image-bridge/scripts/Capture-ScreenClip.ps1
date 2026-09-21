[CmdletBinding()]
param(
    [ValidateSet('All', 'Primary', 'Screen', 'Window', 'ListWindows')]
    [string]$Mode = 'All',

    [int]$ScreenIndex = 0,
    [string]$WindowQuery = '',
    [string]$OutputPath = '',

    [ValidateRange(0, 3600)]
    [int]$DelaySeconds = 0,

    [string]$WorkspaceRoot = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\common\PathSafety.ps1')

function Resolve-WorkspaceRoot {
    param([string]$Value)

    $candidate = $Value
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = $env:AGENTTOOLS_WORKSPACE_ROOT
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = (Get-Location).Path
    }

    $full = [System.IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        throw ('WorkspaceRoot does not exist: ' + $full)
    }
    return $full.TrimEnd([char[]]@(92, 47))
}

function Resolve-OutputPath {
    param([string]$Root, [string]$Value)

    $requested = $Value
    if ([string]::IsNullOrWhiteSpace($requested)) {
        $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
        $requested = 'UserData\Screenshots\screenshot_' + $stamp + '.png'
    }

    return Resolve-AgentToolsPathInsideWorkspace -Root $Root -Value $requested -Label 'OutputPath'
}

function Get-TopLevelWindows {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    $result = @()
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($element in $elements) {
        try {
            $title = $element.Current.Name
            $handle = [IntPtr]$element.Current.NativeWindowHandle
            if ($handle -eq [IntPtr]::Zero -or [string]::IsNullOrWhiteSpace($title)) { continue }

            $processId = $element.Current.ProcessId
            $processName = 'unknown'
            try { $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }

            $state = 'Unknown'
            $windowPattern = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$windowPattern)) {
                $state = $windowPattern.Current.WindowVisualState.ToString()
            }

            $result += [pscustomobject]@{
                Title = $title
                ProcessName = $processName
                ProcessId = $processId
                Bounds = $element.Current.BoundingRectangle
                IsOffscreen = $element.Current.IsOffscreen
                State = $state
            }
        }
        catch { }
    }
    return @($result)
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $workspace = Resolve-WorkspaceRoot $WorkspaceRoot
    if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

    $targetLabel = ''
    if ($Mode -eq 'Window' -or $Mode -eq 'ListWindows') {
        $windows = @(Get-TopLevelWindows)
        if ($Mode -eq 'ListWindows') {
            if ($windows.Count -eq 0) {
                Write-Host '[Capture-ScreenClip] No capturable top-level windows were found.'
                exit 0
            }
            $windows | Sort-Object ProcessName, Title | ForEach-Object {
                Write-Host ('[Capture-ScreenClip] [' + $_.ProcessName + ':' + $_.ProcessId + '] ' + $_.Title + ' Bounds=' + $_.Bounds.ToString() + ' State=' + $_.State)
            }
            exit 0
        }

        if ([string]::IsNullOrWhiteSpace($WindowQuery)) {
            throw 'WindowQuery is required for Window mode.'
        }
        $query = $WindowQuery.Trim()
        $matches = @($windows | Where-Object { $_.Title -ieq $query })
        if ($matches.Count -eq 0) {
            $matches = @($windows | Where-Object { $_.ProcessName -ieq $query -or ($_.ProcessName + '.exe') -ieq $query })
        }
        if ($matches.Count -eq 0) {
            $matches = @($windows | Where-Object { $_.Title.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
        }
        if ($matches.Count -eq 0) { throw ('No window matched: ' + $query) }
        if ($matches.Count -gt 1) {
            $candidateText = ($matches | ForEach-Object { '[' + $_.ProcessName + ':' + $_.ProcessId + '] ' + $_.Title }) -join [Environment]::NewLine
            throw ('Window query is ambiguous: ' + $query + [Environment]::NewLine + $candidateText)
        }

        $target = $matches[0]
        if ($target.State -eq 'Minimized') { throw ('Target window is minimized: ' + $target.Title) }
        if ($target.IsOffscreen) { throw ('Target window is off-screen: ' + $target.Title) }

        $b = $target.Bounds
        $left = [int][Math]::Floor($b.X)
        $top = [int][Math]::Floor($b.Y)
        $right = [int][Math]::Ceiling($b.X + $b.Width)
        $bottom = [int][Math]::Ceiling($b.Y + $b.Height)
        $bounds = New-Object System.Drawing.Rectangle($left, $top, ($right - $left), ($bottom - $top))
        $targetLabel = 'window [' + $target.ProcessName + ':' + $target.ProcessId + '] ' + $target.Title
    }
    else {
        $screens = [System.Windows.Forms.Screen]::AllScreens
        switch ($Mode) {
            'Primary' {
                $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                $targetLabel = 'primary'
            }
            'Screen' {
                if ($ScreenIndex -lt 0 -or $ScreenIndex -ge $screens.Count) {
                    throw ('ScreenIndex is out of range. Screen count: ' + $screens.Count)
                }
                $bounds = $screens[$ScreenIndex].Bounds
                $targetLabel = 'screen ' + $ScreenIndex
            }
            default {
                $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
                $targetLabel = 'all screens'
            }
        }
    }

    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'Capture bounds are invalid.' }
    $out = Resolve-OutputPath $workspace $OutputPath
    $outDir = Split-Path -Parent $out
    if (-not [string]::IsNullOrWhiteSpace($outDir)) {
        [System.IO.Directory]::CreateDirectory($outDir) | Out-Null
    }

    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
        $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bmp.Dispose()
    }

    Write-Host ('[Capture-ScreenClip] Target: ' + $targetLabel + ' Bounds=' + $bounds.ToString())
    Write-Host ('[Capture-ScreenClip] Saved: ' + $out)
}
catch {
    [Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)
    exit 1
}
