import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from src.utils.task_index import TaskIndex, TaskSnapshot


class TaskIndexTests(unittest.TestCase):
    def test_platform_column_uses_saved_bangumi_category_without_guessing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, platform in enumerate(['TV', '剧场版', 'WEB', 'OVA', 'OAD', '']):
                (root / f'{index}.json').write_text(json.dumps(
                    {'platform': platform, 'is_movie': True, 'name': 'OVA title'}), encoding='utf-8')
            rows = TaskIndex(root).refresh().rows
            self.assertEqual({row['platform'] for row in rows}, {'TV', '剧场版', 'WEB', 'OVA', 'OAD', '—'})

    def test_unchanged_tasks_are_not_read_again_and_changes_are_incremental(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'a.json').write_text(json.dumps({'name': 'A'}), encoding='utf-8')
            (root / 'b.json').write_text(json.dumps({'name': 'B'}), encoding='utf-8')
            index = TaskIndex(root)
            original = Path.read_text
            reads = []

            def read(path, **kwargs):
                reads.append(path.name)
                return original(path, **kwargs)

            with patch.object(Path, 'read_text', read):
                self.assertEqual(len(index.refresh().rows), 2)
                self.assertEqual(len(reads), 2)
                index.refresh()
                self.assertEqual(len(reads), 2)
                (root / 'a.json').write_text(json.dumps({'name': 'A updated', 'error': 'failed'}), encoding='utf-8')
                updated = index.refresh()
                self.assertEqual(sorted(reads[:2]), ['a.json', 'b.json'])
                self.assertEqual(reads[2:], ['a.json'])
                self.assertEqual(updated.failed, 1)
                (root / 'b.json').unlink()
                self.assertEqual(len(index.refresh().rows), 1)
                self.assertEqual(len(reads), 3)

    def test_in_progress_writes_keep_last_good_record_then_recover(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = root / 'a.json'
            task.write_text('{"name":"Original"}', encoding='utf-8')
            index = TaskIndex(root)
            self.assertEqual(index.refresh().rows[0]['name'], 'Original')
            task.write_text('{"name":', encoding='utf-8')
            self.assertEqual(index.refresh().rows[0]['name'], 'Original')
            task.write_text('{"name":"Repaired"}', encoding='utf-8')
            self.assertEqual(index.refresh().rows[0]['name'], 'Repaired')




if __name__ == '__main__':
    unittest.main()
