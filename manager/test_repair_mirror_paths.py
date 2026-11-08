import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mirror_repair', Path(__file__).with_name('repair-mirror-paths.py'))
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class MirrorRepairTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data, self.run = self.root / 'data', self.root / 'run'
        self.old, self.new, self.target = (self.root / name for name in ('old.mkv', 'new.mkv', 'output.mkv'))
        self.old.write_bytes(b'unchanged video content')
        os.symlink(self.old, self.target)
        self.record = self.data / 'record' / 'one.json'
        repair.write(self.record, {'entries': {'missing-original.mkv': {'target': str(self.target), 'mirror': str(self.old)}}})
        self.before = self.record.read_bytes()
        self.journal = {'state': 'prepared', 'data': str(self.data), 'issues': [], 'mirrors_checked': 1,
                        'operations': [{'target': str(self.target), 'old': str(self.old), 'new': str(self.new),
                                        'identity': repair.identity(self.old), 'link': os.readlink(self.target)}],
                        'records': {'one.json': {'sha256': repair.hashlib.sha256(self.before).hexdigest(),
                                                'changes': [{'source': 'missing-original.mkv', 'old': str(self.old), 'new': str(self.new)}]}}}
        repair.write(self.run / 'journal.json', self.journal)

    def test_repairs_without_original_and_rolls_back_exact_records(self):
        self.assertEqual(repair.apply(self.run)['state'], 'completed')
        self.assertEqual(repair.key(os.readlink(self.target)), repair.key(self.new))
        self.assertTrue(os.path.samefile(self.new, self.old))
        self.assertEqual(self.target.read_bytes(), b'unchanged video content')
        self.assertEqual(json.loads(self.record.read_bytes())['entries']['missing-original.mkv']['mirror'], str(self.new))
        repair.rollback(self.run)
        self.assertEqual(repair.key(os.readlink(self.target)), repair.key(self.old))
        self.assertEqual(self.record.read_bytes(), self.before)

    def test_collision_never_overwrites_other_content(self):
        self.new.write_bytes(b'other content')
        with self.assertRaisesRegex(ValueError, '路径冲突'):
            repair.apply(self.run)
        self.assertEqual(self.new.read_bytes(), b'other content')
        self.assertEqual(repair.key(os.readlink(self.target)), repair.key(self.old))

    def test_concurrent_record_change_is_preserved(self):
        self.record.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '记录已变化'):
            repair.apply(self.run)
        self.assertEqual(repair.key(os.readlink(self.target)), repair.key(self.old))

    def test_failure_after_link_switch_can_be_rolled_back(self):
        original = repair.replace_link
        def fail_after_switch(*args):
            original(*args)
            raise OSError('simulated interruption')
        with patch.object(repair, 'replace_link', side_effect=fail_after_switch):
            with self.assertRaisesRegex(OSError, 'simulated interruption'):
                repair.apply(self.run)
        self.assertEqual(repair.read(self.run / 'journal.json')['state'], 'interrupted')
        repair.rollback(self.run)
        self.assertEqual(repair.key(os.readlink(self.target)), repair.key(self.old))
        self.assertEqual(self.record.read_bytes(), self.before)


if __name__ == '__main__':
    unittest.main()
