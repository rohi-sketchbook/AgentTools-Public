param(
    [string]$SourcePath = '',
    [string]$InstallerPath = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $SourcePath = Join-Path $root 'upstream\kimodo.cpp'
}

function Write-Result([string]$Name, [bool]$Ok, [string]$Value) {
    $status = if ($Ok) { 'OK' } else { 'CHECK' }
    Write-Host ("[{0}] {1}: {2}" -f $status, $Name, $Value)
}

Write-Host '=== Kimodo PoC security check ==='

if (Test-Path (Join-Path $SourcePath '.git')) {
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $origin = (& $git -C $SourcePath remote get-url origin 2>$null).Trim()
    Write-Result 'Origin' ($origin -eq 'https://github.com/localai-org/kimodo.cpp') $origin

    $head = (& $git -C $SourcePath rev-parse HEAD).Trim()
    Write-Result 'Pinned source revision' ($head -match '^[0-9a-f]{40}$') $head

    $submodules = & $git -C $SourcePath config --file .gitmodules --get-regexp '^submodule\..*\.url$' 2>$null
    if ($LASTEXITCODE -eq 0 -and $submodules) {
        foreach ($line in $submodules) {
            $parts = $line -split '\s+', 2
            $url = if ($parts.Count -gt 1) { $parts[1] } else { '' }
            Write-Result "Submodule $($parts[0])" ($url -match '^https://github\.com/(ggml-org|ggerganov)/ggml(?:\.git)?$') $url
        }
    } else {
        Write-Result 'Submodules' $false 'Could not read .gitmodules'
    }

    $patterns = @(
        'Invoke-WebRequest', 'Start-BitsTransfer', 'curl ', 'wget ',
        'requests\.', 'urllib\.', 'socket\.', 'subprocess\.', 'os\.system',
        'CreateProcess', 'ShellExecute', 'WinExec', 'popen\(', 'system\('
    )
    $codeExtensions = @('.cpp','.cc','.c','.h','.hpp','.py','.ps1','.sh','.go','.nix','.cmake','.txt','.mod')
    $hits = New-Object System.Collections.Generic.List[string]
    Get-ChildItem -Path $SourcePath -Recurse -File -Force |
        Where-Object { $_.FullName -notmatch '\\.git\\' -and ($codeExtensions -contains $_.Extension -or $_.Name -in @('CMakeLists.txt','flake.nix','go.mod')) } |
        ForEach-Object {
            $file = $_
            foreach ($pattern in $patterns) {
                $m = Select-String -Path $file.FullName -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
                foreach ($item in $m) {
                    $rel = $file.FullName.Substring($SourcePath.Length).TrimStart('\')
                    $hits.Add(("{0}:{1}: {2}" -f $rel, $item.LineNumber, $item.Line.Trim()))
                }
            }
        }
    Write-Host ("[INFO] Network/process-related static scan hits: {0}" -f $hits.Count)
    $hits | Select-Object -First 80 | ForEach-Object { Write-Host "  $_" }
    if ($hits.Count -gt 80) { Write-Host ("  ... {0} more" -f ($hits.Count - 80)) }

    $mp = Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue
    if ($mp) {
        $status = Get-MpComputerStatus
        Write-Result 'Microsoft Defender realtime protection' ([bool]$status.RealTimeProtectionEnabled) ("enabled={0}" -f $status.RealTimeProtectionEnabled)
    } else {
        Write-Result 'Microsoft Defender' $false 'Defender cmdlets unavailable'
    }
} else {
    Write-Result 'Source checkout' $false "not found: $SourcePath"
}

if (-not [string]::IsNullOrWhiteSpace($InstallerPath)) {
    if (-not (Test-Path $InstallerPath)) { throw "Installer not found: $InstallerPath" }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $InstallerPath).Hash.ToLowerInvariant()
    $expected = '81f474711e9042f4cd22b31b2f7a8870db2e428b21586fb43dd80150be97310d'
    Write-Result 'Vulkan SDK SHA256' ($hash -eq $expected) $hash
    $sig = Get-AuthenticodeSignature -FilePath $InstallerPath
    Write-Result 'Vulkan SDK Authenticode' ($sig.Status -eq 'Valid') ("status={0}; signer={1}" -f $sig.Status, $sig.SignerCertificate.Subject)
}
