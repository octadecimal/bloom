import uuid
from datetime import datetime, timezone
from typing import Literal

from app.models import _WireModel


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RunStep(_WireModel):
    index: int
    type: Literal["thinking", "tool_call", "tool_result", "final", "approval"]
    tool_name: str | None = None
    content: str = ""
    status: Literal["running", "complete", "error"] = "running"


class Run(_WireModel):
    id: str
    room_id: str
    skill_name: str
    args: dict
    status: Literal["running", "completed", "error"] = "running"
    steps: list[RunStep] = []
    created_at: datetime
    completed_at: datetime | None = None


def run_wire(run: Run) -> dict:
    return run.model_dump(by_alias=True, mode="json")


def _from_doc(doc: dict) -> Run:
    return Run(
        id=doc["_id"],
        room_id=doc["room_id"],
        skill_name=doc["skill_name"],
        args=doc.get("args", {}),
        status=doc["status"],
        steps=[RunStep(**s) for s in doc.get("steps", [])],
        created_at=doc["created_at"],
        completed_at=doc.get("completed_at"),
    )


class RunStore:
    def __init__(self, db):
        self._runs = db["runs"]

    async def create_run(self, room_id: str, skill_name: str, args: dict) -> Run:
        doc = {
            "_id": str(uuid.uuid4()),
            "room_id": room_id,
            "skill_name": skill_name,
            "args": args,
            "status": "running",
            "steps": [],
            "created_at": _now(),
            "completed_at": None,
        }
        await self._runs.insert_one(doc)
        return _from_doc(doc)

    async def get_run(self, run_id: str) -> Run | None:
        doc = await self._runs.find_one({"_id": run_id})
        return _from_doc(doc) if doc else None

    async def append_step(self, run_id: str, step: RunStep) -> Run:
        await self._runs.update_one(
            {"_id": run_id}, {"$push": {"steps": step.model_dump()}}
        )
        return await self.get_run(run_id)

    async def append_step_token(self, run_id: str, index: int, delta: str) -> None:
        run = await self.get_run(run_id)
        content = run.steps[index].content + delta
        await self._runs.update_one(
            {"_id": run_id}, {"$set": {f"steps.{index}.content": content}}
        )

    async def complete_step(self, run_id, index, status, content=None) -> None:
        update = {f"steps.{index}.status": status}
        if content is not None:
            update[f"steps.{index}.content"] = content
        await self._runs.update_one({"_id": run_id}, {"$set": update})

    async def complete_run(self, run_id: str, status: str) -> Run:
        await self._runs.update_one(
            {"_id": run_id},
            {"$set": {"status": status, "completed_at": _now()}},
        )
        return await self.get_run(run_id)

    async def list_runs(self, room_id: str) -> list[Run]:
        cursor = self._runs.find({"room_id": room_id}).sort("created_at", 1)
        return [_from_doc(doc) async for doc in cursor]
