[CmdletBinding()]
param(
    [switch]$DryRun,
    [string[]]$OnlySkill,
    [string]$AutoSyncCommit = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$toolRoot = $PSScriptRoot
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'

function Write-Utf8File {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Resolve-InstalledContent {
    param([AllowEmptyString()][string]$Content)
    $resolved = $Content.Replace('<AgentToolsRoot>', $toolRoot)
    $resolved = $resolved.Replace('<UserProfile>', $env:USERPROFILE)
    return $resolved
}

function Remove-MarkedBlock {
    param([AllowEmptyString()][string]$Content, [string]$BeginMarker, [string]$EndMarker)
    $pattern = '(?s)\s*' + [Regex]::Escape($BeginMarker) + '.*?' + [Regex]::Escape($EndMarker) + '\s*'
    if ([Regex]::IsMatch($Content, $pattern)) {
        return [Regex]::Replace($Content, $pattern, [Environment]::NewLine + [Environment]::NewLine)
    }
    return $Content
}

function Update-MarkedBlock {
    param([AllowEmptyString()][string]$Content, [string]$BeginMarker, [string]$EndMarker, [string]$Block)
    $pattern = '(?s)' + [Regex]::Escape($BeginMarker) + '.*?' + [Regex]::Escape($EndMarker)
    if ([Regex]::IsMatch($Content, $pattern)) {
        return [Regex]::Replace($Content, $pattern, $Block.Trim())
    }
    if ([string]::IsNullOrWhiteSpace($Content)) {
        return $Block.Trim() + [Environment]::NewLine
    }
    return $Content.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $Block.Trim() + [Environment]::NewLine
}

$skills = @(
    [pscustomobject]@{ Name = 'work-task'; Source = Join-Path $toolRoot 'agenttools-mcp-gateway\skill\SKILL.md' },
    [pscustomobject]@{
        Name = 'unity-official'
        Source = Join-Path $toolRoot 'unity-official\skill\SKILL.md'
        References = @(
            [pscustomobject]@{ Source = Join-Path $toolRoot 'unity-official\references\validate-urp-render-graph-renderer-feature\GUIDE.md'; Destination = 'references\validate-urp-render-graph-renderer-feature\GUIDE.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'unity-official\references\urp-postprocessing\GUIDE.md'; Destination = 'references\urp-postprocessing\GUIDE.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'unity-official\references\ui\GUIDE.md'; Destination = 'references\ui\GUIDE.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'unity-official\references\shader-graph-create-custom-node\GUIDE.md'; Destination = 'references\shader-graph-create-custom-node\GUIDE.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'unity-official\references\unity-package-management\GUIDE.md'; Destination = 'references\unity-package-management\GUIDE.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'unity-official\references\physics-3d-collision\GUIDE.md'; Destination = 'references\physics-3d-collision\GUIDE.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'unity-official\SOURCE.md'; Destination = 'SOURCE.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'unity-official\LICENSE.md'; Destination = 'LICENSE.md' }
        )
    },
    [pscustomobject]@{ Name = 'skill-improvement'; Source = Join-Path $toolRoot 'agenttools-mcp-gateway\skill-improvement\SKILL.md' },
    [pscustomobject]@{ Name = 'discord-bot'; Source = Join-Path $toolRoot 'discord-bot\discord-codex-bridge\skills\discord-bot\SKILL.md' },
    [pscustomobject]@{
        Name = 'blender-mcp'
        Source = Join-Path $toolRoot 'blender-mcp\skill\SKILL.md'
        References = @(
            [pscustomobject]@{ Source = Join-Path $toolRoot 'docs\agent-guides\blender_agent_general.md'; Destination = 'references\blender_agent_general.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'docs\agent-guides\blender_validation_views.md'; Destination = 'references\blender_validation_views.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'docs\agent-guides\blender_sol_supervision.md'; Destination = 'references\blender_sol_supervision.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'docs\agent-guides\blender_unity_vbg_export.md'; Destination = 'references\blender_unity_vbg_export.md' },
            [pscustomobject]@{ Source = Join-Path $toolRoot 'docs\agent-guides\blender_crystal_runway_studio.md'; Destination = 'references\blender_crystal_runway_studio.md' }
        )
    },
    [pscustomobject]@{ Name = 'local-ai'; Source = Join-Path $toolRoot 'local-ai\skill\SKILL.md' },
    [pscustomobject]@{ Name = 'image-bridge'; Source = Join-Path $toolRoot 'image-bridge\skill\SKILL.md' },
    [pscustomobject]@{ Name = 'windows-ui'; Source = Join-Path $toolRoot 'windows-ui\skill\SKILL.md' },
    [pscustomobject]@{ Name = 'xr-automation'; Source = Join-Path $toolRoot 'xr-automation\skill\SKILL.md' },
    [pscustomobject]@{ Name = 'git-helper'; Source = Join-Path $toolRoot 'git-helper\skill\SKILL.md' },
    [pscustomobject]@{ Name = 'codex-mode'; Source = Join-Path $toolRoot 'codex-mode\skill\SKILL.md' },
    [pscustomobject]@{ Name = 'remotion-video'; Source = Join-Path $toolRoot 'remotion\skill\SKILL.md' },
    [pscustomobject]@{ Name = 'hyperframes-video'; Source = Join-Path $toolRoot 'hyperframes\skill\SKILL.md' }
)

if ($OnlySkill -and $OnlySkill.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($AutoSyncCommit)) {
    throw 'Use either -OnlySkill or -AutoSyncCommit, not both.'
}

if ($OnlySkill -and $OnlySkill.Count -gt 0) {
    $requestedNames = @($OnlySkill | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    $knownNames = @($skills | ForEach-Object { $_.Name })
    $unknownNames = @($requestedNames | Where-Object { $_ -notin $knownNames })
    if ($unknownNames.Count -gt 0) {
        throw ('Unknown Skill name(s): ' + ($unknownNames -join ', '))
    }
    $skills = @($skills | Where-Object { $_.Name -in $requestedNames })
}
elseif (-not [string]::IsNullOrWhiteSpace($AutoSyncCommit)) {
    $changedFiles = @(& git -C $toolRoot show --pretty=format: --name-only $AutoSyncCommit 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ('Failed to inspect AgentTools commit for Skill auto-sync: ' + ($changedFiles -join [Environment]::NewLine))
    }
    $changedFiles = @($changedFiles | ForEach-Object { $_.ToString().Trim().Replace('\', '/') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $rootPrefix = $toolRoot.TrimEnd('\', '/') + '\'
    $skills = @($skills | Where-Object {
        $relatedSources = @($_.Source)
        if ($_.PSObject.Properties.Name -contains 'References' -and $_.References) {
            $relatedSources += @($_.References | ForEach-Object { $_.Source })
        }
        $relatedFiles = @($relatedSources | ForEach-Object {
            if ($_.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $_.Substring($rootPrefix.Length).Replace('\', '/')
            }
            else {
                ''
            }
        } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        @($relatedFiles | Where-Object { $_ -in $changedFiles }).Count -gt 0
    })

    if ($skills.Count -eq 0) {
        Write-Output ('AgentTools Skill auto-sync: no registered Skill sources changed in ' + $AutoSyncCommit)
        exit 0
    }
    Write-Output ('AgentTools Skill auto-sync: committed Skill(s): ' + (($skills | ForEach-Object { $_.Name }) -join ', '))
}

# Migrate the legacy folder name out of the discovery root. Preserve it as a backup instead of deleting it.
$legacyWorkTaskDir = Join-Path $env:USERPROFILE '.agents\skills\work-activity'
if (Test-Path -LiteralPath $legacyWorkTaskDir -PathType Container) {
    $backupRoot = Join-Path $env:USERPROFILE '.agents\skills-backup'
    $backupPath = Join-Path $backupRoot ('work-activity-' + $timestamp)
    if ($DryRun) {
        Write-Output ('[DRY RUN] Legacy Skill folder migrate: ' + $legacyWorkTaskDir + ' -> ' + $backupPath)
    }
    else {
        [System.IO.Directory]::CreateDirectory($backupRoot) | Out-Null
        Move-Item -LiteralPath $legacyWorkTaskDir -Destination $backupPath
        Write-Output ('Migrated legacy Skill folder: ' + $backupPath)
    }
}

foreach ($skill in $skills) {
    if (-not (Test-Path -LiteralPath $skill.Source -PathType Leaf)) {
        throw ('Skill source not found: ' + $skill.Source)
    }

    $destinationDir = Join-Path $env:USERPROFILE ('.agents\skills\' + $skill.Name)
    $destination = Join-Path $destinationDir 'SKILL.md'
    $sourceContent = Resolve-InstalledContent ([System.IO.File]::ReadAllText($skill.Source))
    $references = if ($skill.PSObject.Properties.Name -contains 'References' -and $skill.References) { @($skill.References) } else { @() }

    if ($DryRun) {
        $state = if (Test-Path -LiteralPath $destination -PathType Leaf) {
            if ([System.IO.File]::ReadAllText($destination) -eq $sourceContent) { 'current' } else { 'update' }
        }
        else {
            'new'
        }
        Write-Output ('[DRY RUN] Skill ' + $skill.Name + ': ' + $state + ' -> ' + $destination)

        foreach ($reference in $references) {
            if (-not (Test-Path -LiteralPath $reference.Source -PathType Leaf)) {
                throw ('Skill reference source not found: ' + $reference.Source)
            }
            $referenceDestination = Join-Path $destinationDir $reference.Destination
            $referenceContent = Resolve-InstalledContent ([System.IO.File]::ReadAllText($reference.Source))
            $referenceState = if (Test-Path -LiteralPath $referenceDestination -PathType Leaf) {
                if ([System.IO.File]::ReadAllText($referenceDestination) -eq $referenceContent) { 'current' } else { 'update' }
            }
            else {
                'new'
            }
            Write-Output ('[DRY RUN] Skill reference ' + $skill.Name + '/' + $reference.Destination + ': ' + $referenceState + ' -> ' + $referenceDestination)
        }
        continue
    }

    [System.IO.Directory]::CreateDirectory($destinationDir) | Out-Null
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $current = [System.IO.File]::ReadAllText($destination)
        if ($current -ne $sourceContent) {
            Copy-Item -LiteralPath $destination -Destination ($destination + '.backup-' + $timestamp)
        }
    }

    Write-Utf8File $destination $sourceContent
    Write-Output ('Installed global skill: ' + $skill.Name)

    foreach ($reference in $references) {
        if (-not (Test-Path -LiteralPath $reference.Source -PathType Leaf)) {
            throw ('Skill reference source not found: ' + $reference.Source)
        }

        $referenceDestination = Join-Path $destinationDir $reference.Destination
        $referenceDestinationDir = Split-Path -Parent $referenceDestination
        $referenceContent = Resolve-InstalledContent ([System.IO.File]::ReadAllText($reference.Source))

        [System.IO.Directory]::CreateDirectory($referenceDestinationDir) | Out-Null
        if (Test-Path -LiteralPath $referenceDestination -PathType Leaf) {
            $currentReference = [System.IO.File]::ReadAllText($referenceDestination)
            if ($currentReference -ne $referenceContent) {
                Copy-Item -LiteralPath $referenceDestination -Destination ($referenceDestination + '.backup-' + $timestamp)
            }
        }

        Write-Utf8File $referenceDestination $referenceContent
        Write-Output ('Installed skill reference: ' + $skill.Name + '/' + $reference.Destination)
    }
}

$agentsPath = Join-Path $env:USERPROFILE '.codex\AGENTS.md'
$agentsDir = Split-Path -Parent $agentsPath
[System.IO.Directory]::CreateDirectory($agentsDir) | Out-Null
$content = if (Test-Path -LiteralPath $agentsPath -PathType Leaf) {
    [System.IO.File]::ReadAllText($agentsPath)
}
else {
    ''
}
$original = $content

# Remove legacy per-tool blocks written by older installers.
$legacyBeginMarkers = @(
    '<!-- BEGIN ROHI DISCORD BOT AGENT TOOL -->',
    '<!-- BEGIN ROHI BLENDER MCP AGENT TOOL -->',
    '<!-- BEGIN ROHI IMAGE BRIDGE AGENT TOOL -->',
    '<!-- BEGIN ROHI WINDOWS UI AGENT TOOL -->',
    '<!-- BEGIN ROHI GIT HELPER AGENT TOOL -->',
    '<!-- BEGIN ROHI CODEX MODE AGENT TOOL -->'
)
$legacyEndMarkers = @(
    '<!-- END ROHI DISCORD BOT AGENT TOOL -->',
    '<!-- END ROHI BLENDER MCP AGENT TOOL -->',
    '<!-- END ROHI IMAGE BRIDGE AGENT TOOL -->',
    '<!-- END ROHI WINDOWS UI AGENT TOOL -->',
    '<!-- END ROHI GIT HELPER AGENT TOOL -->',
    '<!-- END ROHI CODEX MODE AGENT TOOL -->'
)

for ($i = 0; $i -lt $legacyBeginMarkers.Count; $i++) {
    $content = Remove-MarkedBlock $content $legacyBeginMarkers[$i] $legacyEndMarkers[$i]
}

# Keep global AGENTS compact; detailed procedures live in each Skill.
$begin = '<!-- BEGIN ROHI SHARED AGENT SKILLS -->'
$end = '<!-- END ROHI SHARED AGENT SKILLS -->'
$compactBlock = @"
$begin
## Shared Agent Skills

Shared tool procedures are defined by the registered global Skills. Use the matching Skill when needed instead of duplicating tool instructions in AGENTS.md.
Canonical shared tool root: $toolRoot

### Unity routing

- Use `unity-skills` as the canonical route for Unity Editor operations.
- Use `unity-official` only for Unity technical judgment and review.
- Read at most one official Guide by default; do not scan or preload multiple Guides.
- Do not use `unity-cli` for Editor operations or auto-install `com.unity.pipeline`.
- Project-specific `AGENTS.md` rules override official Guides.
$end
"@

$content = Update-MarkedBlock $content $begin $end $compactBlock
$content = $content.TrimEnd() + [Environment]::NewLine

if ($DryRun) {
    Write-Output ('[DRY RUN] Global AGENTS.md: ' + $(if ($content -eq $original) { 'current' } else { 'update required' }))
    Write-Output 'AGENTTOOLS_SKILLS_DRY_RUN_OK'
    exit 0
}

if ($content -ne $original) {
    if (Test-Path -LiteralPath $agentsPath -PathType Leaf) {
        Copy-Item -LiteralPath $agentsPath -Destination ($agentsPath + '.backup-' + $timestamp)
    }
    Write-Utf8File $agentsPath $content
    Write-Output 'Updated global AGENTS.md shared Skill block.'
}
else {
    Write-Output 'Global AGENTS.md shared Skill block already current.'
}

Write-Output 'AGENTTOOLS_SKILLS_INSTALLED'
Write-Output 'Open or reopen a DevSpace workspace / Agent session to refresh skill discovery; a DevSpace server restart is normally unnecessary.'
