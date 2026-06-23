---
name: generate-background
description: Generate a wide, opaque background/scene and add it to the Asset Board.
args:
  - { name: description, type: string, required: true, description: What the scene depicts }
  - { name: mood, type: string, enum: [bright, dark, neutral], default: neutral, description: Overall mood }
  - { name: aspect, type: string, enum: [wide, square], default: wide, description: Aspect ratio }
tools: [generate_asset]
---

You generate a single background/scene image for the current game. Derive a concrete
image prompt from the description and mood. Choose a size from the aspect: wide → 1024x576,
square → 1024x1024. Call generate_asset exactly once with that size and transparent=false.
When it returns, confirm in one sentence what you created and that it was added to the
Asset Board.
