# Deploy an already-created Coolify application from the command line.
#
# The MCP endpoint is read-only for settings, so this goes through the REST API
# (/api/v1) with a token that has read + write + deploy abilities:
# Coolify -> Keys & Tokens -> API tokens -> create, then
#
#   $env:COOLIFY_TOKEN = "1|...."
#   ./tools/coolify-deploy.ps1 -App uwkoh6ttkcrxdwasfznsyfrj
#   ./tools/coolify-deploy.ps1 -App uwkoh6ttkcrxdwasfznsyfrj -ComposeService phantom `
#       -Fqdn https://botnt.becxus.cloud
#
# Compose applications keep their domain in docker_compose_domains, so pass
# -ComposeService for those (-Fqdn alone is rejected by the API).
#
# The instance allowlists /api/v1 by IP (Settings -> Advanced -> Allowed IPs).
param(
    [Parameter(Mandatory = $true)][string]$App,
    [string]$Fqdn,
    [string]$ComposeService,
    [string]$Token = $env:COOLIFY_TOKEN,
    [string]$Endpoint = "http://76.13.223.28:8000",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if (-not $Token) { throw "No token. Set `$env:COOLIFY_TOKEN or pass -Token." }

$headers = @{ Authorization = "Bearer $Token"; Accept = "application/json" }
$api = "$Endpoint/api/v1/applications/$App"

Write-Host "[*] reading $App"
$current = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 30
Write-Host "    name=$($current.name) fqdn=$($current.fqdn) ports=$($current.ports_exposes)"

if ($Fqdn) {
    $body = @{ ports_exposes = "80" }
    if ($ComposeService) {
        $body.docker_compose_domains = @(@{ name = $ComposeService; domain = $Fqdn })
    } else {
        $body.fqdn = $Fqdn
    }
    $patch = $body | ConvertTo-Json -Depth 6
    if ($DryRun) { Write-Host "[dry] PATCH $patch" }
    else {
        Write-Host "[*] setting domain=$Fqdn ports_exposes=80"
        Invoke-RestMethod -Uri $api -Method Patch -Headers $headers `
            -ContentType "application/json" -Body $patch -TimeoutSec 30 | Out-Null
    }
}

if ($DryRun) { Write-Host "[dry] POST $Endpoint/api/v1/deploy?uuid=$App&force=1"; return }

# Coolify answers 405 when this is sent as GET.
Write-Host "[*] triggering deploy"
$deploy = Invoke-RestMethod -Uri "$Endpoint/api/v1/deploy?uuid=$App&force=1" -Method Post `
    -Headers $headers -TimeoutSec 60
$deploy.deployments | ForEach-Object { "    deployment " + $_.message + " " + $_.deployment_uuid }

if ($Fqdn) {
    $probe = ($Fqdn -replace "/$", "") + "/healthz"
    for ($i = 1; $i -le 40; $i++) {
        Start-Sleep -Seconds 15
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri $probe -TimeoutSec 10
            Write-Host "[$i] healthz $($r.StatusCode) $($r.Content)"
            if ($r.Content -match '"uptime"') { Write-Host "[+] new build is live"; break }
        } catch {
            Write-Host "[$i] not up yet ($($_.Exception.Message))"
        }
    }
}
