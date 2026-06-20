// A tiny shell signal so the "Save arrangement…" command (registered in the host
// layer at boot) can open the Menubar-owned SaveLayoutDialog.
let opener: (() => void) | null = null;

export function setSaveLayoutOpener(fn: () => void): void {
  opener = fn;
}

export function openSaveLayoutDialog(): void {
  opener?.();
}
