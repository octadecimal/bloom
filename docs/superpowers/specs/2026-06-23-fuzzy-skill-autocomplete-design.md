# Fuzzy skill autocomplete — design

**Date:** 2026-06-23
**Status:** Approved (brainstorming)
**Scope:** `studio/frontend` llm-chat plugin — the `/skill` composer autocomplete.

## Problem

The skill autocomplete popup filters skills by prefix only:

```ts
// ChatRoomPane.tsx
const matches = selecting ? (s.skills.get() as ISkill[]).filter((sk) => sk.name.startsWith(slash!.skillName)) : [];
```

`name.startsWith(prefix)` is brittle: it only matches at the start (`/sprite` never finds
`generate-sprite`), is intolerant of typos (`/genrate`), never matches on description, and offers
no relevance ranking. We want fuzzy matching with relevance-ranked results and matched-character
highlighting, backed by a proven library rather than hand-rolled scoring.

**Note on Fuse's matching model:** Fuse.js is a bitap/edit-distance matcher — it finds the pattern
as a typo-tolerant substring (match anywhere, not just the prefix; tolerate a few errors). It is
**not** a gapped-subsequence matcher (it will not match `grsp` → `generate-sprite`). That is the
accepted trade-off for choosing one general-purpose library; the upgrade over `startsWith` is
match-anywhere + typo tolerance + description matching + relevance ranking.

## Decisions

| Decision      | Choice                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Library       | **Fuse.js** — one general-purpose fuzzy lib for the whole app (future reuse: messages, assets, palettes), kept behind a thin swappable seam. |
| Match display | **Rank by relevance (best first) + highlight matched characters** in whichever field hit.                                                    |
| Match scope   | **Name (weight 0.7) + description (weight 0.3).** A name hit always outranks a description-only hit.                                         |
| Seam          | Fuse is imported in **exactly one** new module; its types never reach components.                                                            |

These honor the repo's `prefer-proven-libraries` principle: reach for a mature library, but keep
it behind a thin, swappable seam.

## Architecture

### New module: `studio/frontend/src/plugins/llm-chat/fuzzySkills.ts`

The single owner of Fuse. `slashParse.ts` remains the _draft → parts_ parser; `fuzzySkills.ts`
is the _skills + query → ranked matches with highlight positions_ matcher. Two small, isolated,
independently testable units.

```ts
import type { ISkill } from './state';

/** One run of text in a rendered match, flagged as matched (highlight) or not. */
export interface IFuzzySegment {
  text: string;
  matched: boolean;
}

/** A skill that matched the query, with pre-split highlight segments and score. */
export interface ISkillMatch {
  skill: ISkill;
  nameSegments: IFuzzySegment[]; // skill.name split into matched/unmatched runs
  descSegments: IFuzzySegment[]; // skill.description likewise; [] when no desc or no desc hit
  score: number; // lower is better (Fuse convention); for debugging/secondary sort only
}

/** Rank skills against `query`, best match first, with highlight segments. */
export function fuzzyMatchSkills(skills: ISkill[], query: string): ISkillMatch[];
```

**Why segments, not raw indices.** The component maps `IFuzzySegment[]` → spans (matched runs as
`<strong>`). Fuse returns range-based `indices` (`[[start, end], …]`); converting those to a
boolean mask and then to contiguous runs happens **inside the seam**. The component never sees a
Fuse type or an index array. Swapping the library out only rewrites this file.

**Fuse configuration:**

```ts
new Fuse(skills, {
  keys: [
    { name: 'name', weight: 0.7 },
    { name: 'description', weight: 0.3 },
  ],
  includeMatches: true,
  includeScore: true,
  ignoreLocation: true, // short command names: don't penalize match position
  threshold: 0.4, // fuzziness ceiling (tunable)
  minMatchCharLength: 1,
});
```

Weighting guarantees a name hit outranks a description-only hit. `ignoreLocation` matters because
skill names are short tokens where Fuse's default location/distance penalty distorts ranking.

**Empty query** (`/` with no name typed yet): return **all** skills in their original backend
order (the sorted `*.md` glob order), each rendered as a single unmatched segment. This preserves
today's "type `/` to browse every skill" behavior — Fuse returns nothing for an empty pattern, so
the helper special-cases it.

**No match:** return `[]` (popup hidden, same as today).

**Purity / cost.** `fuzzyMatchSkills` is pure and stateless — it constructs a Fuse instance per
call. The skills list is tiny (a handful of markdown skills), so construction cost is negligible.
Memoizing the Fuse index is deferred (YAGNI) until profiling shows a need.

### Wiring: `ChatRoomPane.tsx`

- Replace the line-197 filter with `fuzzyMatchSkills(s.skills.get() as ISkill[], slash!.skillName)`,
  keeping the existing `selecting` hot-path guard so render-count discipline is unchanged (the
  skills leaf is still read only while actively selecting).
- `SkillAutocomplete` takes `matches: ISkillMatch[]`. It renders `/` followed by the name segments
  (matched runs wrapped in `<strong>`) and, below/beside, the description segments (matched runs in
  `<strong>`). Keeps `data-testid={skill-option-${name}}` and `data-active` exactly as today.
- `decideEnter` / `accept` receive a lightweight projection — `matches.map((m) => ({ name: m.skill.name }))`
  — so **`slashParse.ts` stays decoupled** from fuzzy types. Its signature and unit tests are
  untouched.
- Keyboard navigation (`moveHighlight`, `clampHighlight`, Tab / Esc / Arrow / Enter) is unchanged;
  it is index-based over `matches.length`. `highlight = 0` now means "best fuzzy match" rather than
  "alphabetically first."

### Highlight markup

Matched runs render as `<strong>` (semantic emphasis, styleable via the design language). This
gives the e2e suite a stable target (`skill-option-<name> strong`) to assert that typed characters
are highlighted, without adding a bespoke `data-*` hook.

## Behavioral contract changes (e2e is authoritative)

`e2e/skill-autocomplete.spec.ts` is the source of truth and **moves with the feature**:

- The default-order assertion changes. Today `/gen` is backend-ordered (`generate-background`
  before `generate-sprite`). Under fuzzy ranking the order is score-based; the spec is updated to
  assert the new deterministic order for the seeded skills.
- A new assertion verifies that the typed characters render highlighted (a `<strong>` inside the
  active option contains the typed substring).
- All existing behavior — Tab completes + hides popup, prose + Enter runs, bare Enter opens the
  form, Escape dismisses, arrows move the active option — stays green.

## Test plan (TDD)

**Unit — `fuzzySkills.spec.ts` (new):**

- ranks the best match first (subsequence beats no-match; closer match scores better);
- name match produces matched segments over the name;
- description match produces matched segments over the description;
- a name hit outranks a description-only hit (weighting);
- empty query returns **all** skills in original order, each a single unmatched segment;
- no match returns `[]`;
- segment reconstruction round-trips: concatenated `segment.text` equals the original string.

**Component — `ChatRoomPane.spec.tsx` (extend):**

- the popup surfaces a fuzzy (non-prefix) match;
- matched characters render inside `<strong>`.

**e2e — `skill-autocomplete.spec.ts` (update):** as in the contract section above.

## Out of scope (YAGNI)

- Memoized / cached Fuse index.
- Typo-distance or threshold tuning UI.
- Fuzzy search over message history or game assets (the seam makes this a later reuse, not part of
  this change).
- Folding tool-call/run-step messages into chat history (that is the separate second feature).

## Files touched

- `studio/frontend/src/plugins/llm-chat/fuzzySkills.ts` — new seam.
- `studio/frontend/src/plugins/llm-chat/fuzzySkills.spec.ts` — new unit tests.
- `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` — wire helper + render segments.
- `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx` — extend component tests.
- `studio/frontend/e2e/skill-autocomplete.spec.ts` — update authoritative contract.
- root `package.json` — add `fuse.js` dependency.
