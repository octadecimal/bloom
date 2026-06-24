from app.gdd.schemas import Field

_EMPTY = (None, "", [], {})


def render(schema: list[Field], data: dict) -> str:
    lines: list[str] = []

    scalars = [f for f in schema
               if f.role == "param" and f.type not in ("table", "list")]
    param_lines: list[str] = []
    for f in scalars:
        val = data.get(f.key)
        if val in _EMPTY:
            if f.required:
                param_lines.append(f"- **{f.label}:** ⚠ needs input")
            continue
        param_lines.append(f"- **{f.label}:** {_fmt(f, val)}")
    if param_lines:
        lines.append("**Parameters**")
        lines.extend(param_lines)
        lines.append("")

    for f in (f for f in schema if f.type == "table"):
        lines.append(f"**{f.label}**")
        rows = data.get(f.key)
        if not rows:
            lines.append("⚠ needs input" if f.required else "_none yet_")
        else:
            lines.append(_render_table(f, rows))
        lines.append("")

    for f in (f for f in schema if f.type == "list"):
        lines.append(f"**{f.label}**")
        items = data.get(f.key) or []
        if not items:
            lines.append("_none yet_")
        for it in items:
            lines.append(f"- {it}")
        lines.append("")

    for f in (f for f in schema if f.role == "narrative"):
        val = data.get(f.key)
        lines.append(f"**{f.label}**")
        lines.append(str(val) if val not in _EMPTY else "_(not yet written)_")
        lines.append("")

    return "\n".join(lines).strip() + "\n"


def _fmt(field: Field, val) -> str:
    if field.type == "percent":
        try:
            return f"{float(val) * 100:g}%"
        except (ValueError, TypeError):
            return str(val)
    if field.type == "number":
        try:
            return f"{float(val):g}"
        except (ValueError, TypeError):
            return str(val)
    return str(val)


def _render_table(field: Field, rows: list[dict]) -> str:
    cols = field.columns or ()
    header = "| " + " | ".join(c.label for c in cols) + " |"
    sep = "| " + " | ".join("---" for _ in cols) + " |"
    body = [
        "| " + " | ".join(str(row.get(c.key, "")) for c in cols) + " |"
        for row in rows
    ]
    return "\n".join([header, sep, *body])
