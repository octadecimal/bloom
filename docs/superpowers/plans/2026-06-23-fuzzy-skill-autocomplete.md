# Fuzzy Skill Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prefix-only skill autocomplete filter with Fuse.js fuzzy matching that ranks by relevance and highlights matched characters in the skill name and description.

**Architecture:** A new pure module `fuzzySkills.ts` is the single owner of Fuse.js; it turns `(skills, query)` into ranked `ISkillMatch[]` with pre-split highlight segments, so components never touch a Fuse type or index array. `ChatRoomPane.tsx` swaps its `startsWith` filter for this helper and renders the segments; `slashParse.ts` stays decoupled via a `{ name }` projection.

**Tech Stack:** TypeScript (strict, `I`-prefixed interfaces), React 18, Vitest + Testing Library (unit/component), Playwright (e2e, replay backend), Fuse.js v7.

## Global Constraints

- **TypeScript interfaces always use an `I` prefix** (`IFuzzySegment`, `ISkillMatch`).
- **TDD is mandatory:** failing test → watch it fail → minimal code → pass → refactor.
- **Prettier is a CI gate.** Run `npx prettier --write <files>` before every commit; CI runs `prettier --check .`.
- **Frontend CI gates (run all before any push), exact CI commands:** from repo root — `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`. Vitest green ≠ types valid; run typecheck too.
- **Browser e2e is NOT in CI** — run locally with `just e2e` against a replay backend (start `just backend-serve-replay` first).
- **Conventional Commits** for every commit (`feat:`, `test:`, `refactor:`, `build:`, `docs:`).
- **Studio design language:** no raw colors outside `styles.css`; matched-character emphasis uses a semantic `<strong>` styled with existing tokens/utilities, not a new color.
- **Render-count discipline:** the skills state leaf is read only while actively selecting (the existing `selecting` guard). Do not move skill reads onto the unconditional hot path.

### Environment notes (Windows + PowerShell)

- If `npx`/`git`/`gh` are missing from a fresh terminal, refresh PATH:
  ```powershell
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```
- Unit tests run from the `studio/frontend` directory.

### Seeded skills (ground truth for tests)

The backend serves three markdown skills from `skills/` (sorted glob order):

1. `generate-background` — "Generate a wide, opaque background/scene and add it to the Asset Board."
2. `generate-sprite` — "Generate a game sprite from a description and add it to the Asset Board."
3. `manage-assets` — "Review the Asset Board and remove assets you no longer want (deletion is confirmed)."

Key facts these tests rely on:

- `asset` is a substring of the **name** `manage-assets` (weight 0.7) and of the **description** "Asset Board" in all three (weight 0.3) → `manage-assets` must rank first for query `asset`.
- `sprite` is a non-prefix substring of `generate-sprite` (name) → demonstrates match-anywhere.
- `remove` appears only in the `manage-assets` **description** (its name has no `r`) → demonstrates description-only matching with name segments unmatched.

---

## Task 1: Add the Fuse.js dependency

**Files:**

- Modify: `package.json` (root) — add `fuse.js` to `dependencies`.

**Interfaces:**

- Consumes: nothing.
- Produces: the `fuse.js` module importable as `import Fuse from 'fuse.js'`.

- [ ] **Step 1: Install the dependency**

From the repo root (`C:\code\bloom`):

```bash
npm install fuse.js@^7.1.0 --save
```

- [ ] **Step 2: Verify it landed in dependencies**

Run:

```bash
node -e "console.log(require('./package.json').dependencies['fuse.js'])"
```

Expected: prints a version like `^7.1.0` (not `undefined`).

- [ ] **Step 3: Verify the module imports**

Run:

```bash
node -e "const F=require('fuse.js'); console.log(typeof (F.default||F))"
```

Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add fuse.js for fuzzy skill autocomplete"
```

---

## Task 2: `fuzzySkills.ts` — empty/no-match/all behavior (the seam skeleton)

Build the helper's structure and the two boundary cases first, before wiring Fuse's match indices. This task establishes the exported types every later task and component depends on.

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/fuzzySkills.ts`
- Test: `studio/frontend/src/plugins/llm-chat/fuzzySkills.spec.ts`

**Interfaces:**

- Consumes: `ISkill` from `./state` (`{ name: string; description: string; args: ISkillArg[] }`).
- Produces:
  - `interface IFuzzySegment { text: string; matched: boolean }`
  - `interface ISkillMatch { skill: ISkill; nameSegments: IFuzzySegment[]; descSegments: IFuzzySegment[]; score: number }`
  - `function fuzzyMatchSkills(skills: ISkill[], query: string): ISkillMatch[]`
  - For an empty/whitespace query: returns **all** skills in input order, `score: 0`, `nameSegments` = one unmatched segment covering the whole name, `descSegments` = one unmatched segment covering the whole description (or `[]` if the description is empty).

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/fuzzySkills.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fuzzyMatchSkills, type ISkillMatch } from './fuzzySkills';
import type { ISkill } from './state';

const skill = (name: string, description: string): ISkill => ({ name, description, args: [] });

const SKILLS: ISkill[] = [
  skill('generate-background', 'Generate a wide, opaque background/scene and add it to the Asset Board.'),
  skill('generate-sprite', 'Generate a game sprite from a description and add it to the Asset Board.'),
  skill('manage-assets', 'Review the Asset Board and remove assets you no longer want (deletion is confirmed).'),
];

// Concatenating a match's segments must reproduce the original string.
const joinName = (m: ISkillMatch) => m.nameSegments.map((s) => s.text).join('');
const joinDesc = (m: ISkillMatch) => m.descSegments.map((s) => s.text).join('');

describe('fuzzyMatchSkills — boundary cases', () => {
  it('returns all skills in input order for an empty query, with no highlights', () => {
    const out = fuzzyMatchSkills(SKILLS, '');
    expect(out.map((m) => m.skill.name)).toEqual(['generate-background', 'generate-sprite', 'manage-assets']);
    expect(out.every((m) => m.nameSegments.every((s) => !s.matched))).toBe(true);
    expect(out.every((m) => m.descSegments.every((s) => !s.matched))).toBe(true);
  });

  it('treats a whitespace-only query as empty', () => {
    expect(fuzzyMatchSkills(SKILLS, '   ').map((m) => m.skill.name)).toEqual(['generate-background', 'generate-sprite', 'manage-assets']);
  });

  it('returns [] when nothing matches', () => {
    expect(fuzzyMatchSkills(SKILLS, 'zzzzzzz')).toEqual([]);
  });

  it('round-trips segment text back to the original strings', () => {
    const out = fuzzyMatchSkills(SKILLS, '');
    expect(joinName(out[0])).toBe('generate-background');
    expect(joinDesc(out[0])).toBe('Generate a wide, opaque background/scene and add it to the Asset Board.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd studio/frontend && npx vitest run src/plugins/llm-chat/fuzzySkills.spec.ts
```

Expected: FAIL — `fuzzySkills.ts` does not exist / `fuzzyMatchSkills is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/fuzzySkills.ts`:

```ts
import Fuse from 'fuse.js';
import type { ISkill } from './state';

/** One run of text in a rendered match, flagged as matched (highlight) or not. */
export interface IFuzzySegment {
  text: string;
  matched: boolean;
}

/** A skill that matched the query, with pre-split highlight segments and score. */
export interface ISkillMatch {
  skill: ISkill;
  nameSegments: IFuzzySegment[];
  descSegments: IFuzzySegment[];
  score: number;
}

/** Whole string as a single unmatched segment (or [] for an empty string). */
function plainSegments(text: string): IFuzzySegment[] {
  return text.length > 0 ? [{ text, matched: false }] : [];
}

/** Rank skills against `query`, best match first, with highlight segments. */
export function fuzzyMatchSkills(skills: ISkill[], query: string): ISkillMatch[] {
  const q = query.trim();
  if (q === '') {
    return skills.map((skill) => ({
      skill,
      nameSegments: plainSegments(skill.name),
      descSegments: plainSegments(skill.description),
      score: 0,
    }));
  }
  // Fuse wiring added in the next task.
  return [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd studio/frontend && npx vitest run src/plugins/llm-chat/fuzzySkills.spec.ts
```

Expected: PASS (4 tests). The "nothing matches" case passes trivially because the Fuse branch returns `[]` for now.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/fuzzySkills.ts studio/frontend/src/plugins/llm-chat/fuzzySkills.spec.ts
git commit -m "feat(chat): fuzzySkills seam — types + empty/no-match cases"
```

---

## Task 3: `fuzzySkills.ts` — Fuse matching, ranking, and highlight segments

Wire Fuse for non-empty queries: rank results, weight name over description, and convert Fuse's match indices into highlight segments.

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/fuzzySkills.ts`
- Test: `studio/frontend/src/plugins/llm-chat/fuzzySkills.spec.ts` (extend)

**Interfaces:**

- Consumes: `Fuse` (default export from `fuse.js`), the types from Task 2.
- Produces: `fuzzyMatchSkills` now returns Fuse-ranked matches for non-empty queries, with `nameSegments`/`descSegments` reflecting matched character runs. Same signature as Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `studio/frontend/src/plugins/llm-chat/fuzzySkills.spec.ts`:

```ts
describe('fuzzyMatchSkills — fuzzy ranking and highlights', () => {
  it('matches a non-prefix substring of the name', () => {
    const out = fuzzyMatchSkills(SKILLS, 'sprite');
    expect(out[0].skill.name).toBe('generate-sprite');
  });

  it('highlights the matched run inside the name', () => {
    const out = fuzzyMatchSkills(SKILLS, 'sprite');
    const matched = out[0].nameSegments
      .filter((s) => s.matched)
      .map((s) => s.text)
      .join('');
    expect(matched.toLowerCase()).toContain('sprite');
    // Segments still reconstruct the full name.
    expect(out[0].nameSegments.map((s) => s.text).join('')).toBe('generate-sprite');
  });

  it('ranks a name hit above a description-only hit (weighting)', () => {
    // "asset" is in the NAME manage-assets and in the DESCRIPTION ("Asset Board") of the others.
    const out = fuzzyMatchSkills(SKILLS, 'asset');
    expect(out[0].skill.name).toBe('manage-assets');
    expect(out.length).toBeGreaterThan(1); // the generate-* skills also match via description
  });

  it('highlights a description-only match and leaves the name unhighlighted', () => {
    // "remove" appears only in the manage-assets description; its name has no "r".
    const out = fuzzyMatchSkills(SKILLS, 'remove');
    const top = out.find((m) => m.skill.name === 'manage-assets')!;
    expect(top.nameSegments.some((s) => s.matched)).toBe(false);
    const desc = top.descSegments
      .filter((s) => s.matched)
      .map((s) => s.text)
      .join('');
    expect(desc.toLowerCase()).toContain('remove');
  });

  it('orders results best-first by score (ascending)', () => {
    const out = fuzzyMatchSkills(SKILLS, 'asset');
    const scores = out.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd studio/frontend && npx vitest run src/plugins/llm-chat/fuzzySkills.spec.ts
```

Expected: FAIL — the new cases get `[]` from the Fuse branch (e.g. `Cannot read properties of undefined (reading 'skill')`).

- [ ] **Step 3: Implement the Fuse branch**

In `studio/frontend/src/plugins/llm-chat/fuzzySkills.ts`, add the index-to-segments helper and replace the `return []` placeholder:

```ts
/** Build segments from a string and inclusive [start,end] match ranges (Fuse format). */
function segmentsFromIndices(text: string, ranges: ReadonlyArray<readonly [number, number]>): IFuzzySegment[] {
  if (ranges.length === 0) return plainSegments(text);
  const matched = new Array<boolean>(text.length).fill(false);
  for (const [start, end] of ranges) {
    for (let i = start; i <= end && i < text.length; i++) matched[i] = true;
  }
  const segments: IFuzzySegment[] = [];
  let i = 0;
  while (i < text.length) {
    const flag = matched[i];
    let j = i + 1;
    while (j < text.length && matched[j] === flag) j++;
    segments.push({ text: text.slice(i, j), matched: flag });
    i = j;
  }
  return segments;
}
```

Then replace the trailing `// Fuse wiring added in the next task.\n  return [];` with:

```ts
const fuse = new Fuse(skills, {
  keys: [
    { name: 'name', weight: 0.7 },
    { name: 'description', weight: 0.3 },
  ],
  includeMatches: true,
  includeScore: true,
  ignoreLocation: true, // short command names: don't penalize match position
  threshold: 0.4, // fuzziness ceiling
  minMatchCharLength: 1,
});

return fuse.search(q).map((r) => {
  const nameRanges = r.matches?.find((m) => m.key === 'name')?.indices ?? [];
  const descRanges = r.matches?.find((m) => m.key === 'description')?.indices ?? [];
  return {
    skill: r.item,
    nameSegments: segmentsFromIndices(r.item.name, nameRanges),
    descSegments: segmentsFromIndices(r.item.description, descRanges),
    score: r.score ?? 0,
  };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd studio/frontend && npx vitest run src/plugins/llm-chat/fuzzySkills.spec.ts
```

Expected: PASS (all boundary + fuzzy tests). If the weighting test fails (a `generate-*` outranks `manage-assets`), confirm `ignoreLocation: true` and the `0.7`/`0.3` weights are present — those are what make the name key dominate.

- [ ] **Step 5: Typecheck (CI command)**

Run from repo root:

```bash
npx nx typecheck frontend
```

Expected: no errors. (Fuse's `matches`/`indices` are typed; `indices` is `ReadonlyArray<readonly [number, number]>`, which matches `segmentsFromIndices`.)

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/fuzzySkills.ts studio/frontend/src/plugins/llm-chat/fuzzySkills.spec.ts
git commit -m "feat(chat): Fuse-backed fuzzy matching with highlight segments"
```

---

## Task 4: Wire `ChatRoomPane.tsx` to the fuzzy helper and render segments

Swap the `startsWith` filter for `fuzzyMatchSkills`, render matched runs as `<strong>`, and keep `slashParse.ts` decoupled via a `{ name }` projection.

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
  - Import line (`./slashParse` import block, ~line 11): add `import { fuzzyMatchSkills, type ISkillMatch } from './fuzzySkills';`
  - `SkillAutocomplete` component (~lines 132-153)
  - `matches` computation (~line 197)
  - `accept`/`decideEnter` call sites (~lines 233, 239-242)
  - The `popupOpen && <SkillAutocomplete .../>` render (~line 274)
- Test: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx` (extend)

**Interfaces:**

- Consumes: `fuzzyMatchSkills`, `ISkillMatch` from Task 3; the existing `decideEnter(draft, matches: { name: string }[], highlight)`, `moveHighlight`, `clampHighlight` from `slashParse.ts` (unchanged).
- Produces: a `matches: ISkillMatch[]` value in `ChatRoomPane`; `SkillAutocomplete` now accepts `matches: ISkillMatch[]`.

- [ ] **Step 1: Write the failing component test**

Append to `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx` (inside the existing top-level `describe('ChatRoomPane', ...)`), after the existing tests. This reuses the file's existing `render`, `screen`, `fireEvent` imports and `beforeEach` seeding. Seed skills onto state first:

```ts
it('surfaces a fuzzy (non-prefix) match and highlights the typed chars', () => {
  chatSlice().skills.set([
    { name: 'generate-sprite', description: 'Generate a game sprite and add it to the Asset Board.', args: [] },
    { name: 'manage-assets', description: 'Review the Asset Board and remove assets.', args: [] },
  ]);
  render(<ChatRoomPane />);
  fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: '/sprite' } });
  // Non-prefix substring still matches under Fuse:
  const option = screen.getByTestId('skill-option-generate-sprite');
  expect(option).toBeTruthy();
  // Matched characters render inside <strong>:
  const strongText = Array.from(option.querySelectorAll('strong'))
    .map((el) => el.textContent ?? '')
    .join('')
    .toLowerCase();
  expect(strongText).toContain('sprite');
});
```

Ensure `chatSlice` is imported in the test file (it already imports from `./state` — add `chatSlice` to that import if missing).

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd studio/frontend && npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx
```

Expected: FAIL — with the old `startsWith` filter, `/sprite` matches nothing, so `skill-option-generate-sprite` is absent.

- [ ] **Step 3: Replace the `matches` computation**

In `ChatRoomPane.tsx`, change the matches line (~197) from:

```tsx
const matches = selecting ? (s.skills.get() as ISkill[]).filter((sk) => sk.name.startsWith(slash!.skillName)) : [];
```

to:

```tsx
const matches: ISkillMatch[] = selecting ? fuzzyMatchSkills(s.skills.get() as ISkill[], slash!.skillName) : [];
```

- [ ] **Step 4: Update the `decideEnter`/`accept`/Tab call sites**

`decideEnter` and the Tab handler take `{ name: string }[]`. Project the matches so `slashParse.ts` stays decoupled.

In the `Tab` branch of `onComposerKeyDown` (~line 233), change:

```tsx
accept(matches[clampHighlight(highlight, matches.length)].name);
```

to:

```tsx
accept(matches[clampHighlight(highlight, matches.length)].skill.name);
```

In the `Enter` branch (~line 239), change:

```tsx
const decision = decideEnter(draft, matches, highlight);
```

to:

```tsx
const decision = decideEnter(
  draft,
  matches.map((m) => ({ name: m.skill.name })),
  highlight,
);
```

- [ ] **Step 5: Update `SkillAutocomplete` to take `ISkillMatch[]` and render segments**

Replace the `SkillAutocomplete` component (~lines 132-153) with:

```tsx
function SkillAutocomplete({ matches, highlight, onPick }: { matches: ISkillMatch[]; highlight: number; onPick: (name: string) => void }) {
  if (matches.length === 0) return null;
  return (
    <ul data-testid="skill-autocomplete" className="m-0 list-none rounded-md border bg-surface p-1 text-sm shadow-md">
      {matches.map((m, i) => (
        <li
          key={m.skill.name}
          data-testid={`skill-option-${m.skill.name}`}
          data-active={i === highlight ? 'true' : 'false'}
          className={`cursor-pointer rounded px-2 py-1 text-foreground ${i === highlight ? 'bg-raised' : 'hover:bg-raised'}`}
          onMouseDown={(e) => {
            e.preventDefault(); // keep composer focus
            onPick(m.skill.name);
          }}
        >
          <span className="font-semibold text-accent-text">
            /
            {m.nameSegments.map((seg, j) =>
              seg.matched ? (
                <strong key={j} className="font-bold underline decoration-accent-text/60">
                  {seg.text}
                </strong>
              ) : (
                <span key={j}>{seg.text}</span>
              ),
            )}
          </span>
          {m.descSegments.length > 0 ? (
            <span className="ml-2 text-muted-foreground">
              {m.descSegments.map((seg, j) =>
                seg.matched ? (
                  <strong key={j} className="font-semibold text-foreground">
                    {seg.text}
                  </strong>
                ) : (
                  <span key={j}>{seg.text}</span>
                ),
              )}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Update the `SkillAutocomplete` render site**

At the render (~line 274), the props already pass `matches`, `highlight`, `onPick={accept}`. Confirm it reads:

```tsx
popupOpen && <SkillAutocomplete matches={matches} highlight={clampHighlight(highlight, matches.length)} onPick={accept} />;
```

No change needed if it already matches; the `matches` variable is now `ISkillMatch[]`, which the new component expects.

- [ ] **Step 7: Remove the now-unused `ISkill` import if orphaned**

If `ISkill` is no longer referenced in `ChatRoomPane.tsx` after the `matches` change, remove it from the `./state` import to keep the typecheck/lint clean. (The `formSkill` block near line 168 still casts to `ISkill`, so it likely stays — verify before removing.)

- [ ] **Step 8: Run the component test to verify it passes**

Run:

```bash
cd studio/frontend && npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx
```

Expected: PASS — including the new fuzzy/highlight test and all pre-existing ChatRoomPane tests (render-count, send, etc.).

- [ ] **Step 9: Typecheck (CI command)**

Run from repo root:

```bash
npx nx typecheck frontend
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
git commit -m "feat(chat): render fuzzy-ranked skill autocomplete with highlights"
```

---

## Task 5: Update the authoritative e2e contract

The Playwright suite is the source of truth and moves with the feature: keep all existing behaviors green, add a highlight assertion, and add a match-anywhere assertion.

**Files:**

- Modify: `studio/frontend/e2e/skill-autocomplete.spec.ts`

**Interfaces:**

- Consumes: the running replay backend (seeded skills above), the `data-testid` hooks unchanged from Task 4.
- Produces: nothing for later tasks (final task).

- [ ] **Step 1: Confirm the default order for `/gen` empirically**

Both `generate-background` and `generate-sprite` match `gen` as a name prefix (equal-ish score); Fuse's sort is stable, so input order (sorted glob) should keep `generate-background` first. Before editing, run the existing suite to see the current pass/fail and the real order (start the replay backend in another terminal: `just backend-serve-replay`):

```bash
just e2e
```

Expected: the existing `arrow keys move the active option` test still passes (default active = `generate-background`). If Fuse reorders it, update that test's expectation to the observed order and note it.

- [ ] **Step 2: Add a match-anywhere (non-prefix) test**

Add this test inside the `test.describe('skill autocomplete keyboard navigation', ...)` block in `studio/frontend/e2e/skill-autocomplete.spec.ts`:

```ts
test('matches a non-prefix substring (fuzzy, not just startsWith)', async ({ page }) => {
  await openApp(page, 'alice');
  await createRoom(page, `AC ${Date.now()}`);
  const composer = page.getByTestId('chat-composer');
  await composer.fill('/sprite');
  // "sprite" is not a prefix of any skill name; prefix filtering would show nothing.
  await expect(page.getByTestId('skill-option-generate-sprite')).toBeVisible();
});
```

- [ ] **Step 3: Add a matched-character highlight test**

Add this test in the same block:

```ts
test('highlights the typed characters in the matched name', async ({ page }) => {
  await openApp(page, 'alice');
  await createRoom(page, `AC ${Date.now()}`);
  const composer = page.getByTestId('chat-composer');
  await composer.fill('/sprite');
  const option = page.getByTestId('skill-option-generate-sprite');
  await expect(option).toBeVisible();
  // The matched run renders inside <strong>; its text includes the typed chars.
  await expect(option.locator('strong').first()).toContainText('sprite');
});
```

- [ ] **Step 4: Run the full e2e suite**

With the replay backend running (`just backend-serve-replay` in another terminal):

```bash
just e2e
```

Expected: PASS — the two new tests plus all five pre-existing ones (arrows, Tab-complete+hide, Tab+prose+Enter runs, Tab+bare Enter opens form, Escape dismisses).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/skill-autocomplete.spec.ts
git commit -m "test(chat): e2e contract for fuzzy match-anywhere + highlight"
```

---

## Task 6: Full gate sweep and PR

**Files:** none (verification + integration).

**Interfaces:**

- Consumes: everything above.
- Produces: a merged PR.

All four commands below run from the repo root and mirror the CI Frontend job exactly.

- [ ] **Step 1: Prettier (whole repo gate)**

```bash
npx prettier --write . && npx prettier --check .
```

Expected: "All matched files use Prettier code style!"

- [ ] **Step 2: Typecheck**

```bash
npx nx typecheck frontend
```

Expected: no errors.

- [ ] **Step 3: Full unit suite**

```bash
npx nx test frontend
```

Expected: all green (new `fuzzySkills` suite + extended `ChatRoomPane` suite + everything pre-existing).

- [ ] **Step 4: Build**

```bash
npx nx build frontend
```

Expected: build succeeds.

- [ ] **Step 5: Full e2e against replay backend**

Start `just backend-serve-replay` in another terminal, then:

```bash
just e2e
```

Expected: all green.

- [ ] **Step 6: Push and open a PR**

```bash
git push -u origin feat/fuzzy-skill-autocomplete
gh pr create --fill
```

Then self-merge once checks pass:

```bash
gh pr merge --squash --delete-branch
```

---

## Self-Review (author check — completed at plan-writing time)

**Spec coverage:**

- Library = Fuse.js behind a seam → Tasks 1-3. ✓
- Rank best-first → Task 3 (ascending-score test). ✓
- Highlight matched chars (name + description) → Task 3 (segments) + Task 4 (`<strong>` render) + Task 5 (e2e). ✓
- Match scope name(0.7)+description(0.3), name outranks desc-only → Task 3 weighting test. ✓
- Empty query → all in order; no match → `[]` → Task 2. ✓
- `slashParse.ts` decoupled via `{ name }` projection → Task 4 Step 4. ✓
- Render-count discipline preserved (`selecting` guard) → Task 4 Step 3. ✓
- e2e moves with the feature → Task 5. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every code step shows full code. The Task 2 implementation intentionally leaves a `return []` that Task 3 replaces; both the placeholder and its replacement string are shown verbatim. ✓

**Type consistency:** `IFuzzySegment`/`ISkillMatch`/`fuzzyMatchSkills` names and signatures are identical across Tasks 2, 3, 4. `decideEnter` keeps its `{ name: string }[]` signature; Task 4 feeds it a projection. `segmentsFromIndices` takes `ReadonlyArray<readonly [number, number]>` matching Fuse's `indices`. ✓
