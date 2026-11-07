import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src import integration_api as api
from src.rename import review_rollback


class TaskSummaryTests(unittest.TestCase):
    def test_summary_preserves_edit_fields_status_and_full_detail_api(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            tasks = root / 'task'
            tasks.mkdir()
            plans = root / 'rename_plans'
            plans.mkdir()
            task = {'uuid': 'one', 'name': 'Example', 'bgm_id': '42',
                    'subject_ids': ['42', '43'], 'use_ai': False,
                    'bangumi_candidates': [{'id': 42, 'name': 'Example'}],
                    'episode_bindings': {'1': {'path': 'large-detail.mkv'}},
                    'relations': ['detail'], 'file_plan_context': {'name': 'detail'}}
            (tasks / 'one.json').write_text(json.dumps(task), encoding='utf-8')
            (plans / 'one.json').write_text('{"state":"pending"}', encoding='utf-8')
            with patch.object(api, 'DATA_PATH', root), patch.object(api, 'TASK_PATH', tasks), \
                 patch.object(review_rollback, 'DATA_PATH', root), \
                 patch.object(review_rollback, 'TASK_PATH', tasks):
                app = FastAPI()
                api.register(app)
                headers = {'x-bgm-token': json.loads((root / 'desktop-api.json').read_text())['token']}
                with TestClient(app) as client:
                    self.assertEqual(client.get('/integration/v1/tasks?summary=true').status_code, 403)
                    summary = client.get('/integration/v1/tasks?summary=true', headers=headers).json()['tasks'][0]
                    full = client.get('/integration/v1/tasks', headers=headers).json()['tasks'][0]
                for key in api.TASK_SUMMARY_FIELDS:
                    self.assertEqual(summary.get(key), full.get(key), key)
                self.assertEqual(summary['subject_id'], '42')
                self.assertEqual(summary['plan_state'], 'pending')
                self.assertFalse(summary['can_cancel_review'])
                self.assertFalse(summary['rollback_blocked'])
                for key in ('episode_bindings', 'relations', 'file_plan_context', 'migration'):
                    self.assertNotIn(key, summary)
                    self.assertIn(key, full)
                self.assertEqual(api.read_task('one')['episode_bindings'], task['episode_bindings'])
