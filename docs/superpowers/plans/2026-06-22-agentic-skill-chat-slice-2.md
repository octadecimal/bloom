# Agentic Skill Chat — Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make git-authored skills invocable via a generated typed form and authorable in-studio via an editor that writes `skills/*.md` to the worktree, proven with a second real skill (`generate-background`).

**Architecture:** Backend enriches the per-arg schema (`description`/`default`/`enum`) and `validate_args`; `generate_asset` gains `size`+`transparent`; the skills REST surface grows (`GET /skills` enriched, `GET /skills/{name}`, `POST /skills`, `GET /tools`) with validate→write→reload. Frontend renders a per-arg form in the composer and adds a Skill Editor Dockview pane. No change to the agent loop, run model, realtime protocol, or provider seam.

**Tech Stack:** Python 3 / FastAPI / pydantic / python-frontmatter / pytest (backend); React / Nx / hookstate / Tailwind design tokens / vitest / Playwright (frontend).

## Global Constraints

- **Commits:** Conventional Commits, imperative mood (`feat:`, `fix:`, `test:`, `docs:`). One per task step where indicated.
- **Branch/PR:** `main` is protected; work on a branch, finish with `git push -u` + `gh pr create` (no options menu).
- **TS interfaces use the `I` prefix** (`ISkill`, `ISkillArg`) — `docs/coding-standards.md`.
- **Design language is authoritative** (`docs/design-language.md`): 4 surfaces, 2 hairlines, 3 text tiers, 1 accent, floating-card model. **No raw colors** outside `styles.css` (a guard test blocks them) — use tokens (`bg-surface`, `bg-raised`, `text-foreground`, `text-muted-foreground`, `text-accent-text`, `border`, `border-destructive`, etc.).
- **TDD mandatory:** RED → GREEN → REFACTOR per step.
- **Backend tests run via** `uv --directory studio/backend run pytest`.
- **Before any frontend push, run all four CI gates** from `studio/frontend`: `npx prettier --check .`, `nx typecheck`, `nx test`, `nx build` (vitest green ≠ types valid).
- **Before every PR/merge, run `just e2e`** against a replay backend.
- **Skill slug rule:** a skill `name` must match `^[a-z0-9-]+$` (filename-safe, no path traversal).
- **Behavior-preservation:** `generate-sprite` and the existing `skill-run` e2e must stay green; `generate_asset` defaults reproduce slice-1 output exactly.

---

### Task 1: Enrich `SkillArg` schema + `validate_args` (description / default / enum)

**Files:**

- Modify: `studio/backend/app/skills.py`
- Test: `studio/backend/tests/test_skills.py`

**Interfaces:**

- Consumes: existing `SkillRegistry`, `SkillSpec`, `SkillError`.
- Produces: `SkillArg{name, type, required, description: str, default: str|float|bool|None, enum: list[str|float]|None}`; `validate_args` now applies defaults and rejects out-of-enum values; `list_skills()` returns the full arg dump (incl. the new fields).

- [ ] **Step 1: Write failing tests for enum + default behavior**

Add to `studio/backend/tests/test_skills.py`:

```python
ENRICHED = """---
name: gen-bg
description: Generate a background.
args:
  - { name: description, type: string, required: true }
  - { name: mood, type: string, enum: [bright, dark, neutral], default: neutral }
tools: [generate_asset]
---
Generate a background with generate_asset.
"""


def test_enriched_args_load_and_list(tmp_path):
    write(tmp_path, "gen-bg.md", ENRICHED)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    args = reg.list_skills()[0]["args"]
    assert args == [
        {"name": "description", "type": "string", "required": True,
         "description": "", "default": None, "enum": None},
        {"name": "mood", "type": "string", "required": False,
         "description": "", "default": "neutral", "enum": ["bright", "dark", "neutral"]},
    ]


def test_validate_args_applies_default(tmp_path):
    write(tmp_path, "gen-bg.md", ENRICHED)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    spec = reg.get("gen-bg")
    out = reg.validate_args(spec, {"description": "a forest"})
    assert out == {"description": "a forest", "mood": "neutral"}


def test_validate_args_rejects_out_of_enum(tmp_path):
    write(tmp_path, "gen-bg.md", ENRICHED)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    spec = reg.get("gen-bg")
    with pytest.raises(SkillError):
        reg.validate_args(spec, {"description": "x", "mood": "sparkly"})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_skills.py -v`
Expected: FAIL (the 3 new tests; `list_skills` lacks new keys, defaults not applied, enum not enforced).

- [ ] **Step 3: Enrich the schema + validation in `app/skills.py`**

Replace the `SkillArg` class:

```python
class SkillArg(BaseModel):
    name: str
    type: Literal["string", "number", "boolean"]
    required: bool = False
    description: str = ""
    default: str | float | bool | None = None
    enum: list[str | float] | None = None
```

Replace `validate_args`:

```python
    def validate_args(self, spec: SkillSpec, args: dict) -> dict:
        out: dict = {}
        for a in spec.args:
            if a.name not in args or args[a.name] in (None, ""):
                if a.default is not None:
                    out[a.name] = a.default
                elif a.required:
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

- [ ] **Step 4: Update the existing exact-match list test**

In `test_loads_and_lists_skill`, the `args` now carry the new keys. Replace its expected `args` list with:

```python
            "args": [
                {"name": "description", "type": "string", "required": True,
                 "description": "", "default": None, "enum": None},
                {"name": "style", "type": "string", "required": False,
                 "description": "", "default": None, "enum": None},
            ],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_skills.py -v`
Expected: PASS (all, including the updated exact-match test).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/skills.py studio/backend/tests/test_skills.py
git commit -m "feat(skills): enrich arg schema with description, default, enum"
```

---

### Task 2: `generate_asset` gains `size` + `transparent`

**Files:**

- Modify: `studio/backend/app/agent_tools.py`
- Test: `studio/backend/tests/test_agent_tools.py`

**Interfaces:**

- Consumes: `AssetStore.create_asset(game_id, name, prompt, width, height, workflow, seed=None, category=None)`; workflows `schnell-transparent` (default) and `schnell-opaque`.
- Produces: `generate_asset(description: str, style: str = "", size: str = "512x512", transparent: bool = True)` — `size` parsed `"WxH"` → ints; `transparent=False` → workflow `schnell-opaque`.

- [ ] **Step 1: Write failing tests for size + opaque workflow**

Add to `studio/backend/tests/test_agent_tools.py`:

```python
@pytest.mark.asyncio
async def test_generate_asset_size_and_opaque(mongo_db):
    store = AssetStore(mongo_db)
    hub = FakeHub(store)
    factory = ToolFactory(store, hub)
    ctx = ToolContext("r1", "g1", store, hub)
    tool = factory.build(["generate_asset"], ctx)[0]
    await tool.ainvoke({"description": "a forest", "size": "1024x576", "transparent": False})
    asset = (await store.list_assets("g1"))[0]
    assert (asset.width, asset.height) == (1024, 576)
    assert asset.workflow == "schnell-opaque"


@pytest.mark.asyncio
async def test_generate_asset_defaults_unchanged(mongo_db):
    store = AssetStore(mongo_db)
    factory = ToolFactory(store, FakeHub(store))
    ctx = ToolContext("r1", "g1", store, store and FakeHub(store))
    tool = factory.build(["generate_asset"], ctx)[0]
    await tool.ainvoke({"description": "a knight"})
    asset = (await store.list_assets("g1"))[0]
    assert (asset.width, asset.height) == (512, 512)
    assert asset.workflow == "schnell-transparent"
```

(Confirm `Asset` exposes `.width`, `.height`, `.workflow`; if a field name differs in `app/assets/models.py`, use the actual attribute names.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_agent_tools.py -v`
Expected: FAIL (size/transparent kwargs unknown; workflow always transparent).

- [ ] **Step 3: Implement size + transparency in `build_generate_asset_tool`**

Replace the inner `generate_asset` coroutine:

```python
def build_generate_asset_tool(ctx: ToolContext) -> BaseTool:
    async def generate_asset(
        description: str,
        style: str = "",
        size: str = "512x512",
        transparent: bool = True,
    ) -> str:
        prompt = description if not style else f"{description}, {style} style"
        width, height = (int(x) for x in size.lower().split("x", 1))
        workflow = "schnell-transparent" if transparent else "schnell-opaque"
        asset = await ctx.asset_store.create_asset(
            ctx.game_id, description[:40] or "asset", prompt, width, height, workflow
        )
        await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
        return f"Generated '{asset.name}' (asset {asset.id}) and added it to the Asset Board."

    return StructuredTool.from_function(
        coroutine=generate_asset,
        name="generate_asset",
        description=(
            "Generate a game image from a text description and add it to the Asset Board. "
            "size is 'WIDTHxHEIGHT' (default 512x512); set transparent=false for an opaque "
            "background/scene."
        ),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_agent_tools.py -v`
Expected: PASS (new + existing `test_generate_asset_creates_and_attaches`).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(tools): add size and transparency to generate_asset"
```

---

### Task 3: Ship the `generate-background` skill file

**Files:**

- Create: `skills/generate-background.md`
- Test: `studio/backend/tests/test_skills.py` (loads from the real repo skills dir)

**Interfaces:**

- Consumes: enriched loader (Task 1), `generate_asset` (Task 2).
- Produces: a registered skill `generate-background` with args `description`/`mood`/`aspect`.

- [ ] **Step 1: Write a failing test that the real skills dir loads both skills**

Add to `studio/backend/tests/test_skills.py`:

```python
def test_repo_skills_dir_loads_background():
    from app.config import get_settings
    reg = SkillRegistry(Path(get_settings().skills_dir), known_tools={"generate_asset"})
    reg.load()
    names = {s["name"] for s in reg.list_skills()}
    assert {"generate-sprite", "generate-background"} <= names
    bg = reg.get("generate-background")
    assert [a.name for a in bg.args] == ["description", "mood", "aspect"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_skills.py::test_repo_skills_dir_loads_background -v`
Expected: FAIL (`generate-background` not found).

- [ ] **Step 3: Create `skills/generate-background.md`**

```markdown
---
name: generate-background
description: Generate a wide, opaque background/scene and add it to the Asset Board.
args:
  - {
      name: description,
      type: string,
      required: true,
      description: What the scene depicts,
    }
  - {
      name: mood,
      type: string,
      enum: [bright, dark, neutral],
      default: neutral,
      description: Overall mood,
    }
  - {
      name: aspect,
      type: string,
      enum: [wide, square],
      default: wide,
      description: Aspect ratio,
    }
tools: [generate_asset]
---

You generate a single background/scene image for the current game. Derive a concrete
image prompt from the description and mood. Choose a size from the aspect: wide → 1024x576,
square → 1024x1024. Call generate_asset exactly once with that size and transparent=false.
When it returns, confirm in one sentence what you created and that it was added to the
Asset Board.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/test_skills.py::test_repo_skills_dir_loads_background -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/generate-background.md studio/backend/tests/test_skills.py
git commit -m "feat(skills): add generate-background skill"
```

---

### Task 4: `SkillRegistry.write_skill` (serialize → validate → write → reload)

**Files:**

- Modify: `studio/backend/app/skills.py`
- Test: `studio/backend/tests/test_skills.py`

**Interfaces:**

- Consumes: `frontmatter` (already a dependency), `SkillSpec`, `SkillError`.
- Produces: `SkillRegistry.write_skill(*, name, description, args, tools, body) -> SkillSpec` (validates SkillSpec + slug + known tools, writes `<dir>/<name>.md`, reloads, returns reloaded spec); `SkillRegistry.known_tools() -> list[str]`.

- [ ] **Step 1: Write failing tests for write_skill**

Add to `studio/backend/tests/test_skills.py`:

```python
def test_write_skill_round_trips(tmp_path):
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    spec = reg.write_skill(
        name="my-skill",
        description="A test skill.",
        args=[{"name": "description", "type": "string", "required": True}],
        tools=["generate_asset"],
        body="Do the thing with generate_asset.",
    )
    assert spec.name == "my-skill"
    assert (tmp_path / "my-skill.md").exists()
    # reloaded into the live registry
    assert reg.get("my-skill") is not None
    assert reg.get("my-skill").body == "Do the thing with generate_asset."


def test_write_skill_rejects_unknown_tool(tmp_path):
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    with pytest.raises(SkillError):
        reg.write_skill(name="bad", description="x", args=[],
                        tools=["nuke_everything"], body="x")


def test_write_skill_rejects_bad_slug(tmp_path):
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    with pytest.raises(SkillError):
        reg.write_skill(name="../escape", description="x", args=[],
                        tools=[], body="x")


def test_known_tools(tmp_path):
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    assert reg.known_tools() == ["generate_asset"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_skills.py -k "write_skill or known_tools" -v`
Expected: FAIL (`write_skill`/`known_tools` not defined).

- [ ] **Step 3: Implement `write_skill` + `known_tools`**

At the top of `app/skills.py` add `import re`. Add these methods to `SkillRegistry`:

```python
    def known_tools(self) -> list[str]:
        return sorted(self._known)

    def write_skill(self, *, name, description, args, tools, body) -> SkillSpec:
        if not re.fullmatch(r"[a-z0-9-]+", name or ""):
            raise SkillError(f"invalid skill name '{name}' (use a-z, 0-9, -)")
        try:
            spec = SkillSpec(
                name=name, description=description, args=args, tools=tools,
                body=body.strip(),
            )
        except ValidationError as e:
            raise SkillError(f"invalid skill: {e}") from e
        unknown = set(spec.tools) - self._known
        if unknown:
            raise SkillError(f"unknown tools {sorted(unknown)}")
        metadata = {
            "name": spec.name,
            "description": spec.description,
            "args": [a.model_dump(exclude_none=True) for a in spec.args],
            "tools": spec.tools,
        }
        post = frontmatter.Post(spec.body, **metadata)
        (self._dir).mkdir(parents=True, exist_ok=True)
        (self._dir / f"{spec.name}.md").write_text(
            frontmatter.dumps(post), encoding="utf-8"
        )
        self.load()
        return self.get(spec.name)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_skills.py -k "write_skill or known_tools" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/skills.py studio/backend/tests/test_skills.py
git commit -m "feat(skills): add write_skill (validate, serialize, reload) and known_tools"
```

---

### Task 5: Skills REST surface — `GET /skills/{name}`, `POST /skills`, `GET /tools`

**Files:**

- Modify: `studio/backend/app/rest.py`
- Test: `studio/backend/tests/test_rest.py`

**Interfaces:**

- Consumes: `request.app.state.skill_registry` (`get`, `write_skill`, `known_tools`, `list_skills`), `SkillError`.
- Produces:
  - `GET /skills/{name}` → `{name, description, args, tools, body}` or 404.
  - `POST /skills` body `{name, description, args, tools, body}` → 200 full spec, or 400 `{detail}` on `SkillError`.
  - `GET /tools` → `[{"name": str}, ...]`.

- [ ] **Step 1: Write failing REST tests**

Add to `studio/backend/tests/test_rest.py`:

```python
@pytest.mark.asyncio
async def test_get_skill_full_and_404(ctx):
    async with _client(ctx) as client:
        ok = await client.get("/skills/generate-sprite")
        assert ok.status_code == 200
        body = ok.json()
        assert body["name"] == "generate-sprite"
        assert "body" in body and "tools" in body and isinstance(body["args"], list)
        missing = await client.get("/skills/nope")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_get_tools_lists_known(ctx):
    async with _client(ctx) as client:
        resp = await client.get("/tools")
        assert resp.status_code == 200
        assert {"name": "generate_asset"} in resp.json()


@pytest.mark.asyncio
async def test_post_skill_writes_and_rejects(ctx):
    async with _client(ctx) as client:
        good = await client.post("/skills", json={
            "name": "tmp-skill", "description": "d",
            "args": [{"name": "description", "type": "string", "required": True}],
            "tools": ["generate_asset"], "body": "use generate_asset",
        })
        assert good.status_code == 200
        assert good.json()["name"] == "tmp-skill"
        # now listed
        listed = await client.get("/skills")
        assert "tmp-skill" in [s["name"] for s in listed.json()]
        # unknown tool rejected
        bad = await client.post("/skills", json={
            "name": "bad-skill", "description": "d", "args": [],
            "tools": ["nuke"], "body": "x",
        })
        assert bad.status_code == 400
```

(These write into the real `skills/` dir used by the test app. Clean up at the end of the test, or — preferred — point the test app's registry at a `tmp_path` dir. If `ctx` fixture wires a fixed `skills_dir`, add a cleanup: `import os; os.remove(.../skills/tmp-skill.md)` in a `finally`. Confirm the `ctx` fixture in `studio/backend/tests/conftest.py` and follow its pattern; if it already isolates the skills dir, no cleanup is needed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_rest.py -k "skill or tools" -v`
Expected: FAIL (routes 404/405).

- [ ] **Step 3: Add the routes to `app/rest.py`**

Add the import and a request model near the top:

```python
from app.skills import SkillError


class WriteSkillBody(BaseModel):
    name: str
    description: str = ""
    args: list[dict] = []
    tools: list[str] = []
    body: str = ""
```

Add routes (after the existing `GET /skills`):

```python
@router.get("/tools")
async def list_tools(request: Request) -> list[dict]:
    return [{"name": t} for t in request.app.state.skill_registry.known_tools()]


@router.get("/skills/{name}")
async def get_skill(name: str, request: Request) -> dict:
    spec = request.app.state.skill_registry.get(name)
    if spec is None:
        raise HTTPException(status_code=404, detail="skill not found")
    return {
        "name": spec.name,
        "description": spec.description,
        "args": [a.model_dump() for a in spec.args],
        "tools": spec.tools,
        "body": spec.body,
    }


@router.post("/skills")
async def write_skill(body: WriteSkillBody, request: Request) -> dict:
    try:
        spec = request.app.state.skill_registry.write_skill(
            name=body.name, description=body.description, args=body.args,
            tools=body.tools, body=body.body,
        )
    except SkillError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        "name": spec.name,
        "description": spec.description,
        "args": [a.model_dump() for a in spec.args],
        "tools": spec.tools,
        "body": spec.body,
    }
```

> Note: declare `GET /skills/{name}` **after** the static `GET /skills` route; FastAPI matches in definition order and a `{name}` path param must not shadow the list route.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_rest.py -k "skill or tools" -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/rest.py studio/backend/tests/test_rest.py
git commit -m "feat(api): add GET /skills/{name}, POST /skills, GET /tools"
```

---

### Task 6: Frontend types + REST client (`ISkillArg`, `getSkill`, `saveSkill`, `getTools`)

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/state.ts`
- Modify: `studio/frontend/src/plugins/llm-chat/restClient.ts`
- Test: `studio/frontend/src/plugins/llm-chat/restClient.spec.ts`

**Interfaces:**

- Produces:
  - `ISkillArg{name; type:'string'|'number'|'boolean'; required:boolean; description?:string; default?:string|number|boolean|null; enum?:(string|number)[]|null}`
  - `ISkill{name; description; args: ISkillArg[]}`
  - `ISkillFull extends ISkill { tools: string[]; body: string }`
  - `getSkill(name): Promise<ISkillFull>`, `saveSkill(payload: ISkillFull): Promise<ISkillFull>` (throws `Error` with server `detail` on non-2xx), `getTools(): Promise<string[]>`.

- [ ] **Step 1: Write failing restClient tests**

Add to `studio/frontend/src/plugins/llm-chat/restClient.spec.ts` (follow the existing `fetch` mock pattern in that file):

```ts
it("getSkill fetches the full skill", async () => {
  const skill = {
    name: "x",
    description: "d",
    args: [],
    tools: ["generate_asset"],
    body: "b",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(skill), { status: 200 })),
  );
  const { getSkill } = await import("./restClient");
  expect(await getSkill("x")).toEqual(skill);
});

it("saveSkill surfaces the server detail on 400", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: "unknown tools" }), {
          status: 400,
        }),
    ),
  );
  const { saveSkill } = await import("./restClient");
  await expect(
    saveSkill({
      name: "x",
      description: "",
      args: [],
      tools: ["nuke"],
      body: "",
    }),
  ).rejects.toThrow("unknown tools");
});

it("getTools returns tool names", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify([{ name: "generate_asset" }]), {
          status: 200,
        }),
    ),
  );
  const { getTools } = await import("./restClient");
  expect(await getTools()).toEqual(["generate_asset"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `studio/frontend`): `npx nx test frontend -- restClient`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Update types in `state.ts`**

Replace the `ISkill` interface:

```ts
export interface ISkillArg {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  default?: string | number | boolean | null;
  enum?: (string | number)[] | null;
}

export interface ISkill {
  name: string;
  description: string;
  args: ISkillArg[];
}

export interface ISkillFull extends ISkill {
  tools: string[];
  body: string;
}
```

- [ ] **Step 4: Add functions to `restClient.ts`**

Add (import `ISkillFull` from `./state`):

```ts
export async function getSkill(name: string): Promise<ISkillFull> {
  return okJson<ISkillFull>(await fetch(`${BACKEND_URL}/skills/${name}`));
}

export async function getTools(): Promise<string[]> {
  const tools = await okJson<{ name: string }[]>(
    await fetch(`${BACKEND_URL}/tools`),
  );
  return tools.map((t) => t.name);
}

export async function saveSkill(payload: ISkillFull): Promise<ISkillFull> {
  const res = await fetch(`${BACKEND_URL}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => b.detail)
      .catch(() => null);
    throw new Error(detail ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as ISkillFull;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx nx test frontend -- restClient`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/restClient.ts studio/frontend/src/plugins/llm-chat/restClient.spec.ts
git commit -m "feat(chat): enriched skill types + getSkill/saveSkill/getTools clients"
```

---

### Task 7: `SkillForm` component (typed inputs from an arg schema)

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/SkillForm.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/SkillForm.spec.tsx`

**Interfaces:**

- Consumes: `ISkill`, `ISkillArg` from `./state`.
- Produces: `export function SkillForm({ skill, onSubmit, onCancel }: { skill: ISkill; onSubmit: (args: Record<string, unknown>) => void; onCancel: () => void })`. Renders one input per arg (`string→text`, `number→number`, `boolean→checkbox`, `enum→select`), prefills `default`, blocks submit while a `required` field is empty. Test ids: `skill-form`, `skill-form-field-<name>`, `skill-form-submit`, `skill-form-cancel`.

- [ ] **Step 1: Write failing component tests**

Create `studio/frontend/src/plugins/llm-chat/SkillForm.spec.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillForm } from "./SkillForm";
import type { ISkill } from "./state";

const skill: ISkill = {
  name: "generate-background",
  description: "bg",
  args: [
    { name: "description", type: "string", required: true },
    {
      name: "mood",
      type: "string",
      required: false,
      default: "neutral",
      enum: ["bright", "dark", "neutral"],
    },
  ],
};

describe("SkillForm", () => {
  it("renders a field per arg and prefills the default", () => {
    render(<SkillForm skill={skill} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(
      screen.getByTestId("skill-form-field-description"),
    ).toBeInTheDocument();
    const mood = screen.getByTestId(
      "skill-form-field-mood",
    ) as HTMLSelectElement;
    expect(mood.value).toBe("neutral");
  });

  it("blocks submit until required fields are filled", () => {
    const onSubmit = vi.fn();
    render(<SkillForm skill={skill} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId("skill-form-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("skill-form-field-description"), {
      target: { value: "a forest" },
    });
    fireEvent.click(screen.getByTestId("skill-form-submit"));
    expect(onSubmit).toHaveBeenCalledWith({
      description: "a forest",
      mood: "neutral",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx nx test frontend -- SkillForm`
Expected: FAIL (no such module).

- [ ] **Step 3: Implement `SkillForm.tsx`**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ISkill, ISkillArg } from "./state";

function initialValue(a: ISkillArg): string | boolean {
  if (a.default !== undefined && a.default !== null)
    return a.default as string | boolean;
  return a.type === "boolean" ? false : "";
}

export function SkillForm({
  skill,
  onSubmit,
  onCancel,
}: {
  skill: ISkill;
  onSubmit: (args: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(skill.args.map((a) => [a.name, initialValue(a)])),
  );

  const missingRequired = skill.args.some(
    (a) =>
      a.required && (values[a.name] === "" || values[a.name] === undefined),
  );

  const set = (name: string, v: string | boolean) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  const submit = () => {
    if (missingRequired) return;
    onSubmit({ ...values });
  };

  return (
    <div
      data-testid="skill-form"
      className="flex flex-col gap-2 rounded-md border bg-surface p-2.5 text-sm shadow-md"
    >
      <div className="text-[10.5px] font-semibold text-accent-text">
        /{skill.name}
      </div>
      {skill.args.map((a) => (
        <label key={a.name} className="flex flex-col gap-0.5">
          <span className="text-[10.5px] text-muted-foreground">
            {a.name}
            {a.required ? " *" : ""}
            {a.description ? ` — ${a.description}` : ""}
          </span>
          {a.enum ? (
            <select
              data-testid={`skill-form-field-${a.name}`}
              value={String(values[a.name] ?? "")}
              className="rounded border bg-raised px-2 py-1 text-foreground"
              onChange={(e) => set(a.name, e.target.value)}
            >
              {!a.required && <option value="" />}
              {a.enum.map((opt) => (
                <option key={String(opt)} value={String(opt)}>
                  {String(opt)}
                </option>
              ))}
            </select>
          ) : a.type === "boolean" ? (
            <input
              data-testid={`skill-form-field-${a.name}`}
              type="checkbox"
              checked={Boolean(values[a.name])}
              className="h-4 w-4 self-start"
              onChange={(e) => set(a.name, e.target.checked)}
            />
          ) : (
            <Input
              data-testid={`skill-form-field-${a.name}`}
              type={a.type === "number" ? "number" : "text"}
              value={String(values[a.name] ?? "")}
              onChange={(e) => set(a.name, e.target.value)}
            />
          )}
        </label>
      ))}
      <div className="flex justify-end gap-2">
        <Button
          data-testid="skill-form-cancel"
          size="sm"
          variant="ghost"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          data-testid="skill-form-submit"
          size="sm"
          disabled={missingRequired}
          onClick={submit}
        >
          Run
        </Button>
      </div>
    </div>
  );
}
```

(If `variant="ghost"`/`size="sm"` aren't valid props on the shared `Button`, use the closest existing variant — check `@/components/ui/button`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- SkillForm`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/SkillForm.tsx studio/frontend/src/plugins/llm-chat/SkillForm.spec.tsx
git commit -m "feat(chat): SkillForm renders typed inputs from a skill arg schema"
```

---

### Task 8: Wire `SkillForm` into the composer (autocomplete → form → run)

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx`

**Interfaces:**

- Consumes: `SkillForm` (Task 7), `runSkill` (existing), `parseSlashCommand` (existing, retained as fallback).
- Produces: clicking an autocomplete option opens `SkillForm` for that skill; submitting it calls `runSkill(name, args)` and clears; the text `key=value` path is unchanged.

- [ ] **Step 1: Write a failing test for the click→form→run flow**

Add to `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx` (reuse the file's existing state-seeding + `runSkill` mock pattern; seed `skills` to include `generate-sprite` with a required `description` arg):

```tsx
it("opens a form when an autocomplete option is clicked and runs on submit", () => {
  // seed an active room + a skill (follow the existing beforeEach/seed helper in this file)
  render(<ChatRoomPane />);
  fireEvent.change(screen.getByTestId("chat-composer"), {
    target: { value: "/generate-sprite" },
  });
  fireEvent.click(screen.getByTestId("skill-option-generate-sprite"));
  expect(screen.getByTestId("skill-form")).toBeInTheDocument();
  fireEvent.change(screen.getByTestId("skill-form-field-description"), {
    target: { value: "a knight" },
  });
  fireEvent.click(screen.getByTestId("skill-form-submit"));
  expect(runSkillMock).toHaveBeenCalledWith("generate-sprite", {
    description: "a knight",
  });
});
```

(Mock `runSkill` the same way existing tests in this file mock actions — e.g. `vi.mock('./actions', ...)`. Match the established pattern rather than introducing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- ChatRoomPane`
Expected: FAIL (clicking an option does nothing; no `skill-form`).

- [ ] **Step 3: Wire the form into `ChatRoomPane`**

Add the import:

```tsx
import { SkillForm } from "./SkillForm";
```

Give `SkillAutocomplete` an `onPick` prop and call it on click:

```tsx
function SkillAutocomplete({
  prefix,
  onPick,
}: {
  prefix: string;
  onPick: (name: string) => void;
}) {
  const s = llmChatHooks.usePluginState();
  const skills = s.skills.get();
  const matches = skills.filter((sk) => sk.name.startsWith(prefix));
  if (matches.length === 0) return null;
  return (
    <ul
      data-testid="skill-autocomplete"
      className="m-0 list-none rounded-md border bg-surface p-1 text-sm shadow-md"
    >
      {matches.map((sk) => (
        <li
          key={sk.name}
          data-testid={`skill-option-${sk.name}`}
          className="cursor-pointer rounded px-2 py-1 text-foreground hover:bg-raised"
          onClick={() => onPick(sk.name)}
        >
          <span className="font-semibold text-accent-text">/{sk.name}</span>
          {sk.description ? (
            <span className="ml-2 text-muted-foreground">{sk.description}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
```

In `ChatRoomPane`, add form state and render it. After `const [draft, setDraft] = useState('');` add:

```tsx
const [formSkillName, setFormSkillName] = useState<string | null>(null);
const formSkill = formSkillName
  ? (s.skills.get().find((sk) => sk.name === formSkillName) ?? null)
  : null;
```

Replace the autocomplete line `{slashPrefix !== null && <SkillAutocomplete prefix={slashPrefix} />}` with:

```tsx
{
  formSkill ? (
    <SkillForm
      skill={formSkill}
      onSubmit={(args) => {
        runSkill(formSkill.name, args);
        setFormSkillName(null);
        setDraft("");
        setTyping(false);
      }}
      onCancel={() => setFormSkillName(null)}
    />
  ) : (
    slashPrefix !== null && (
      <SkillAutocomplete
        prefix={slashPrefix}
        onPick={(name) => setFormSkillName(name)}
      />
    )
  );
}
```

(The existing `submit()` text path and `parseSlashCommand` stay exactly as-is — the `key=value` fallback is preserved.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- ChatRoomPane`
Expected: PASS (new test + all existing ChatRoomPane tests, including render-count and the autocomplete display test).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
git commit -m "feat(chat): open SkillForm from autocomplete and run on submit"
```

---

### Task 9: `SkillEditorPane` (author/edit a skill → POST /skills)

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/SkillEditorPane.tsx`
- Modify: `studio/frontend/src/plugins/llm-chat/index.ts`
- Test: `studio/frontend/src/plugins/llm-chat/SkillEditorPane.spec.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/index.spec.ts`

**Interfaces:**

- Consumes: `getTools`, `getSkill`, `saveSkill` (Task 6), `ISkillFull`, `ISkillArg`.
- Produces: `export function SkillEditorPane()` — name/description/body fields, dynamic arg rows (name/type/required/description/default/enum-as-comma-list), tool checkboxes from `GET /tools`, a live markdown preview, and a Save button that calls `saveSkill` and shows success (`skill-editor-status`) or the server error. Registered as pane `llm-chat/skill-editor` + command `llm-chat/open-skill-editor`.

- [ ] **Step 1 (RED): update the plugin manifest test**

In `studio/frontend/src/plugins/llm-chat/index.spec.ts`, update the pane-id assertion:

```ts
expect(llmChat.panes.map((p) => p.id)).toEqual([
  "llm-chat/room",
  "llm-chat/settings",
  "llm-chat/skill-editor",
]);
```

- [ ] **Step 2 (RED): write the editor component test**

Create `studio/frontend/src/plugins/llm-chat/SkillEditorPane.spec.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("./restClient", () => ({
  getTools: vi.fn(async () => ["generate_asset"]),
  getSkill: vi.fn(async () => ({
    name: "",
    description: "",
    args: [],
    tools: [],
    body: "",
  })),
  saveSkill: vi.fn(async (p) => p),
}));

import { SkillEditorPane } from "./SkillEditorPane";
import * as rest from "./restClient";

describe("SkillEditorPane", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads tools and saves an authored skill", async () => {
    render(<SkillEditorPane />);
    await waitFor(() =>
      expect(
        screen.getByTestId("skill-editor-tool-generate_asset"),
      ).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("skill-editor-name"), {
      target: { value: "my-skill" },
    });
    fireEvent.change(screen.getByTestId("skill-editor-description"), {
      target: { value: "d" },
    });
    fireEvent.change(screen.getByTestId("skill-editor-body"), {
      target: { value: "use generate_asset" },
    });
    fireEvent.click(screen.getByTestId("skill-editor-tool-generate_asset"));
    fireEvent.click(screen.getByTestId("skill-editor-save"));
    await waitFor(() => expect(rest.saveSkill).toHaveBeenCalled());
    const arg = (rest.saveSkill as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.name).toBe("my-skill");
    expect(arg.tools).toContain("generate_asset");
  });

  it("shows the server error when save fails", async () => {
    (rest.saveSkill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("unknown tools"),
    );
    render(<SkillEditorPane />);
    fireEvent.change(screen.getByTestId("skill-editor-name"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByTestId("skill-editor-save"));
    await waitFor(() =>
      expect(screen.getByTestId("skill-editor-status")).toHaveTextContent(
        "unknown tools",
      ),
    );
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx nx test frontend -- SkillEditorPane index`
Expected: FAIL (no module; pane list mismatch).

- [ ] **Step 4: Implement `SkillEditorPane.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getTools, saveSkill } from "./restClient";
import type { ISkillArg, ISkillFull } from "./state";

interface IArgRow {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  default: string;
  enumCsv: string;
}

function rowToArg(r: IArgRow): ISkillArg {
  const arg: ISkillArg = { name: r.name, type: r.type, required: r.required };
  if (r.description) arg.description = r.description;
  if (r.default !== "")
    arg.default = r.type === "number" ? Number(r.default) : r.default;
  const en = r.enumCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (en.length) arg.enum = en;
  return arg;
}

function previewMarkdown(skill: ISkillFull): string {
  const lines = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `tools: [${skill.tools.join(", ")}]`,
    "---",
    "",
    skill.body,
  ];
  return lines.join("\n");
}

export function SkillEditorPane() {
  const [tools, setTools] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [rows, setRows] = useState<IArgRow[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  useEffect(() => {
    void getTools()
      .then(setTools)
      .catch(() => setTools([]));
  }, []);

  const skill: ISkillFull = {
    name,
    description,
    body,
    tools: selectedTools,
    args: rows.map(rowToArg),
  };

  const toggleTool = (t: string) =>
    setSelectedTools((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      {
        name: "",
        type: "string",
        required: false,
        description: "",
        default: "",
        enumCsv: "",
      },
    ]);

  const setRow = (i: number, patch: Partial<IArgRow>) =>
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );

  const save = async () => {
    setStatus(null);
    try {
      await saveSkill(skill);
      setStatus({
        ok: true,
        msg: `Saved to skills/${name}.md — commit + PR it.`,
      });
    } catch (e) {
      setStatus({ ok: false, msg: (e as Error).message });
    }
  };

  return (
    <div
      data-testid="skill-editor-pane"
      className="flex h-full flex-col gap-2 overflow-auto bg-surface p-2.5 text-sm"
    >
      <h2 className="text-base font-semibold text-foreground">Skill Editor</h2>
      <Input
        data-testid="skill-editor-name"
        placeholder="name (a-z0-9-)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        data-testid="skill-editor-description"
        placeholder="description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <div className="flex flex-col gap-1">
        <span className="text-[10.5px] text-muted-foreground">Tools</span>
        <div className="flex flex-wrap gap-2">
          {tools.map((t) => (
            <label key={t} className="flex items-center gap-1 text-foreground">
              <input
                data-testid={`skill-editor-tool-${t}`}
                type="checkbox"
                checked={selectedTools.includes(t)}
                onChange={() => toggleTool(t)}
              />
              {t}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] text-muted-foreground">Args</span>
          <Button
            data-testid="skill-editor-add-arg"
            size="sm"
            variant="ghost"
            onClick={addRow}
          >
            + arg
          </Button>
        </div>
        {rows.map((r, i) => (
          <div
            key={i}
            data-testid={`skill-editor-arg-${i}`}
            className="flex flex-wrap gap-1 rounded border bg-raised p-1"
          >
            <Input
              className="w-24"
              placeholder="name"
              value={r.name}
              onChange={(e) => setRow(i, { name: e.target.value })}
            />
            <select
              className="rounded border bg-surface px-1 text-foreground"
              value={r.type}
              onChange={(e) =>
                setRow(i, { type: e.target.value as IArgRow["type"] })
              }
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
            </select>
            <label className="flex items-center gap-1 text-muted-foreground">
              <input
                type="checkbox"
                checked={r.required}
                onChange={(e) => setRow(i, { required: e.target.checked })}
              />
              req
            </label>
            <Input
              className="w-28"
              placeholder="description"
              value={r.description}
              onChange={(e) => setRow(i, { description: e.target.value })}
            />
            <Input
              className="w-20"
              placeholder="default"
              value={r.default}
              onChange={(e) => setRow(i, { default: e.target.value })}
            />
            <Input
              className="w-28"
              placeholder="enum a,b,c"
              value={r.enumCsv}
              onChange={(e) => setRow(i, { enumCsv: e.target.value })}
            />
          </div>
        ))}
      </div>

      <textarea
        data-testid="skill-editor-body"
        className="min-h-[120px] rounded border bg-raised p-2 font-mono text-foreground"
        placeholder="skill body (prompt)…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <div className="flex flex-col gap-1">
        <span className="text-[10.5px] text-muted-foreground">Preview</span>
        <pre
          data-testid="skill-editor-preview"
          className="overflow-auto rounded border bg-raised p-2 font-mono text-[11px] text-muted-foreground"
        >
          {previewMarkdown(skill)}
        </pre>
      </div>

      <div className="flex items-center justify-between gap-2">
        {status && (
          <span
            data-testid="skill-editor-status"
            className={status.ok ? "text-accent-text" : "text-destructive"}
          >
            {status.msg}
          </span>
        )}
        <Button
          data-testid="skill-editor-save"
          size="sm"
          className="ml-auto"
          onClick={save}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Register the pane + command in `index.ts`**

```ts
import { SkillEditorPane } from "./SkillEditorPane";
```

Add to `panes`:

```ts
    { id: 'llm-chat/skill-editor', title: 'Skill Editor', component: SkillEditorPane as never },
```

Add to `commands`:

```ts
    { id: 'llm-chat/open-skill-editor', title: 'Open Skill Editor', run: (host) => host.openPane('llm-chat/skill-editor') },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx nx test frontend -- SkillEditorPane index`
Expected: PASS.

- [ ] **Step 7: Run all four frontend CI gates**

From `studio/frontend`:

```bash
npx prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all PASS. Fix any prettier/type issues before committing.

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/SkillEditorPane.tsx studio/frontend/src/plugins/llm-chat/SkillEditorPane.spec.tsx studio/frontend/src/plugins/llm-chat/index.ts studio/frontend/src/plugins/llm-chat/index.spec.ts
git commit -m "feat(chat): Skill Editor pane writes git skills via POST /skills"
```

---

### Task 10: End-to-end — author `generate-background` via the editor, invoke via the form

**Files:**

- Create: `studio/frontend/e2e/skill-editor.spec.ts`
- Reference: `studio/frontend/e2e/skill-run.spec.ts` (existing patterns: backend health/parity, room setup, asset-board assertions)

**Interfaces:**

- Consumes: the running replay backend on :8000 + the studio frontend; `llm-chat/open-skill-editor` command; `SkillForm`; Asset Board.

> This is the authoritative behavioral contract for slice 2. Browser e2e is **local-only** (never CI). Run against a replay backend (`just backend-serve-replay` first, then `just e2e`). The editor writes a real file into `skills/`; the spec must delete `skills/generate-background.md` is **not** removed (it's a shipped skill from Task 3) — instead author a throwaway skill name OR assert against the shipped `generate-background` invoked via the form. Prefer the latter to avoid mutating the repo from a test.

- [ ] **Step 1: Write the e2e spec**

Create `studio/frontend/e2e/skill-editor.spec.ts` following `skill-run.spec.ts`'s setup. Two flows:

```ts
// (1) Invoke the shipped generate-background via the FORM and see an opaque asset.
//     - open a room, type "/generate-background", click skill-option-generate-background
//     - fill skill-form-field-description, leave mood/aspect at defaults
//     - click skill-form-submit
//     - assert the run timeline runs and a new asset appears on the Asset Board
//
// (2) Author a throwaway skill via the editor and see it become invocable.
//     - run command llm-chat/open-skill-editor (or open the pane)
//     - fill skill-editor-name="e2e-temp", description, body, check generate_asset
//     - click skill-editor-save → assert skill-editor-status shows the success copy
//     - back in the composer, type "/e2e-temp" → assert skill-option-e2e-temp appears
//     - (cleanup) delete studio/.../skills/e2e-temp.md in test teardown
```

Use the concrete selectors/assertions from `skill-run.spec.ts` for the run timeline and Asset Board. Keep flow (2)'s file cleanup in an `afterAll`/`finally` so the repo stays clean.

- [ ] **Step 2: Start the replay backend**

Run: `just backend-serve-replay`
(Confirm `/health` reports `providerMode: replay`.)

- [ ] **Step 3: Run the e2e suite**

Run: `just e2e`
Expected: the new spec PASSES alongside the existing `skill-run` spec (which must remain green — the text-invocation safety net).

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/skill-editor.spec.ts
git commit -m "test(e2e): author a skill via editor, invoke generate-background via form"
```

---

### Task 11: Branch wrap-up — full gates + PR

- [ ] **Step 1: Backend suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS.

- [ ] **Step 2: Frontend gates**

From `studio/frontend`: `npx prettier --check .` · `npx nx typecheck frontend` · `npx nx test frontend` · `npx nx build frontend`. All PASS.

- [ ] **Step 3: e2e**

`just e2e` (replay backend running). PASS, including `skill-run`.

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/skill-chat-slice-2
gh pr create --fill
```

---

## Self-Review

**Spec coverage (slice-2 spec §5–§7):**

- §5.1 enriched `SkillArg` + `validate_args` (default/enum) → **Task 1**.
- §5.2 `generate_asset` size/transparency → **Task 2**; `generate-background.md` → **Task 3**.
- §5.3 `GET /skills` enriched (args now full-dump) → **Task 1** (list_skills) + verified in **Task 5**; `GET /skills/{name}` + `POST /skills` (validate→write→reload) → **Task 4** (registry) + **Task 5** (routes); `GET /tools` for the editor picker → **Task 4/5**.
- §5.4 per-arg form invocation, text fallback retained → **Task 7** (component) + **Task 8** (wiring).
- §5.5 Skill Editor pane (form + tool picker + body + preview + save; load-existing via `getSkill` available in client) → **Task 9**.
- §6 test ladder: pytest unit (T1–T5), vitest (T6–T9), Playwright local (T10) → covered.
- §7 scope: approval gate / Mongo / new tools / git automation all excluded — no task adds them. ✓

**Placeholder scan:** every code step contains full code; commands have expected output. The only deliberately-deferred specifics are flagged as such in the spec §8 (size values are concretely set in Task 3; non-transparent model is concretely `schnell-opaque` in Task 2).

**Type consistency:** `ISkillArg`/`ISkill`/`ISkillFull` defined in Task 6 and consumed unchanged in Tasks 7–9. `write_skill(*, name, description, args, tools, body)` defined in Task 4 and called identically in Task 5. `getSkill`/`saveSkill`/`getTools` signatures defined in Task 6, consumed in Task 9. `generate_asset(description, style, size, transparent)` defined in Task 2, exercised by `generate-background` body (Task 3) and e2e (Task 10).

**Notes for the implementer (verify before coding each task):**

- Confirm the `ctx` fixture in `studio/backend/tests/conftest.py` — whether it isolates `skills_dir` (affects Task 5 cleanup).
- Confirm `Asset` field names (`width`/`height`/`workflow`) in `app/assets/models.py` (Task 2).
- Confirm the shared `Button`/`Input` prop API in `@/components/ui/` (`size`/`variant`) before using them (Tasks 7, 9).
- Match the existing vitest mocking idiom in each spec file rather than introducing a new one (Tasks 6–9).
  </content>
