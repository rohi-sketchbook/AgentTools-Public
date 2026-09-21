[CmdletBinding()]
param(
    [string]$Output
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root 'AgentToolsControlCenter.Web.csproj'
$output = if ([string]::IsNullOrWhiteSpace($Output)) { Join-Path $root 'dist' } else { [IO.Path]::GetFullPath($Output) }

& dotnet publish $project -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o $output
if ($LASTEXITCODE -ne 0) {
    throw "Web dashboard publish failed with exit code $LASTEXITCODE."
}

$exe = Join-Path $output 'AgentToolsControlCenter.Web.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Published executable was not found: $exe"
}

Write-Host "Web dashboard release: $exe"
