import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.rename.identify_missing import apply_report, exact_title, identify


class IdentifyMissingTests(unittest.TestCase):
    def test_punctuation_that_distinguishes_sequels_is_preserved(self):
        self.assertFalse(exact_title('NEW GAME!', 'NEW GAME!!'))
        self.assertTrue(exact_title('LoveLive!', 'LoveLive！'))

    def test_same_title_with_different_dates_is_not_arbitrarily_bound(self):
        search = Mock()
        subjects = [{'id': 1, 'name': 'Show', 'name_cn': 'Show', 'date': '2000-01-01'},
                    {'id': 2, 'name': 'Show', 'name_cn': 'Show', 'date': '2020-01-01'}]
        search.search_bangumi_subjects.return_value = subjects
        search._bangumi_titles.side_effect = lambda subject: [subject['name']]
        search._score_bangumi_subject.return_value = (1,)
        search.get_bangumi_subject_by_id.side_effect = lambda sid: subjects[sid - 1]
        search._extract_bangumi_platform.return_value = 'TV'
        search.last_error = None
        with patch('src.rename.identify_missing.Search', return_value=search):
            result = identify({'uuid': 'a', 'name': 'Show', 'path': 'Show'})
        self.assertEqual(result['status'], 'ambiguous')
        self.assertIsNone(result['selected'])

    def test_oad_source_never_binds_to_exact_tv_title(self):
        search = Mock()
        subject = {'id': 1, 'name': 'Show', 'name_cn': 'Show', 'date': '2000-01-01'}
        search.search_bangumi_subjects.return_value = [subject]
        search._bangumi_titles.return_value = ['Show']
        search._score_bangumi_subject.return_value = (1,)
        search.get_bangumi_subject_by_id.return_value = subject
        search._extract_bangumi_platform.return_value = 'TV'
        search.last_error = None
        with patch('src.rename.identify_missing.Search', return_value=search):
            result = identify({'uuid': 'a', 'name': 'Show', 'path': '[Group] Show OADs'})
        self.assertIsNone(result['selected'])

    def test_apply_updates_only_identity_and_preserves_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'task').mkdir()
            task = {'uuid': 'old', 'name': 'Old name', 'output_dir': 'old/Season 1',
                    'layout': 'legacy', 'error': 'keep error', 'use_ai': True}
            path = root / 'task/old.json'
            raw = json.dumps(task).encode()
            path.write_bytes(raw)
            modified = path.stat().st_mtime_ns
            report_path = root / 'report.json'
            report_path.write_text(json.dumps({'results': [
                {'uuid': 'old', 'old_name': 'Old name', 'status': 'matched', 'name_changed': True,
                 'selected': {'id': 123, 'name': 'Bangumi name'}},
            ]}))
            self.assertEqual(apply_report(root, report_path)['updated'], 1)
            saved = json.loads(path.read_bytes())
            self.assertEqual(saved['bgm_id'], '123')
            for key in ('name', 'output_dir', 'layout', 'error', 'use_ai'):
                self.assertEqual(saved[key], task[key])
            self.assertEqual(path.stat().st_mtime_ns, modified)
            self.assertEqual((root / 'before/old.json').read_bytes(), raw)
            self.assertEqual(apply_report(root, report_path)['updated'], 0)
