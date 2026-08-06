"""Cross-class end-game: best-A vs best-B, logged as cls "X".

A playoff is just a two-technique class: standings/separated work on X
verdicts unchanged, and the evidence floor applies. The pair always follows
the CURRENT champions — if a class's leader changes, X verdicts for the
dethroned pairing stay in the log and simply stop accumulating.
"""
from matte_bench.ranking import separated, standings
from matte_bench.store import Verdict


def class_champion(verdicts: list[Verdict], bucket: str, cls: str) -> str | None:
    rows = standings(verdicts, bucket, cls=cls)
    return rows[0].technique if separated(rows) else None


def playoff_pair(verdicts: list[Verdict], bucket: str) -> tuple[str, str] | None:
    a = class_champion(verdicts, bucket, "A")
    b = class_champion(verdicts, bucket, "B")
    return (a, b) if a is not None and b is not None else None


def derive_cls(left: str, right: str, technique_cls: dict[str, str],
               verdicts: list[Verdict], bucket: str) -> str | None:
    """The server-derived class of a judged pair; None when the pair is not
    a comparison the bench could legally have served."""
    lc, rc = technique_cls.get(left), technique_cls.get(right)
    if lc is None or rc is None:
        return None
    if lc == rc:
        return lc
    pair = playoff_pair(verdicts, bucket)
    if pair is not None and {left, right} == set(pair):
        return "X"
    return None
