[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
$stateRoot = Join-Path $env:LOCALAPPDATA 'AgentTools\cloudflare'
$secretPath = Join-Path $env:LOCALAPPDATA 'AgentTools\secrets\cloudflare-agenttools-tunnel.dpapi'
$pidPath = Join-Path $stateRoot 'agenttools-tunnel.pid'

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $existingPid = 0
    if ([int]::TryParse(([IO.File]::ReadAllText($pidPath).Trim()), [ref]$existingPid)) {
        $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($existing -and $existing.ProcessName -eq 'cloudflared') {
            Write-Host "AgentTools Cloudflare Tunnel is already running: PID $existingPid"
            exit 0
        }
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "AgentTools Tunnel token is not registered: $secretPath"
}

$encrypted = [IO.File]::ReadAllText($secretPath, [Text.UTF8Encoding]::new($false)).Trim()
$secure = ConvertTo-SecureString $encrypted
$credential = [pscredential]::new('tunnel', $secure)
$token = $credential.GetNetworkCredential().Password

if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Unable to decrypt AgentTools Tunnel token.'
}

$env:TUNNEL_TOKEN = $token
$token = $null
$credential = $null
$secure = $null
$encrypted = $null

Write-Host 'Starting AgentTools Cloudflare Tunnel as a hidden user process.'
try {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $cloudflared
    $startInfo.Arguments = "tunnel --pidfile `"$pidPath`" run"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw 'Unable to start AgentTools Cloudflare Tunnel.'
    }

    $deadline = (Get-Date).AddSeconds(10)
    do {
        if ($process.HasExited) {
            throw "AgentTools Cloudflare Tunnel exited during startup: $($process.ExitCode)"
        }
        if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
            Write-Host "AgentTools Cloudflare Tunnel started: PID $($process.Id)"
            exit 0
        }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)

    throw 'AgentTools Cloudflare Tunnel did not create its pid file within 10 seconds.'
}
finally {
    Remove-Item Env:TUNNEL_TOKEN -ErrorAction SilentlyContinue
}
