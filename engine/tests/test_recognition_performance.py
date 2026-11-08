import json
import os
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
    def test_desktop_pac_route_is_used_for_metadata_but_not_other_hosts(self):
        routes = json.dumps({'api.bgm.tv': 'http://127.0.0.1:7890'})
        with patch.dict(os.environ, {'BGM_METADATA_PROXIES': routes}), \
             patch.object(requests.utils, 'get_environ_proxies', return_value={}), \
             patch.object(http, '_CACHE', http.ResponseCache()), \
             patch.object(requests.Session, 'request', return_value=response({'id': 1})) as send:
            session = http.MetadataSession()
            session.get('https://api.bgm.tv/v0/subjects/1')
            self.assertEqual(send.call_args.kwargs['proxies'], {'https': 'http://127.0.0.1:7890'})
            session.get('https://example.org/')
            self.assertNotIn('proxies', send.call_args.kwargs)

    def test_desktop_pac_preserves_explicit_proxy_env_and_session_settings(self):
        with patch.dict(os.environ, {'BGM_METADATA_PROXIES': '{"api.bgm.tv":"http://desktop:7890"}'}), \
             patch.object(http, '_CACHE', http.ResponseCache()), \
             patch.object(requests.Session, 'request', return_value=response({'id': 1})) as send:
            url = 'https://api.bgm.tv/v0/search/subjects'
            for index, settings in enumerate(({'https': 'http://custom:80'}, {}, None)):
                http.MetadataSession().get(url + f'?explicit={index}', proxies=settings)
                self.assertEqual(send.call_args.kwargs['proxies'], settings)
            with patch.object(requests.utils, 'get_environ_proxies', return_value={'https': 'http://env:80'}):
                http.MetadataSession().get(url + '?env')
                self.assertNotIn('proxies', send.call_args.kwargs)
            with patch.object(requests.utils, 'get_environ_proxies', return_value={}), \
                 patch.object(requests.utils, 'should_bypass_proxies', return_value=True):
                http.MetadataSession().get(url + '?no-proxy')
                self.assertNotIn('proxies', send.call_args.kwargs)
            session = http.MetadataSession()
            session.proxies = {'https': 'http://session:80'}
            session.get(url + '?session')
            self.assertNotIn('proxies', send.call_args.kwargs)

    def test_invalid_desktop_routes_do_not_break_requests(self):
        with patch.object(requests.utils, 'get_environ_proxies', return_value={}), \
             patch.object(http, '_CACHE', http.ResponseCache()), \
             patch.object(requests.Session, 'request', return_value=response({'id': 1})) as send:
            for index, routes in enumerate(('invalid', '[]', 'null', '{"api.bgm.tv":"file:///bad"}')):
                with patch.dict(os.environ, {'BGM_METADATA_PROXIES': routes}):
                    http.MetadataSession().get(f'https://api.bgm.tv/v0/subjects/{index}')
                    self.assertNotIn('proxies', send.call_args.kwargs)

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

    def test_batch_directory_episode_range_is_removed_before_search(self):
        with tempfile.TemporaryDirectory() as folder:
            worker = Rename.__new__(Rename)
            for name, title, year in (
                ('[Kamigami] Mushishi 01-26 [BD x264 1920×1080 AAC(5.1ch) MKV Sub(CH,JP)]', 'Mushishi', 0),
                ('Show S02 01-12 (2020)', 'Show S02', 2020),
                ('86 01-12', '86', 0),
            ):
                source = Path(folder) / name
                source.mkdir()
                self.assertEqual(worker.build_search_candidates(source)[0], (title, year))
                self.assertEqual(worker.build_search_candidates(source, 'Explicit 01-26'), [('Explicit 01-26', 0)])

    def test_multilingual_movie_directory_separates_titles_year_and_platform(self):
        source = Path('[冷番补完字幕组&白恋字幕组][机动战士高达 闪光的哈萨维][機動戦士ガンダム 閃光のハサウェイ]'
                      '[Mobile Suit Gundam Hathaway][2021][Movie][2160p][内封简繁中字]')
        worker = Rename.__new__(Rename)
        self.assertEqual(worker.build_search_candidates(source), [
            ('机动战士高达 闪光的哈萨维', 2021), ('機動戦士ガンダム 閃光のハサウェイ', 2021),
            ('Mobile Suit Gundam Hathaway', 2021)])
        self.assertIn('剧场版', worker.search_folder_context(source)[1])

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
