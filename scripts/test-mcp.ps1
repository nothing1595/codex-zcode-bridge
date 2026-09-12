$ErrorActionPreference = 'Stop'
$server = Join-Path (Split-Path -Parent (Split-Path -Parent $PSCommandPath)) 'server\zcode-worker.cjs'
$messages = @(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
) -join "`n"
$messages + "`n" | & 'E:\Node.js\node.exe' $server
