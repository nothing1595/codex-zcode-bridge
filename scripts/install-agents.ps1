$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$sourceDir = Join-Path $bridgeRoot 'agents'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { 'E:\ChatGPT\UserProfile\.codex' }
$targetDir = Join-Path $codexHome 'agents'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($env:ZCODE_NODE_EXE) { $env:ZCODE_NODE_EXE } elseif ($nodeCommand) { $nodeCommand.Source } else { 'E:\Node.js\node.exe' }
$serverPath = Join-Path $bridgeRoot 'server\zcode-worker.cjs'

function ConvertTo-TomlBasicStringValue([string]$Value) {
    return $Value.Replace('\', '\\').Replace('"', '\"')
}

function Install-AgentTemplate([string]$Name) {
    $template = Get-Content -Raw -LiteralPath (Join-Path $sourceDir $Name)
    $rendered = $template.Replace('__NODE_EXE__', (ConvertTo-TomlBasicStringValue $nodeExe))
    $rendered = $rendered.Replace('__ZCODE_BRIDGE_SERVER__', (ConvertTo-TomlBasicStringValue $serverPath))
    Set-Content -LiteralPath (Join-Path $targetDir $Name) -Value $rendered -Encoding utf8NoBOM
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Install-AgentTemplate 'glm53-worker.toml'
Install-AgentTemplate 'glm53-flash-worker.toml'

Write-Output "Installed Codex agents into $targetDir"
Write-Output 'Restart Codex, then ask it to spawn glm53_worker or glm53_flash_worker.'
