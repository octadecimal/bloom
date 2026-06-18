"""Windowless launcher for ComfyUI's API server, with file logging.

Run by the scheduled task via pythonw.exe (GUI-subsystem -> no console window,
no flash at logon). It spawns the real python.exe with the exact standard launch
command, CREATE_NO_WINDOW so the child has no console either, and redirects all
output to comfyui-server.log.

Place this file in the ComfyUI_windows_portable root (next to python_embeded\).

    pythonw.exe run_comfyui.pyw
"""
import os
import subprocess

PORT = "8188"

ROOT = os.path.dirname(os.path.abspath(__file__))
PYTHON = os.path.join(ROOT, "python_embeded", "python.exe")
MAIN = os.path.join("ComfyUI", "main.py")  # relative to ROOT (cwd below)
LOG = os.path.join(ROOT, "comfyui-server.log")

CREATE_NO_WINDOW = 0x08000000  # keep the spawned python.exe windowless too

cmd = [
    PYTHON, "-s", MAIN,
    "--windows-standalone-build",
    "--listen", "0.0.0.0",
    "--port", PORT,
    "--enable-cors-header", "*",
]

with open(LOG, "w", encoding="utf-8") as log:
    subprocess.run(
        cmd,
        cwd=ROOT,
        stdout=log,
        stderr=subprocess.STDOUT,
        creationflags=CREATE_NO_WINDOW,
    )
