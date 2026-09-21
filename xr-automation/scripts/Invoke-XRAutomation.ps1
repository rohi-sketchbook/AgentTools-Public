[CmdletBinding(PositionalBinding = $true)]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'metavr', 'metavr-mcp', 'mcpbridge-status', 'mcpbridge-tools', 'mcpbridge-menu', 'mcpbridge-call')]
    [string]$Action = 'status',

    [string]$ProjectRoot,

    [string]$MenuPath,

    [string]$ToolName,

    [string]$MethodName,

    [string]$ArgumentsJson = '{}',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments = @()
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-CommandInfo {
    param([string[]]$Names)

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $command) {
            return $command
        }
    }
    return $null
}

function Get-NodeState {
    $node = Get-CommandInfo @('node.exe', 'node')
    $npx = Get-CommandInfo @('npx.cmd', 'npx')
    $nodeVersion = $null
    $nodeMajor = $null

    if ($null -ne $node) {
        $rawVersion = (& $node.Source --version 2>$null | Select-Object -First 1)
        if ($rawVersion -match '^v?(\d+)\.') {
            $nodeVersion = $rawVersion.Trim()
            $nodeMajor = [int]$Matches[1]
        }
    }

    [pscustomobject]@{
        nodeAvailable = $null -ne $node
        nodePath = if ($null -ne $node) { $node.Source } else { $null }
        nodeVersion = $nodeVersion
        nodeMeetsMetaVrRequirement = $null -ne $nodeMajor -and $nodeMajor -ge 20
        npxAvailable = $null -ne $npx
        npxPath = if ($null -ne $npx) { $npx.Source } else { $null }
    }
}

function Get-McpBridgeDiscovery {
    param([string]$Root)

    $normalizedRoot = if ([string]::IsNullOrWhiteSpace($Root)) { $null } else { [System.IO.Path]::GetFullPath($Root).TrimEnd('\\').Replace('\\', '/') }
    $candidates = Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Filter 'mcpbridge_*.info' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending

    foreach ($candidate in $candidates) {
        try {
            $info = Get-Content -LiteralPath $candidate.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -eq $info.port -or [string]::IsNullOrWhiteSpace([string]$info.token)) { continue }
            if ($null -ne $normalizedRoot) {
                $candidateRoot = [System.IO.Path]::GetFullPath([string]$info.projectPath).TrimEnd('\\').Replace('\\', '/')
                if (-not $candidateRoot.Equals($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            }
            $process = Get-Process -Id ([int]$info.pid) -ErrorAction SilentlyContinue
            if ($null -eq $process) { continue }
            return [pscustomobject]@{
                path = $candidate.FullName
                port = [int]$info.port
                token = [string]$info.token
                projectPath = [string]$info.projectPath
                unityVersion = [string]$info.unityVersion
                pid = [int]$info.pid
            }
        }
        catch {
            continue
        }
    }

    return $null
}

function Invoke-McpBridgeRequest {
    param(
        [Parameter(Mandatory = $true)][object]$Discovery,
        [Parameter(Mandatory = $true)][string]$Method,
        [object]$Parameters = $null,
        [int]$Id = 1
    )

    $payload = [ordered]@{
        jsonrpc = '2.0'
        id = $Id
        method = $Method
    }
    if ($null -ne $Parameters) {
        $payload.params = $Parameters
    }

    $headers = @{ Authorization = 'Bearer ' + $Discovery.token }
    $uri = 'http://127.0.0.1:' + $Discovery.port + '/mcpbridge/'
    $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 20 -Compress) -TimeoutSec 10
    $errorProperty = $response.PSObject.Properties['error']
    if ($null -ne $errorProperty -and $null -ne $errorProperty.Value) {
        $errorValue = $errorProperty.Value
        throw ('MCPBridge error ' + $errorValue.code + ': ' + $errorValue.message)
    }
    $resultProperty = $response.PSObject.Properties['result']
    if ($null -eq $resultProperty) {
        throw 'MCPBridge response did not contain a result property.'
    }
    return $resultProperty.Value
}

function Require-Npx {
    $state = Get-NodeState
    if (-not $state.nodeAvailable) {
        throw 'Node.js was not found. Meta VR CLI requires Node.js.'
    }
    if (-not $state.nodeMeetsMetaVrRequirement) {
        throw ('Node.js 20+ is required for the supported Meta VR CLI workflow. Detected: ' + $state.nodeVersion)
    }
    if (-not $state.npxAvailable) {
        throw 'npx was not found.'
    }
    return $state.npxPath
}

switch ($Action) {
    'status' {
        $state = [pscustomobject]@{
            tool = 'xr-automation'
            root = Split-Path -Parent $PSScriptRoot
            node = Get-NodeState
            metaVrCli = [pscustomobject]@{
                invocation = 'npx -y metavr'
                installModel = 'on-demand; not globally installed by xr-automation'
                mcpCommand = 'npx -y metavr mcp server --no-telemetry'
            }
            backgroundService = $false
        }
        $state | ConvertTo-Json -Depth 6
        exit 0
    }

    'mcpbridge-status' {
        $discovery = Get-McpBridgeDiscovery -Root $ProjectRoot
        if ($null -eq $discovery) {
            [pscustomobject]@{ ok = $false; connected = $false; projectRoot = $ProjectRoot } | ConvertTo-Json -Depth 4
            exit 5
        }
        [pscustomobject]@{
            ok = $true
            connected = $true
            projectPath = $discovery.projectPath
            unityVersion = $discovery.unityVersion
            pid = $discovery.pid
            port = $discovery.port
        } | ConvertTo-Json -Depth 4
        exit 0
    }

    'mcpbridge-tools' {
        $discovery = Get-McpBridgeDiscovery -Root $ProjectRoot
        if ($null -eq $discovery) {
            throw 'No live Unity MCPBridge discovery entry was found for the requested project.'
        }
        [void](Invoke-McpBridgeRequest -Discovery $discovery -Method 'initialize' -Parameters ([ordered]@{
            protocolVersion = '2024-11-05'
            capabilities = @{}
            clientInfo = [ordered]@{ name = 'agenttools-xr-automation'; version = '0.1' }
        }) -Id 1)
        $toolsResult = Invoke-McpBridgeRequest -Discovery $discovery -Method 'tools/list' -Id 2
        $tools = @($toolsResult.tools)
        [pscustomobject]@{
            ok = $true
            projectPath = $discovery.projectPath
            port = $discovery.port
            toolCount = $tools.Count
            tools = @($tools | ForEach-Object {
                [pscustomobject]@{
                    name = $_.name
                    description = $_.description
                    inputSchema = $_.inputSchema
                }
            })
        } | ConvertTo-Json -Depth 20
        exit 0
    }

    'mcpbridge-menu' {
        if ([string]::IsNullOrWhiteSpace($MenuPath)) {
            throw 'mcpbridge-menu requires -MenuPath <Unity menu path>.'
        }
        $discovery = Get-McpBridgeDiscovery -Root $ProjectRoot
        if ($null -eq $discovery) {
            throw 'No live Unity MCPBridge discovery entry was found for the requested project.'
        }
        $result = Invoke-McpBridgeRequest -Discovery $discovery -Method 'tools/call' -Parameters ([ordered]@{
            name = 'UIVerificationTools'
            arguments = [ordered]@{
                method = 'ExecuteMenuItem'
                menuPath = $MenuPath
            }
        }) -Id 3
        [pscustomobject]@{
            ok = $true
            projectPath = $discovery.projectPath
            menuPath = $MenuPath
            result = $result
        } | ConvertTo-Json -Depth 12
        exit 0
    }

    'mcpbridge-call' {
        if ([string]::IsNullOrWhiteSpace($ToolName)) {
            throw 'mcpbridge-call requires -ToolName <tool name>.'
        }
        if ([string]::IsNullOrWhiteSpace($MethodName)) {
            throw 'mcpbridge-call requires -MethodName <method name>.'
        }
        $discovery = Get-McpBridgeDiscovery -Root $ProjectRoot
        if ($null -eq $discovery) {
            throw 'No live Unity MCPBridge discovery entry was found for the requested project.'
        }
        $toolArguments = $ArgumentsJson | ConvertFrom-Json
        $argumentMap = [ordered]@{ method = $MethodName }
        foreach ($property in @($toolArguments.PSObject.Properties)) {
            $argumentMap[$property.Name] = $property.Value
        }
        $result = Invoke-McpBridgeRequest -Discovery $discovery -Method 'tools/call' -Parameters ([ordered]@{
            name = $ToolName
            arguments = $argumentMap
        }) -Id 4
        [pscustomobject]@{
            ok = $true
            projectPath = $discovery.projectPath
            tool = $ToolName
            method = $MethodName
            result = $result
        } | ConvertTo-Json -Depth 20
        exit 0
    }

    'metavr' {
        $npx = Require-Npx
        & $npx -y metavr @Arguments
        exit $LASTEXITCODE
    }

    'metavr-mcp' {
        $npx = Require-Npx
        & $npx -y metavr mcp server @Arguments
        exit $LASTEXITCODE
    }
}
