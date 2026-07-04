"""Shared runaway-guard for math subprocesses (curate_json / tune_json). A
numerically-degenerate model can drive the kernel into unbounded memory; the
watchdog polls the subprocess tree and hard-kills it the instant resident memory
or wall-clock crosses a cap. Used by both the simulator and tuner runners."""
import asyncio
import sys
import threading

import psutil


class LoopSafeRunner:
    """Make a Subprocess*Runner work on loops that cannot spawn subprocesses.

    Under `uvicorn --reload` on Windows the app runs on a SelectorEventLoop
    (the reloader's listen-socket handoff forces it), and
    asyncio.create_subprocess_exec raises NotImplementedError there — so a
    live-stack Generate/Verify died instantly while the replay stack (no
    --reload) was fine. On such loops this wrapper runs the inner runner's
    whole coroutine on a private ProactorEventLoop in a worker thread and
    marshals the sync progress callback back to the caller's loop; on
    subprocess-capable loops it is a pure passthrough.

    The last positional argument of `run` must be the sync on_progress
    callable — true for both CurationRunner and TunerRunner protocols.
    """

    def __init__(self, inner):
        self._inner = inner

    async def run(self, *args):
        loop = asyncio.get_running_loop()
        if not (sys.platform == "win32"
                and isinstance(loop, asyncio.SelectorEventLoop)):
            return await self._inner.run(*args)

        *head, on_progress = args

        def relay(p):  # called on the worker thread's loop
            loop.call_soon_threadsafe(on_progress, p)

        result: list = []
        error: list[BaseException] = []
        ready = asyncio.Event()

        def worker():
            inner_loop = asyncio.ProactorEventLoop()
            try:
                result.append(
                    inner_loop.run_until_complete(self._inner.run(*head, relay)))
            except BaseException as exc:  # surfaced on the caller's loop below
                error.append(exc)
            finally:
                inner_loop.close()
                loop.call_soon_threadsafe(ready.set)

        threading.Thread(target=worker, daemon=True,
                         name="loop-safe-runner").start()
        await ready.wait()
        if error:
            raise error[0]
        return result[0]


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
