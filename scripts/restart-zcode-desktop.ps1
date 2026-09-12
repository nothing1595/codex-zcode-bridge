$ErrorActionPreference = 'Stop'

$zcodeExe = if ($env:ZCODE_EXE) { $env:ZCODE_EXE } else { 'E:\ZCode\ZCode.exe' }
$cdpPort = if ($env:ZCODE_CDP_PORT) { [int]$env:ZCODE_CDP_PORT } else { 19223 }
$resolvedExe = (Resolve-Path -LiteralPath $zcodeExe).Path

Get-CimInstance Win32_Process -Filter "Name = 'ZCode.exe'" |
    Where-Object { $_.ExecutablePath -and ((Resolve-Path -LiteralPath $_.ExecutablePath).Path -eq $resolvedExe) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep -Milliseconds 750
Start-Process -FilePath $resolvedExe -ArgumentList '--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$cdpPort"
Write-Output "Restarted ZCode Desktop with local CDP port $cdpPort."
