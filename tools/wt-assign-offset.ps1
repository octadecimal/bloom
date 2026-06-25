param([Parameter(Mandatory = $true)][string]$Target)

# Copy the primary checkout's .env into the new worktree (if present).
if (Test-Path .env) {
    Copy-Item .env (Join-Path $Target '.env') -Force
}

# Strip any inherited BLOOM_PORT_OFFSET so we never leave a duplicate key.
$envOut = Join-Path $Target '.env'
if (Test-Path $envOut) {
    (Get-Content $envOut) |
        Where-Object { $_ -notmatch '^\s*BLOOM_PORT_OFFSET\s*=' } |
        Set-Content $envOut -Encoding utf8
}

# Collect offsets already in use across every registered worktree (primary = 0).
$used = @(0)
$paths = (git worktree list --porcelain) |
    Where-Object { $_ -like 'worktree *' } |
    ForEach-Object { $_.Substring(9) }
foreach ($p in $paths) {
    $f = Join-Path $p '.env'
    if (Test-Path $f) {
        $m = Select-String -Path $f -Pattern '^\s*BLOOM_PORT_OFFSET\s*=\s*(\d+)' | Select-Object -First 1
        if ($m -and $m.Matches.Count -gt 0) { $used += [int]$m.Matches[0].Groups[1].Value }
    }
}

# Lowest free positive offset (reuses gaps left by removed worktrees).
$offset = 1
while ($used -contains $offset) { $offset++ }

Add-Content -Path $envOut -Value ("BLOOM_PORT_OFFSET={0}" -f $offset)
Write-Host ("BLOOM_PORT_OFFSET={0}  ->  backend {1} / frontend {2} / runtime {3}" -f $offset, (8000 + $offset), (4200 + $offset), (4300 + $offset))
