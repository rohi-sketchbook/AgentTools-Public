[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('prepare', 'verify')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$WorkspaceRoot,

    [Parameter(Mandatory = $true)]
    [string]$Date,

    [ValidateSet('png', 'webp', 'jpg', 'jpeg')]
    [string]$Extension = 'png'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-ResultLine {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
    )

    Write-Output ("{0}={1}" -f $Name, $Value)
}

function Fail {
    param(
        [Parameter(Mandatory = $true)][int]$Code,
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$Message
    )

    Write-ResultLine 'STATE' $State
    Write-ResultLine 'ACTION' 'STOP'
    Write-ResultLine 'MESSAGE' $Message
    exit $Code
}

try {
    if (-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) {
        Fail -Code 40 -State 'INVALID_WORKSPACE' -Message "WorkspaceRoot does not exist: $WorkspaceRoot"
    }

    $parsedDate = [DateTime]::MinValue
    $dateOk = [DateTime]::TryParseExact(
        $Date,
        'yyyy-MM-dd',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None,
        [ref]$parsedDate
    )
    if (-not $dateOk -or $parsedDate.ToString('yyyy-MM-dd') -ne $Date) {
        Fail -Code 41 -State 'INVALID_DATE' -Message "Date must be yyyy-MM-dd: $Date"
    }

    $workspaceFull = [IO.Path]::GetFullPath($WorkspaceRoot)
    $relativePath = "docs/assets/images/devlog-$Date-comic.$Extension"
    $destination = Join-Path $workspaceFull ($relativePath -replace '/', [IO.Path]::DirectorySeparatorChar)
    $imageDirectory = Split-Path -Parent $destination

    if (-not (Test-Path -LiteralPath $imageDirectory -PathType Container)) {
        Fail -Code 42 -State 'MISSING_IMAGE_DIRECTORY' -Message "Image directory does not exist: $imageDirectory"
    }

    # A same-day canonical image in a different extension is a conflict. Never invent
    # a second filename or silently switch formats after transfer has started.
    $canonicalCandidates = @(
        Get-ChildItem -LiteralPath $imageDirectory -File -ErrorAction Stop |
            Where-Object { $_.Name -match ('^devlog-' + [regex]::Escape($Date) + '-comic\.(png|webp|jpg|jpeg)$') }
    )

    $otherCanonical = @($canonicalCandidates | Where-Object { $_.FullName -ne $destination })
    if ($otherCanonical.Count -gt 0) {
        Write-ResultLine 'STATE' 'FORMAT_CONFLICT'
        Write-ResultLine 'ACTION' 'STOP'
        Write-ResultLine 'DESTINATION' $relativePath
        Write-ResultLine 'CONFLICT' (($otherCanonical | ForEach-Object { $_.Name }) -join ';')
        exit 43
    }

    if ($Mode -eq 'prepare') {
        Write-ResultLine 'DESTINATION' $relativePath

        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            Write-ResultLine 'STATE' 'EXISTS'
            Write-ResultLine 'ACTION' 'DO_NOT_TRANSFER'
            Write-ResultLine 'MESSAGE' 'Canonical devlog image already exists. Do not call artifact download again.'
            exit 20
        }

        Write-ResultLine 'STATE' 'MISSING'
        Write-ResultLine 'ACTION' 'TRANSFER_ALLOWED'
        Write-ResultLine 'MESSAGE' 'Call artifact download exactly once using DESTINATION without modifying the path.'
        exit 0
    }

    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        Write-ResultLine 'DESTINATION' $relativePath
        Fail -Code 44 -State 'MISSING_AFTER_TRANSFER' -Message 'Canonical devlog image does not exist. Do not invent an alternate destination.'
    }

    $file = Get-Item -LiteralPath $destination
    if ($file.Length -le 0) {
        Write-ResultLine 'DESTINATION' $relativePath
        Fail -Code 45 -State 'EMPTY_FILE' -Message 'Canonical devlog image is empty.'
    }

    $hash = Get-FileHash -LiteralPath $destination -Algorithm SHA256

    $width = ''
    $height = ''
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $image = [System.Drawing.Image]::FromFile($destination)
        try {
            $width = [string]$image.Width
            $height = [string]$image.Height
        }
        finally {
            $image.Dispose()
        }
    }
    catch {
        # Integrity verification still succeeds when dimensions cannot be read.
        $width = 'UNKNOWN'
        $height = 'UNKNOWN'
    }

    Write-ResultLine 'STATE' 'VERIFIED'
    Write-ResultLine 'ACTION' 'TRANSFER_COMPLETE'
    Write-ResultLine 'DESTINATION' $relativePath
    Write-ResultLine 'BYTES' ([string]$file.Length)
    Write-ResultLine 'SHA256' $hash.Hash.ToLowerInvariant()
    Write-ResultLine 'WIDTH' $width
    Write-ResultLine 'HEIGHT' $height
    Write-ResultLine 'MESSAGE' 'Transfer is complete. Do not call artifact download again for this date.'
    exit 0
}
catch {
    Write-ResultLine 'STATE' 'ERROR'
    Write-ResultLine 'ACTION' 'STOP'
    Write-ResultLine 'MESSAGE' $_.Exception.Message
    exit 99
}
