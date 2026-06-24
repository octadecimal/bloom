from app.gdd.schemas import Field, Column
from app.gdd.normalize import normalize_value

PERCENT = Field("rtp", "RTP", "percent", "param")
RATIO = Field("bonus_hit_rate", "Bonus hit rate", "ratio", "param")
NUMBER = Field("max_win", "Max win", "number", "param")
ENUM = Field("volatility", "Volatility", "enum", "param",
             enum=("low", "medium", "medium-high", "high"))
TABLE = Field("payouts", "Payouts", "table", "param",
              columns=(Column("symbol", "Symbol"), Column("5oak", "5 OAK")))
LIST = Field("sfx", "SFX", "list", "param")
TEXT = Field("name", "Name", "text", "param")


def test_percent_accepts_percent_string_decimal_and_whole():
    assert normalize_value(PERCENT, "96%") == (0.96, None)
    assert normalize_value(PERCENT, "0.96") == (0.96, None)
    assert normalize_value(PERCENT, 96) == (0.96, None)
    assert normalize_value(PERCENT, 0.96) == (0.96, None)


def test_percent_bad_input_warns_not_raises():
    value, warn = normalize_value(PERCENT, "lots")
    assert value == "lots" and warn is not None


def test_ratio_canonicalizes_to_one_in_n():
    assert normalize_value(RATIO, "1:200") == ("1:200", None)
    assert normalize_value(RATIO, "1 in 200") == ("1:200", None)
    assert normalize_value(RATIO, 200) == ("1:200", None)
    assert normalize_value(RATIO, 0.005) == ("1:200", None)


def test_number_strips_suffix():
    assert normalize_value(NUMBER, "5000x") == (5000.0, None)
    assert normalize_value(NUMBER, 5000) == (5000.0, None)


def test_enum_normalizes_case_and_warns_on_unknown():
    assert normalize_value(ENUM, "High") == ("high", None)
    value, warn = normalize_value(ENUM, "spicy")
    assert value == "spicy" and warn is not None


def test_table_coerces_rows_and_warns_on_missing_columns():
    rows = [{"symbol": "Wild", "5oak": 500}, {"symbol": "Seven"}]
    value, warn = normalize_value(TABLE, rows)
    assert value == [{"symbol": "Wild", "5oak": 500}, {"symbol": "Seven", "5oak": ""}]
    assert warn is not None  # row 1 missing 5oak
    bad, bad_warn = normalize_value(TABLE, "not a list")
    assert bad == "not a list" and bad_warn is not None


def test_list_wraps_scalar_and_passes_list():
    assert normalize_value(LIST, ["a", "b"]) == (["a", "b"], None)
    assert normalize_value(LIST, "solo") == (["solo"], None)


def test_text_passthrough():
    assert normalize_value(TEXT, "Neon Nights") == ("Neon Nights", None)
