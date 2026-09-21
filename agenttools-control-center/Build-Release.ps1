[CmdletBinding()]
param(
    [string]$Output
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root 'AgentToolsControlCenter.csproj'
$output = if ([string]::IsNullOrWhiteSpace($Output)) { Join-Path $root 'dist' } else { [IO.Path]::GetFullPath($Output) }

Write-Host "Building AgentTools Control Center..."
dotnet publish $project `
    -c Release `
    -r win-x64 `
    --self-contained false `
    -p:PublishSingleFile=true `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    -o $output

if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

$exe = Join-Path $output 'AgentToolsControlCenter.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Published executable was not found: $exe"
}

Write-Host "Built: $exe"
