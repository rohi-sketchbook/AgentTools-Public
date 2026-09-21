[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TexturePath,

    [ValidateSet('Color', 'BaseColor', 'Emission', 'Normal', 'Roughness', 'Metallic', 'AmbientOcclusion', 'Alpha', 'Mask', 'Height', 'Data')]
    [string]$TextureKind = 'Color',

    [string]$ImageName = '',

    [ValidateRange(1024, 65535)]
    [int]$Port = 9876,

    [switch]$Pack,
    [switch]$UseFakeUser,
    [switch]$Reload,
    [string]$WorkspaceRoot = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\common\PathSafety.ps1')
$McpHost = '127.0.0.1'

function Resolve-WorkspaceRoot {
    param([string]$Value)
    $candidate = $Value
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = $env:AGENTTOOLS_WORKSPACE_ROOT }
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = (Get-Location).Path }
    $full = [System.IO.Path]::GetFullPath($candidate).TrimEnd([char[]]@(92, 47))
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw ('WorkspaceRoot does not exist: ' + $full) }
    return $full
}

function Resolve-PathInsideWorkspace {
    param([string]$Root, [string]$Value)
    return Resolve-AgentToolsPathInsideWorkspace -Root $Root -Value $Value -Label 'TexturePath'
}

function Test-TcpPort {
    param([string]$HostName, [int]$TargetPort, [int]$TimeoutMilliseconds = 500)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $client.BeginConnect($HostName, $TargetPort, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) { return $false }
        $client.EndConnect($asyncResult)
        return $true
    }
    catch { return $false }
    finally { $client.Close() }
}

function Invoke-BlenderMcpCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Type,
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
        $request = [ordered]@{ type = $Type; params = $Params }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress -Depth 20))
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()

        $buffer = New-Object byte[] 8192
        $builder = New-Object System.Text.StringBuilder
        while ($true) {
            $count = $stream.Read($buffer, 0, $buffer.Length)
            if ($count -le 0) { break }
            [void]$builder.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $count))
            try { return ($builder.ToString() | ConvertFrom-Json) } catch { }
        }
        throw 'BlenderMCP closed the connection before a complete JSON response was received.'
    }
    finally { $client.Close() }
}

function Test-BlenderMcpServer {
    try {
        $response = Invoke-BlenderMcpCommand -Type 'get_scene_info' -TimeoutMilliseconds 1500
        return ($response.status -eq 'success')
    }
    catch { return $false }
}

function Get-DesiredColorSpace {
    param([string]$Kind)
    switch ($Kind) {
        'Color' { return 'sRGB' }
        'BaseColor' { return 'sRGB' }
        'Emission' { return 'sRGB' }
        default { return 'Non-Color' }
    }
}

try {
    $workspace = Resolve-WorkspaceRoot $WorkspaceRoot
    $fullTexturePath = Resolve-PathInsideWorkspace $workspace $TexturePath
    if (-not (Test-Path -LiteralPath $fullTexturePath -PathType Leaf)) { throw ('Texture file not found: ' + $fullTexturePath) }
    if (-not (Test-TcpPort -HostName $McpHost -TargetPort $Port)) { throw "BlenderMCP is not listening on ${McpHost}:$Port." }
    if (-not (Test-BlenderMcpServer)) { throw "Port $Port is open but is not responding as BlenderMCP." }

    $desiredColorSpace = Get-DesiredColorSpace $TextureKind
    $textureLiteral = $fullTexturePath | ConvertTo-Json -Compress
    $imageNameLiteral = if ([string]::IsNullOrWhiteSpace($ImageName)) { 'None' } else { ($ImageName | ConvertTo-Json -Compress) }
    $colorLiteral = $desiredColorSpace | ConvertTo-Json -Compress
    $packLiteral = if ($Pack.IsPresent) { 'True' } else { 'False' }
    $fakeLiteral = if ($UseFakeUser.IsPresent) { 'True' } else { 'False' }
    $reloadLiteral = if ($Reload.IsPresent) { 'True' } else { 'False' }

    $pythonLines = @(
        'import bpy, os',
        ('texture_path = ' + $textureLiteral),
        ('image_name = ' + $imageNameLiteral),
        ('color_space = ' + $colorLiteral),
        ('pack_image = ' + $packLiteral),
        ('use_fake_user = ' + $fakeLiteral),
        ('reload_image = ' + $reloadLiteral),
        "if not os.path.isfile(texture_path): raise RuntimeError('Texture file not found: ' + texture_path)",
        'image = bpy.data.images.load(texture_path, check_existing=True)',
        'if reload_image:',
        '    try: image.reload()',
        '    except Exception: pass',
        'if image_name: image.name = image_name',
        'try: image.colorspace_settings.name = color_space',
        'except Exception: pass',
        'image.use_fake_user = use_fake_user',
        'if pack_image and not image.packed_file: image.pack()',
        "print('BLENDERMCP_TEXTURE_NAME=' + image.name)",
        "print('BLENDERMCP_TEXTURE_FILE=' + bpy.path.abspath(image.filepath))",
        "print('BLENDERMCP_TEXTURE_COLORSPACE=' + image.colorspace_settings.name)",
        "print('BLENDERMCP_TEXTURE_PACKED=' + ('1' if image.packed_file else '0'))"
    )
    $response = Invoke-BlenderMcpCommand -Type 'execute_code' -Params @{ code = ($pythonLines -join "`n") }
    if ($response.status -ne 'success') { throw ('BlenderMCP could not import texture: ' + $response.message) }

    $output = [string]$response.result.result
    $name = [regex]::Match($output, '(?m)^BLENDERMCP_TEXTURE_NAME=(.*)$')
    $file = [regex]::Match($output, '(?m)^BLENDERMCP_TEXTURE_FILE=(.*)$')
    $color = [regex]::Match($output, '(?m)^BLENDERMCP_TEXTURE_COLORSPACE=(.*)$')
    $packed = [regex]::Match($output, '(?m)^BLENDERMCP_TEXTURE_PACKED=(.*)$')
    Write-Host ('[BlenderTextureImport] Imported: ' + $(if ($name.Success) { $name.Groups[1].Value.Trim() } else { '' }))
    Write-Host ('[BlenderTextureImport] File: ' + $(if ($file.Success) { $file.Groups[1].Value.Trim() } else { $fullTexturePath }))
    Write-Host ('[BlenderTextureImport] TextureKind: ' + $TextureKind)
    Write-Host ('[BlenderTextureImport] ColorSpace: ' + $(if ($color.Success) { $color.Groups[1].Value.Trim() } else { $desiredColorSpace }))
    Write-Host ('[BlenderTextureImport] Packed: ' + $(if ($packed.Success -and $packed.Groups[1].Value.Trim() -eq '1') { 'True' } else { 'False' }))
}
catch {
    [Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)
    exit 1
}
