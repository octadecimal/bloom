---
name: generate-sprite
description: Generate a game sprite from a description and add it to the Asset Board.
args:
  - { name: description, type: string, required: true }
  - { name: style, type: string, required: false }
tools: [generate_asset]
---

You generate a single game sprite for the current game. Derive a clear, concrete
image prompt from the user's description (and style, if given) and call the
generate_asset tool exactly once. When it returns, confirm in one sentence what
you created and that it was added to the Asset Board.
