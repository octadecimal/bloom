"""Shared per-asset quality floor: generate -> critique -> bounded regenerate.

Extracted from run_compose's inline asset gate so the compose loop AND the direct
generate path enforce ONE floor. Pure: I/O is behind async callables, so it is
unit-testable without Mongo, sockets, or an LLM. The caller supplies `judge`
(load bytes + critique for an attempt index) and `regenerate`.
"""
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from app.scene.asset_critic import AssetVerdict


@dataclass
class AssetFloorResult:
    verdict: AssetVerdict
    regens_spent: int = 0
    attempts: int = 0
    notes: list[str] = field(default_factory=list)


async def run_asset_floor(
    *,
    judge: Callable[[int], Awaitable[AssetVerdict]],
    regenerate: Callable[[], Awaitable[None]],
    role: str,
    asset_regen_retries: int,
    regen_left: int,
) -> AssetFloorResult:
    result = AssetFloorResult(verdict=await judge(0))
    attempt = 0
    while (result.verdict.action == "regenerate" and regen_left > 0
           and attempt < asset_regen_retries):
        regen_left -= 1
        result.regens_spent += 1
        await regenerate()
        attempt += 1
        result.notes.append(
            f"{role}: {result.verdict.reason} -> regenerated (attempt {attempt})")
        result.verdict = await judge(attempt)

    result.attempts = attempt
    if result.verdict.action == "regenerate":
        cause = "regen budget exhausted" if regen_left <= 0 else "retries exhausted"
        result.notes.append(f"{role}: {result.verdict.reason} (could not fix: {cause}, kept)")
    elif result.verdict.ok:
        result.notes.append(f"{role}: asset ok")
    else:
        result.notes.append(f"{role}: {result.verdict.reason}")
    return result
