from datetime import datetime, timezone
from app.gdd.models import GddDoc, GDD_TAXONOMY, GDD_TOOL_NAMES, gdd_wire


def _doc() -> GddDoc:
    now = datetime(2026, 6, 23, tzinfo=timezone.utc)
    return GddDoc(
        id="d1", game_id="g1", aspect="math-model", title="Math Model",
        order=2, body="RTP 96%", status="drafted", created_at=now, updated_at=now,
    )


def test_taxonomy_is_seven_ordered_aspects():
    aspects = [t["aspect"] for t in GDD_TAXONOMY]
    assert aspects == [
        "theme", "math-model", "symbols-reels", "paytable",
        "bonus-features", "ui-ux", "audio",
    ]
    assert [t["order"] for t in GDD_TAXONOMY] == [1, 2, 3, 4, 5, 6, 7]


def test_gdd_tool_names_cover_the_six_tools():
    assert GDD_TOOL_NAMES == {
        "list_gdd_docs", "read_gdd_doc", "write_gdd_doc",
        "edit_gdd_doc", "set_doc_status", "ask_user_question",
    }


def test_gdd_wire_uses_camelcase_aliases():
    wire = gdd_wire(_doc())
    assert wire["gameId"] == "g1"
    assert wire["aspect"] == "math-model"
    assert wire["status"] == "drafted"
    assert "game_id" not in wire
