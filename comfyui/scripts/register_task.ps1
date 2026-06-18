# Registers a Scheduled Task that auto-starts ComfyUI (hidden) at the current user's logon.
# REQUIRES ELEVATION (run from an Administrator PowerShell, or it will fail to register).
#
# Logon trigger (not boot) is intentional: CUDA/GPU apps need an active user session.
#
# Usage (from an elevated shell):
#   .\register_task.ps1 -ComfyUIRoot "C:\ComfyUI\ComfyUI_windows_portable"
#
# Assumes start_comfyui_hidden.vbs + start_comfyui.ps1 live in $ComfyUIRoot.
param(
    [Parameter(Mandatory = $true)]
    [string]$ComfyUIRoot,
    [string]$TaskName = 'ComfyUI API Server'
)
$ErrorActionPreference = 'Stop'

$vbs = Join-Path $ComfyUIRoot 'start_comfyui_hidden.vbs'
if (-not (Test-Path $vbs)) { throw "Launcher not found: $vbs" }

$user = "$env:USERDOMAIN\$env:USERNAME"

$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $vbs)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Starts ComfyUI with REST API on 0.0.0.0:8188 (LAN + CORS) at user logon.' `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' for $user."
Write-Host "Manage: Start-ScheduledTask / Stop-ScheduledTask / Disable-ScheduledTask -TaskName '$TaskName'"
