import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from src.integration_api import reviewing, preview_only
from src.rename import trans, plan_resolution as plans


class DesktopPreviewTests(unittest.TestCase):
    def test_preview_preserves_source_existing_output_and_record_until_explicit_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source' / 'Show 01.mkv'
            target = root / 'library' / 'Season 1' / 'Show S01E01.mkv'
            source.parent.mkdir(); target.parent.mkdir(parents=True)
            source.write_bytes(b'new-video'); target.write_bytes(b'old-video')
            records = root / 'record'; records.mkdir()
            record = records / 'preview.json'
            old_record = {'entries': {str(source): {'target': str(target)}}}
            record.write_text(json.dumps(old_record), encoding='utf-8')
            tasks=root/'tasks'; tasks.mkdir()
            (tasks/'preview.json').write_text(json.dumps({'uuid':'preview','path':str(source.parent),'name':'Show','layout':'legacy'}),encoding='utf-8')
            with patch.object(trans, 'RECORD_PATH', records), patch.object(plans, 'TASK_PATH', tasks), patch.object(plans, 'PLAN_PATH', root / 'plans'), patch.object(trans.cm, 'get_config', return_value='复制'):
                worker = trans.Trans({source: target}, 'preview', source.parent,
                    plan_context={'work_path': str(target.parent.parent), 'name': 'Show', 'is_movie': False})
                with reviewing():
                    self.assertIn('待审核', worker.trans_file())
                self.assertFalse(preview_only())
                plan = plans.load_plan('preview')
                self.assertEqual(plan['state'], 'pending')
                self.assertEqual(source.read_bytes(), b'new-video')
                self.assertEqual(target.read_bytes(), b'old-video')
                self.assertEqual(json.loads(record.read_text(encoding='utf-8')), old_record)
                checked=plans.check_saved_plan('preview',plan['revision'],plan['rows'])
                self.assertFalse(checked['issues'])
                self.assertEqual(target.read_bytes(),b'old-video')
                self.assertIsNone(plans.execute_saved_plan('preview',plan['revision'],plan['rows'],checked['token']))
                self.assertEqual(target.read_bytes(),b'new-video')
                self.assertEqual(source.read_bytes(),b'new-video')
                self.assertEqual(plans.load_plan('preview')['state'],'completed')

    def test_preview_flag_is_scoped_even_on_error(self):
        self.assertFalse(preview_only())
        with self.assertRaises(RuntimeError):
            with reviewing():
                self.assertTrue(preview_only())
                raise RuntimeError('failure')
        self.assertFalse(preview_only())
