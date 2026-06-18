# Launches ComfyUI with the API exposed (LAN + CORS), logging all output to a file.
# Portable: paths are derived from this script's own location ($PSScriptRoot), so just
# drop this file into the ComfyUI_windows_portable root (next to python_embeded\).
# Invoked at logon by the scheduled task via start_comfyui_hidden.vbs.
param(
    [int]$Port = 8188
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$log  = Join-Path $root 'comfyui-server.log'
Set-Location $root
& (Join-Path $root 'python_embeded\python.exe') -s (Join-Path $root 'ComfyUI\main.py') `
    --windows-standalone-build `
    --listen 0.0.0.0 `
    --port $Port `
    --enable-cors-header '*' *> $log
