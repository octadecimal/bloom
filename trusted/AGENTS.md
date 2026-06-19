# trusted/ — the certified shared heart

Certified-grade code shared by **both** planes (the simulator and the server use
the math engine identically). Treat everything here as if a regulator will audit it.

- **Determinism is sacred.** Integer-only math in the outcome path: no floats, no
  clock/time, no I/O, no randomness source beyond an injected seed/index. Output
  MUST be bit-reproducible across platforms, forever.
- **Mechanics are append-only and immutable once shipped.** A behavior change is a
  NEW mechanic version, never an edit. Any change here is a re-certification event.
- **No AI / automated free-editing** of this code.
