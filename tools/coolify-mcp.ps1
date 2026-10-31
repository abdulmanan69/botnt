# Talks to the Coolify MCP endpoint (Streamable HTTP, JSON-RPC 2.0).
#
# Coolify serves an MCP server on https://<coolify-host>:8000/mcp guarded by a
# bearer token: Coolify -> Keys & Tokens -> API tokens (or as the instance admin
# Profile -> API tokens). Export it once, e.g.
#
#   $env:COOLIFY_TOKEN = "1|...."
#
# then:
#   ./tools/coolify-mcp.ps1 -ListTools
#   ./tools/coolify-mcp.ps1 -Call list_applications -Arguments '{"page":1}'
#   ./tools/coolify-mcp.ps1 -Call deploy -ArgumentsFile deploy.json
#
# -ArgumentsFile is the safe way to pass JSON on Windows: quoting JSON through
# powershell.exe -File mangles the quotes otherwise.
#
# The MCP tool set is read-only plus deploy/control: creating a resource or
# changing settings (fqdn, ports_exposes, env vars) still goes through the REST
# API with a token that has read/write/deploy abilities — an MCP-scoped token
# answers 403 on /api/v1.
#
# -Endpoint overrides the default instance (http://76.13.223.28:8000/mcp).
param(
    [string]$Endpoint = "http://76.13.223.28:8000/mcp",
    [string]$Token = $env:COOLIFY_TOKEN,
    [switch]$ListTools,
    [Alias("Args")]
    [string]$Arguments = "{}",
    [string]$ArgumentsFile,
    [string]$Call,
    [string]$Method,
    [string]$Params = "{}",
    [switch]$ShowBody
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $Token) { throw "No token. Set `$env:COOLIFY_TOKEN or pass -Token (Coolify -> Keys & Tokens -> API tokens)." }

$protocol = "2025-06-18"
$sessionId = $null
$script:nextId = 0

function Send-Rpc {
    param([string]$RpcMethod, $RpcParams, [switch]$Notify)

    $script:nextId++
    $payload = [ordered]@{ jsonrpc = "2.0"; method = $RpcMethod }
    if (-not $Notify) { $payload.id = $script:nextId }
    if ($null -ne $RpcParams -and $RpcParams.PSObject.Properties.Count + @($RpcParams.Keys).Count -gt 0) {
        $payload.params = $RpcParams
    }

    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = "application/json, text/event-stream"
        "MCP-Protocol-Version" = $protocol
    }
    if ($sessionId) { $headers["Mcp-Session-Id"] = $sessionId }

    $body = $payload | ConvertTo-Json -Depth 12 -Compress
    if ($ShowBody) { Write-Host "> $body" }
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri $Endpoint -Method POST `
        -Body $body -ContentType "application/json" -Headers $headers

    $sid = $response.Headers["Mcp-Session-Id"]
    if ($sid) { $sessionId = @($sid)[0] }
    if ($Notify -or -not $response.Content) { return $null }

    # Streamable HTTP may answer as SSE: collect the data: lines and parse them.
    $text = $response.Content
    if ($text -match '(?m)^(event|data):') {
        $text = (($text -split "`r?`n") | Where-Object { $_ -match '^data:' } |
                 ForEach-Object { $_ -replace '^data:\s?', '' }) -join "`n"
    }
    if (-not $text.Trim()) { return $null }
    return $text | ConvertFrom-Json
}

$init = Send-Rpc -RpcMethod "initialize" -RpcParams @{
    protocolVersion = $protocol
    capabilities    = @{}
    clientInfo      = @{ name = "coolify-mcp-ps"; version = "1.0" }
}
Write-Host ("connected: " + $init.result.serverInfo.name + " " + $init.result.serverInfo.version)
try { Send-Rpc -RpcMethod "notifications/initialized" -Notify | Out-Null } catch { }

if ($ListTools) {
    $tools = Send-Rpc -RpcMethod "tools/list" -RpcParams @{}
    $tools.result.tools | ForEach-Object { "{0,-34} {1}" -f $_.name, ($_.description -replace "`r?`n", " " | ForEach-Object { $_.Substring(0, [Math]::Min(100, $_.Length)) }) }
    return
}

if ($Method) {
    $result = Send-Rpc -RpcMethod $Method -RpcParams ($Params | ConvertFrom-Json)
    $result | ConvertTo-Json -Depth 12
    return
}

if (-not $Call) { throw "Nothing to do: use -ListTools, -Call <tool> or -Method <rpc-method>." }

$toolArgs = $null
if ($ArgumentsFile) { $Arguments = Get-Content -Raw $ArgumentsFile }
try { $toolArgs = $Arguments | ConvertFrom-Json } catch { throw "Arguments is not valid JSON: $Arguments" }
if ($null -eq $toolArgs) { $toolArgs = [pscustomobject]@{} }
$result = Send-Rpc -RpcMethod "tools/call" -RpcParams @{ name = $Call; arguments = $toolArgs }
foreach ($item in $result.result.content) {
    if ($item.type -eq "text") { $item.text } else { $item | ConvertTo-Json -Depth 12 }
}
if ($result.result.isError) { exit 1 }
