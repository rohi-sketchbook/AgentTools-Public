[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'dist\AgentToolsControlCenter.Web.exe'

if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Release build is required first. Run Build-Web-Release.ps1: $exe"
}

& $exe
exit $LASTEXITCODE
