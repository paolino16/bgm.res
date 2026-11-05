import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

from src.utils.task_identity import task_path_key
from src.utils.task_index import TaskIndex
from src.rename import task_submission, runner, process as process_module
from src.rename.task_submission import ExistingTasks, existing_task


class DuplicateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tasks = self.root / 'tasks'
        self.tasks.mkdir()
        self.source = self.root / 'source' / 'Episode.mkv'
        self.source.parent.mkdir()
        self.source.touch()
        self.patchers = [patch.object(task_submission, 'TASK_PATH', self.tasks),
                         patch.object(process_module, 'TASK_PATH', self.tasks)]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def task(self, uuid, path=None, error=None):
        data = {'uuid': uuid, 'path': str(path or self.source), 'name': 'Example', 'error': error}
        (self.tasks / f'{uuid}.json').write_text(json.dumps(data), encoding='utf-8')
        return data

    def test_history_groups_paths_without_deleting_or_changing_status(self):
        self.task('a')
        self.task('b')
        self.task('c', self.root / 'another' / 'Episode.mkv')
        before = {p.name: p.read_bytes() for p in self.tasks.iterdir()}
        snapshot = TaskIndex(self.tasks).refresh()
        self.assertEqual(snapshot.duplicates, 1)
        self.assertEqual(snapshot.successful, 3)
        self.assertEqual(snapshot.failed, 0)
        group = [row for row in snapshot.rows if row['duplicate_count']]
        self.assertEqual(len(group), 2)
        self.assertEqual(set(group[0]['duplicate_task_ids']), {'a', 'b'})
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.tasks.iterdir()})

    def test_windows_case_slashes_and_dot_segments(self):
        if os.name != 'nt':
            self.skipTest('Windows identity')
        alternative = str(self.source).upper().replace('\\', '/')
        self.assertEqual(task_path_key(self.source), task_path_key(alternative))
        self.assertEqual(task_path_key(self.source.parent / '..' / 'source' / self.source.name), task_path_key(self.source))
        self.task('a')
        self.task('b', alternative)
        self.assertEqual(TaskIndex(self.tasks).refresh().duplicates, 1)

    def test_failed_existing_task_is_reused_with_retry_guidance(self):
        self.task('failed', error='conflict')
        result = existing_task(self.source)
        self.assertIsInstance(result, ExistingTasks)
        self.assertTrue(result.tasks[0]['has_error'])
        self.assertIn('重试', result.message)
        self.assertEqual(len(list(self.tasks.iterdir())), 1)

    def test_completed_record_is_preferred_over_failed_record(self):
        self.task('complete')
        self.task('failed', error='failed')
        self.assertEqual(existing_task(self.source).tasks[0]['uuid'], 'complete')

    def test_split_bangumi_subjects_at_same_path_are_not_duplicates(self):
        first = self.task('first')
        second = self.task('second')
        for task, subject in ((first, '101'), (second, '202')):
            task.update(layout='bangumi', subject_id=subject, bgm_id=subject)
            (self.tasks / f'{task["uuid"]}.json').write_text(json.dumps(task), encoding='utf-8')
        snapshot = TaskIndex(self.tasks).refresh()
        self.assertEqual(snapshot.duplicates, 0)
        self.assertTrue(all(row['duplicate_count'] == 0 for row in snapshot.rows))
        self.assertEqual({row['uuid'] for row in existing_task(self.source).tasks}, {'first', 'second'})

    def test_public_and_nested_process_skip_recognition_but_explicit_retry_bypasses(self):
        self.task('original')
        rename = process_module.Rename.__new__(process_module.Rename)
        rename._contains_video_files = Mock(return_value=True)
        self.assertIsInstance(rename.process(self.source), ExistingTasks)
        rename._contains_video_files.assert_not_called()
        self.assertIsInstance(rename._process(self.source), ExistingTasks)
        rename._process = Mock(return_value=True)
        self.assertTrue(rename.process(self.source, _tuuid='original'))
        rename._process.assert_called_once()



class DuplicateAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_queued_duplicate_submissions_create_only_one_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = root / 'tasks'
            tasks.mkdir()
            source = root / 'Episode.mkv'
            source.touch()

            def process(path, *_):
                (tasks / 'original.json').write_text(json.dumps({'uuid': 'original', 'path': str(path)}), encoding='utf-8')
                return True

            with patch.object(task_submission, 'TASK_PATH', tasks), \
                 patch.object(runner, '_processing_lock', asyncio.Lock()), \
                 patch.object(runner.run, 'io_bound', asyncio.to_thread), \
                 patch.object(runner, 'Rename', return_value=SimpleNamespace(process=process)) as constructor:
                results = await asyncio.gather(runner.run_rename(source), runner.run_rename(source))
            self.assertIs(results[0], True)
            self.assertIsInstance(results[1], ExistingTasks)
            self.assertEqual(constructor.call_count, 1)
            self.assertEqual(len(list(tasks.iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
