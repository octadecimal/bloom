# Agentic Skill Chat — Slice 2: author ↔ invoke skills with rich typed args

- **Date:** 2026-06-22
- **Status:** Design approved (brainstorming). Ready for implementation planning.
- **Builds on:** Slice 1 (PR #44, commit `54f8d53`) and its design,
  [`2026-06-22-agentic-skill-chat-design.md`](2026-06-22-agentic-skill-chat-design.md).
- **Scope:** Make git-authored skills (a) **invocable via a generated typed form**
  and (b) **authorable in-studio** through an editor that emits `skills/*.md` to the
  worktree — proven with a second real skill, `generate-background`.

## 1. Summary

Slice 1 proved the whole vertical with one tool (`generate_asset`), one skill
(`generate-sprite`), and explicit `/skill key=value` invocation. Slice 2 deepens the
**skill experience** without expanding the tool layer or changing where skills live:

- **Skills stay git-only and PR-reviewed.** This is a deliberate decision (§3.1): the
  PR-review workflow is too valuable to trade for self-service Mongo-backed authoring.
- **Invocation gets a typed form.** Selecting a skill renders a form generated from its
  declared args (text / number / checkbox / select), replacing the need to remember
  `key=value` syntax. The slice-1 text path remains as a fallback.
- **Authoring comes in-studio.** A Skill Editor pane lets you compose/edit a skill
  (frontmatter form + tool-allowlist picker + body, with live validation + preview) and
  writes the validated `skills/<name>.md` into the working tree. **You** commit + PR it;
  the studio never touches git.
- **A second real skill, `generate-background`,** exercises the enriched arg schema and
  drives a small, principled enrichment of the one tool (`size` + `transparency`).

The theme is one coherent loop: **the editor _defines_ a skill's typed args; the form
_consumes_ them; the second skill _proves_ it generalizes.**

## 2. Guiding principles (carried forward)

- **Leverage libraries over hand-rolling.** No new agent machinery — LangGraph/LangChain
  unchanged. (See `prefer-proven-libraries`.)
- **Test/real parity is mandatory.** No new provider surface; replay parity from slice 1
  is untouched. (See `test-real-parity`.)
- **E2e is the authoritative behavioral contract**, and browser e2e stays out of CI.
- **Design language is authoritative** — the form and editor are floating-card surfaces
  per `docs/design-language.md`.
- **TypeScript interfaces use the `I` prefix** (`docs/coding-standards.md`).
- **YAGNI** — approval gates have no consumer while every skill is PR-reviewed; deferred.

## 3. Key decisions (with rationale)

### 3.1 Skills stay git-only — Mongo/user-authoring rejected

The original slice-2 candidate set included Mongo-backed, user-authored skills with an
editor. We **reject the Mongo source**: PR review is the trust boundary that makes a
skill (which binds real tools) safe to ship, and that review is too valuable to lose.
The editor therefore produces **git artifacts** (`skills/*.md` in the worktree), not
database rows.

**Consequence:** the **approval gate is deferred** (again). Its only live justification
was un-reviewed skills needing approval; with every skill PR-reviewed, an approval gate
gates nothing. It returns in the "more tools" slice, where a genuinely destructive tool
gives it a real consumer. A per-skill `requires_approval` override is a documented seam.

### 3.2 Form invocation is primary; text invocation is a fallback

Selecting a skill opens a generated form; submitting it emits the existing
`runSkill(skillName, args)`. The slice-1 `parseSlashCommand` (`/skill key=value`) path
**remains valid** so the authoritative `skill-run` e2e suite stays green and power users
keep a fast path. The server re-validates args regardless of entry path.

### 3.3 Enriched arg schema (description + default + enum)

The form is only as good as the schema it renders. `SkillArg` gains `description`
(field label/help), `default` (prefilled value), and `enum` (renders a `<select>`).
This one schema is the single source the editor writes and the form renders, and the
second skill exercises every input type.

### 3.4 Editor writes to the worktree; the human owns git

The backend (running locally in dev, already loading skills from `<repo-root>/skills/`)
writes the validated file and **hot-reloads the registry** so the skill is immediately
invocable. Git/branch/commit/PR stay entirely in the user's hands — the studio does not
run `git`/`gh` (rejected as environment-specific and over-reaching).

### 3.5 Second skill enriches the one tool, not the tool _set_

`generate-background` needs a wider, opaque asset, so `generate_asset` gains `size` and
`transparent` parameters — listed as an open detail in the slice-1 spec (§8), **not** the
deferred "more tools" work (which is about adding _new_ tools / entity mutation). The
tool set stays at one; only its argument surface grows, with defaults preserving
`generate-sprite` behavior byte-for-byte.

## 4. Architecture (delta from slice 1)

No change to the agent loop, provider seam, run model, or realtime protocol. The deltas
are localized:

```
studio/frontend (llm-chat plugin)
  Composer: select skill → per-arg FORM (typed inputs from schema) → runSkill   [NEW]
            '/skill key=value' text path retained as fallback                    [KEEP]
  SkillEditor pane: frontmatter form + tool picker + body + validation/preview   [NEW]
                    load existing (GET /skills/{name}) · save (POST /skills)
              │ GET /skills (enriched args) · GET /skills/{name} · POST /skills
studio/backend (Python)
  SkillRegistry: enriched SkillArg (description/default/enum); validate_args      [EDIT]
                 enum + default handling; reload() on write                       [EDIT]
  Skills API:    GET /skills (enriched) · GET /skills/{name} (full) · POST /skills [NEW/EDIT]
                 POST validates with loader rules → writes skills/<name>.md → reload
  ToolFactory:   generate_asset gains size + transparency (defaults unchanged)    [EDIT]
  skills/generate-background.md                                                   [NEW]
```

## 5. Components

### 5.1 Arg schema + validation (`app/skills.py`)

- Extend `SkillArg`:
  ```python
  class SkillArg(BaseModel):
      name: str
      type: Literal["string", "number", "boolean"]
      required: bool = False
      description: str = ""
      default: str | float | bool | None = None
      enum: list[str | float] | None = None
  ```
- `validate_args`:
  - apply `default` when an arg is omitted/empty (instead of skipping) — so the agent
    receives the declared default;
  - reject a value not in `enum` (when `enum` is set) with a clear `SkillError`;
  - keep existing per-type coercion and required checks; same fail-fast contract.
- The loader keeps failing fast on unknown tools / malformed frontmatter; enriched fields
  are validated by pydantic at load time.

### 5.2 Tool enrichment + second skill

- **`generate_asset`** (`app/agent_tools.py`) gains:
  - `size: str = "512x512"` — parsed into width/height for `asset_store.create_asset`;
  - `transparent: bool = True` — selects the model id (`schnell-transparent` when true; a
    non-transparent model id when false).
  - Defaults reproduce current behavior exactly, so `generate-sprite` is unchanged.
  - Tool description updated to mention size/transparency.
- **`skills/generate-background.md`:**
  ```markdown
  ---
  name: generate-background
  description: Generate a wide, opaque background/scene and add it to the Asset Board.
  args:
    - { name: description, type: string, required: true, description: 'What the scene depicts' }
    - { name: mood, type: string, enum: [bright, dark, neutral], default: neutral, description: 'Overall mood' }
    - { name: aspect, type: string, enum: [wide, square], default: wide, description: 'Aspect ratio' }
  tools: [generate_asset]
  ---

  You generate a single background/scene image for the current game. Derive a concrete
  prompt from the description and mood, choose a size from the aspect (wide → 1024x576,
  square → 1024x1024), and call generate_asset once with transparent=false. Confirm in
  one sentence what you created and that it was added to the Asset Board.
  ```

### 5.3 Skills API

- **`GET /skills`** — now returns the **enriched** args (`description`, `default`,
  `enum`) per arg, so the composer form can render. Shape stays a list of
  `{ name, description, args }`.
- **`GET /skills/{name}`** — returns the **full** `SkillSpec` (`name`, `description`,
  `args`, `tools`, `body`). The editor loads this to edit an existing skill. 404 if
  unknown.
- **`POST /skills`** — body `{ name, description, args, tools, body }`:
  1. Validate with the **exact loader rules** (pydantic `SkillSpec` + unknown-tool check).
  2. On failure → `400` with the validation error message (surfaced as form errors).
  3. On success → write `skills/<name>.md` (frontmatter + body) and **reload the
     registry** so the skill is immediately listed and invocable.
  - Writes are confined to the configured skills dir; `name` is constrained to a safe
    slug (`[a-z0-9-]+`) to prevent path traversal and keep file names predictable.
  - Create and update share this endpoint (write/overwrite by `name`).

### 5.4 Per-arg form invocation (frontend composer)

- Selecting a skill from the existing autocomplete renders a **floating-card form** built
  from the skill's arg schema:
  - `string → text`, `number → number`, `boolean → checkbox`, `enum → select`;
  - `default` prefilled; `required` enforced client-side before submit;
  - `description` shown as the field label/help.
- Submit → existing `runSkill(skillName, args)`; the server re-validates (§5.1).
- `parseSlashCommand` (`/skill key=value`) stays as a fallback that bypasses the form.
- State/render-count discipline preserved; the form subscribes only to the leaves it
  needs. Interfaces use the `I` prefix.

### 5.5 Skill Editor pane (frontend)

- A new Dockview pane (floating-card per `docs/design-language.md`) containing:
  - frontmatter **form**: name, description, **typed-arg rows** (name/type/required +
    description/default/enum), **tool-allowlist picker** (from the tool set exposed by the
    skills API), and a markdown **body** editor;
  - **live validation + preview** of the assembled markdown;
  - **load existing** (`GET /skills/{name}`) to edit, or start blank to create;
  - **Save** → `POST /skills`; on success show "Saved to `skills/<name>.md` — commit + PR
    it"; on `400` surface the field-level error.
- The editor never invokes git; it only writes the file via the API.

## 6. Testing (the ladder)

Per repo policy: TDD at the unit level; e2e is the authoritative behavioral contract;
browser e2e stays out of CI; non-browser e2e is CI-affordable and gates CI.

- **pytest unit (CI):**
  - enriched `SkillArg` validation: `default` applied on omission; value outside `enum`
    rejected; required/coercion unchanged;
  - `POST /skills`: rejects unknown tool / malformed frontmatter (`400`), writes file +
    reloads on success, slug constraint blocks traversal;
  - `GET /skills/{name}`: full spec incl. body/tools; 404 unknown;
  - `GET /skills`: enriched args present;
  - `generate_asset`: size parsed to width/height; `transparent=false` selects the
    non-transparent model; defaults reproduce slice-1 behavior.
- **pytest realtime (CI):** existing skill-run realtime suite stays green (no protocol
  change); a run invoked for `generate-background` attaches an opaque asset.
- **Replay parity (CI):** unchanged from slice 1; if a `generate-background` cassette is
  recorded, the committed-fixtures guard covers it.
- **vitest (CI):** form renders each input type from schema; `default` prefill; `enum`
  select; required blocks submit; editor form → `POST` mapping + `400` error surfacing;
  `parseSlashCommand` still parses `key=value` (fallback retained).
- **Playwright (local-only):** open the Skill Editor → author `generate-background` →
  Save → it appears in autocomplete → invoke it via the **form** → a wide opaque asset
  appears on the Asset Board; `generate-sprite` still works via both the form and the
  text fallback.

## 7. Scope

**In scope:**

- Arg-schema enrichment (`description`, `default`, `enum`) + `validate_args` handling.
- `generate_asset` `size` + `transparent` parameters (defaults preserve current behavior).
- `skills/generate-background.md`.
- Skills API: enrich `GET /skills`; add `GET /skills/{name}`; add `POST /skills`
  (validate with loader rules → write → reload), with slug-constrained, dir-confined
  writes.
- Per-arg **form invocation** in the composer; slice-1 text path retained as fallback.
- **Skill Editor** Dockview pane (form + tool picker + body + validation/preview + load
  existing).
- The full test ladder above.

**Out of scope (later slices):**

- New tools / game-data / entity mutation / file ops / run-the-game.
- Model **auto-selection** of skills by description.
- **Mongo-backed / user-authored** skills (explicitly rejected for git+PR review, §3.1).
- **Approval gates** and a per-skill `requires_approval` flag.
- Editor-driven git/PR automation (the studio running `git`/`gh`).

**Documented seams for later:**

- `SkillRegistry` source remains swappable (a non-git source could slot in if the
  trust-model decision ever changes).
- `ToolFactory` registry shape is unchanged — new tools register without touching the
  runner.
- Approval-gate trigger (provenance- or flag-based) is documented for the tools slice.

## 8. Open implementation details (for the plan)

- Exact `size` value set and the description→prompt shaping for `generate-background`,
  and the non-transparent model id used when `transparent=false`.
- Whether `GET /skills` and `GET /skills/{name}` are merged (list returns full specs) or
  kept separate; default here is separate to keep the list payload lean.
- The editor pane's registration/opening path in the studio shell (toolbar/command).
- Whether a `generate-background` replay cassette is recorded this slice or the realtime
  test runs against the existing fixture set.
- Frontend module layout for the form and editor (new files under
  `plugins/llm-chat/`) and which existing components they compose with.
