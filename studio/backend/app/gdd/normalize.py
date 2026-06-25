import re

from app.gdd.schemas import Field


def normalize_value(field: Field, raw) -> tuple[object, str | None]:
    if field.type == "percent":
        return _percent(raw)
    if field.type == "ratio":
        return _ratio(raw)
    if field.type == "number":
        return _number(raw)
    if field.type == "enum":
        return _enum(field, raw)
    if field.type == "table":
        return _table(field, raw)
    if field.type == "list":
        return _list(raw)
    return (str(raw), None)


def _percent(raw) -> tuple[object, str | None]:
    s = str(raw).strip()
    try:
        if s.endswith("%"):
            # "90%" → 0.9, "5000%" → 50.0; no second division: the % suffix is
            # authoritative, so 5000% genuinely means 50x RTP.
            v = float(s[:-1]) / 100
        else:
            # bare number: "0.96" → 0.96, "96" → 0.96 (assumed to mean 96%).
            v = float(s)
            if v > 1:
                v = v / 100
        return (round(v, 4), None)
    except ValueError:
        return (raw, f"could not parse '{raw}' as a percent")


def _ratio(raw) -> tuple[object, str | None]:
    s = str(raw).strip().lower()
    try:
        if ":" in s:
            a, b = s.split(":", 1)
            p = float(a) / float(b)
        elif " in " in s:
            a, b = s.split(" in ", 1)
            p = float(a) / float(b)
        else:
            v = float(s)
            p = v if 0 < v < 1 else 1.0 / v
        if p <= 0:
            raise ValueError
        return (f"1:{round(1 / p)}", None)
    except (ValueError, ZeroDivisionError):
        return (raw, f"could not parse '{raw}' as a ratio (use e.g. '1:200')")


def _number(raw) -> tuple[object, str | None]:
    m = re.search(r"-?\d+(\.\d+)?", str(raw))
    if not m:
        return (raw, f"could not parse '{raw}' as a number")
    return (float(m.group()), None)


def _enum(field: Field, raw) -> tuple[object, str | None]:
    s = str(raw).strip().lower()
    allowed = field.enum or ()
    if s in allowed:
        return (s, None)
    return (s, f"'{raw}' is not one of {list(allowed)} for {field.key}")


def _table(field: Field, raw) -> tuple[object, str | None]:
    cols = [c.key for c in (field.columns or ())]
    if not isinstance(raw, list):
        return (raw, f"{field.key} expects a list of row objects")
    warns: list[str] = []
    rows: list[dict] = []
    for i, row in enumerate(raw):
        if not isinstance(row, dict):
            warns.append(f"{field.key} row {i} is not an object")
            continue
        rows.append({c: row.get(c, "") for c in cols})
        missing = [c for c in cols if c not in row]
        if missing:
            warns.append(f"{field.key} row {i} missing {missing}")
    return (rows, "; ".join(warns) if warns else None)


def _list(raw) -> tuple[object, str | None]:
    if isinstance(raw, list):
        return ([str(x) for x in raw], None)
    if isinstance(raw, str):
        return ([raw], None)
    return (raw, "expected a list")
