$ErrorActionPreference = 'Stop'

$zcodeExe = if ($env:ZCODE_EXE) { $env:ZCODE_EXE } else { 'E:\ZCode\ZCode.exe' }
$cdpPort = if ($env:ZCODE_CDP_PORT) { [int]$env:ZCODE_CDP_PORT } else { 19223 }

try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$cdpPort/json/version" -TimeoutSec 2
    Write-Output "ZCode Desktop CDP is already available on port $cdpPort ($($response.Browser))."
    exit 0
} catch {
    # Continue to the guarded startup checks below.
}

$running = Get-Process -Name ZCode -ErrorAction SilentlyContinue
if ($running) {
    throw "ZCode is running without CDP port $cdpPort. Close it first, or run scripts\restart-zcode-desktop.ps1 after reviewing that script's process-stop behavior."
}

if (-not (Test-Path -LiteralPath $zcodeExe -PathType Leaf)) {
    throw "ZCode executable not found: $zcodeExe"
}

Start-Process -FilePath $zcodeExe -ArgumentList '--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$cdpPort"
Write-Output "Started ZCode Desktop with local CDP port $cdpPort. Keep this window/session logged in while using the bridge."
