"""Keep blocking rename work off the UI loop and serialize output mutations."""

import asyncio
from pathlib import Path
from typing import Callable

from types import SimpleNamespace

# Keep the shared worker independent of either desktop or NiceGUI lifecycle.
run = SimpleNamespace(io_bound=asyncio.to_thread)

from .process import Rename
from .task_submission import existing_task


_processing_lock = asyncio.Lock()


async def run_serialized(callback: Callable, *args, **kwargs):
    # Retries temporarily alter shared AI settings and may touch the same outputs.
    async with _processing_lock:
        work = asyncio.create_task(run.io_bound(callback, *args, **kwargs))
        try:
            return await asyncio.shield(work)
        except asyncio.CancelledError:
            # Disconnecting a caller cannot stop its worker thread. Keep the
            # output lock until that thread finishes before accepting more work.
            try:
                await work
            finally:
                raise


def _rename(path: Path, is_anime=True, is_movie=None):
    existing = existing_task(path)
    if existing:
        return existing
    # Construction also creates directories and initializes API clients.
    return Rename().process(path, is_anime, is_movie)


async def run_rename(path: Path, is_anime=True, is_movie=None):
    return await run_serialized(_rename, path, is_anime, is_movie)
