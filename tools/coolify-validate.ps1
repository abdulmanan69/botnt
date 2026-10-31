# Runs Coolify's own docker-compose injection validator against this repo's
# compose file. Coolify refuses to load a compose file that fails it (for
# example a variable inside a volume target), so run this before pushing any
# compose change.
#
# Usage:  ./tools/coolify-validate.ps1 [-File docker-compose.yml]
param([string]$File = "docker-compose.yml")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$compose = if ([IO.Path]::IsPathRooted($File)) { $File } else { Join-Path $root $File }
if (-not (Test-Path $compose)) { throw "compose file not found: $compose" }

$work = Join-Path $env:TEMP "coolify-validate"
New-Item -ItemType Directory -Force -Path $work | Out-Null

foreach ($helper in @("parsers.php", "shared.php")) {
    Invoke-WebRequest -UseBasicParsing `
        "https://raw.githubusercontent.com/coollabsio/coolify/main/bootstrap/helpers/$helper" `
        -OutFile (Join-Path $work $helper)
}

@'
<?php
namespace App\Models { class Application { const MAX_DOCKER_COMPOSE_COLLECTION_ALIASES = 5000; } }
namespace {
require __DIR__."/vendor/autoload.php";
require __DIR__."/shared.php";
require __DIR__."/parsers.php";
try {
    validateDockerComposeForInjection(file_get_contents($argv[1]));
    echo "OK: compose passes Coolify validation";
} catch (Throwable $e) {
    echo "FAIL: ".$e->getMessage();
}
}
'@ | Set-Content (Join-Path $work "test.php")

$mount = "${compose}:/compose.yml:ro"
docker run --rm -v "${work}:/w" -v $mount -w /w composer:2 sh -c "composer require symfony/yaml illuminate/support --quiet >/dev/null 2>&1; php test.php /compose.yml"
