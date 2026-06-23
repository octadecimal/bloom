import pytest

from app.runs import RunStore, RunStep


@pytest.fixture
def store(mongo_db):  # mongo_db fixture mirrors tests/test_store.py
    return RunStore(mongo_db)


async def test_create_and_get_run(store):
    run = await store.create_run("r1", "generate-sprite", {"description": "knight"})
    assert run.status == "running" and run.room_id == "r1" and run.steps == []
    again = await store.get_run(run.id)
    assert again.skill_name == "generate-sprite"


async def test_append_step_token_and_complete(store):
    run = await store.create_run("r1", "generate-sprite", {})
    await store.append_step(run.id, RunStep(index=0, type="final", content=""))
    await store.append_step_token(run.id, 0, "Hel")
    await store.append_step_token(run.id, 0, "lo")
    await store.complete_step(run.id, 0, "complete")
    done = await store.complete_run(run.id, "completed")
    assert done.status == "completed" and done.completed_at is not None
    assert done.steps[0].content == "Hello" and done.steps[0].status == "complete"


def test_run_step_accepts_approval_type():
    from app.runs import RunStep
    step = RunStep(index=2, type="approval", content="{}", status="running")
    assert step.type == "approval"


async def test_list_runs_returns_room_runs_in_creation_order(store):
    a = await store.create_run("r1", "skill-a", {})
    b = await store.create_run("r1", "skill-b", {})
    await store.create_run("other", "skill-c", {})
    runs = await store.list_runs("r1")
    assert [r.id for r in runs] == [a.id, b.id]
    assert all(r.room_id == "r1" for r in runs)
