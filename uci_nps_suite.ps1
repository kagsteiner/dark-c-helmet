param(
    [string]$EnginePath = ".\build\Release\vibechess_c.exe",
    [int]$Depth = 10,
    [int]$MovetimeMs = 0,
    [int]$HashMB = 64,
    [int]$TimeoutSec = 60,
    [int]$Repeat = 1,
    [switch]$ShowRawOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Repeat -lt 1) {
    throw "Repeat must be >= 1."
}

function Get-Median {
    param([long[]]$Values)
    if (-not $Values -or $Values.Count -eq 0) { return 0L }
    $sorted = @($Values | Sort-Object)
    $n = $sorted.Count
    if ($n % 2 -eq 1) {
        return [long]$sorted[[int]($n / 2)]
    }
    $a = [double]$sorted[($n / 2) - 1]
    $b = [double]$sorted[$n / 2]
    return [long][math]::Round(($a + $b) / 2.0)
}

function Invoke-UciSearch {
    param(
        [string]$EngineFile,
        [string]$PositionCommand,
        [string]$GoCommand,
        [int]$Hash,
        [int]$TimeoutSeconds
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $EngineFile
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    $uciLines = @(
        "uci",
        "isready",
        "setoption name Hash value $Hash",
        "isready",
        $PositionCommand,
        $GoCommand,
        "quit"
    )

    foreach ($line in $uciLines) {
        $proc.StandardInput.WriteLine($line)
    }
    $proc.StandardInput.Close()

    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        try { $proc.Kill($true) } catch {}
        throw "Engine did not finish within timeout (${TimeoutSeconds}s)."
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
            if ($nps -gt $peakNps) { $peakNps = $nps }
        }
    }

    [pscustomobject]@{
        InfoLines = $infoLines.Count
        LastNps = $lastNps
        PeakNps = $peakNps
        BestMove = if ($bestLine.Count -gt 0) { $bestLine[0] } else { "" }
        RawOutput = $allOutput
    }
}

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
$goCommand = if ($MovetimeMs -gt 0) { "go movetime $MovetimeMs" } else { "go depth $Depth" }

$suite = @(
    [pscustomobject]@{ Name = "Start Position"; Fen = ""; Moves = @() },
    [pscustomobject]@{ Name = "Open Sicilian"; Fen = ""; Moves = @("e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6") },
    [pscustomobject]@{ Name = "Kingside Attack"; Fen = "r2q1rk1/pp2bppp/2np1n2/2p1p3/2B1P1b1/2NP1N2/PPPQ1PPP/R1B2RK1 w - - 2 10"; Moves = @() },
    [pscustomobject]@{ Name = "IQP Middlegame"; Fen = "r1bq1rk1/pp3ppp/2n1pn2/2bp4/3P4/2N1PN2/PPQ2PPP/R1B2RK1 w - - 0 10"; Moves = @() },
    [pscustomobject]@{ Name = "Rook Endgame"; Fen = "8/2p3pk/1p1p2pp/p2P4/P1P1P3/1P4P1/5K1P/2R5 w - - 0 40"; Moves = @() },
    [pscustomobject]@{ Name = "Minor Piece Endgame"; Fen = "8/2k5/2p2pp1/1pPp4/1P1P1P2/2K3P1/8/8 w - - 0 50"; Moves = @() }
)

$overallLast = New-Object System.Collections.Generic.List[long]
$overallPeak = New-Object System.Collections.Generic.List[long]
$positionStats = @()

Write-Host "Engine: $($resolvedEngine.Path)"
Write-Host "Search: $goCommand"
Write-Host "Hash MB: $HashMB"
Write-Host "Positions: $($suite.Count), Repeat: $Repeat"
Write-Host ""

foreach ($pos in $suite) {
    $lastList = New-Object System.Collections.Generic.List[long]
    $peakList = New-Object System.Collections.Generic.List[long]
    $bestLast = ""

    for ($run = 1; $run -le $Repeat; $run++) {
        $positionCommand = Get-PositionCommand -FenArg $pos.Fen -MovesArg $pos.Moves
        $result = Invoke-UciSearch -EngineFile $resolvedEngine.Path -PositionCommand $positionCommand -GoCommand $goCommand -Hash $HashMB -TimeoutSeconds $TimeoutSec

        if ($result.LastNps -ne $null) {
            $lastList.Add([long]$result.LastNps)
            $overallLast.Add([long]$result.LastNps)
        }
        $peakList.Add([long]$result.PeakNps)
        $overallPeak.Add([long]$result.PeakNps)
        $bestLast = $result.BestMove

        if ($ShowRawOutput) {
            Write-Host "----- Raw output [$($pos.Name)] run $run -----"
            foreach ($line in $result.RawOutput) { Write-Host $line }
        }
    }

    $avgLast = if ($lastList.Count -gt 0) { [long][math]::Round(($lastList | Measure-Object -Average).Average) } else { 0L }
    $avgPeak = if ($peakList.Count -gt 0) { [long][math]::Round(($peakList | Measure-Object -Average).Average) } else { 0L }
    $medLast = Get-Median -Values ([long[]]$lastList.ToArray())
    $medPeak = Get-Median -Values ([long[]]$peakList.ToArray())

    $positionStats += [pscustomobject]@{
        Position = $pos.Name
        AvgLastNps = $avgLast
        MedLastNps = $medLast
        AvgPeakNps = $avgPeak
        MedPeakNps = $medPeak
        BestMove = $bestLast
    }
}

Write-Host "Per-position results:"
foreach ($s in $positionStats) {
    Write-Host ("- {0}: avg_last={1:N0}, med_last={2:N0}, avg_peak={3:N0}, med_peak={4:N0}, {5}" -f `
        $s.Position, $s.AvgLastNps, $s.MedLastNps, $s.AvgPeakNps, $s.MedPeakNps, $s.BestMove)
}

$overallAvgLast = if ($overallLast.Count -gt 0) { [long][math]::Round(($overallLast | Measure-Object -Average).Average) } else { 0L }
$overallMedLast = Get-Median -Values ([long[]]$overallLast.ToArray())
$overallAvgPeak = if ($overallPeak.Count -gt 0) { [long][math]::Round(($overallPeak | Measure-Object -Average).Average) } else { 0L }
$overallMedPeak = Get-Median -Values ([long[]]$overallPeak.ToArray())

Write-Host ""
Write-Host "Overall:"
Write-Host ("- Avg Last NPS: {0:N0}" -f $overallAvgLast)
Write-Host ("- Med Last NPS: {0:N0}" -f $overallMedLast)
Write-Host ("- Avg Peak NPS: {0:N0}" -f $overallAvgPeak)
Write-Host ("- Med Peak NPS: {0:N0}" -f $overallMedPeak)
