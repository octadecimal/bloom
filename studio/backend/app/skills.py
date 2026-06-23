import re
from pathlib import Path
from typing import Literal

import frontmatter
from pydantic import BaseModel, ValidationError


class SkillError(Exception):
    pass


class SkillArg(BaseModel):
    name: str
    type: Literal["string", "number", "boolean"]
    required: bool = False
    description: str = ""
    default: str | float | bool | None = None
    enum: list[str | float] | None = None


class SkillSpec(BaseModel):
    name: str
    description: str
    args: list[SkillArg] = []
    tools: list[str] = []
    body: str


_COERCE = {
    "string": str,
    "number": float,
    "boolean": lambda v: v if isinstance(v, bool) else str(v).lower() == "true",
}


class SkillRegistry:
    def __init__(self, skills_dir: Path, known_tools: set[str]):
        self._dir = Path(skills_dir)
        self._known = known_tools
        self._skills: dict[str, SkillSpec] = {}

    def load(self) -> None:
        self._skills = {}
        if not self._dir.is_dir():
            return
        for path in sorted(self._dir.glob("*.md")):
            post = frontmatter.load(str(path))
            try:
                spec = SkillSpec(body=post.content.strip(), **post.metadata)
            except ValidationError as e:
                raise SkillError(f"{path.name}: invalid skill frontmatter: {e}") from e
            unknown = set(spec.tools) - self._known
            if unknown:
                raise SkillError(f"{path.name}: unknown tools {sorted(unknown)}")
            self._skills[spec.name] = spec

    def get(self, name: str) -> SkillSpec | None:
        return self._skills.get(name)

    def list_skills(self) -> list[dict]:
        return [
            {
                "name": s.name,
                "description": s.description,
                "args": [a.model_dump() for a in s.args],
            }
            for s in self._skills.values()
        ]

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
        result = self.get(spec.name)
        assert result is not None
        return result
