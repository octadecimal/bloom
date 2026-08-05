# Preflight: refuse to "serve to a human" if the backend isn't in live mode.
#
# Lives in a script file rather than inline in the justfile on purpose: `just`
# hands recipe lines to `sh -cu`, which expands `$off`/`$env:...` itself and
# aborts with "unbound variable" before powershell ever sees them. Recipes that
# need PowerShell variables must shell out to a -File script (same idiom as
# tools/wt-assign-offset.ps1).
#
# Keep this file ASCII-only: `powershell` (5.1) decodes a BOM-less .ps1 as ANSI,
# so non-ASCII punctuation (em dashes) turns into mojibake and fails to parse.

$ErrorActionPreference = 'Stop'

$offset = 0
if ($env:BLOOM_PORT_OFFSET) { $offset = [int]$env:BLOOM_PORT_OFFSET }
$port = 8000 + $offset

try {
    $health = Invoke-RestMethod ('http://localhost:{0}/health' -f $port) -TimeoutSec 10
}
catch {
    Write-Error ("No backend answered http://localhost:{0}/health - start one with: just backend-serve" -f $port)
    exit 1
}

$mode = "$($health.providerMode)"
if (-not $mode) {
    Write-Error ("Backend on port {0} returned no providerMode - is it a Bloom backend?" -f $port)
    exit 1
}

Write-Host ('Provider mode: ' + $mode.ToUpper() + ' (port ' + $port + ')')

if ($mode -ne 'live') {
    Write-Error ("Backend is in {0} mode - not safe to hand to a user. Start it with PROVIDER_MODE=live." -f $mode.ToUpper())
    exit 1
}
