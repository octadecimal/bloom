# bloom-runtime-server

Authoritative game-round server: verifies a `.pkg` archive, draws a seeded outcome
via `bloom-math`, records an audit entry, and returns the spin result over HTTP.

## Windows Rust toolchain (GNU target) prerequisite

Building this crate on a Windows-GNU target (the default for `x86_64-pc-windows-gnu`)
pulls in `tokio` and `windows-sys`, which require `dlltool` to generate raw-dylib
import libraries. The Rust self-contained `dlltool.exe` tries to spawn `as.exe`
(GNU assembler) as a subprocess; on some machines this launch fails with a
`NotImplementedError` / access-denied, breaking the build.

**Fix:** install a fully-working `dlltool` that bundles its own assembler, such as
[WinLibs](https://winlibs.com/) (POSIX/UCRT flavour):

```powershell
winget install BrechtSanders.WinLibs.POSIX.UCRT
```

Then tell Cargo which `dlltool` to use. Create a **local, git-ignored**
`.cargo/config.toml` at the repo root (already in `.gitignore` — do **not** commit
it) with the path that `winget` installed:

```toml
[env]
DLLTOOL = { value = "C:\\Users\\<you>\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\mingw64\\bin\\dlltool.exe", force = false }
```

Alternatively, prepend the WinLibs `bin` dir to `PATH` before Rust's self-contained
dir — Cargo picks whichever `dlltool` appears first on `PATH`.

This file is **machine-specific** (it encodes a username and a WinGet store hash);
that is why it lives outside git. Every developer who hits the build error on
Windows-GNU should create their own copy pointing at their local WinLibs install.
