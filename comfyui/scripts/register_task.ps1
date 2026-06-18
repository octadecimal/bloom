# Registers a Scheduled Task that auto-starts ComfyUI (hidden, no console flash) at logon.
# REQUIRES ELEVATION (run from an Administrator PowerShell, or it will fail to register).
#
# The task runs pythonw.exe (the windowless interpreter) on run_comfyui.pyw, which boots
# ComfyUI and logs to comfyui-server.log. Logon trigger (not boot) is intentional:
# CUDA/GPU apps need an active user session.
#
# Usage (from an elevated shell):
#   .\register_task.ps1 -ComfyUIRoot "C:\ComfyUI\ComfyUI_windows_portable"
#
# Assumes run_comfyui.pyw lives in $ComfyUIRoot (next to python_embeded\).
param(
    [Parameter(Mandatory = $true)]
    [string]$ComfyUIRoot,
    [string]$TaskName = 'ComfyUI API Server'
)
$ErrorActionPreference = 'Stop'

$pythonw  = Join-Path $ComfyUIRoot 'python_embeded\pythonw.exe'
$launcher = Join-Path $ComfyUIRoot 'run_comfyui.pyw'
foreach ($p in @($pythonw, $launcher)) {
    if (-not (Test-Path $p)) { throw "Required file not found: $p" }
}

$user = "$env:USERDOMAIN\$env:USERNAME"

$action  = New-ScheduledTaskAction -Execute $pythonw -Argument ('"{0}"' -f $launcher) -WorkingDirectory $ComfyUIRoot
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
