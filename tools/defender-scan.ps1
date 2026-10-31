param([Parameter(Mandatory=$true)][string]$Path)

# emulate a browser download (Mark of the Web) so cloud/AV heuristics engage
$motw = "[ZoneTransfer]`r`nZoneId=3`r`nReferrerUrl=https://example.com/x`r`n"
Set-Content -LiteralPath $Path -Stream 'Zone.Identifier' -Value $motw -NoNewline

$mp = Join-Path 'C:\ProgramData\Microsoft\Windows Defender\Platform\CurrentVersion' 'MpCmdRun.exe'
& $mp -Scan -ScanType 3 -File $Path -DisableRemediation 2>&1 | Out-String

# drop MOTW so the "Open File - Security Warning" dialog does not block the test
Unblock-File -LiteralPath $Path

Write-Output '--- launching ---'
$p = Start-Process -FilePath $Path -PassThru
Start-Sleep -Seconds 12
$alive = $p -and -not $p.HasExited
Write-Output ("process alive: " + $alive)
if ($alive) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }

Write-Output '--- detections ---'
Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending |
  Select-Object -First 3 | ForEach-Object {
    Write-Output ("{0} | {1} | {2}" -f $_.InitialDetectionTime, $_.ThreatID, ($_.Resources -join ','))
  }
Get-MpThreat | Select-Object -First 3 | ForEach-Object { Write-Output ("threat: " + $_.ThreatName) }
