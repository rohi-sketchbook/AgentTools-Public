[CmdletBinding()]
param(
    [ValidateSet("Start", "Stop", "Restart", "Status")]
    [string]$Action = "Status",

    [ValidateRange(1024, 65535)]
    [int]$Port = 9876,

    [string]$BlenderPath = "",

    [switch]$Force,

    [ValidateRange(5, 120)]
    [int]$StartupTimeoutSeconds = 30
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$McpHost = "127.0.0.1"

function Test-TcpPort {
    param(
        [string]$HostName,
        [int]$TargetPort,
        [int]$TimeoutMilliseconds = 500
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $client.BeginConnect($HostName, $TargetPort, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($asyncResult)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Invoke-BlenderMcpCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Type,

        [hashtable]$Params = @{},

        [int]$TimeoutMilliseconds = 5000
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $client.BeginConnect($McpHost, $Port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            throw "Timed out connecting to BlenderMCP at ${McpHost}:$Port."
        }
        $client.EndConnect($asyncResult)
        $client.ReceiveTimeout = $TimeoutMilliseconds
        $client.SendTimeout = $TimeoutMilliseconds

        $stream = $client.GetStream()
        $request = [ordered]@{
            type = $Type
            params = $Params
        }
        $json = $request | ConvertTo-Json -Compress -Depth 20
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()

        $buffer = New-Object byte[] 8192
        $builder = New-Object System.Text.StringBuilder

        while ($true) {
            $count = $stream.Read($buffer, 0, $buffer.Length)
            if ($count -le 0) {
                break
            }

            [void]$builder.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $count))
            $text = $builder.ToString()

            try {
                return ($text | ConvertFrom-Json)
            }
            catch {
                # The JSON response can arrive in more than one TCP packet.
            }
        }

        throw "BlenderMCP closed the connection before a complete JSON response was received."
    }
    finally {
        $client.Close()
    }
}

function Test-BlenderMcpServer {
    try {
        $response = Invoke-BlenderMcpCommand -Type "get_scene_info" -TimeoutMilliseconds 1500
        return ($response.status -eq "success")
    }
    catch {
        return $false
    }
}

function Resolve-BlenderExecutable {
    if ($BlenderPath) {
        $resolved = [Environment]::ExpandEnvironmentVariables($BlenderPath)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "Blender executable was not found: $resolved"
        }
        return (Resolve-Path -LiteralPath $resolved).Path
    }

    if ($env:BLENDER_EXE) {
        $fromEnvironment = [Environment]::ExpandEnvironmentVariables($env:BLENDER_EXE)
        if (Test-Path -LiteralPath $fromEnvironment -PathType Leaf) {
            return (Resolve-Path -LiteralPath $fromEnvironment).Path
        }
    }

    $fromPath = Get-Command blender.exe -ErrorAction SilentlyContinue
    if ($fromPath -and $fromPath.Source) {
        return $fromPath.Source
    }

    $candidates = New-Object System.Collections.Generic.List[string]

    $officialRoots = @(
        (Join-Path $env:ProgramFiles "Blender Foundation")
    )

    if (${env:ProgramFiles(x86)}) {
        $officialRoots += (Join-Path ${env:ProgramFiles(x86)} "Blender Foundation")
    }

    foreach ($root in $officialRoots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            continue
        }

        Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "Blender *" } |
            ForEach-Object {
                $exe = Join-Path $_.FullName "blender.exe"
                if (Test-Path -LiteralPath $exe -PathType Leaf) {
                    [void]$candidates.Add($exe)
                }
            }
    }

    $localOfficial = Join-Path $env:LOCALAPPDATA "Programs\Blender Foundation"
    if (Test-Path -LiteralPath $localOfficial -PathType Container) {
        Get-ChildItem -LiteralPath $localOfficial -Recurse -Filter blender.exe -File -ErrorAction SilentlyContinue |
            ForEach-Object { [void]$candidates.Add($_.FullName) }
    }

    if (${env:ProgramFiles(x86)}) {
        $steamExe = Join-Path ${env:ProgramFiles(x86)} "Steam\steamapps\common\Blender\blender.exe"
        if (Test-Path -LiteralPath $steamExe -PathType Leaf) {
            [void]$candidates.Add($steamExe)
        }
    }

    if ($candidates.Count -eq 0) {
        throw "Blender executable was not found. Install Blender or set BLENDER_EXE / -BlenderPath."
    }

    $selected = $candidates |
        Select-Object -Unique |
        ForEach-Object { Get-Item -LiteralPath $_ } |
        Sort-Object -Property @{ Expression = {
            try {
                [version]$_.VersionInfo.FileVersion
            }
            catch {
                [version]"0.0"
            }
        }; Descending = $true }, FullName |
        Select-Object -First 1

    return $selected.FullName
}

function Get-BlenderDirtyState {
    $code = "print('BLENDERMCP_DIRTY=' + ('1' if bpy.data.is_dirty else '0')); print('BLENDERMCP_FILE=' + bpy.data.filepath)"
    $response = Invoke-BlenderMcpCommand -Type "execute_code" -Params @{ code = $code }
    if ($response.status -ne "success") {
        throw "BlenderMCP could not query Blender dirty state: $($response.message)"
    }

    $output = [string]$response.result.result
    $dirty = ($output -match "BLENDERMCP_DIRTY=1")
    $file = ""
    $fileMatch = [regex]::Match($output, "(?m)^BLENDERMCP_FILE=(.*)$")
    if ($fileMatch.Success) {
        $file = $fileMatch.Groups[1].Value.Trim()
    }

    return [pscustomobject]@{
        Dirty = $dirty
        File = $file
    }
}

function Get-BlenderProcessIdentity {
    $code = "import os; print('BLENDERMCP_PID=' + str(os.getpid())); print('BLENDERMCP_EXE=' + bpy.app.binary_path)"
    $response = Invoke-BlenderMcpCommand -Type "execute_code" -Params @{ code = $code }
    if ($response.status -ne "success") {
        throw "BlenderMCP could not query Blender process identity: $($response.message)"
    }

    $output = [string]$response.result.result
    $pidMatch = [regex]::Match($output, "(?m)^BLENDERMCP_PID=(\d+)$")
    $exeMatch = [regex]::Match($output, "(?m)^BLENDERMCP_EXE=(.*)$")
    if (-not $pidMatch.Success -or -not $exeMatch.Success) {
        throw "BlenderMCP returned an incomplete process identity. Refusing process control."
    }

    $processId = [int]$pidMatch.Groups[1].Value
    $binaryPath = $exeMatch.Groups[1].Value.Trim()
    if ([System.IO.Path]::GetFileName($binaryPath) -ine "blender.exe") {
        throw "MCP endpoint reports a non-Blender executable: $binaryPath. Refusing process control."
    }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
        throw "BlenderMCP reports PID $processId, but that process does not exist. Refusing process control."
    }

    $processPath = $process.Path
    if (-not $processPath -or [System.IO.Path]::GetFileName($processPath) -ine "blender.exe") {
        throw "PID $processId is not blender.exe. Refusing process control."
    }

    return [pscustomobject]@{
        ProcessId = $processId
        BinaryPath = $binaryPath
        ProcessPath = $processPath
    }
}

function Wait-ForMcpReady {
    param([int]$TimeoutSeconds)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-BlenderMcpServer) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Wait-ForMcpStopped {
    param([int]$TimeoutSeconds = 15)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Test-TcpPort -HostName $McpHost -TargetPort $Port -TimeoutMilliseconds 250)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Start-BlenderMcp {
    if (Test-TcpPort -HostName $McpHost -TargetPort $Port) {
        if (Test-BlenderMcpServer) {
            Write-Host "BlenderMCP is already running at ${McpHost}:$Port."
            return
        }
        throw "Port $Port is already in use, but it is not responding as BlenderMCP."
    }

    $exe = Resolve-BlenderExecutable
    Write-Host "Starting Blender: $exe"

    $pythonExpression = "import bpy; s=bpy.context.scene; p=$Port; running=getattr(s,'blendermcp_server_running',False); current=getattr(s,'blendermcp_port',9876); bpy.ops.blendermcp.stop_server() if running and current != p else None; s.blendermcp_port=p; bpy.ops.blendermcp.start_server() if not getattr(s,'blendermcp_server_running',False) else None"
    $quotedExpression = '"' + $pythonExpression + '"'

    $process = Start-Process -FilePath $exe -ArgumentList @("--python-expr", $quotedExpression) -PassThru

    if (-not (Wait-ForMcpReady -TimeoutSeconds $StartupTimeoutSeconds)) {
        if ($process.HasExited) {
            throw "Blender exited before BlenderMCP became ready. Exit code: $($process.ExitCode)"
        }
        throw "Blender started (PID $($process.Id)), but BlenderMCP did not become ready on port $Port within $StartupTimeoutSeconds seconds. Confirm that the Blender MCP add-on is installed and enabled."
    }

    Write-Host "BlenderMCP is ready at ${McpHost}:$Port (PID $($process.Id))."
}

function Stop-BlenderMcp {
    if (-not (Test-TcpPort -HostName $McpHost -TargetPort $Port)) {
        Write-Host "BlenderMCP is not listening on ${McpHost}:$Port. Nothing was stopped."
        return
    }

    if (-not (Test-BlenderMcpServer)) {
        throw "Port $Port is in use, but it is not responding as BlenderMCP. Refusing to stop any Blender process by PID."
    }

    $identity = Get-BlenderProcessIdentity
    $state = Get-BlenderDirtyState
    if ($state.Dirty -and -not $Force) {
        $target = if ($state.File) { $state.File } else { "an unsaved Blender scene" }
        throw "Blender has unsaved changes ($target). Stop/restart was refused. Save the scene first, or use -Force only when discarding unsaved changes is intended."
    }

    if ($state.Dirty -and $Force) {
        Write-Warning "Discarding unsaved Blender changes because -Force was specified."
    }

    $quitCode = @'
def _devspace_quit_blender():
    bpy.ops.wm.quit_blender()
    return None
bpy.app.timers.register(_devspace_quit_blender, first_interval=0.25)
print('BLENDERMCP_QUIT_SCHEDULED')
'@

    $response = Invoke-BlenderMcpCommand -Type "execute_code" -Params @{ code = $quitCode }
    if ($response.status -ne "success") {
        throw "BlenderMCP could not schedule Blender shutdown: $($response.message)"
    }

    if (-not (Wait-ForMcpStopped -TimeoutSeconds 15)) {
        throw "Blender shutdown was requested, but port $Port is still open after 15 seconds."
    }

    Write-Host "BlenderMCP and Blender PID $($identity.ProcessId) stopped."
}

function Show-BlenderMcpStatus {
    if (-not (Test-TcpPort -HostName $McpHost -TargetPort $Port)) {
        Write-Host "BlenderMCP: stopped (${McpHost}:$Port)"
        $processes = Get-Process blender -ErrorAction SilentlyContinue
        if ($processes) {
            Write-Host "Blender process(es) exist without an MCP listener on this port:"
            $processes | ForEach-Object { Write-Host "  PID=$($_.Id) $($_.Path)" }
        }
        return
    }

    if (-not (Test-BlenderMcpServer)) {
        throw "Port $Port is open, but the service is not responding as BlenderMCP."
    }

    $sceneResponse = Invoke-BlenderMcpCommand -Type "get_scene_info"
    $identity = Get-BlenderProcessIdentity
    $state = Get-BlenderDirtyState
    $scene = $sceneResponse.result
    $fileLabel = if ($state.File) { $state.File } else { "<not saved>" }

    Write-Host "BlenderMCP: running (${McpHost}:$Port)"
    Write-Host "Blender PID: $($identity.ProcessId)"
    Write-Host "Blender executable: $($identity.BinaryPath)"
    Write-Host "Scene: $($scene.name)"
    Write-Host "Objects: $($scene.object_count)"
    Write-Host "File: $fileLabel"
    Write-Host "Unsaved changes: $($state.Dirty)"
}

try {
    switch ($Action) {
        "Start" {
            Start-BlenderMcp
        }
        "Stop" {
            Stop-BlenderMcp
        }
        "Restart" {
            if (Test-TcpPort -HostName $McpHost -TargetPort $Port) {
                Stop-BlenderMcp
            }
            Start-BlenderMcp
        }
        "Status" {
            Show-BlenderMcpStatus
        }
    }
}
catch {
    [Console]::Error.WriteLine("ERROR: " + $_.Exception.Message)
    exit 1
}
