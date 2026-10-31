Add-Type -AssemblyName System.Drawing
$p = Join-Path $env:TEMP 'stub_ico.exe'
$i = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
if ($null -eq $i) { Write-Output 'NO ICON'; exit 1 }
$b = $i.ToBitmap()
$b.Save((Join-Path $env:TEMP 'icon_check.png'))
Write-Output ("extracted " + $b.Width + "x" + $b.Height)
