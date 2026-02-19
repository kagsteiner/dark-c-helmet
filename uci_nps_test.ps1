param(
    [string]$EnginePath = ".\build\Release\vibechess_c.exe",
    [string]$Fen = "",
    [string[]]$Moves = @(),
    [int]$Depth = 10,
    [int]$MovetimeMs = 0,
    [int]$HashMB = 64,
    [int]$TimeoutSec = 60,
    [switch]$ShowRawOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-PositionCommand {
    param(
        [string]$FenArg,
        [string[]]$MovesArg
    )

    $position = if ([string]::IsNullOrWhiteSpace($FenArg)) {
        "position startpos"
    } else {
        "position fen $FenArg"
    }

    if ($MovesArg.Count -gt 0) {
        $position += " moves " + ($MovesArg -join " ")
    }

    return $position
}

$resolvedEngine = Resolve-Path -Path $EnginePath -ErrorAction Stop

$goCommand = if ($MovetimeMs -gt 0) {
    "go movetime $MovetimeMs"
} else {
    "go depth $Depth"
}

$uciLines = @(
    "uci",
    "isready",
    "setoption name Hash value $HashMB",
    "isready",
    (Get-PositionCommand -FenArg $Fen -MovesArg $Moves),
    $goCommand,
    "quit"
)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $resolvedEngine.Path
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

[void]$proc.Start()

foreach ($line in $uciLines) {
    $proc.StandardInput.WriteLine($line)
}
$proc.StandardInput.Close()

if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    try { $proc.Kill($true) } catch {}
    throw "Engine did not finish within timeout (${TimeoutSec}s)."
}

$stdout = $proc.StandardOutput.ReadToEnd()
$stderr = $proc.StandardError.ReadToEnd()

$allOutput = @()
if (-not [string]::IsNullOrWhiteSpace($stdout)) {
    $allOutput += ($stdout -split "(`r`n|`n|`r)" | Where-Object { $_ -ne "" })
}
if (-not [string]::IsNullOrWhiteSpace($stderr)) {
    $allOutput += ($stderr -split "(`r`n|`n|`r)" | Where-Object { $_ -ne "" })
}

$infoLines = @($allOutput | Where-Object { $_ -like "info *" })
$bestLine = @($allOutput | Where-Object { $_ -like "bestmove *" } | Select-Object -Last 1)

$lastNps = $null
$peakNps = 0L

foreach ($line in $infoLines) {
    if ($line -match "\bnps\s+(\d+)") {
        $nps = [long]$Matches[1]
        $lastNps = $nps
        if ($nps -gt $peakNps) {
            $peakNps = $nps
        }
    }
}

Write-Host "Engine: $($resolvedEngine.Path)"
if ([string]::IsNullOrWhiteSpace($Fen)) {
    Write-Host "Position: startpos"
} else {
    Write-Host "Position: fen $Fen"
}
if ($Moves.Count -gt 0) {
    Write-Host "Moves: $($Moves -join ' ')"
}
Write-Host "Search: $goCommand"
Write-Host "Hash MB: $HashMB"
Write-Host ("Info lines: {0}" -f $infoLines.Count)
if ($lastNps -ne $null) {
    Write-Host ("Last NPS: {0:N0}" -f $lastNps)
    Write-Host ("Peak NPS: {0:N0}" -f $peakNps)
} else {
    Write-Host "No NPS found in info output."
}
if ($bestLine.Count -gt 0) {
    Write-Host "Bestmove: $($bestLine[0])"
}

if ($ShowRawOutput) {
    Write-Host ""
    Write-Host "Raw engine output:"
    foreach ($line in $allOutput) {
        Write-Host $line
    }
}
