"""Shared runaway-guard for math subprocesses (curate_json / tune_json). A
numerically-degenerate model can drive the kernel into unbounded memory; the
watchdog polls the subprocess tree and hard-kills it the instant resident memory
or wall-clock crosses a cap. Used by both the simulator and tuner runners."""
import asyncio

import psutil


def proc_tree_rss_mb(pid: int) -> float:
    """Resident memory of the whole process subtree rooted at `pid`, in MiB. Sums
    parent + all descendants (under `cargo run` the real binary is a grandchild).
    Returns 0.0 if the tree has already gone."""
    try:
        root = psutil.Process(pid)
        procs = [root, *root.children(recursive=True)]
    except psutil.NoSuchProcess:
        return 0.0
    total = 0
    for p in procs:
        try:
            total += p.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return total / (1024 * 1024)


def kill_proc_tree(pid: int) -> None:
    """Hard-kill the subtree rooted at `pid` (descendants first, then the root) so
    a runaway can never outlive the guard or keep eating RAM."""
    try:
        root = psutil.Process(pid)
        procs = [*root.children(recursive=True), root]
    except psutil.NoSuchProcess:
        return
    for p in procs:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(procs, timeout=5)


async def watch_proc_tree(
    proc, done: asyncio.Event, *,
    label: str, mem_cap_mb: float, timeout_s: float, poll_s: float,
) -> str | None:
    """Poll the subprocess tree until `done` is set; hard-kill it and return a
    guard-trip message the instant resident memory or wall-clock crosses a cap.
    Returns None if the process finished on its own. `label` names the operation
    in the message (e.g. "curation", "tuning"). A fast runaway (the kernel can hit
    GBs in a fraction of a second) is caught by the memory cap; the timeout is a
    backstop for a stuck process."""
    loop = asyncio.get_event_loop()
    start = loop.time()
    while not done.is_set():
        try:
            await asyncio.wait_for(done.wait(), timeout=poll_s)
            return None  # process finished on its own
        except asyncio.TimeoutError:
            pass
        rss = proc_tree_rss_mb(proc.pid)
        elapsed = loop.time() - start
        if rss > mem_cap_mb:
            msg = (f"{label} aborted: subprocess memory {rss:.0f}MiB exceeded "
                   f"cap {mem_cap_mb:.0f}MiB (runaway model); process killed")
        elif elapsed > timeout_s:
            msg = (f"{label} aborted: subprocess ran longer than "
                   f"{timeout_s:.0f}s wall-clock; process killed")
        else:
            continue
        kill_proc_tree(proc.pid)
        done.set()
        return msg
    return None
