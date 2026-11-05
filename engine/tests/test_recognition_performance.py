import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from src.rename import metadata_http as http, source_scan
from src.rename.get_info import Search
from src.rename.process import Rename


def response(data):
    result = requests.Response()
    result.status_code = 200
    result._content = json.dumps(data).encode()
    result.encoding = 'utf-8'
    return result


class RecognitionPerformanceTests(unittest.TestCase):
    def test_file_title_removes_only_extension_and_version_keeps_title_season_year(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            worker = Rename.__new__(Rename)
            for filename, title in (
                ('[Group] The Ribbon Hero [v2][1080p].mkv', 'The Ribbon Hero'),
                ('[Group] Show S02 [v3][1080p].mp4', 'Show S02'),
                ('[Group] 86 [v2].mkv', '86'),
                ('[Group] Re.Zero [1080p].mkv', 'Re.Zero'),
            ):
                file = root / filename
                file.touch()
                candidates = worker.build_search_candidates(file)
                self.assertIn((title, 0), candidates)
                self.assertTrue(all('.mkv' not in name and '.mp4' not in name and '[v' not in name for name, _ in candidates))

    def test_network_failure_does_not_search_next_title_candidate(self):
        worker = Rename.__new__(Rename)
        worker.search = Search()
        worker.build_search_candidates = Mock(return_value=[('First', 0), ('Second', 0)])
        def fail(*args):
            worker.search.network_error = '[Bangumi] 网络失败'
            return worker.search.network_error
        worker.check_task_type = Mock(side_effect=fail)
        self.assertIn('网络失败', worker.resolve_task_type('id', Path('Show'), True, None))
        worker.check_task_type.assert_called_once()

    def test_interactive_timeout_retries_twice_and_budget_stops_followup_requests(self):
        with patch.object(http, '_CACHE', http.ResponseCache()), \
             patch.object(requests.Session, 'request', side_effect=requests.Timeout) as send, \
             patch.object(http.time, 'sleep'):
            with http.recognition_budget():
                with self.assertRaisesRegex(http.MetadataRequestError, '2 次'):
                    http.MetadataSession().get('https://api.bgm.tv/v0/search/subjects')
            self.assertEqual(send.call_count, 2)
            with http.recognition_budget(seconds=-1):
                with self.assertRaisesRegex(http.MetadataRequestError, '上限'):
                    http.MetadataSession().get('https://api.bgm.tv/v0/search/subjects')
            self.assertEqual(send.call_count, 2)

    def test_persistent_catalog_survives_memory_reset_and_expires_without_stale_fallback(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(http, 'DATA_PATH', Path(folder)), \
             patch.object(http, '_CACHE', http.ResponseCache()), \
             patch.object(requests.Session, 'request', return_value=response({'data': [{'id': 1}]})) as send:
            url = 'https://api.bgm.tv/v0/episodes?subject_id=1&limit=100&offset=0'
            with http.recognition_budget():
                http.MetadataSession().get(url)
            with patch.object(http, '_CACHE', http.ResponseCache()), http.recognition_budget():
                self.assertEqual(http.MetadataSession().get(url).json()['data'][0]['id'], 1)
            self.assertEqual(send.call_count, 1)
            file = next((Path(folder) / 'metadata_cache').glob('*.json'))
            data = json.loads(file.read_text()); data['saved'] = time.time() - http.CACHE_TTL - 1
            file.write_text(json.dumps(data))
            with patch.object(http, '_CACHE', http.ResponseCache()), http.recognition_budget():
                http.MetadataSession().get(url)
            self.assertEqual(send.call_count, 2)

    def test_empty_relations_are_cached_and_authenticated_responses_are_not_persisted(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(http, 'DATA_PATH', Path(folder)), \
             patch.object(http, '_CACHE', http.ResponseCache()), \
             patch.object(requests.Session, 'request', return_value=response([])) as send, http.recognition_budget():
            url = 'https://api.bgm.tv/v0/subjects/1/subjects'
            http.MetadataSession().get(url)
            http.MetadataSession().get(url)
            self.assertEqual(send.call_count, 1)
            http.MetadataSession().get(url, headers={'Authorization': 'Bearer secret'})
            self.assertEqual(len(list((Path(folder) / 'metadata_cache').glob('*.json'))), 1)

    def test_candidate_details_are_concurrent_bounded_and_errors_are_kept(self):
        search = Search()
        lock = threading.Lock()
        active = peak = 0
        def fetch(subject_id):
            nonlocal active, peak
            with lock:
                active += 1; peak = max(active, peak)
            time.sleep(.03)
            with lock:
                active -= 1
            return {'id': subject_id}
        with patch.object(search, 'get_bangumi_subject_by_id', side_effect=fetch):
            self.assertEqual(set(search._subject_details([1, 2, 3, 4, 5])), {1, 2, 3, 4, 5})
        self.assertGreater(peak, 1)
        self.assertLessEqual(peak, 3)

    def test_scans_are_shared_only_within_one_recognition_and_skip_unrelated_subdirs_for_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); video = root / 'Show 01.mkv'; video.touch()
            nested = root / 'deep'; nested.mkdir(); (nested / 'Other.mkv').touch()
            real_scandir = source_scan.os.scandir
            with patch.object(source_scan.os, 'scandir', wraps=real_scandir) as scan:
                self.assertTrue(source_scan.has_video(root))
                self.assertEqual(scan.call_count, 1)
            with source_scan.scan_scope(), patch.object(source_scan.os, 'scandir', wraps=real_scandir) as scan:
                self.assertEqual(source_scan.files_in(root, recursive=False), [video])
                source_scan.files_in(root, recursive=False)
                self.assertEqual(scan.call_count, 1)
            (root / 'Show 02.mkv').touch()
            with source_scan.scan_scope():
                self.assertEqual(len(source_scan.files_in(root, recursive=False)), 2)

    def test_native_metadata_defers_filtered_episode_fetch(self):
        search = Search(); search.defer_episodes = True
        with patch.object(search, 'get_bangumi_subject_by_id', return_value={'id': 1, 'name': 'Show'}), \
             patch.object(search, 'get_bangumi_episodes') as episodes:
            self.assertEqual(search.get_bangumi_info('Show', 0, bgm_id=1)[0], 'Show')
            episodes.assert_not_called()

    def test_candidate_network_error_is_propagated_without_legacy_search(self):
        search = Search()
        def request(endpoint, *args):
            if endpoint.startswith('/v0/search'):
                return {'data': [{'id': 1, 'name': 'Unrelated'}]}
            search.network_error = search.last_error = '[Bangumi] 请求超时'
            return None
        with patch.object(search, '_bangumi_request', side_effect=request) as send:
            self.assertEqual(search.search_bangumi_subjects('Different title'), [])
            self.assertIn('超时', search.network_error)
            self.assertEqual(send.call_count, 2)

    def test_persistent_cache_recovers_from_corruption_and_honors_entry_limit(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(http, 'DATA_PATH', Path(folder)), \
             patch.object(http, '_CACHE', http.ResponseCache()), patch.object(http, 'CACHE_ENTRIES', 1), \
             patch.object(requests.Session, 'request', return_value=response({'id': 1})) as send, http.recognition_budget():
            session = http.MetadataSession()
            session.get('https://api.bgm.tv/v0/subjects/1')
            file = next((Path(folder) / 'metadata_cache').glob('*.json'))
            file.write_text('broken json')
            with patch.object(http, '_CACHE', http.ResponseCache()):
                session.get('https://api.bgm.tv/v0/subjects/1')
                session.get('https://api.bgm.tv/v0/subjects/2')
            self.assertEqual(send.call_count, 3)
            self.assertEqual(len(list((Path(folder) / 'metadata_cache').glob('*.json'))), 1)

    def test_recognition_scan_cache_does_not_hide_new_files_from_execution_check(self):
        from src.rename.preflight import expected_videos
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / 'Show 01.mkv').touch()
            with source_scan.scan_scope():
                self.assertEqual(len(expected_videos(root)), 1)
                (root / 'Show 02.mkv').touch()
                self.assertEqual(len(expected_videos(root)), 1)
            self.assertEqual(len(expected_videos(root)), 2)


if __name__ == '__main__':
    unittest.main()
