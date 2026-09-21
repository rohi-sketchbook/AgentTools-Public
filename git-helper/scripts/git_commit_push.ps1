[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Message,

    [string[]]$Paths,
    [switch]$All,
    [switch]$Push,
    [string]$Remote = 'origin',
    [switch]$IncludeExistingStaged,
    [switch]$DryRun,
    [string]$Branch = '',
    [string]$UserName = '',
    [string]$UserEmail = '',
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-RepoRoot {
    param([string]$Value)
    $candidate = $Value
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = $env:AGENTTOOLS_WORKSPACE_ROOT }
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = (Get-Location).Path }
    $full = (Resolve-Path -LiteralPath $candidate).Path
    return $full
}

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$AllowFailure)
    & git -C $RepoRoot @Arguments
    $exitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $exitCode."
    }
    return $exitCode
}

function Get-GitOutput {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $output = & git -C $RepoRoot @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed.`n$($output -join [Environment]::NewLine)" }
    return @($output)
}

function Assert-RepositoryState {
    $inside = (Get-GitOutput -Arguments @('rev-parse', '--is-inside-work-tree') | Select-Object -First 1).ToString().Trim()
    if ($inside -ne 'true') { throw "Not a Git working tree: $RepoRoot" }

    $gitDirRelative = (Get-GitOutput -Arguments @('rev-parse', '--git-dir') | Select-Object -First 1).ToString().Trim()
    $gitDir = if ([System.IO.Path]::IsPathRooted($gitDirRelative)) { $gitDirRelative } else { Join-Path $RepoRoot $gitDirRelative }
    foreach ($statePath in @(
        (Join-Path $gitDir 'MERGE_HEAD'),
        (Join-Path $gitDir 'CHERRY_PICK_HEAD'),
        (Join-Path $gitDir 'REVERT_HEAD'),
        (Join-Path $gitDir 'rebase-merge'),
        (Join-Path $gitDir 'rebase-apply')
    )) {
        if (Test-Path -LiteralPath $statePath) { throw "Git operation is already in progress: $statePath" }
    }
}

function Invoke-AgentToolsSkillAutoSync {
    param([Parameter(Mandatory = $true)][string]$CommitHash)

    $agentToolsRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\')
    $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path.TrimEnd('\')
    if (-not [string]::Equals($resolvedRepoRoot, $agentToolsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    $installer = Join-Path $agentToolsRoot 'install-agenttools-skills.ps1'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        Write-Warning "AgentTools Skill auto-sync skipped: installer not found: $installer"
        return
    }

    try {
        & $installer -AutoSyncCommit $CommitHash
    }
    catch {
        Write-Warning ('AgentTools Skill auto-sync failed after commit ' + $CommitHash + ': ' + $_.Exception.Message)
    }
}

$RepoRoot = Resolve-RepoRoot $RepoRoot

if ($All -and $Paths -and $Paths.Count -gt 0) { throw 'Use either -All or -Paths, not both.' }
if (-not $All -and (-not $Paths -or $Paths.Count -eq 0)) { throw 'Specify the commit target with -All or -Paths <path1>,<path2>.' }
if ([string]::IsNullOrWhiteSpace($Message)) { throw 'Commit message must not be empty.' }
if ([string]::IsNullOrWhiteSpace($UserName) -xor [string]::IsNullOrWhiteSpace($UserEmail)) {
    throw 'Specify both -UserName and -UserEmail, or neither.'
}

Assert-RepositoryState
$currentBranch = (& git -C $RepoRoot symbolic-ref --quiet --short HEAD 2>$null)
$isDetached = $LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentBranch)
$requestedBranch = if ([string]::IsNullOrWhiteSpace($Branch)) { '' } else { $Branch.Trim() }
$branchAction = $null

if ($isDetached) {
    if ([string]::IsNullOrWhiteSpace($requestedBranch)) {
        throw 'Detached HEAD requires an explicit -Branch value.'
    }
    & git -C $RepoRoot check-ref-format --branch $requestedBranch *> $null
    if ($LASTEXITCODE -ne 0) { throw "Invalid branch name: $requestedBranch" }

    $headCommit = (Get-GitOutput -Arguments @('rev-parse', 'HEAD') | Select-Object -First 1).ToString().Trim()
    & git -C $RepoRoot show-ref --verify --quiet "refs/heads/$requestedBranch"
    $branchExists = $LASTEXITCODE -eq 0
    if ($branchExists) {
        $existingBranchCommit = (Get-GitOutput -Arguments @('rev-parse', "refs/heads/$requestedBranch") | Select-Object -First 1).ToString().Trim()
        if ($existingBranchCommit -ne $headCommit) {
            throw "Branch '$requestedBranch' points to $existingBranchCommit, but detached HEAD is $headCommit. Refusing to move it implicitly."
        }
        $branchAction = @('switch', $requestedBranch)
    } else {
        $branchAction = @('switch', '-c', $requestedBranch)
    }
    $branch = $requestedBranch
} else {
    $currentBranch = $currentBranch.Trim()
    if (-not [string]::IsNullOrWhiteSpace($requestedBranch) -and $requestedBranch -ne $currentBranch) {
        & git -C $RepoRoot check-ref-format --branch $requestedBranch *> $null
        if ($LASTEXITCODE -ne 0) { throw "Invalid branch name: $requestedBranch" }
        & git -C $RepoRoot show-ref --verify --quiet "refs/heads/$requestedBranch"
        if ($LASTEXITCODE -eq 0) {
            throw "Branch '$requestedBranch' already exists; refusing to switch an attached checkout implicitly."
        }
        $branchAction = @('switch', '-c', $requestedBranch)
        $branch = $requestedBranch
    } else {
        $branch = $currentBranch
    }
}

$existingStaged = @(& git -C $RepoRoot diff --cached --name-only)
if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect staged changes.' }
if ($existingStaged.Count -gt 0 -and -not $IncludeExistingStaged) {
    Write-Host 'Existing staged changes were found:' -ForegroundColor Yellow
    $existingStaged | ForEach-Object { Write-Host "  $_" }
    throw 'Refusing to mix existing staged changes. Commit/unstage them first, or pass -IncludeExistingStaged explicitly.'
}

$status = @(& git -C $RepoRoot status --short)
if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect working tree status.' }
if ($status.Count -eq 0 -and $existingStaged.Count -eq 0) { Write-Host 'Nothing to commit.'; exit 0 }

Write-Host "Repository : $RepoRoot"
Write-Host "Branch     : $branch"
Write-Host "Commit     : $Message"
Write-Host "Push       : $($Push.IsPresent)"
Write-Host "Remote     : $Remote"
if ($branchAction) { Write-Host "Branch setup: git $($branchAction -join ' ')" }
if (-not [string]::IsNullOrWhiteSpace($UserName)) { Write-Host "Identity   : $UserName <$UserEmail> (repository local)" }
Write-Host ''
Write-Host 'Current status:'
$status | ForEach-Object { Write-Host "  $_" }
Write-Host ''

if ($DryRun) {
    if ($branchAction) { Write-Host ('[DRY RUN] git ' + ($branchAction -join ' ')) }
    if (-not [string]::IsNullOrWhiteSpace($UserName)) {
        Write-Host ('[DRY RUN] git config --local user.name "' + $UserName + '"')
        Write-Host ('[DRY RUN] git config --local user.email "' + $UserEmail + '"')
    }
    if ($All) { Write-Host '[DRY RUN] git add -A' } else { Write-Host ('[DRY RUN] git add -- ' + ($Paths -join ' ')) }
    Write-Host ('[DRY RUN] git commit -m "' + $Message + '"')
    if ($Push) { Write-Host "[DRY RUN] git push $Remote $branch" }
    exit 0
}

if ($branchAction) {
    Invoke-Git -Arguments $branchAction | Out-Null
}
if (-not [string]::IsNullOrWhiteSpace($UserName)) {
    Invoke-Git -Arguments @('config', '--local', 'user.name', $UserName) | Out-Null
    Invoke-Git -Arguments @('config', '--local', 'user.email', $UserEmail) | Out-Null
}

if ($All) {
    Invoke-Git -Arguments @('add', '-A') | Out-Null
} else {
    Invoke-Git -Arguments (@('add', '--') + $Paths) | Out-Null
}

& git -C $RepoRoot diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host 'No staged changes matched the requested target. Nothing to commit.'; exit 0 }
if ($LASTEXITCODE -ne 1) { throw "Failed to inspect staged diff. Exit code: $LASTEXITCODE" }

Write-Host 'Staged changes:'
& git -C $RepoRoot status --short
if ($LASTEXITCODE -ne 0) { throw 'Failed to display staged status.' }
& git -C $RepoRoot diff --cached --stat
if ($LASTEXITCODE -ne 0) { throw 'Failed to display staged diff summary.' }

Invoke-Git -Arguments @('commit', '-m', $Message) | Out-Null
$commitHash = (Get-GitOutput -Arguments @('rev-parse', '--short', 'HEAD') | Select-Object -First 1).ToString().Trim()
Write-Host "Committed: $commitHash" -ForegroundColor Green
Invoke-AgentToolsSkillAutoSync -CommitHash $commitHash

if (-not $Push) { Write-Host 'Push was not requested. The commit remains local.'; exit 0 }
$remoteCheck = & git -C $RepoRoot remote get-url $Remote 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($remoteCheck | Select-Object -First 1))) {
    throw "Remote '$Remote' does not exist. Commit $commitHash was created locally, but was not pushed."
}
Write-Host "Pushing $branch to $Remote..."
Invoke-Git -Arguments @('push', $Remote, $branch) | Out-Null
Write-Host "Pushed: $Remote/$branch ($commitHash)" -ForegroundColor Green
