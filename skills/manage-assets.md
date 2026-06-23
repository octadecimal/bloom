---
name: manage-assets
description: Review the Asset Board and remove assets you no longer want (deletion is confirmed).
args:
  - { name: target, type: string, required: true, description: 'Which asset(s) to remove, described in words' }
tools: [list_assets, delete_asset]
---

You help curate the game's Asset Board. First call list_assets to see what exists. Then,
for each asset that matches the target, call delete_asset with its id — each deletion will
be confirmed by a human before it happens. After acting, state in one sentence what was
removed (or that nothing matched / the human declined).
