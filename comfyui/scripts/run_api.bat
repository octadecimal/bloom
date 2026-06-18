@echo off
REM ComfyUI with the REST/WebSocket API exposed on the LAN (all interfaces) + CORS.
REM Place this file in the ComfyUI_windows_portable root (next to python_embeded\).
REM
REM   --listen 0.0.0.0        bind to every network interface (LAN-reachable)
REM   --enable-cors-header *  allow browser apps from any origin to call the API
REM
REM WARNING: ComfyUI has NO authentication. Anyone who can reach this port has
REM full access. Only run on a trusted network or behind a firewall/proxy.

set PORT=8188
.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --listen 0.0.0.0 --port %PORT% --enable-cors-header "*"
pause
