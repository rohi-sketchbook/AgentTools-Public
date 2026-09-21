[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\PathSafety.ps1')

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $threw = $false
    try { & $Action }
    catch { $threw = $true }
    if (-not $threw) { throw $Message }
}

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('agenttools-path-safety-' + [Guid]::NewGuid().ToString('N'))
$root = Join-Path $base 'root'
$outside = Join-Path $base 'outside'
$link = Join-Path $root 'escape'
[System.IO.Directory]::CreateDirectory($root) | Out-Null
[System.IO.Directory]::CreateDirectory($outside) | Out-Null
$junctionCreated = $false

try {
    $inside = Resolve-AgentToolsPathInsideWorkspace -Root $root -Value 'output\image.png' -Label 'OutputPath'
    if (-not $inside.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Normal inside path was not accepted.'
    }

    Assert-Throws { Resolve-AgentToolsPathInsideWorkspace -Root $root -Value '..\outside\image.png' -Label 'OutputPath' | Out-Null } 'Parent traversal must be rejected.'

    & cmd.exe /d /c "mklink /J `"$link`" `"$outside`"" *> $null
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $link -PathType Container)) {
        $junctionCreated = $true
        Assert-Throws { Resolve-AgentToolsPathInsideWorkspace -Root $root -Value 'escape\image.png' -Label 'OutputPath' | Out-Null } 'Junction traversal must be rejected.'
    }

    Write-Host ('[PathSafetyTests] PASS' + $(if ($junctionCreated) { ' (junction checked)' } else { ' (junction creation unavailable)' }))
}
finally {
    if ($junctionCreated -and (Test-Path -LiteralPath $link)) {
        & cmd.exe /d /c "rmdir `"$link`"" *> $null
    }
    if (Test-Path -LiteralPath $base) {
        Remove-Item -LiteralPath $base -Recurse -Force
    }
}
