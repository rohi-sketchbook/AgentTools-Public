[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 47832
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root 'AgentToolsControlCenter.Web.csproj'
$builtExe = Join-Path $root 'bin\Release\net10.0-windows\AgentToolsControlCenter.Web.exe'
$baseUrl = "http://127.0.0.1:$Port"

$process = $null
$startedBySmoke = $false
$existing = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $existing) {
    $previousPort = $env:CONTROL_CENTER_WEB_PORT
    try {
        $env:CONTROL_CENTER_WEB_PORT = [string]$Port
        if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) {
            & dotnet build $project -c Release --no-restore
            if ($LASTEXITCODE -ne 0) { throw "Web dashboard smoke build failed with exit code $LASTEXITCODE." }
        }
        $process = Start-Process -FilePath $builtExe -WorkingDirectory $root -PassThru -WindowStyle Hidden
        $startedBySmoke = $true
    }
    finally {
        if ($null -eq $previousPort) { Remove-Item Env:CONTROL_CENTER_WEB_PORT -ErrorAction SilentlyContinue }
        else { $env:CONTROL_CENTER_WEB_PORT = $previousPort }
    }
}
try {
    $deadline = (Get-Date).AddSeconds(15)
    do {
        try {
            $health = Invoke-RestMethod -Uri "$baseUrl/healthz" -TimeoutSec 2
            if ($health.ok -eq $true) { break }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    } while ((Get-Date) -lt $deadline)

    if (-not $health -or $health.ok -ne $true) {
        throw 'Web dashboard did not become healthy.'
    }

    $tasks = Invoke-RestMethod -Uri "$baseUrl/api/tasks" -TimeoutSec 10
    $services = Invoke-RestMethod -Uri "$baseUrl/api/services" -TimeoutSec 50
    $resources = Invoke-RestMethod -Uri "$baseUrl/api/resources" -TimeoutSec 5
    $planUsage = Invoke-RestMethod -Uri "$baseUrl/api/plan-usage" -TimeoutSec 15
    $communications = Invoke-RestMethod -Uri "$baseUrl/api/communications" -TimeoutSec 5
    $skillImprovements = Invoke-RestMethod -Uri "$baseUrl/api/skill-improvements" -TimeoutSec 5
    $actionSession = Invoke-RestMethod -Uri "$baseUrl/api/task-actions/session" -TimeoutSec 5
    $updateStatus = Invoke-RestMethod -Uri "$baseUrl/api/control-center/update-status" -TimeoutSec 20
    $index = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/" -TimeoutSec 5

    if ($index.StatusCode -ne 200) { throw "Dashboard returned HTTP $($index.StatusCode)." }
    if (-not $services.PSObject.Properties.Name.Contains('services')) { throw 'Services payload is incomplete.' }
    if (-not $tasks.PSObject.Properties.Name.Contains('tasks')) { throw 'Tasks payload is incomplete.' }
    if (-not $resources.PSObject.Properties.Name.Contains('cpuPercent')) { throw 'Resources payload is missing CPU data.' }
    if (-not $resources.PSObject.Properties.Name.Contains('ram')) { throw 'Resources payload is missing RAM data.' }
    if (-not $resources.PSObject.Properties.Name.Contains('gpus')) { throw 'Resources payload is missing GPU data.' }
    if (-not $planUsage.PSObject.Properties.Name.Contains('provider')) { throw 'Plan usage payload is missing provider data.' }
    if (-not $planUsage.PSObject.Properties.Name.Contains('refreshedAt')) { throw 'Plan usage payload is missing refresh metadata.' }
    if (-not $communications.PSObject.Properties.Name.Contains('requests') -or -not $communications.PSObject.Properties.Name.Contains('limit')) { throw 'Communication payload is incomplete.' }
    if ([int]$communications.limit -ne 20 -or $communications.requests.Count -gt [int]$communications.limit) { throw 'Communication display limit is not enforced.' }
    if (-not $skillImprovements.PSObject.Properties.Name.Contains('proposals')) { throw 'Skill improvement payload is incomplete.' }
    if (-not $actionSession.csrfToken) { throw 'Task action session did not return a CSRF token.' }
    if (-not $updateStatus.PSObject.Properties.Name.Contains('updateAvailable')) { throw 'Control Center update status payload is incomplete.' }
    if ($index.Content -notmatch 'apply-control-update') { throw 'Control Center update button is missing from the dashboard.' }
    if ($index.Content -notmatch 'plan-usage-list') { throw 'Plan usage dashboard section is missing.' }
    if ($index.Content -notmatch 'communication-list') { throw 'Communication dashboard section is missing.' }
    foreach ($tabId in @('dashboard-tab-tasks', 'dashboard-tab-services', 'dashboard-tab-communications')) {
        if ($index.Content -notmatch [regex]::Escape(('id="' + $tabId + '"'))) { throw "Dashboard tab is missing: $tabId" }
    }
    if ($index.Content -notmatch 'data-dashboard-panel="tasks"' -or $index.Content -notmatch 'data-dashboard-panel="services"' -or $index.Content -notmatch 'data-dashboard-panel="communications"') {
        throw 'Dashboard tab panels are incomplete.'
    }
    if ($index.Content -notmatch 'detail-communication-list') { throw 'Per-task communication history is missing from task detail.' }
    if ($index.Content -notmatch 'task-inspect-detailed') { throw 'Detailed task inspection action is missing.' }
    if ($index.Content -notmatch 'id="task-continue"') { throw 'ChatGPT host continuation action is missing.' }
    if ($index.Content -match 'task-resume-prompt-copy') { throw 'Legacy resume-prompt copy UI is still exposed.' }

    $servicesJson = $services | ConvertTo-Json -Depth 8
    $tasksJson = $tasks | ConvertTo-Json -Depth 8
    $resourcesJson = $resources | ConvertTo-Json -Depth 8
    $planUsageJson = $planUsage | ConvertTo-Json -Depth 8
    $communicationJson = $communications | ConvertTo-Json -Depth 8
    $skillJson = $skillImprovements | ConvertTo-Json -Depth 8
    foreach ($forbidden in @('LogPath', 'WorkspaceRoot', 'Details', 'agentToolsRoot', '"request":', 'workDisplay', 'workersDisplay', 'workLogDisplay', 'skillPath', 'baseContent', 'proposedContent', 'baseHash', 'proposedHash', 'accountId', 'rateLimitsByLimitId', 'rateLimitResetCredits', 'creditId')) {
        if ($servicesJson -match [regex]::Escape($forbidden) -or $tasksJson -match [regex]::Escape($forbidden) -or $resourcesJson -match [regex]::Escape($forbidden) -or $planUsageJson -match [regex]::Escape($forbidden) -or $communicationJson -match [regex]::Escape($forbidden) -or $skillJson -match [regex]::Escape($forbidden)) {
            throw "Public payload contains forbidden field: $forbidden"
        }
    }

    if ($tasks.tasks.Count -gt 0) {
        $taskId = $tasks.tasks[0].id
        $actionHeaders = @{ 'X-Control-Center-CSRF' = $actionSession.csrfToken }
        $inspection = Invoke-RestMethod -Uri "$baseUrl/api/tasks/$taskId/inspect" -Method Post -Headers $actionHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 15
        if ($inspection.ok -ne $true -or -not $inspection.inspection) { throw 'Task inspection payload is incomplete.' }
        $taskCommunications = Invoke-RestMethod -Uri "$baseUrl/api/tasks/$taskId/communications" -TimeoutSec 5
        if ($taskCommunications.taskId -ne $taskId -or [int]$taskCommunications.limit -ne 10 -or $taskCommunications.requests.Count -gt [int]$taskCommunications.limit) {
            throw 'Per-task communication payload is incomplete or unbounded.'
        }
        foreach ($request in $taskCommunications.requests) {
            if ($request.taskId -ne $taskId) { throw 'Per-task communication endpoint returned another task.' }
        }
        $inspectionJson = $inspection | ConvertTo-Json -Depth 8
        foreach ($forbidden in @('"workspaceId":', '"workspaceRoot":', '"request":', '"workLog":')) {
            if ($inspectionJson -match [regex]::Escape($forbidden)) { throw "Public task inspection contains forbidden field: $forbidden" }
        }

        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/tasks/$taskId/continue" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
            throw 'Task continue without CSRF unexpectedly succeeded.'
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 403) { throw }
        }

        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/tasks/$taskId/continue-chatgpt" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
            throw 'ChatGPT host continuation without CSRF unexpectedly succeeded.'
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 403) { throw }
        }

        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/tasks/$taskId/complete" -Method Post -Headers $actionHeaders -ContentType 'application/json' -Body '{"confirm":false}' -TimeoutSec 5 | Out-Null
            throw 'Task complete without explicit confirmation unexpectedly succeeded.'
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 400) { throw }
        }
    }

    $actionHeaders = @{ 'X-Control-Center-CSRF' = $actionSession.csrfToken }
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/control-center/apply-update" -Method Post -Headers $actionHeaders -ContentType 'application/json' -Body '{"confirm":false}' -TimeoutSec 5 | Out-Null
        throw 'Control Center update without explicit confirmation unexpectedly succeeded.'
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 400) { throw }
    }

    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/control-center/apply-update" -Method Post -ContentType 'application/json' -Body '{"confirm":true}' -TimeoutSec 5 | Out-Null
        throw 'Control Center update without CSRF unexpectedly succeeded.'
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 403) { throw }
    }

    foreach ($readOnlyEndpoint in @('/api/services', '/api/plan-usage', '/api/communications', '/api/skill-improvements')) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl$readOnlyEndpoint" -Method Post -TimeoutSec 5 | Out-Null
            throw "POST $readOnlyEndpoint unexpectedly succeeded."
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -notin @(404, 405)) {
                throw
            }
        }
    }

    $headers = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/healthz" -TimeoutSec 5).Headers
    if ($headers['Content-Security-Policy'] -notmatch "default-src 'self'") { throw 'CSP header is missing.' }
    if ($headers['Cache-Control'] -notmatch 'no-store') { throw 'Cache-Control no-store is missing.' }

    Write-Host "Web smoke OK: services=$($services.services.Count) tasks=$($tasks.tasks.Count) communications=$($communications.requests.Count) skillProposals=$($skillImprovements.proposals.Count) gpus=$($resources.gpus.Count) plan=$($planUsage.planType)"
} finally {
    if ($startedBySmoke -and $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}
