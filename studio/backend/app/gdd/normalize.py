import re

from app.gdd.schemas import Field


def normalize_value(
    field: Field, raw, ignore_missing: frozenset[str] = frozenset()
) -> tuple[object, str | None]:
    if field.type == "percent":
        return _percent(raw)
    if field.type == "ratio":
        return _ratio(raw)
    if field.type == "number":
        return _number(raw)
    if field.type == "enum":
        return _enum(field, raw)
    if field.type == "table":
        return _table(field, raw, ignore_missing)
    if field.type == "list":
        return _list(raw)
    if field.type == "range":
        return _range(raw)
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


def _table(
    field: Field, raw, ignore_missing: frozenset[str] = frozenset()
) -> tuple[object, str | None]:
    cols = field.columns or ()
    col_keys = [c.key for c in cols]
    if not isinstance(raw, list):
        return (raw, f"{field.key} expects a list of row objects")
    warns: list[str] = []
    rows: list[dict] = []
    for i, row in enumerate(raw):
        if not isinstance(row, dict):
            warns.append(f"{field.key} row {i} is not an object")
            continue
        rows.append({c: row.get(c, "") for c in col_keys})
        missing = [c for c in col_keys if c not in row and c not in ignore_missing]
        if missing:
            warns.append(f"{field.key} row {i} missing {missing}")
        for col in cols:
            if col.enum and col.key in row:
                cell = str(row[col.key]).strip().lower()
                if cell not in col.enum:
                    warns.append(
                        f"{field.key} row {i} {col.key} '{row[col.key]}' "
                        f"not one of {list(col.enum)}"
                    )
    return (rows, "; ".join(warns) if warns else None)


def _range(raw) -> tuple[object, str | None]:
    if isinstance(raw, dict):
        try:
            lo, hi = float(raw["min"]), float(raw["max"])
        except (KeyError, TypeError, ValueError):
            return (raw, f"could not parse '{raw}' as a range (need numeric min/max)")
    else:
        s = str(raw)
        # First try to split on common delimiters to avoid treating "-" as a sign
        for delim in [" to ", "-", " "]:
            if delim in s:
                parts = s.split(delim)
                nums = [re.search(r"-?\d+(?:\.\d+)?", p) for p in parts]
                nums = [float(m.group()) for m in nums if m]
                if len(nums) >= 2:
                    lo, hi = nums[0], nums[1]
                    break
        else:
            # Fallback to simple regex search
            nums = re.findall(r"-?\d+(?:\.\d+)?", s)
            if len(nums) < 2:
                return (raw, f"could not parse '{raw}' as a range (use e.g. '8-20')")
            lo, hi = float(nums[0]), float(nums[1])
    warn = None
    if lo > hi:
        lo, hi = hi, lo
        warn = f"range min > max; swapped to min {lo:g}, max {hi:g}"
    return ({"min": lo, "max": hi}, warn)


def _list(raw) -> tuple[object, str | None]:
    if isinstance(raw, list):
        return ([str(x) for x in raw], None)
    if isinstance(raw, str):
        return ([raw], None)
    return (raw, "expected a list")
