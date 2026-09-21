[CmdletBinding()]
param(
    [ValidateSet('Status', 'Finalize')]
    [string]$Action = 'Status',

    [string]$TransferId = '',
    [string]$OutputName = '',
    [string]$OutputPath = '',

    [ValidateSet('Color', 'BaseColor', 'Emission', 'Normal', 'Roughness', 'Metallic', 'AmbientOcclusion', 'Alpha', 'Mask', 'Height', 'Data')]
    [string]$TextureKind = 'Color',

    [string]$ImageName = '',
    [switch]$ImportToBlender,
    [switch]$Pack,
    [switch]$UseFakeUser,
    [switch]$Reload,
    [switch]$Force,
    [switch]$Cleanup,

    [ValidateRange(1024, 65535)]
    [int]$Port = 9876,

    [ValidateRange(1, 1073741824)]
    [long]$MaxDecodedBytes = 67108864,
    [string]$WorkspaceRoot = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\common\PathSafety.ps1')

function Resolve-WorkspaceRoot {
    param([string]$Value)
    $candidate = $Value
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = $env:AGENTTOOLS_WORKSPACE_ROOT }
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = (Get-Location).Path }
    $full = [System.IO.Path]::GetFullPath($candidate).TrimEnd([char[]]@(92, 47))
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw ('WorkspaceRoot does not exist: ' + $full) }
    return $full
}

function Assert-TransferId {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'TransferId is required.' }
    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'Invalid TransferId.' }
}

function Resolve-PathInsideWorkspace {
    param([string]$Root, [string]$Value, [string]$Label)
    return Resolve-AgentToolsPathInsideWorkspace -Root $Root -Value $Value -Label $Label
}

function Read-Manifest {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
    catch { throw ('Invalid manifest.json: ' + $_.Exception.Message) }
}

function Get-ManifestValue {
    param([object]$Manifest, [string]$Name)
    if ($null -eq $Manifest) { return $null }
    $property = $Manifest.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-DefaultExtension {
    param([string]$ContentType)
    switch ($ContentType.ToLowerInvariant()) {
        'image/jpeg' { return '.jpg' }
        'image/webp' { return '.webp' }
        'image/gif' { return '.gif' }
        default { return '.png' }
    }
}

try {
    Assert-TransferId $TransferId
    $workspace = Resolve-WorkspaceRoot $WorkspaceRoot
    $transferDirectory = Join-Path (Join-Path $workspace 'UserData\Temp\ChatGPTImageBridge\inbox') $TransferId
    $manifest = Read-Manifest (Join-Path $transferDirectory 'manifest.json')

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $resolvedOutput = Resolve-PathInsideWorkspace $workspace $OutputPath 'OutputPath'
    }
    else {
        $fileName = ''
        if (-not [string]::IsNullOrWhiteSpace($OutputName)) {
            $fileName = [System.IO.Path]::GetFileName($OutputName)
        }
        elseif ($null -ne $manifest) {
            $manifestOutput = [string](Get-ManifestValue $manifest 'outputPath')
            if (-not [string]::IsNullOrWhiteSpace($manifestOutput)) { $fileName = [System.IO.Path]::GetFileName($manifestOutput) }
        }
        if ([string]::IsNullOrWhiteSpace($fileName)) {
            $contentType = [string](Get-ManifestValue $manifest 'contentType')
            $fileName = $TransferId + (Get-DefaultExtension $contentType)
        }
        $resolvedOutput = Resolve-PathInsideWorkspace $workspace (Join-Path 'UserData\Temp\BlenderMCP\Textures' $fileName) 'TextureOutputPath'
    }

    $receiveScript = Join-Path $PSScriptRoot 'Receive-ChatGPTImage.ps1'
    $blenderImportScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\blender-mcp\scripts\Import-BlenderTexture.ps1'))

    if ($Action -eq 'Status') {
        Write-Host ('[ChatGPTTextureBridge] Workspace: ' + $workspace)
        Write-Host ('[ChatGPTTextureBridge] Target: ' + $resolvedOutput)
        if ($ImportToBlender.IsPresent) { Write-Host ('[ChatGPTTextureBridge] Post action: Blender import as ' + $TextureKind) }
        & $receiveScript -Action Status -TransferId $TransferId -WorkspaceRoot $workspace
        if (-not $?) { exit 1 }
        exit 0
    }

    $receiveArgs = @{
        Action = 'Finalize'
        TransferId = $TransferId
        OutputPath = $resolvedOutput
        MaxDecodedBytes = $MaxDecodedBytes
        WorkspaceRoot = $workspace
    }
    if ($Force.IsPresent) { $receiveArgs['Force'] = $true }
    if ($Cleanup.IsPresent) { $receiveArgs['Cleanup'] = $true }
    & $receiveScript @receiveArgs
    if (-not $?) { throw 'Receive-ChatGPTImage.ps1 failed.' }

    if ($ImportToBlender.IsPresent) {
        if (-not (Test-Path -LiteralPath $blenderImportScript -PathType Leaf)) { throw ('Blender import tool not found: ' + $blenderImportScript) }
        $importArgs = @{
            TexturePath = $resolvedOutput
            TextureKind = $TextureKind
            Port = $Port
            WorkspaceRoot = $workspace
        }
        if (-not [string]::IsNullOrWhiteSpace($ImageName)) { $importArgs['ImageName'] = $ImageName }
        if ($Pack.IsPresent) { $importArgs['Pack'] = $true }
        if ($UseFakeUser.IsPresent) { $importArgs['UseFakeUser'] = $true }
        if ($Reload.IsPresent) { $importArgs['Reload'] = $true }
        & $blenderImportScript @importArgs
        if (-not $?) { throw 'Import-BlenderTexture.ps1 failed.' }
    }
}
catch {
    [Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)
    exit 1
}
