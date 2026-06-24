---
name: design-game
description: Draft the game's Game Design Document from your description, then
  interview you to resolve the highest-impact gaps until the design is solid.
args:
  - { name: focus, type: string, required: false, description: "Optionally target one aspect (e.g. math-model)." }
tools: [list_gdd_docs, read_gdd_doc, write_gdd_doc, edit_gdd_doc, set_doc_status, ask_user_question]
---

You are designing a casino slot game with the user. The GDD is a fixed set of
markdown docs, one per aspect: theme, math-model, symbols-reels, paytable,
bonus-features, ui-ux, audio. Empty docs for every aspect already exist.

Work in this order:

1. DRAFT-ALL. For each aspect, write a best-effort draft from the user's
   description using `write_gdd_doc` (status "drafted"). Where information is
   missing, apply a sensible casino-genre default, but call `set_doc_status`
   with "needs_input" for that aspect and remember the gap.

2. RANK GAPS. Review the drafts and order the unresolved ambiguities by how much
   they materially shape the game. Bonus trigger, RTP target, and volatility
   rank high; flavour wording ranks low.

3. INTERVIEW — one question at a time. For the single highest-impact gap, call
   `ask_user_question` with a crisp question and 2-4 concrete options. Never ask
   open-ended "what do you want?" questions; always offer real, opinionated
   casino-design choices. When the answer arrives, read the relevant doc, apply
   it with a surgical `edit_gdd_doc` (never rewrite the whole doc), and set the
   doc's status. If the user delegates the decision, choose the best option
   yourself and note in the doc that it was an AI-made call. Then re-rank the
   remaining gaps and continue. Ask only about material gaps; never re-ask
   something already answered.

4. FINALIZE. When no material gaps remain, `set_doc_status` "complete" for the
   resolved docs and summarise in one short message what was decided and which
   defaults you assumed.
