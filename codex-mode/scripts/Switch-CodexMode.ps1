[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('LMStudio', 'ChatGPT')]
    [string]$Mode,

    [string]$LMStudioModel = 'qwen/qwen3-coder-30b',
    [ValidateRange(1024, 1048576)]
    [int]$LMStudioContextWindow = 32768,
    [string]$LMStudioPath = '',
    [ValidateRange(1024, 65535)]
    [int]$LMStudioPort = 1234,

    [switch]$NoRestart,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$codexHome = Join-Path $env:USERPROFILE '.codex'
$activeConfig = Join-Path $codexHome 'config.toml'
$backupDir = Join-Path $codexHome 'mode-switch-backups'
$stateDir = Join-Path $codexHome 'mode-switch-state'
$chatGptProfilePath = Join-Path $stateDir 'chatgpt-profile.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$controlledKeys = @('model', 'model_provider', 'model_context_window', 'model_verbosity', 'model_reasoning_effort')

function Read-ConfigLines {
    if (-not (Test-Path -LiteralPath $activeConfig -PathType Leaf)) {
        throw ('Codex config.toml was not found: ' + $activeConfig)
    }
    return @([System.IO.File]::ReadAllLines($activeConfig))
}

function Get-TopLevelProfile {
    param([string[]]$Lines)
    $profile = [ordered]@{}
    $insideTable = $false
    foreach ($line in $Lines) {
        if ($line -match '^\s*\[') { $insideTable = $true }
        if ($insideTable) { continue }
        foreach ($key in $controlledKeys) {
            if ($line -match ('^\s*' + [Regex]::Escape($key) + '\s*=\s*(.+?)\s*$')) {
                $profile[$key] = $Matches[1]
                break
            }
        }
    }
    return $profile
}

function Remove-ControlledSettings {
    param([string[]]$Lines)
    $result = New-Object System.Collections.Generic.List[string]
    $currentTable = ''
    $skipLocalProvider = $false

    foreach ($line in $Lines) {
        if ($line -match '^\s*\[([^\]]+)\]\s*$') {
            $currentTable = $Matches[1]
            $skipLocalProvider = ($currentTable -eq 'model_providers.local_lmstudio')
            if ($skipLocalProvider) { continue }
        }
        elseif ($skipLocalProvider) {
            continue
        }

        if ([string]::IsNullOrEmpty($currentTable)) {
            $isControlled = $false
            foreach ($key in $controlledKeys) {
                if ($line -match ('^\s*' + [Regex]::Escape($key) + '\s*=')) {
                    $isControlled = $true
                    break
                }
            }
            if ($isControlled) { continue }
        }
        [void]$result.Add($line)
    }
    return @($result)
}

function Build-ConfigLines {
    param([string[]]$BaseLines, [System.Collections.IDictionary]$Profile, [bool]$AddLocalProvider)

    $clean = @(Remove-ControlledSettings $BaseLines)
    while ($clean.Count -gt 0 -and [string]::IsNullOrWhiteSpace($clean[0])) {
        if ($clean.Count -eq 1) { $clean = @(); break }
        $clean = @($clean[1..($clean.Count - 1)])
    }

    $modeLines = New-Object System.Collections.Generic.List[string]
    foreach ($key in $controlledKeys) {
        if ($Profile.Contains($key) -and -not [string]::IsNullOrWhiteSpace([string]$Profile[$key])) {
            [void]$modeLines.Add($key + ' = ' + [string]$Profile[$key])
        }
    }

    $result = New-Object System.Collections.Generic.List[string]
    foreach ($line in $modeLines) { [void]$result.Add($line) }
    if ($modeLines.Count -gt 0 -and $clean.Count -gt 0) { [void]$result.Add('') }
    foreach ($line in $clean) { [void]$result.Add($line) }

    if ($AddLocalProvider) {
        while ($result.Count -gt 0 -and [string]::IsNullOrWhiteSpace($result[$result.Count - 1])) { $result.RemoveAt($result.Count - 1) }
        [void]$result.Add('')
        [void]$result.Add('[model_providers.local_lmstudio]')
        [void]$result.Add('name = "LM Studio Local"')
        [void]$result.Add(('base_url = "http://127.0.0.1:' + $LMStudioPort + '/v1"'))
        [void]$result.Add('wire_api = "responses"')
        [void]$result.Add('request_max_retries = 2')
        [void]$result.Add('stream_max_retries = 2')
        [void]$result.Add('stream_idle_timeout_ms = 600000')
    }
    return @($result)
}

function Save-ChatGptProfile {
    param([System.Collections.IDictionary]$Profile)
    [System.IO.Directory]::CreateDirectory($stateDir) | Out-Null
    $object = [ordered]@{}
    foreach ($key in $controlledKeys) {
        if ($key -eq 'model_provider') { continue }
        if ($Profile.Contains($key)) { $object[$key] = [string]$Profile[$key] }
    }
    [System.IO.File]::WriteAllText($chatGptProfilePath, ($object | ConvertTo-Json -Depth 4), $utf8NoBom)
}

function Load-ChatGptProfile {
    if (-not (Test-Path -LiteralPath $chatGptProfilePath -PathType Leaf)) { return $null }
    try {
        $json = [System.IO.File]::ReadAllText($chatGptProfilePath) | ConvertFrom-Json
        $profile = [ordered]@{}
        foreach ($key in $controlledKeys) {
            if ($key -eq 'model_provider') { continue }
            $property = $json.PSObject.Properties[$key]
            if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                $profile[$key] = [string]$property.Value
            }
        }
        return $profile
    }
    catch { throw ('Saved ChatGPT profile is invalid: ' + $_.Exception.Message) }
}

function Backup-ActiveConfig {
    [System.IO.Directory]::CreateDirectory($backupDir) | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $destination = Join-Path $backupDir ('config-' + $stamp + '.toml')
    Copy-Item -LiteralPath $activeConfig -Destination $destination
    return $destination
}

function Write-ConfigAtomically {
    param([string[]]$Lines)
    $content = ($Lines -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine
    $temp = $activeConfig + '.agenttools-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [System.IO.File]::WriteAllText($temp, $content, $utf8NoBom)
        if (Test-Path -LiteralPath $activeConfig -PathType Leaf) {
            $replaceBackup = $temp + '.replace-backup'
            try { [System.IO.File]::Replace($temp, $activeConfig, $replaceBackup, $true) }
            finally { if (Test-Path -LiteralPath $replaceBackup) { Remove-Item -LiteralPath $replaceBackup -Force } }
        }
        else { [System.IO.File]::Move($temp, $activeConfig) }
    }
    finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}

function Find-LMStudioExecutable {
    if (-not [string]::IsNullOrWhiteSpace($LMStudioPath)) {
        $explicit = [Environment]::ExpandEnvironmentVariables($LMStudioPath)
        if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { throw ('LM Studio executable not found: ' + $explicit) }
        return (Resolve-Path -LiteralPath $explicit).Path
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LMSTUDIO_EXE) -and (Test-Path -LiteralPath $env:LMSTUDIO_EXE -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $env:LMSTUDIO_EXE).Path
    }
    foreach ($candidate in @(
        'H:\LMStudio\LM Studio\LM Studio.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\LM Studio\LM Studio.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw 'LM Studio executable was not found. Use -LMStudioPath or LMSTUDIO_EXE.'
}

function Test-LMStudioServer {
    try {
        $result = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $LMStudioPort + '/v1/models') -Method Get -TimeoutSec 3
        return ($null -ne $result)
    }
    catch { return $false }
}

function Start-LMStudioServer {
    $exe = Find-LMStudioExecutable
    if (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'LM Studio*' })) {
        Start-Process -FilePath $exe
        Start-Sleep -Seconds 7
    }
    if (-not (Test-LMStudioServer)) {
        $lms = Get-Command 'lms' -ErrorAction SilentlyContinue
        if ($null -ne $lms) {
            try { & $lms.Source server start --port $LMStudioPort | Out-Host } catch { }
        }
    }
    Write-Host ('Waiting for LM Studio API on port ' + $LMStudioPort + '...')
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-LMStudioServer) { Write-Host 'LM Studio API is ready.'; return }
        Start-Sleep -Seconds 2
    }
    throw 'LM Studio API did not become ready.'
}

function Stop-CodexApp {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match '^(Codex|codex)$' } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

function Start-CodexStoreApp {
    $app = Get-StartApps | Where-Object { $_.Name -match '^Codex$|Codex' } | Select-Object -First 1
    if ($null -eq $app) { throw 'Codex Store app was not found in the Start menu.' }
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $app.AppID)
}

try {
    $lines = @(Read-ConfigLines)
    $currentProfile = Get-TopLevelProfile $lines
    $currentProvider = if ($currentProfile.Contains('model_provider')) { [string]$currentProfile['model_provider'] } else { '' }
    $isLocal = ($currentProvider -match 'local_lmstudio')

    if ($Mode -eq 'LMStudio') {
        if (-not $isLocal) {
            if ($DryRun) { Write-Host '[DRY RUN] ChatGPT profile would be saved before switching.' }
            else { Save-ChatGptProfile $currentProfile }
        }
        $target = [ordered]@{
            model = ('"' + $LMStudioModel.Replace('"', '\"') + '"')
            model_provider = '"local_lmstudio"'
            model_context_window = [string]$LMStudioContextWindow
            model_verbosity = '"low"'
        }
        $newLines = @(Build-ConfigLines $lines $target $true)
    }
    else {
        $target = $null
        if ($isLocal) { $target = Load-ChatGptProfile }
        if ($null -eq $target -or $target.Count -eq 0) {
            if (-not $isLocal -and $currentProfile.Contains('model')) {
                $target = [ordered]@{}
                foreach ($key in $controlledKeys) {
                    if ($key -ne 'model_provider' -and $currentProfile.Contains($key)) { $target[$key] = $currentProfile[$key] }
                }
            }
            else {
                $target = [ordered]@{ model = '"gpt-5.4-mini"'; model_reasoning_effort = '"medium"' }
            }
        }
        $newLines = @(Build-ConfigLines $lines $target $false)
    }

    if ($DryRun) {
        Write-Host ('[DRY RUN] Mode: ' + $Mode)
        Write-Host '[DRY RUN] Controlled top-level settings:'
        $preview = Get-TopLevelProfile $newLines
        foreach ($key in $controlledKeys) {
            if ($preview.Contains($key)) { Write-Host ('  ' + $key + ' = ' + $preview[$key]) }
        }
        Write-Host ('[DRY RUN] Local provider table: ' + ($Mode -eq 'LMStudio'))
        Write-Host ('[DRY RUN] Restart Codex: ' + (-not $NoRestart.IsPresent))
        exit 0
    }

    if ($Mode -eq 'LMStudio') { Start-LMStudioServer }
    $backup = Backup-ActiveConfig
    Write-Host ('Backed up Codex config: ' + $backup)
    Write-ConfigAtomically $newLines
    Write-Host ('Codex config switched to: ' + $Mode)

    if (-not $NoRestart.IsPresent) {
        Stop-CodexApp
        Start-CodexStoreApp
        Write-Host 'Codex App restarted.'
    }
    else { Write-Host 'Codex App restart skipped by -NoRestart.' }
}
catch {
    [Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)
    exit 1
}
