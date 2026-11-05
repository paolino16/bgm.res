"""Offline plan validation and no-side-effects regressions."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.rename.preflight import inspect_plan, expected_videos, format_report
from src.rename import trans, reprocess
from src.rename.process import Rename
from src.rename import process as process_module


class PreflightTests(unittest.TestCase):
    def setUp(self):
        log_patch = patch.object(trans, 'logger')
        log_patch.start()
        self.addCleanup(log_patch.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        from src.rename import plan_resolution
        plans_patch = patch.object(plan_resolution, 'PLAN_PATH', self.root / 'plans')
        plans_patch.start()
        self.addCleanup(plans_patch.stop)
        self.a = self.root / '01.mkv'
        self.b = self.root / '02.MKV'
        self.a.write_bytes(b'first')
        self.b.write_bytes(b'second')
        self.target = self.root / 'output' / 'S01E01.mkv'

    def test_reports_every_source_in_duplicate_and_missing_mapping(self):
        missing = self.root / '03.mkv'
        missing.touch()
        issues = inspect_plan({self.a: self.target, self.b: self.target}, set(), '复制',
                              videos=expected_videos(self.root))
        report = format_report(issues)
        self.assertEqual(len(issues), 2)
        for path in (self.a, self.b, missing, self.target):
            self.assertIn(str(path), report)
        self.assertFalse(self.target.parent.exists())

    def test_occupied_target_missing_source_and_parent_file_all_reported(self):
        self.target.parent.mkdir()
        self.target.touch()
        missing = self.root / 'gone.mkv'
        issues = inspect_plan({self.a: self.target, missing: self.b / 'bad.mkv'}, set(), '复制')
        self.assertEqual(len(issues), 3)
        self.assertIn('目标父路径', format_report(issues))

    def test_source_overlap_and_historical_source_are_blocked(self):
        report = format_report(inspect_plan({self.a: self.b, self.b: self.target}, {self.a}, '复制'))
        self.assertIn('源文件属于将被清理', report)
        self.assertIn('源文件重叠', report)

    def test_planned_parent_and_mirror_conflicts(self):
        issues = inspect_plan({self.a: self.target, self.b: self.target / 'child.mkv'},
                              set(), '链接', mirrors=[(self.b, self.target)])
        report = format_report(issues)
        self.assertIn('多个文件映射', report)
        self.assertIn('父目录同时被规划为文件', report)

    def test_windows_case_insensitive_targets(self):
        if os.name != 'nt':
            self.skipTest('Windows path semantics')
        issues = inspect_plan({self.a: self.target, self.b: Path(str(self.target).upper())}, set(), '复制')
        self.assertIn('多个文件映射', format_report(issues))

    def test_reusable_hardlink_and_previous_target_are_allowed(self):
        self.target.parent.mkdir()
        os.link(self.a, self.target)
        with patch.object(trans.cm, 'get_config', return_value='链接'):
            worker = trans.Trans({self.a: self.target}, 'test')
        self.assertEqual(worker.preflight(set()), [])
        self.assertEqual(inspect_plan({self.b: self.target}, {self.target}, '复制'), [])

    def test_failed_preflight_does_not_cleanup_write_or_transfer(self):
        record = self.root / 'task.json'
        old = self.root / 'old.mkv'
        old.write_bytes(b'keep')
        payload = {'status': 'completed', 'entries': {str(self.a): {'target': str(old)}}}
        record.write_text(json.dumps(payload), encoding='utf-8')
        original = record.read_bytes()
        with patch.object(trans, 'RECORD_PATH', self.root), \
             patch.object(trans.cm, 'get_config', return_value='剪切'), \
             patch.object(trans.shutil, 'move') as move:
            result = trans.Trans({self.a: self.target, self.b: self.target}, 'task', self.root).trans_file()
        self.assertIn('执行前检查未通过', result)
        move.assert_not_called()
        self.assertEqual(record.read_bytes(), original)
        self.assertEqual(old.read_bytes(), b'keep')
        self.assertTrue(self.a.exists())
        self.assertFalse(self.target.parent.exists())

    def test_clean_plan_copies_and_records_success(self):
        with patch.object(trans, 'RECORD_PATH', self.root), \
             patch.object(trans.cm, 'get_config', return_value='复制'):
            result = trans.Trans({self.a: self.target}, 'task', self.a).trans_file()
        self.assertIsNone(result)
        self.assertEqual(self.target.read_bytes(), self.a.read_bytes())
        self.assertEqual(json.loads((self.root / 'task.json').read_text())['status'], 'completed')

    def test_retry_recognition_failure_keeps_existing_outputs(self):
        self.target.parent.mkdir()
        self.target.write_bytes(b'keep')
        task = {'uuid': 'task', 'path': str(self.a), 'output_dir': str(self.target.parent), 'use_ai': True}
        with patch.object(reprocess, 'Rename') as rename:
            rename.return_value.process.return_value = '识别失败'
            result = reprocess.reprocess_task(task)
        self.assertEqual(result, '识别失败')
        self.assertEqual(self.target.read_bytes(), b'keep')

    def test_public_process_propagates_failures_for_file_and_folder(self):
        rename = Rename.__new__(Rename)
        rename._contains_video_files = Mock(return_value=True)
        rename._process = Mock(return_value='执行前检查未通过')
        self.assertEqual(rename.process(self.a), '执行前检查未通过')
        self.assertEqual(rename.process(self.root), '执行前检查未通过')
        nested = self.root / 'nested'
        nested.mkdir()
        (nested / 'season').mkdir()
        self.assertEqual(rename.process(nested), '执行前检查未通过')

    def test_real_process_persists_complete_report_without_media_changes(self):
        rename = Rename.__new__(Rename)
        rename.R = {}
        rename.ANIME_PATH = rename.BANGUMI_PATH = self.root / 'library'
        rename.ai_processor = Mock()
        rename.ai_processor.ai_client.is_available.return_value = False

        def plan(*args):
            rename.R = {self.a: self.target, self.b: self.target}

        rename._process_traditional = Mock(side_effect=plan)
        tasks = self.root / 'tasks'
        tasks.mkdir()
        with patch.object(process_module, 'TASK_PATH', tasks), \
             patch.object(process_module, 'logger'), \
             patch.object(trans, 'RECORD_PATH', tasks), \
             patch.object(trans.cm, 'get_config', return_value='复制'):
            result = rename.process(self.root, False, False, 'task', 'Example', 1,
                                    'Group', '2020', skip_search=True)
        self.assertIn('多个文件映射', result)
        task = json.loads((tasks / 'task.json').read_text(encoding='utf-8'))
        self.assertEqual(task['error'], result)
        self.assertIn(str(self.a), task['error'])
        self.assertIn(str(self.b), task['error'])
        self.assertTrue(self.a.exists())
        self.assertFalse(self.target.exists())


if __name__ == '__main__':
    unittest.main()
