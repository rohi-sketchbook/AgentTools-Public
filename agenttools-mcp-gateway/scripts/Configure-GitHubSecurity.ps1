#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter()]
    [string]$Owner = $env:GITHUB_REPOSITORY_OWNER,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$Repository = 'AgentTools',

    [Parameter()]
    [string]$Token = $env:GITHUB_TOKEN
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Owner)) {
    throw 'GitHub repository owner is required. Pass -Owner or set GITHUB_REPOSITORY_OWNER.'
}

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw 'GitHub token is required. Set GITHUB_TOKEN to a fine-grained token with Administration: write for this repository.'
}

$apiVersion = '2026-03-10'
$baseUri = "https://api.github.com/repos/$Owner/$Repository"
$headers = @{
    Accept                 = 'application/vnd.github+json'
    Authorization          = "Bearer $Token"
    'X-GitHub-Api-Version' = $apiVersion
    'User-Agent'           = 'AgentTools-GitHubSecurityConfigurator'
}

function Invoke-GitHubRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('GET', 'PUT')]
        [string]$Method,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Path,

        [Parameter()]
        [AllowNull()]
        [object]$Body = $null
    )

    $parameters = @{
        Uri             = "$baseUri$Path"
        Headers         = $headers
        Method          = $Method
        UseBasicParsing = $true
        ErrorAction     = 'Stop'
    }

    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 10 -Compress
    }

    try {
        return Invoke-WebRequest @parameters
    }
    catch {
        $statusCode = $null
        if ($null -ne $_.Exception.Response) {
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = $null }
        }
        $suffix = if ($null -ne $statusCode) { " HTTP $statusCode." } else { '' }
        throw "GitHub API request failed: $Method $Path.$suffix $($_.Exception.Message)"
    }
}

$target = "$Owner/$Repository"

if ($PSCmdlet.ShouldProcess($target, 'Enable Dependabot alerts and dependency graph')) {
    [void](Invoke-GitHubRequest -Method PUT -Path '/vulnerability-alerts')
}

if ($PSCmdlet.ShouldProcess($target, 'Set default GitHub Actions token permissions to read-only and disable PR approvals')) {
    [void](Invoke-GitHubRequest -Method PUT -Path '/actions/permissions/workflow' -Body @{
        default_workflow_permissions   = 'read'
        can_approve_pull_request_reviews = $false
    })
}

$actionsResponse = Invoke-GitHubRequest -Method GET -Path '/actions/permissions/workflow'
$actionsSettings = $actionsResponse.Content | ConvertFrom-Json

$dependabotAlertsEnabled = $false
try {
    [void](Invoke-GitHubRequest -Method GET -Path '/vulnerability-alerts')
    $dependabotAlertsEnabled = $true
}
catch {
    if ($_.Exception.Message -notmatch 'HTTP 404') { throw }
}

[pscustomobject]@{
    Repository                    = $target
    DependabotAlertsEnabled       = $dependabotAlertsEnabled
    DefaultWorkflowPermissions    = $actionsSettings.default_workflow_permissions
    ActionsCanApprovePullRequests = [bool]$actionsSettings.can_approve_pull_request_reviews
    MalwareAlerts                 = 'Enable separately in GitHub: Settings > Advanced Security > Dependabot malware alerts.'
} | Format-List
