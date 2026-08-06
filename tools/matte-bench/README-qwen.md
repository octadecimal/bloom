# Enabling the Qwen native-RGBA techniques

The `qwen-layered` Class B technique generates transparent art directly
(no matting pass). It appears in the bench automatically once the weights
below are installed on the ComfyUI box — no code change, no restart flag;
the availability probe detects them at bench startup.

Download from the Comfy-Org `Qwen-Image_ComfyUI` release on Hugging Face
and place on the GPU box:

| File                                            | Destination                        |
| ----------------------------------------------- | ---------------------------------- |
| `qwen_image_fp8_e4m3fn.safetensors` (~20 GB)    | `ComfyUI/models/diffusion_models/` |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` (~9 GB) | `ComfyUI/models/text_encoders/`    |
| `qwen_image_vae.safetensors` (~250 MB)          | `ComfyUI/models/vae/`              |

Then restart ComfyUI (it scans model folders at startup) and start the
bench. `just matte-bench probe` should list the Qwen files; if the bench
prints `qwen-layered disabled: Qwen weights not installed`, one of the
three files is missing or misnamed — the probe requires the full trio and
matches on `qwen_image` / `qwen` / `qwen_image_vae` in the loader lists.
