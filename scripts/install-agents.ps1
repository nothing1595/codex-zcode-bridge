$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$sourceDir = Join-Path $bridgeRoot 'agents'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { 'E:\ChatGPT\UserProfile\.codex' }
$targetDir = Join-Path $codexHome 'agents'
$configPath = Join-Path $codexHome 'config.toml'
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
    # utf8NoBOM encoding is PowerShell 7+ only; .NET works on 5.1 too.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $targetDir $Name), $rendered, $utf8NoBom)
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Install-AgentTemplate 'glm53-worker.toml'
Install-AgentTemplate 'glm53-flash-worker.toml'

if (Test-Path -LiteralPath $configPath) {
    $configText = Get-Content -Raw -LiteralPath $configPath
    if ($configText -notmatch '(?m)^\[mcp_servers\.zcode_worker\]\s*$') {
        $mcpConfig = @"

[mcp_servers.zcode_worker]
command = "$(ConvertTo-TomlBasicStringValue $nodeExe)"
args = ["$(ConvertTo-TomlBasicStringValue $serverPath)"]
startup_timeout_sec = 20
tool_timeout_sec = 60
"@
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($configPath, $mcpConfig, $utf8NoBom)
        Write-Output "Registered zcode_worker globally in $configPath"
    }
}

Write-Output "Installed Codex agents into $targetDir"
Write-Output 'Restart Codex, then ask it to spawn glm53_worker or glm53_flash_worker.'
