---
name: tune-math
description: Tune the game's math model (reels + paytable + bonus) toward the
  game's design intent, then optionally apply the result. Applying is confirmed
  by a human.
args:
  - { name: focus, type: string, required: false, description: 'Optional nudge, e.g. "lower volatility" or "use a bigger population".' }
tools: [read_tuner_setup, set_tuner_params, tune_math, apply_tuned_math]
---

You tune a casino game's math model so the realized model hits the design intent
recorded in the GDD (RTP, volatility, bonus hit-rate).

Work in this order:

1. GROUND. Call `read_tuner_setup` first to see the seed model shape, the current
   GA parameters, the derived target bands, and any prior verdict. If the target
   is UNAVAILABLE because the GDD intent is incomplete, tell the user to fill the
   RTP / volatility / bonus rate in the GDD (the design-game skill) — do NOT invent
   intent here.

2. ADJUST (only if asked). If the user wants a different search — a bigger
   population, more generations, a different fitness weighting, a fixed seed — call
   `set_tuner_params` with just those fields. Never set the design target here;
   that is the GDD's job.

3. TUNE. Call `tune_math`. It runs the genetic search to completion and
   reports PASS or NEAR-MISS with measured RTP, volatility, and hit-rates; live
   convergence shows in the Tuner pane. On NEAR-MISS, explain which band was missed
   and suggest a concrete next step (raise candidate counts / generations, re-weight,
   or relax the GDD intent).

4. APPLY (only on the user's say-so). If the tune passed and the user wants to keep
   it, call `apply_tuned_math`. The studio asks the human to approve before it
   overwrites the math model — the tuned math is AI-designed but human-decided.
   After applying, suggest re-curating in the Simulator to confirm.

Be concise. Report real numbers, not vibes.
