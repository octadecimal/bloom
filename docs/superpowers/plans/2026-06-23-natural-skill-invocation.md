# Natural Skill Invocation + Keyboard Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make slash-skill invocation keyboard-driven (arrows / Tab-complete / Enter / Esc) and let skills infer their args from typed prose, while fixing the latent bug where a skill's args never reach the agent.

**Architecture:** Frontend — the composer popup is shown only while the draft is `/word` with no space; Tab/Enter/click complete the name inline, then prose + Enter runs the skill (agent infers args) or bare Enter opens an optional typed form. Backend — `room_hub.handle_skill_run` persists an "invocation" user message (the prose, or a rendered summary of form args) so the agent actually receives the user's intent via existing room history; required-arg enforcement is relaxed when prose is supplied.

**Tech Stack:** TypeScript + React (Vitest + Testing Library) for `studio/frontend`; Python + FastAPI + python-socketio + LangGraph (pytest) for `studio/backend`; Playwright for e2e.

## Global Constraints

- **Commits:** Conventional Commits format, imperative mood (`feat(...)`, `fix(...)`, `test(...)`). Branch already exists: `feat/natural-skill-invocation`.
- **TDD mandatory:** write the failing test, watch it fail (RED), minimal code to pass (GREEN), refactor. One behavior per test.
- **TypeScript interfaces use an `I` prefix** (`ISkill`, `ISkillArg`) — already the convention in this plugin.
- **Studio design language** is authoritative; raw colors outside `styles.css` are blocked by a guard test. Reuse existing Tailwind tokens already present in `ChatRoomPane.tsx` (`bg-surface`, `bg-raised`, `text-accent-text`, `text-muted-foreground`, `border`). Do **not** introduce raw hex colors.
- **Render-count discipline:** `ChatRoomPane` must not subscribe to the `skills` leaf on the no-slash hot path. Only call `s.skills.get()` when the draft is in slash-selection mode (`/word`, no space). The existing test "appending a token re-renders only that bubble, not the whole pane" must stay green.
- **E2e is the authoritative behavioral contract.** Run `just e2e` against a **replay** backend before any PR (start `just backend-serve-replay` first). Browser e2e is NOT in CI; run locally.
- **No cassette re-recording required:** the run-cassette replay is prompt-agnostic in tool mode (`providers.py:132-159`). Do not run `just record-fixtures` for this work.
- **Frontend CI gates (run all four before pushing):** from `studio/frontend`: `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`. A green vitest run does NOT prove types compile.

---

## File Structure

**Backend (modify):**

- `studio/backend/app/skills.py` — add `invocation_text()` helper; add `enforce_required` param to `validate_args()`.
- `studio/backend/app/room_hub.py` — `handle_skill_run` gains `text` param, persists invocation user message, relaxed validation.
- `studio/backend/app/sockets.py` — `run_skill` reads optional `text` from payload.
- `studio/backend/tests/test_skills.py` — unit tests for the two helper changes.
- `studio/backend/tests/test_room_hub.py` — handle_skill_run persistence + relaxed validation.
- `studio/backend/tests/test_sockets_handlers.py` — run_skill forwards `text`.

**Frontend (modify):**

- `studio/frontend/src/plugins/llm-chat/socketClient.ts` — `runSkill` emits optional `text`.
- `studio/frontend/src/plugins/llm-chat/actions.ts` — `runSkill(skillName, args, text?)`.
- `studio/frontend/src/plugins/llm-chat/slashParse.ts` — **new** pure helpers (`splitSlashDraft`, `moveHighlight`, `clampHighlight`, `decideEnter`). Replaces `parseSlashCommand`.
- `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` — keyboard-driven autocomplete, presentational `SkillAutocomplete`, run-vs-form decision. Remove `parseSlashCommand`.
- `studio/frontend/src/plugins/llm-chat/SkillForm.tsx` — autofocus the first field on mount.

**Frontend tests (modify / create):**

- `studio/frontend/src/plugins/llm-chat/slashParse.spec.ts` — **new** unit tests for the pure helpers.
- `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx` — rewrite slash/autocomplete tests for the new interaction model.
- `studio/frontend/src/plugins/llm-chat/socketClient.spec.ts` / `actions.spec.ts` — update `runSkill` expectations.

**E2e (modify / create):**

- `studio/frontend/e2e/skill-run.spec.ts` — rewrite `description="a knight"` to natural prose.
- `studio/frontend/e2e/skill-autocomplete.spec.ts` — **new** keyboard-navigation suite.

---

## Task 1: Backend — deliver the invocation to the agent (the bug fix)

**Files:**

- Modify: `studio/backend/app/skills.py`
- Modify: `studio/backend/app/room_hub.py` (`handle_skill_run`, ~lines 93-108)
- Modify: `studio/backend/app/sockets.py` (`run_skill`, lines 32-37)
- Test: `studio/backend/tests/test_skills.py`, `studio/backend/tests/test_room_hub.py`, `studio/backend/tests/test_sockets_handlers.py`

**Interfaces:**

- Produces: `invocation_text(spec: SkillSpec, text: str, args: dict) -> str` (module function in `app/skills.py`).
- Produces: `SkillRegistry.validate_args(spec, args, *, enforce_required: bool = True) -> dict`.
- Produces: `RoomHub.handle_skill_run(room_id: str, author: str, skill_name: str, args: dict, text: str = "") -> None`.
- Consumes (frontend Task 2 relies on): socket `run_skill` payload may include `text: str`.

> Run backend commands from `studio/backend`. Tests: `uv run pytest <path> -v` (or the repo's configured `just` target if present). Use whichever you confirm works in the environment; examples below use `uv run pytest`.

- [ ] **Step 1: Write the failing test for `invocation_text`**

Add to `studio/backend/tests/test_skills.py`:

```python
from app.skills import SkillSpec, invocation_text


def _spec():
    return SkillSpec(name="generate-sprite", description="d", args=[], tools=[], body="b")


def test_invocation_text_prefers_prose():
    assert invocation_text(_spec(), "a knight in armor", {}) == "a knight in armor"


def test_invocation_text_strips_prose():
    assert invocation_text(_spec(), "  a knight  ", {"style": "pixel"}) == "a knight"


def test_invocation_text_renders_args_when_no_prose():
    out = invocation_text(_spec(), "", {"description": "a knight", "style": "pixel"})
    assert out == '/generate-sprite description="a knight", style="pixel"'


def test_invocation_text_bare_name_when_empty():
    assert invocation_text(_spec(), "", {}) == "/generate-sprite"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_skills.py -k invocation_text -v`
Expected: FAIL — `ImportError: cannot import name 'invocation_text'`.

- [ ] **Step 3: Implement `invocation_text` in `app/skills.py`**

Add at module level (after the imports / `_COERCE`, before or after the class — module scope):

```python
def invocation_text(spec: "SkillSpec", text: str, args: dict) -> str:
    """Build the user-facing message that conveys a skill invocation to the agent.

    Prose (the user's typed description) wins; otherwise render the structured
    args from the form; otherwise just the skill name.
    """
    prose = (text or "").strip()
    if prose:
        return prose
    if args:
        rendered = ", ".join(f'{k}="{v}"' for k, v in args.items())
        return f"/{spec.name} {rendered}"
    return f"/{spec.name}"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_skills.py -k invocation_text -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Write the failing test for relaxed required-arg validation**

Add to `studio/backend/tests/test_skills.py` (reuse the registry fixture pattern already in that file; if none, construct a `SkillRegistry` with a temp dir is unnecessary — call `validate_args` on a hand-built spec):

```python
from app.skills import SkillRegistry, SkillArg, SkillError
import pytest


def _reg():
    return SkillRegistry(skills_dir=".", known_tools=set())


def _required_spec():
    return SkillSpec(
        name="generate-sprite",
        description="d",
        args=[SkillArg(name="description", type="string", required=True)],
        tools=[],
        body="b",
    )


def test_validate_args_enforces_required_by_default():
    with pytest.raises(SkillError):
        _reg().validate_args(_required_spec(), {})


def test_validate_args_skips_required_when_disabled():
    assert _reg().validate_args(_required_spec(), {}, enforce_required=False) == {}
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `uv run pytest tests/test_skills.py -k validate_args -v`
Expected: FAIL — `validate_args() got an unexpected keyword argument 'enforce_required'`.

- [ ] **Step 7: Add the `enforce_required` param to `validate_args`**

In `app/skills.py`, change the signature and the required branch:

```python
    def validate_args(self, spec: SkillSpec, args: dict, *, enforce_required: bool = True) -> dict:
        out: dict = {}
        for a in spec.args:
            if a.name not in args or args[a.name] in (None, ""):
                if a.default is not None:
                    out[a.name] = a.default
                elif a.required and enforce_required:
                    raise SkillError(f"missing required arg '{a.name}'")
                continue
            try:
                value = _COERCE[a.type](args[a.name])
            except (ValueError, TypeError) as e:
                raise SkillError(f"arg '{a.name}' must be {a.type}") from e
            if a.enum is not None and value not in a.enum:
                raise SkillError(f"arg '{a.name}' must be one of {a.enum}")
            out[a.name] = value
        return out
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `uv run pytest tests/test_skills.py -k validate_args -v`
Expected: PASS (2 passed).

- [ ] **Step 9: Write the failing test for `handle_skill_run` persistence + relaxed validation**

In `studio/backend/tests/test_room_hub.py`, find the existing skill-run test that builds a `RoomHub` with a skills registry and a fake store (look for `handle_skill_run`). Add a test mirroring that setup. The fake store's `add_message` already appends to `self.messages` and `list_messages` returns them. Add:

```python
@pytest.mark.asyncio
async def test_handle_skill_run_persists_prose_invocation_message(make_hub):
    # make_hub is the existing fixture/factory used by other skill-run tests in
    # this file. If the file builds the hub inline instead, copy that construction.
    hub, sio, store, _runner = make_hub()  # adapt to the file's actual helper
    await hub.handle_skill_run("r1", "alice", "generate-sprite", {}, text="a knight in armor")

    user_msgs = [m for m in store.messages if m.role == "user"]
    assert user_msgs and user_msgs[-1].content == "a knight in armor"
    assert "message_created" in sio.names()
```

> NOTE for the implementer: `test_room_hub.py` constructs the hub in a specific
> way (FakeSio, FakeStore, a skills registry, a fake TurnRunner). Match the
> EXACT construction used by the nearest existing `handle_skill_run` test in
> that file rather than the `make_hub()` placeholder above. The behavioral
> assertions (a `user` message with the prose content is persisted, and
> `message_created` is emitted) are what matter.

- [ ] **Step 10: Run the test to verify it fails**

Run: `uv run pytest tests/test_room_hub.py -k persists_prose -v`
Expected: FAIL — either `handle_skill_run()` rejects the `text` kwarg, or no user message is persisted.

- [ ] **Step 11: Update `handle_skill_run` in `app/room_hub.py`**

Replace the current method body (lines ~93-108) with:

```python
    async def handle_skill_run(self, room_id: str, author: str, skill_name: str, args: dict, text: str = "") -> None:
        from app.skills import invocation_text

        spec = self._skills.get(skill_name)
        if spec is None:
            await self._sio.emit("error", {"roomId": room_id, "message": f"unknown skill {skill_name}"}, room=room_id)
            return
        try:
            # Prose path infers required args via the agent, so don't enforce them here.
            clean = self._skills.validate_args(spec, args, enforce_required=not text.strip())
        except Exception as e:
            await self._sio.emit("error", {"roomId": room_id, "message": str(e)}, room=room_id)
            return

        # Persist the invocation as a user message so the agent actually receives
        # the user's intent (history is the agent's only context) and the chat
        # transcript shows what was asked.
        content = invocation_text(spec, text, clean)
        user_msg = await self._store.add_message(room_id, author, "user", content, "complete")
        await self._sio.emit("message_created", {"message": message_wire(user_msg)}, room=room_id)

        async with self._lock(room_id):
            self._queues.setdefault(room_id, []).append(
                {"kind": "skill", "author": author, "skillName": skill_name, "args": clean}
            )
            if room_id in self._busy:
                await self._emit_status(room_id, "queued")
```

> Verify `message_wire` is already imported at the top of `room_hub.py` (it is —
> `handle_prompt` uses it at line 82). Keep the existing post-lock drain/status
> logic that followed the original `append(...)` — only the lines shown above
> change; preserve whatever `_drain`/status call already trailed the queue
> append.

- [ ] **Step 12: Run the test to verify it passes**

Run: `uv run pytest tests/test_room_hub.py -k persists_prose -v`
Expected: PASS.

- [ ] **Step 13: Write the failing test for the socket handler forwarding `text`**

In `studio/backend/tests/test_sockets_handlers.py` (the fake hub there has `handle_skill_run(self, *a, **k)`), add a test that the handler passes `text` through. Adapt to the file's existing harness (it registers handlers against a fake `sio` and invokes them). Capture the call:

```python
@pytest.mark.asyncio
async def test_run_skill_forwards_text(...):  # match the file's existing test signature/harness
    # Arrange a hub spy that records handle_skill_run kwargs, register handlers,
    # then invoke the 'run_skill' handler with a payload including 'text'.
    await invoke("run_skill", {"roomId": "r1", "skillName": "generate-sprite", "args": {}, "text": "a knight"})
    assert recorded == ("r1", "alice", "generate-sprite", {}, "a knight")  # positional+text
```

> Match the EXISTING `run_skill`/`handle_skill_run` test harness in this file
> (how it builds the fake hub, registers handlers, and calls them). The
> assertion to encode: the `text` field from the payload reaches
> `handle_skill_run` (defaulting to `""` when absent).

- [ ] **Step 14: Run the test to verify it fails**

Run: `uv run pytest tests/test_sockets_handlers.py -k forwards_text -v`
Expected: FAIL — `text` not passed through.

- [ ] **Step 15: Update the `run_skill` socket handler in `app/sockets.py`**

```python
    @sio.on("run_skill")
    async def run_skill(sid, data):
        session = await sio.get_session(sid)
        await hub.handle_skill_run(
            data["roomId"], session["displayName"], data["skillName"], data.get("args", {}), data.get("text", "")
        )
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `uv run pytest tests/test_sockets_handlers.py -k forwards_text -v`
Expected: PASS.

- [ ] **Step 17: Run the full backend suite**

Run: `uv run pytest -q`
Expected: all pass. If the existing skill-run test in `test_room_hub.py` asserted "no user message before the run", update it to expect the new invocation message.

- [ ] **Step 18: Commit**

```bash
git add studio/backend/app/skills.py studio/backend/app/room_hub.py studio/backend/app/sockets.py studio/backend/tests/test_skills.py studio/backend/tests/test_room_hub.py studio/backend/tests/test_sockets_handlers.py
git commit -m "fix(skills): deliver prose/args to the agent via a persisted invocation message"
```

---

## Task 2: Frontend wire — thread prose `text` through `runSkill`

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/socketClient.ts:161`
- Modify: `studio/frontend/src/plugins/llm-chat/actions.ts:126-129`
- Test: `studio/frontend/src/plugins/llm-chat/socketClient.spec.ts:233-237`, `studio/frontend/src/plugins/llm-chat/actions.spec.ts:81-86`

**Interfaces:**

- Produces: `runSkill(skillName: string, args: Record<string, unknown>, text?: string): void` (actions).
- Produces: `socketClient.runSkill(roomId, skillName, args, text?: string)` → emits `{ roomId, skillName, args, text }` (text defaults to `''`).
- Consumes: backend Task 1 `run_skill` payload `text` field.

> Run frontend commands from `studio/frontend`. Test a single file with `npx nx test frontend --testFile=<name>` or `npx vitest run src/plugins/llm-chat/<file>` — use whichever you confirm works.

- [ ] **Step 1: Update the failing socketClient test**

In `socketClient.spec.ts`, change the existing `runSkill` test (lines 233-237) to pass and expect `text`:

```ts
it('runSkill emits run_skill to the socket with text', () => {
  const { sock, emitted, client } = connected();
  client.runSkill('r1', 'generate-sprite', { description: 'knight' }, 'a knight');
  expect(emitted).toContainEqual({
    event: 'run_skill',
    payload: { roomId: 'r1', skillName: 'generate-sprite', args: { description: 'knight' }, text: 'a knight' },
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/plugins/llm-chat/socketClient.spec.ts`
Expected: FAIL — emitted payload has no `text` field.

- [ ] **Step 3: Update `socketClient.runSkill`**

In `socketClient.ts` line 161:

```ts
    runSkill: (roomId: string, skillName: string, args: Record<string, unknown>, text = '') =>
      emit('run_skill', { roomId, skillName, args, text }),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/plugins/llm-chat/socketClient.spec.ts`
Expected: PASS.

- [ ] **Step 5: Update the `actions.runSkill` test**

In `actions.spec.ts` (lines 81-86), update the expectation to forward `text`:

```ts
it('runSkill forwards to the socket for the active room', () => {
  actions.__setDeps({ socket });
  chatSlice().activeRoomId.set('r1');
  actions.runSkill('generate-sprite', { description: 'knight' }, 'a knight');
  expect(socket.runSkill).toHaveBeenCalledWith('r1', 'generate-sprite', { description: 'knight' }, 'a knight');
});
```

> The `socket` mock object in `actions.spec.ts` types `runSkill: vi.fn()`, which
> accepts any args — no type change needed there.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/plugins/llm-chat/actions.spec.ts`
Expected: FAIL — called with 3 args, expected 4.

- [ ] **Step 7: Update `actions.runSkill`**

In `actions.ts` (lines 126-129):

```ts
export function runSkill(skillName: string, args: Record<string, unknown>, text = ''): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().runSkill(roomId, skillName, args, text);
}
```

> Also widen the `socket` dep type if `Pick<SocketClient, ...>` enforces the
> signature — since `socketClient.runSkill` now has the optional `text` param,
> the `Pick` picks up the new signature automatically. No change needed unless
> `npx nx typecheck frontend` complains.

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/plugins/llm-chat/actions.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/actions.ts studio/frontend/src/plugins/llm-chat/socketClient.spec.ts studio/frontend/src/plugins/llm-chat/actions.spec.ts
git commit -m "feat(chat): thread prose text through runSkill to the backend"
```

---

## Task 3: Frontend — pure slash/keyboard helpers (`slashParse.ts`)

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/slashParse.ts`
- Test: `studio/frontend/src/plugins/llm-chat/slashParse.spec.ts`

**Interfaces:**

- Produces:
  - `splitSlashDraft(draft: string): { skillName: string; hasSpace: boolean; prose: string } | null` — `null` when not a slash draft.
  - `moveHighlight(current: number, delta: number, count: number): number` — wraps; returns `0` when `count === 0`.
  - `clampHighlight(current: number, count: number): number` — clamps into `[0, count-1]`; `0` when `count === 0`.
  - `decideEnter(draft: string, matches: { name: string }[], highlight: number): { kind: 'accept'; name: string } | { kind: 'run'; name: string; prose: string } | { kind: 'form'; name: string } | { kind: 'send' }`.
- Consumes: nothing (pure functions).

- [ ] **Step 1: Write the failing tests**

Create `studio/frontend/src/plugins/llm-chat/slashParse.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitSlashDraft, moveHighlight, clampHighlight, decideEnter } from './slashParse';

describe('splitSlashDraft', () => {
  it('returns null for non-slash drafts', () => {
    expect(splitSlashDraft('hello world')).toBeNull();
    expect(splitSlashDraft('')).toBeNull();
  });
  it('parses a name being typed (no space yet)', () => {
    expect(splitSlashDraft('/gen')).toEqual({ skillName: 'gen', hasSpace: false, prose: '' });
  });
  it('parses a completed name with empty prose', () => {
    expect(splitSlashDraft('/generate-sprite ')).toEqual({ skillName: 'generate-sprite', hasSpace: true, prose: '' });
  });
  it('parses a name plus prose', () => {
    expect(splitSlashDraft('/generate-sprite a knight in armor')).toEqual({
      skillName: 'generate-sprite',
      hasSpace: true,
      prose: 'a knight in armor',
    });
  });
});

describe('moveHighlight', () => {
  it('wraps forward and backward', () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });
  it('returns 0 for an empty list', () => {
    expect(moveHighlight(0, 1, 0)).toBe(0);
  });
});

describe('clampHighlight', () => {
  it('clamps past-the-end into range', () => {
    expect(clampHighlight(5, 3)).toBe(2);
    expect(clampHighlight(-1, 3)).toBe(0);
    expect(clampHighlight(1, 0)).toBe(0);
  });
});

describe('decideEnter', () => {
  const matches = [{ name: 'generate-sprite' }, { name: 'generate-background' }];
  it('accepts the highlighted match while the popup is open (no space)', () => {
    expect(decideEnter('/gen', matches, 1)).toEqual({ kind: 'accept', name: 'generate-background' });
  });
  it('runs with prose once the name is completed and prose typed', () => {
    expect(decideEnter('/generate-sprite a knight', [], 0)).toEqual({ kind: 'run', name: 'generate-sprite', prose: 'a knight' });
  });
  it('opens the form on bare Enter after completion (no prose)', () => {
    expect(decideEnter('/generate-sprite ', [], 0)).toEqual({ kind: 'form', name: 'generate-sprite' });
  });
  it('falls back to send for a plain message', () => {
    expect(decideEnter('hello', [], 0)).toEqual({ kind: 'send' });
  });
  it('falls back to send for an unknown slash with no matches and no space', () => {
    expect(decideEnter('/nope', [], 0)).toEqual({ kind: 'send' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/plugins/llm-chat/slashParse.spec.ts`
Expected: FAIL — `Cannot find module './slashParse'`.

- [ ] **Step 3: Implement `slashParse.ts`**

```ts
export interface ISlashDraft {
  skillName: string;
  hasSpace: boolean;
  prose: string;
}

/** Parse the composer draft into its slash-skill parts, or null if not a slash draft. */
export function splitSlashDraft(draft: string): ISlashDraft | null {
  if (!draft.startsWith('/')) return null;
  const body = draft.slice(1);
  const spaceIdx = body.indexOf(' ');
  if (spaceIdx === -1) return { skillName: body, hasSpace: false, prose: '' };
  return { skillName: body.slice(0, spaceIdx), hasSpace: true, prose: body.slice(spaceIdx + 1).trim() };
}

/** Move the highlight index by delta, wrapping at both ends. 0 for an empty list. */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

/** Clamp the highlight index into [0, count-1]; 0 for an empty list. */
export function clampHighlight(current: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(current, 0), count - 1);
}

export type EnterDecision = { kind: 'accept'; name: string } | { kind: 'run'; name: string; prose: string } | { kind: 'form'; name: string } | { kind: 'send' };

/** Decide what Enter does given the current draft, visible matches, and highlight. */
export function decideEnter(draft: string, matches: { name: string }[], highlight: number): EnterDecision {
  const slash = splitSlashDraft(draft);
  if (slash === null) return { kind: 'send' };
  // Popup open: still choosing a skill (no space) and there are matches → accept the highlight.
  if (!slash.hasSpace) {
    if (matches.length > 0) {
      const idx = clampHighlight(highlight, matches.length);
      return { kind: 'accept', name: matches[idx].name };
    }
    return { kind: 'send' };
  }
  // Name completed (has space): prose → run; empty → open the form.
  return slash.prose ? { kind: 'run', name: slash.skillName, prose: slash.prose } : { kind: 'form', name: slash.skillName };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/plugins/llm-chat/slashParse.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/slashParse.ts studio/frontend/src/plugins/llm-chat/slashParse.spec.ts
git commit -m "feat(chat): add pure slash-parse + keyboard-nav helpers"
```

---

## Task 4: Frontend — keyboard-driven autocomplete in `ChatRoomPane`

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
- Modify: `studio/frontend/src/plugins/llm-chat/SkillForm.tsx` (autofocus first field)
- Test: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx`

**Interfaces:**

- Consumes: `splitSlashDraft`, `moveHighlight`, `clampHighlight`, `decideEnter` (Task 3); `runSkill(name, args, text)` (Task 2).
- Produces: `SkillAutocomplete` becomes presentational — `{ matches: ISkill[]; highlight: number; onPick: (name: string) => void }`. The highlighted `<li>` carries `data-active="true"`. Existing testids preserved: `skill-autocomplete`, `skill-option-<name>`.
- Removes: `parseSlashCommand` export (and its tests) — replaced by `slashParse.ts`.

> Behavior to implement (from the spec's interaction table):
>
> - Popup shows only when `splitSlashDraft(draft)` is non-null AND `!hasSpace`.
> - ↑/↓ move highlight (wrap); Tab and Enter accept the highlight → set draft to `/<name> `; Esc dismisses (clear nothing, just hide the popup for this keystroke); click = accept.
> - With popup closed: Enter runs `decideEnter` → `run` calls `runSkill(name, {}, prose)`; `form` opens the SkillForm; `send` calls `sendPrompt`.
> - On accept, set `setDraft('/' + name + ' ')` and reset highlight to 0; focus stays in the composer (it never blurred).

- [ ] **Step 1: Write the failing component tests**

In `ChatRoomPane.spec.tsx`: (a) DELETE the `describe('parseSlashCommand', ...)` block (lines 116-128) and the `parseSlashCommand` import — those move to `slashParse.spec.ts`. (b) Replace the `describe('ChatRoomPane skill autocomplete', ...)` block with the new model:

```ts
import { ChatRoomPane } from './ChatRoomPane'; // drop the parseSlashCommand import

// ... keep existing setup ...

describe('ChatRoomPane skill autocomplete (keyboard)', () => {
  const seedSkills = () =>
    chatSlice().skills.set([
      { name: 'generate-sprite', description: 'make a sprite', args: [{ name: 'description', type: 'string', required: true }] },
      { name: 'generate-background', description: 'make a bg', args: [] },
    ]);

  it('typing "/" shows the autocomplete filtered by prefix with the first item active', () => {
    seedSkills();
    render(<ChatRoomPane />);
    fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: '/gen' } });
    expect(screen.getByTestId('skill-autocomplete')).toBeInTheDocument();
    expect(screen.getByTestId('skill-option-generate-sprite')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('skill-option-generate-background')).toHaveAttribute('data-active', 'false');
  });

  it('ArrowDown moves the active highlight', () => {
    seedSkills();
    render(<ChatRoomPane />);
    const composer = screen.getByTestId('chat-composer');
    fireEvent.change(composer, { target: { value: '/gen' } });
    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    expect(screen.getByTestId('skill-option-generate-background')).toHaveAttribute('data-active', 'true');
  });

  it('Tab completes the active skill name inline and hides the popup', () => {
    seedSkills();
    render(<ChatRoomPane />);
    const composer = screen.getByTestId('chat-composer');
    fireEvent.change(composer, { target: { value: '/gen' } });
    fireEvent.keyDown(composer, { key: 'Tab' });
    expect(composer).toHaveValue('/generate-sprite ');
    expect(screen.queryByTestId('skill-autocomplete')).not.toBeInTheDocument();
  });

  it('typing prose then Enter runs the skill with the prose as text', () => {
    seedSkills();
    render(<ChatRoomPane />);
    const composer = screen.getByTestId('chat-composer');
    fireEvent.change(composer, { target: { value: '/generate-sprite a knight' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(actions.runSkill).toHaveBeenCalledWith('generate-sprite', {}, 'a knight');
    expect(composer).toHaveValue('');
  });

  it('bare Enter after completion (no prose) opens the form', () => {
    seedSkills();
    render(<ChatRoomPane />);
    const composer = screen.getByTestId('chat-composer');
    fireEvent.change(composer, { target: { value: '/generate-sprite ' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(screen.getByTestId('skill-form')).toBeInTheDocument();
  });

  it('Escape dismisses the popup', () => {
    seedSkills();
    render(<ChatRoomPane />);
    const composer = screen.getByTestId('chat-composer');
    fireEvent.change(composer, { target: { value: '/gen' } });
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(screen.queryByTestId('skill-autocomplete')).not.toBeInTheDocument();
  });

  it('clicking an option completes it inline (does not open the form)', () => {
    seedSkills();
    render(<ChatRoomPane />);
    const composer = screen.getByTestId('chat-composer');
    fireEvent.change(composer, { target: { value: '/gen' } });
    fireEvent.click(screen.getByTestId('skill-option-generate-background'));
    expect(composer).toHaveValue('/generate-background ');
    expect(screen.queryByTestId('skill-form')).not.toBeInTheDocument();
  });

  it('the form path still runs the skill with structured args on submit', () => {
    seedSkills();
    render(<ChatRoomPane />);
    const composer = screen.getByTestId('chat-composer');
    fireEvent.change(composer, { target: { value: '/generate-sprite ' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.change(screen.getByTestId('skill-form-field-description'), { target: { value: 'a knight' } });
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(actions.runSkill).toHaveBeenCalledWith('generate-sprite', { description: 'a knight' }, '');
    expect(screen.queryByTestId('skill-form')).not.toBeInTheDocument();
    expect(composer).toHaveValue('');
  });
});
```

> NOTE: the existing form-submit assertion used `runSkill('generate-sprite', { description: 'a knight' })`. The form's `onSubmit` should call `runSkill(name, args, '')` (empty prose). If you prefer to keep the 2-arg call, the test must match — but pass `''` explicitly for consistency with the new signature.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: FAIL — no keyboard handling / no `data-active` / `parseSlashCommand` import removed.

- [ ] **Step 3: Rewrite `SkillAutocomplete` as presentational + add highlight**

In `ChatRoomPane.tsx`, replace the `SkillAutocomplete` component (lines ~160-180) with:

```tsx
function SkillAutocomplete({ matches, highlight, onPick }: { matches: ISkill[]; highlight: number; onPick: (name: string) => void }) {
  if (matches.length === 0) return null;
  return (
    <ul data-testid="skill-autocomplete" className="m-0 list-none rounded-md border bg-surface p-1 text-sm shadow-md">
      {matches.map((sk, i) => (
        <li
          key={sk.name}
          data-testid={`skill-option-${sk.name}`}
          data-active={i === highlight ? 'true' : 'false'}
          className={`cursor-pointer rounded px-2 py-1 text-foreground ${i === highlight ? 'bg-raised' : 'hover:bg-raised'}`}
          onMouseDown={(e) => {
            e.preventDefault(); // keep composer focus
            onPick(sk.name);
          }}
        >
          <span className="font-semibold text-accent-text">/{sk.name}</span>
          {sk.description ? <span className="ml-2 text-muted-foreground">{sk.description}</span> : null}
        </li>
      ))}
    </ul>
  );
}
```

> `onMouseDown` + `preventDefault` (instead of `onClick`) keeps the composer
> focused when the user clicks an option. The test uses `fireEvent.click`, which
> in jsdom dispatches `mousedown`→`mouseup`→`click`; if the click test doesn't
> trigger the handler, switch the test to `fireEvent.mouseDown(...)`. Prefer
> `onMouseDown` for the focus behavior.

- [ ] **Step 4: Add `ISkill` import and remove `parseSlashCommand`**

`ISkill` is already imported in `ChatRoomPane.tsx` (line 6). DELETE the `parseSlashCommand` function (lines ~16-38) and its doc comment — its logic now lives in `slashParse.ts`.

- [ ] **Step 5: Rewire the main pane (state, matches, keydown, decision)**

In `ChatRoomPane()`:

(a) Add imports at the top of the file:

```tsx
import { splitSlashDraft, moveHighlight, clampHighlight, decideEnter } from './slashParse';
```

(b) Add highlight state and a popup-suppression flag near the existing `useState` calls:

```tsx
const [draft, setDraft] = useState('');
const [highlight, setHighlight] = useState(0);
const [popupDismissed, setPopupDismissed] = useState(false);
const [formSkillName, setFormSkillName] = useState<string | null>(null);
```

(c) Compute slash context + matches WITHOUT subscribing on the hot path. Replace the old `slashPrefix` line (~224):

```tsx
const slash = splitSlashDraft(draft);
const selecting = slash !== null && !slash.hasSpace && !popupDismissed;
// Only read the skills leaf while actually selecting — preserves render-count discipline.
const matches = selecting ? (s.skills.get() as ISkill[]).filter((sk) => sk.name.startsWith(slash!.skillName)) : [];
const popupOpen = selecting && matches.length > 0;
```

(d) Add an accept helper and the keydown handler. Place inside the component body:

```tsx
const accept = (name: string) => {
  setDraft(`/${name} `);
  setHighlight(0);
  setPopupDismissed(false);
};

const runProse = (name: string, prose: string) => {
  runSkill(name, {}, prose);
  setDraft('');
  setTyping(false);
};

const onComposerKeyDown = (e: React.KeyboardEvent) => {
  if (popupOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => moveHighlight(h, 1, matches.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => moveHighlight(h, -1, matches.length));
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setPopupDismissed(true);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      accept(matches[clampHighlight(highlight, matches.length)].name);
      return;
    }
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const decision = decideEnter(draft, matches, highlight);
    if (decision.kind === 'accept') accept(decision.name);
    else if (decision.kind === 'run') runProse(decision.name, decision.prose);
    else if (decision.kind === 'form') setFormSkillName(decision.name);
    else submit(); // 'send'
  }
};
```

> `submit()` already exists (lines 210-221). Since `decideEnter` now owns the
> slash logic, SIMPLIFY `submit()` to only send a plain prompt (drop its
> `parseSlashCommand` branch):
>
> ```tsx
> const submit = () => {
>   if (draft.trim()) {
>     sendPrompt(draft.trim());
>     setDraft('');
>     setTyping(false);
>   }
> };
> ```

(e) When the draft changes, reset the dismissed flag and clamp the highlight. Update the composer `onChange`:

```tsx
          onChange={(e) => {
            setDraft(e.target.value);
            setTyping(e.target.value.length > 0);
            setPopupDismissed(false);
            setHighlight(0);
          }}
```

(f) Wire `onKeyDown={onComposerKeyDown}` on the `<Input>` (replace the existing `onKeyDown` that only handled Enter).

(g) Render the popup with the new props. Replace the old conditional (~252-254):

```tsx
{
  formSkill ? (
    <SkillForm
      skill={formSkill}
      onSubmit={(args) => {
        runSkill(formSkill.name, args, '');
        setFormSkillName(null);
        setDraft('');
        setTyping(false);
      }}
      onCancel={() => {
        setFormSkillName(null);
        setDraft('');
        setTyping(false);
      }}
    />
  ) : (
    popupOpen && <SkillAutocomplete matches={matches} highlight={clampHighlight(highlight, matches.length)} onPick={accept} />
  );
}
```

> The `formSkill` lookup block above (lines 193-198) stays as-is. The Send
> button's `onClick={submit}` still sends a plain prompt — fine, because a user
> who typed a slash command will use Enter; clicking Send on a `/...` draft now
> just sends it as text. (If you want the Send button to honor slash commands
> too, route it through `decideEnter` — OPTIONAL, not required by any test.)

- [ ] **Step 6: Add autofocus to the first field in `SkillForm.tsx`**

So bare-Enter "focuses the form". In `SkillForm.tsx`, mark the first field. Change the `.map` to pass an `autoFocus` for index 0:

```tsx
{
  skill.args.map((a, i) => (
    <label key={a.name} className="flex flex-col gap-0.5">
      {/* ...span unchanged... */}
      {a.enum ? (
        <select autoFocus={i === 0} /* ...rest unchanged... */ />
      ) : a.type === 'boolean' ? (
        <input autoFocus={i === 0} /* ...rest unchanged... */ />
      ) : (
        <Input autoFocus={i === 0} /* ...rest unchanged... */ />
      )}
    </label>
  ));
}
```

> If `skill.args` is empty (e.g. `generate-background`), there is no field to
> focus — that's fine; the form still renders its Run/Cancel buttons.

- [ ] **Step 7: Run the component tests to verify they pass**

Run: `npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: PASS. If the click test fails on `onMouseDown`, switch that test to `fireEvent.mouseDown(...)` (see Step 3 note).

- [ ] **Step 8: Run the render-count guard explicitly**

Run: `npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx -t "re-renders only that bubble"`
Expected: PASS — confirms the no-slash hot path still doesn't subscribe `ChatRoomPane` to `skills`.

- [ ] **Step 9: Run the full plugin unit suite + typecheck**

Run: `npx vitest run src/plugins/llm-chat` then `npx nx typecheck frontend`
Expected: all PASS. (Catches any leftover `parseSlashCommand` references in other files.)

- [ ] **Step 10: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx studio/frontend/src/plugins/llm-chat/SkillForm.tsx
git commit -m "feat(chat): keyboard-driven skill autocomplete (arrows/Tab/Enter/Esc) + optional form"
```

---

## Task 5: E2e — rewrite skill-run to prose + add keyboard autocomplete suite

**Files:**

- Modify: `studio/frontend/e2e/skill-run.spec.ts`
- Create: `studio/frontend/e2e/skill-autocomplete.spec.ts`

**Interfaces:**

- Consumes: the full app behavior from Tasks 1-4. Backend on :8000 in **replay** mode; frontend on :4200.

> Per AGENTS.md these are the authoritative behavioral contract. Run with the
> replay backend up: `just backend-serve-replay` then `just e2e`. The run
> cassette is prompt-agnostic, so prose drives the same recorded tool call.

- [ ] **Step 1: Rewrite the slash invocations in `skill-run.spec.ts` to prose**

Replace each `'/generate-sprite description="a knight"'` fill with natural prose, and drive it via Enter to exercise the real run path:

```ts
// was: .fill('/generate-sprite description="a knight"'); .click chat-send
await page.getByTestId('chat-composer').fill('/generate-sprite a knight');
await page.getByTestId('chat-composer').press('Enter');
```

Apply the same change to all three tests in the file (single-client, asset-board, two-clients). The assertions (`generate_asset`, `Asset Board`, asset card) are unchanged — the replay cassette still emits them.

- [ ] **Step 2: Run the rewritten skill-run suite**

Ensure `just backend-serve-replay` is running, then:
Run: `npx playwright test e2e/skill-run.spec.ts`
Expected: PASS (3 tests). The run timeline shows `generate_asset` and `Asset Board`.

- [ ] **Step 3: Create the keyboard autocomplete e2e suite**

Create `studio/frontend/e2e/skill-autocomplete.spec.ts`. Reuse the `openApp`/`createRoom` helpers pattern from `skill-run.spec.ts` (copy them or import shared helpers if the file exposes them):

```ts
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

async function openApp(page: Page, username: string) {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
}

async function createRoom(page: Page, name: string) {
  await page.getByPlaceholder(/new room/i).fill(name);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

test.describe('skill autocomplete keyboard navigation', () => {
  test('arrow keys move the active option', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/gen');
    await expect(page.getByTestId('skill-autocomplete')).toBeVisible();
    // First option active by default.
    await expect(page.getByTestId('skill-option-generate-sprite')).toHaveAttribute('data-active', 'true');
    await composer.press('ArrowDown');
    await expect(page.getByTestId('skill-option-generate-background')).toHaveAttribute('data-active', 'true');
  });

  test('Tab completes the highlighted name and hides the popup', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/generate-sprite');
    await composer.press('Tab');
    await expect(composer).toHaveValue('/generate-sprite ');
    await expect(page.getByTestId('skill-autocomplete')).toBeHidden();
  });

  test('Tab-complete then prose then Enter runs the skill', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/generate-sprite');
    await composer.press('Tab');
    await composer.type('a knight');
    await composer.press('Enter');
    await expect(page.getByTestId('run-timeline')).toContainText('generate_asset', { timeout: 20_000 });
  });

  test('Tab-complete then bare Enter opens the form', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/generate-sprite');
    await composer.press('Tab');
    await composer.press('Enter');
    await expect(page.getByTestId('skill-form')).toBeVisible();
  });

  test('Escape dismisses the popup', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/gen');
    await expect(page.getByTestId('skill-autocomplete')).toBeVisible();
    await composer.press('Escape');
    await expect(page.getByTestId('skill-autocomplete')).toBeHidden();
  });
});
```

> This suite assumes the two seeded skills `generate-sprite` and
> `generate-background` exist in the backend's skills dir (they do — see
> `skills/generate-sprite.md`, `skills/generate-background.md`). If a third skill
> beginning with `gen` is added later, adjust the active-index assertions.

- [ ] **Step 4: Run the new e2e suite**

Run: `npx playwright test e2e/skill-autocomplete.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full e2e suite (replay)**

Run: `just e2e`
Expected: green. This is the gate before PR (per AGENTS.md + repo memory).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/e2e/skill-run.spec.ts studio/frontend/e2e/skill-autocomplete.spec.ts
git commit -m "test(e2e): natural-prose skill runs + keyboard autocomplete suite"
```

---

## Task 6: Final verification + PR

**Files:** none (verification only).

- [ ] **Step 1: Backend suite green**

Run (from `studio/backend`): `uv run pytest -q`
Expected: all pass.

- [ ] **Step 2: Frontend CI gates (all four)**

Run (from `studio/frontend`):

```
npx prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all pass. Fix prettier with `npx prettier --write .` if `--check` fails, then re-commit.

- [ ] **Step 3: Full e2e green against replay**

Run: `just e2e` (with `just backend-serve-replay` up).
Expected: green, including `skill-run` and `skill-autocomplete`.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/natural-skill-invocation
gh pr create --fill
```

`main` is protected; PR is the only path. Self-merge with `gh pr merge --squash --delete-branch` once checks pass.

---

## Self-Review

**Spec coverage:**

- Keyboard model (↑/↓, Tab, Enter accept, Esc, click) → Task 3 (`decideEnter`/`moveHighlight`) + Task 4 (wiring) + Task 5 (e2e). ✓
- Popup shown only while `/word` no space → Task 3 `splitSlashDraft` + Task 4 `selecting`/`popupOpen`. ✓
- Prose → run with agent inference → Task 1 (persist invocation, relaxed validation) + Task 2 (`text` wire) + Task 4 (`runProse`). ✓
- Bare Enter → focus form → Task 4 (decision `form`) + SkillForm autofocus. ✓
- Backend arg-delivery bug (root cause) → Task 1 (persisted invocation user message). ✓
- Required-arg relaxation when prose supplied → Task 1 Steps 5-8, 11. ✓
- Drop `key="value"` parsing → Task 4 removes `parseSlashCommand`; Task 3 replaces it. ✓
- Form path still delivers structured args to agent → Task 1 `invocation_text` renders args; Task 4 form `onSubmit` passes `text=''`. ✓
- Render-count discipline preserved → Task 4 Step 5(c) gates `s.skills.get()` behind `selecting`; Step 8 verifies. ✓
- No cassette re-record → Global Constraints + Task 5 note (verified `providers.py:132-159`). ✓
- E2e authoritative, run before PR → Task 5/6. ✓

**Placeholder scan:** The two backend test steps (9/13) intentionally defer to "match the existing harness in this file" because `test_room_hub.py` / `test_sockets_handlers.py` build their fakes in a file-specific way; the exact behavioral assertions are spelled out, which is the load-bearing part. No `TODO`/`TBD`/"add error handling" placeholders remain.

**Type consistency:** `runSkill(skillName, args, text?)` is consistent across `actions.ts` (Task 2), `socketClient.ts` (Task 2), and both call sites in `ChatRoomPane.tsx` (Task 4: `runProse` → `runSkill(name, {}, prose)`; form → `runSkill(name, args, '')`). `splitSlashDraft`/`moveHighlight`/`clampHighlight`/`decideEnter` signatures match between Task 3 definitions and Task 4 usage. `invocation_text` / `validate_args(enforce_required=...)` consistent between Task 1 definitions and `handle_skill_run` usage.
