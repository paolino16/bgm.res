"""Offline regressions: python -m unittest tests.test_ui_responsiveness -v."""

import asyncio
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from src.rename import runner


class DirectoryTests(unittest.TestCase):
    def test_table_tolerates_in_progress_task_record(self):
        from src.utils import utils

        with tempfile.TemporaryDirectory() as directory, patch.object(utils, 'TASK_PATH', Path(directory)):
            task = Path(directory) / 'sample.json'
            task.write_text('{"name":', encoding='utf-8')
            self.assertEqual(utils.get_task('sample'), {})
            task.write_text('{"name": "sample"}', encoding='utf-8')
            self.assertEqual(utils.get_task('sample')['name'], 'sample')




class RunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.lock_patch = patch.object(runner, '_processing_lock', asyncio.Lock())
        self.io_patch = patch.object(runner.run, 'io_bound', asyncio.to_thread)
        self.lock_patch.start()
        self.io_patch.start()
        self.addCleanup(self.lock_patch.stop)
        self.addCleanup(self.io_patch.stop)

    async def test_slow_work_does_not_block_ui_and_is_serialized(self):
        active = 0
        maximum = 0
        ticks = 0
        main_thread = threading.get_ident()
        started = threading.Event()
        release = threading.Event()

        def slow_work():
            nonlocal active, maximum
            self.assertNotEqual(threading.get_ident(), main_thread)
            active += 1
            maximum = max(maximum, active)
            started.set()
            release.wait(2)
            active -= 1
            return True

        async def heartbeat():
            nonlocal ticks
            await asyncio.to_thread(started.wait, 1)
            try:
                for _ in range(6):
                    await asyncio.sleep(.01)
                    self.assertEqual(active, 1)
                    ticks += 1
            finally:
                release.set()

        await asyncio.gather(runner.run_serialized(slow_work),
                             runner.run_serialized(slow_work), heartbeat())
        self.assertEqual(maximum, 1)
        self.assertEqual(ticks, 6)

    async def test_constructor_runs_on_worker_and_failure_releases_lock(self):
        main_thread = threading.get_ident()

        def fail():
            raise RuntimeError('simulated error')

        with self.assertRaisesRegex(RuntimeError, 'simulated error'):
            await runner.run_serialized(fail)

        def construct():
            self.assertNotEqual(threading.get_ident(), main_thread)
            from types import SimpleNamespace
            return SimpleNamespace(process=lambda *args: True)

        with patch.object(runner, 'Rename', side_effect=construct):
            self.assertTrue(await runner.run_rename(Path('sample')))

    async def test_cancelled_caller_keeps_lock_until_worker_finishes(self):
        started = threading.Event()
        finished = threading.Event()

        def slow_work():
            started.set()
            time.sleep(.08)
            finished.set()

        def next_work():
            self.assertTrue(finished.is_set())
            return True

        first = asyncio.create_task(runner.run_serialized(slow_work))
        await asyncio.to_thread(started.wait, 1)
        first.cancel()
        second = asyncio.create_task(runner.run_serialized(next_work))
        results = await asyncio.gather(first, second, return_exceptions=True)
        self.assertIsInstance(results[0], asyncio.CancelledError)
        self.assertTrue(results[1])






if __name__ == '__main__':
    unittest.main()
