# ComfyUI workflows & setup

Reusable [ComfyUI](https://github.com/comfyanonymous/ComfyUI) API workflows for generating
themed text art — including premium **transparent-background** output — plus the scripts to
stand up a ComfyUI server with its REST API exposed.

Validated end-to-end against **ComfyUI 0.25.0** (Windows portable, NVIDIA/CUDA) on an
RTX 4070 Ti (12 GB).

## Contents

```
comfyui/
  workflows/
    ai_slots_neon.json             # FLUX-schnell: neon zombie "AI Slots" sign (opaque)
    ai_slots_transparent.json      # FLUX-schnell + BiRefNet matting -> transparent RGBA
    ai_slots_dev_transparent.json  # FLUX-dev (premium) + BiRefNet matting -> transparent RGBA
  scripts/
    run_api.bat                    # foreground launch (visible console), for manual runs
    run_comfyui.pyw                # windowless launch + file logging (run by pythonw.exe)
    register_task.ps1              # register logon auto-start task (needs admin)
    make_fw_rule.ps1               # open the API port to the LAN (needs admin)
```

`register_task.ps1` and `make_fw_rule.ps1` are **machine-level** helpers; they're parameterized
but touch the Task Scheduler / firewall and require elevation.

## Prerequisites

1. **NVIDIA GPU** + recent driver, and the ComfyUI **Windows portable** package
   (`ComfyUI_windows_portable_nvidia.7z` from the [releases](https://github.com/comfyanonymous/ComfyUI/releases)).
   Extract it; everything below assumes the `ComfyUI_windows_portable\` root.

2. **Models** — download into `ComfyUI\models\checkpoints\`:

   | File | Size | License | Used by |
   |------|------|---------|---------|
   | [`flux1-schnell-fp8.safetensors`](https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors) | ~16 GB | Apache-2.0 | `ai_slots_neon`, `ai_slots_transparent` |
   | [`flux1-dev-fp8.safetensors`](https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev-fp8.safetensors) | ~16 GB | **Non-commercial** | `ai_slots_dev_transparent` |

   Both are all-in-one fp8 checkpoints (transformer + CLIP + T5 + VAE) loadable via the
   standard `CheckpointLoaderSimple` node. FLUX renders legible in-image text far better than
   SDXL; `dev` is the most reliable.

3. **Custom node for transparency** — the `*_transparent` workflows need
   [`ComfyUI-RMBG`](https://github.com/1038lab/ComfyUI-RMBG) (background removal / matting):

   ```bash
   cd ComfyUI\custom_nodes
   git clone https://github.com/1038lab/ComfyUI-RMBG
   # Only two deps are actually needed for BiRefNet/RMBG-2.0 background removal.
   # Skip the full requirements.txt — its SAM/GroundingDINO/onnxruntime deps fail to build
   # on Windows/Python 3.13 (those sub-nodes simply don't load; harmless).
   ..\..\python_embeded\python.exe -m pip install opencv-python timm
   ```

   The BiRefNet-HR model (~900 MB) auto-downloads on first use.

## Running the API server

The API binds to `0.0.0.0:8188` with CORS enabled. **No authentication** — only expose on a
trusted network.

- **Quick / visible:** copy `scripts\run_api.bat` into the portable root and run it.
- **Auto-start at logon (hidden, with logging):** copy `scripts\run_comfyui.pyw` into the
  portable root, then from an **elevated** shell:
  ```powershell
  .\register_task.ps1 -ComfyUIRoot "C:\path\to\ComfyUI_windows_portable"
  ```
  The task runs `pythonw.exe run_comfyui.pyw` — `pythonw` is the windowless interpreter, so
  there's no console window or flash at logon, and the launcher redirects output to
  `comfyui-server.log`. Logon (not boot) is deliberate — CUDA needs an active user session.
- **LAN access:** from an **elevated** shell, `.\make_fw_rule.ps1` opens TCP 8188 to the local subnet.

Sanity check once running: `GET http://127.0.0.1:8188/system_stats`.

## Using a workflow (REST API)

These JSONs are in ComfyUI's **API format** — POST them to `/prompt`:

```powershell
$graph = Get-Content .\workflows\ai_slots_dev_transparent.json -Raw | ConvertFrom-Json
$body  = @{ prompt = $graph; client_id = [guid]::NewGuid().ToString() } | ConvertTo-Json -Depth 20
$r = Invoke-RestMethod http://127.0.0.1:8188/prompt -Method Post -Body $body -ContentType application/json
# poll http://127.0.0.1:8188/history/$($r.prompt_id) ; image lands in ComfyUI\output\
```

To change the text or look, edit node `6` (`text`) and node `3` (`seed`). FLUX is deterministic
per seed, so re-running a seed reproduces the image exactly.

### Transparency

The `*_transparent` workflows route `VAEDecode → BiRefNetRMBG (model: BiRefNet-HR,
background: Alpha, refine_foreground: true) → SaveImage`, producing a true RGBA PNG with
soft anti-aliased edges. Generate the subject on a **plain solid background** for the cleanest matte.

## Prompt / legibility notes

- Describe **bold, clean, readable** letters and treat the theme as **accents** (glow, slime,
  moss, cracks). Prompting "letters made of rotting flesh" garbles the glyphs.
- Put the quoted phrase (e.g. `"AI SLOTS"`) in the prompt; uppercase reads more reliably.
- schnell (4 steps, cfg 1, euler/simple) nails the text on ~4/6 seeds with a clean prompt;
  dev (24 steps, cfg 1, euler/beta, `FluxGuidance 3.5`) is more reliable and more detailed.
  Generate a few seeds and pick the best.
