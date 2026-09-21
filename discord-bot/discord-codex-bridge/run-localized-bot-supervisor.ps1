$ErrorActionPreference = "Stop"

$mutexName = "Local\AgentToolsDiscordBridgeSupervisor"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$ownsMutex = $false

try {
    $ownsMutex = $mutex.WaitOne(0)
    if (-not $ownsMutex) {
        exit 10
    }

    $nodeCommand = Get-Command node -ErrorAction Stop
    $node = $nodeCommand.Source

    $bridgeRoot = $PSScriptRoot
    $discordRoot = Split-Path -Parent $bridgeRoot
    $packageRoot = Join-Path $discordRoot "codex-discord-connector"
    $configPath = Join-Path $packageRoot ".connect\config.json"
    $statePath = Join-Path $packageRoot ".connect\state.json"
    $hookPath = Join-Path $bridgeRoot "jp-hooks.mjs"
    $hookUri = ([System.Uri]$hookPath).AbsoluteUri

    $token = [Environment]::GetEnvironmentVariable("DISCORD_TOKEN", "User")
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "DISCORD_TOKEN is not set in the current user's environment variables."
    }

    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "Connector config was not found: $configPath"
    }

    $env:DISCORD_TOKEN = $token
    $env:CONNECT_CONFIG_PATH = $configPath
    $env:CONNECT_STATE_PATH = $statePath
    $env:CONNECT_MODE = "direct"
    $env:CODEX_CLI_JS = Join-Path $env:APPDATA "npm\node_modules\@openai\codex\bin\codex.js"

    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
    $env:DISCORD_ALLOWED_ROLE_IDS = ($config.discord.allowedRoleIds -join ",")
    if ([string]::IsNullOrWhiteSpace($env:DISCORD_ALLOWED_ROLE_IDS)) {
        throw "No Discord allowed role IDs are configured."
    }

    $arguments = @(
        "--import",
        $hookUri,
        "--import",
        "tsx",
        "apps/discord-bot/src/index.ts"
    )

    $reloadExitCode = 42

    while ($true) {
        $bot = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $packageRoot -WindowStyle Hidden -Wait -PassThru

        if ($bot.ExitCode -eq $reloadExitCode) {
            Start-Sleep -Milliseconds 750
            continue
        }

        exit $bot.ExitCode
    }
}
finally {
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
