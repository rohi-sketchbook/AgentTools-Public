[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MarkerPath,

    [Parameter(Mandatory = $true)]
    [string]$WindowTitle,

    [int]$TimeoutSeconds = 20
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $WindowTitle
$form.Width = 360
$form.Height = 160
$form.StartPosition = 'CenterScreen'
$form.TopMost = $false

$button = New-Object System.Windows.Forms.Button
$button.Text = 'Test Invoke'
$button.Name = 'InvokeButton'
$button.Width = 120
$button.Height = 32
$button.Left = 110
$button.Top = 45
$button.Add_Click({
    [System.IO.File]::WriteAllText($MarkerPath, 'invoked', (New-Object System.Text.UTF8Encoding($false)))
    $form.Close()
})
$form.Controls.Add($button)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1000, $TimeoutSeconds * 1000)
$timer.Add_Tick({
    $timer.Stop()
    $form.Close()
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
