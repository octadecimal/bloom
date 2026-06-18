# Adds an inbound Windows Firewall rule so LAN devices can reach the ComfyUI API.
# REQUIRES ELEVATION (run from an Administrator PowerShell).
#
# Scoped to the local subnet only (RemoteAddress = LocalSubnet) so the port is
# reachable from your LAN but not routable beyond it.
#
# Usage (from an elevated shell):
#   .\make_fw_rule.ps1            # opens TCP 8188
#   .\make_fw_rule.ps1 -Port 8000
param(
    [int]$Port = 8188,
    [string]$RuleName = ''
)
$ErrorActionPreference = 'Stop'
if (-not $RuleName) { $RuleName = "ComfyUI API ($Port)" }

# Idempotent: drop any existing rule of the same name first.
Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule `
    -DisplayName $RuleName `
    -Description 'Allow LAN access to ComfyUI REST/WebSocket API' `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Private, Public `
    -RemoteAddress LocalSubnet | Out-Null

Write-Host "Created firewall rule '$RuleName' (TCP $Port, inbound, LocalSubnet)."
