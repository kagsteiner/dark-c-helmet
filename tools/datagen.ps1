<#
.SYNOPSIS
  Self-play data generation on Windows for NNUE training (the Windows counterpart of the
  data stage of tools/nnue/pipeline.sh).

.DESCRIPTION
  Starts several datagen processes of the engine at below-normal priority, keeps Windows from
  sleeping, and stops everything after the given number of hours. Each process writes
  "<fen> | <score> | <result>" lines to its own file in -OutDir.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\datagen.ps1 -Procs 8 -Hours 10

.NOTES
  Build the engine first (Developer PowerShell for VS 2022, in the project folder):
    cmake -S . -B build
    cmake --build build --config Release --target darkhelmet
#>
param(
    [int]$Procs = [Math]::Max(1, [Environment]::ProcessorCount - 2),
    [double]$Hours = 10,
    [int]$Nodes = 5000,
    [string]$Engine = "build\Release\darkhelmet.exe",
    [string]$OutDir = "$env:USERPROFILE\VibeEngineData\pc",
    [long]$SeedBase = 70000000   # far away from the seeds used on the Mac
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Engine)) { throw "Engine not found: $Engine (build it first, see .NOTES)" }
$Engine = (Resolve-Path $Engine).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Keep the PC awake while this script runs (ES_CONTINUOUS | ES_SYSTEM_REQUIRED).
Add-Type -Namespace Win32 -Name Power -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
'@
[Win32.Power]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null

$version = (("uci`nquit`n") | & $Engine | Select-String "^id name").Line
Write-Host "Engine: $version"
Write-Host "Starting $Procs processes for $Hours hours, $Nodes nodes/move, output in $OutDir"

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$processes = @()
for ($i = 1; $i -le $Procs; $i++) {
    $seed = $SeedBase + [long](Get-Random -Maximum 1000000) * 100 + $i
    $out = Join-Path $OutDir "selfplay_${stamp}_$i.txt"
    $log = Join-Path $OutDir "datagen_${stamp}_$i.log"
    $p = Start-Process -FilePath $Engine -ArgumentList "datagen", "10000000", "$Nodes", "$seed", "`"$out`"" `
        -NoNewWindow -PassThru -RedirectStandardError $log
    $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
    $processes += $p
}

$deadline = (Get-Date).AddHours($Hours)
while ((Get-Date) -lt $deadline -and ($processes | Where-Object { -not $_.HasExited })) {
    Start-Sleep -Seconds 60
    $games = 0; $positions = 0
    Get-ChildItem $OutDir -Filter "datagen_${stamp}_*.log" | ForEach-Object {
        $last = Get-Content $_.FullName -Tail 1
        if ($last -match "games (\d+)\s+positions (\d+)") { $games += [long]$Matches[1]; $positions += [long]$Matches[2] }
    }
    $left = [Math]::Max(0, [int]($deadline - (Get-Date)).TotalMinutes)
    Write-Host ("{0:HH:mm}  games {1:N0}  positions {2:N0}  ({3} min left)" -f (Get-Date), $games, $positions, $left)
}

$processes | Where-Object { -not $_.HasExited } | ForEach-Object { Stop-Process -Id $_.Id -Force }
[Win32.Power]::SetThreadExecutionState([uint32]"0x80000000") | Out-Null
Write-Host "Done. Files are in $OutDir - zip them and copy them to the Mac (~/VibeEngineData/pc)."
