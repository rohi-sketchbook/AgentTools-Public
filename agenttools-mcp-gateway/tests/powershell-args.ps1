[CmdletBinding()]
param(
    [string]$Message,
    [string[]]$Paths,
    [switch]$All,
    [string]$RepoRoot
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[pscustomobject]@{
    Message = $Message
    Paths = @($Paths)
    All = $All.IsPresent
    RepoRoot = $RepoRoot
} | ConvertTo-Json -Compress -Depth 4
