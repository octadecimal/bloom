' Starts ComfyUI fully hidden (no console window flash) at logon.
' Portable: resolves start_comfyui.ps1 from this script's own folder, so place both
' files together in the ComfyUI_windows_portable root.
' Window style 0 = hidden; the PowerShell launcher redirects output to comfyui-server.log.
Dim fso, scriptDir, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\start_comfyui.ps1"
CreateObject("WScript.Shell").Run _
    "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
