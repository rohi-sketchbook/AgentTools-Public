$ErrorActionPreference = "Stop"

$token = [Environment]::GetEnvironmentVariable("DISCORD_TOKEN", "User")
if ([string]::IsNullOrWhiteSpace($token)) {
    throw "DISCORD_TOKEN is not set in the current user's environment variables."
}

$bridgeRoot = $PSScriptRoot
$discordRoot = Split-Path -Parent $bridgeRoot
$connectorRoot = Join-Path $discordRoot "codex-discord-connector"
$configPath = Join-Path $connectorRoot ".connect\config.json"
$statePath = Join-Path $connectorRoot ".connect\state.json"

$env:DISCORD_TOKEN = $token
$env:CONNECT_CONFIG_PATH = $configPath
$env:CONNECT_STATE_PATH = $statePath
$env:CONNECT_MODE = "direct"
$env:CODEX_CLI_JS = Join-Path $env:APPDATA "npm\node_modules\@openai\codex\bin\codex.js"

$config = Get-Content -Raw -LiteralPath $env:CONNECT_CONFIG_PATH | ConvertFrom-Json
$env:DISCORD_ALLOWED_ROLE_IDS = ($config.discord.allowedRoleIds -join ",")
if ([string]::IsNullOrWhiteSpace($env:DISCORD_ALLOWED_ROLE_IDS)) {
    throw "No Discord allowed role IDs are configured."
}

$supervisorScript = Join-Path $bridgeRoot "run-localized-bot-supervisor.ps1"
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $supervisorScript
)

$process = Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 3
if ($process.HasExited) {
    if ($process.ExitCode -eq 10) {
        Write-Output "Localized bot supervisor is already running."
        exit 0
    }

    throw "Localized bot supervisor exited early with code $($process.ExitCode)."
}

Write-Output "Localized bot supervisor running. PID=$($process.Id)"
