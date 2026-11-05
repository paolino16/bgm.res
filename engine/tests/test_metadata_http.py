import json
import threading
import unittest
from unittest.mock import call, patch

import requests

from src.rename import metadata_http as http
from src.rename.get_info import Search


def response(data, status=200, headers=None):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(data).encode()
    result._content_consumed = True
    result.encoding = 'utf-8'
    result.headers.update(headers or {})
    return result


class MetadataTests(unittest.TestCase):
    def setUp(self):
        for replacement in [patch.object(http, '_CACHE', http.ResponseCache()),
                            patch.object(http, '_local', threading.local()),
                            patch('src.rename.get_info.logger')]:
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_cache_reuses_results_and_returns_independent_json(self):
        with patch.object(requests.Session, 'request', return_value=response({'name': 'Series', 'seasons': [1]})) as send:
            first = http.metadata_session().get('https://api.themoviedb.org/3/tv/1', params={'api_key': 'a'})
            first.json()['seasons'].append(2)
            second = http.MetadataSession().get('https://api.themoviedb.org/3/tv/1', params={'api_key': 'a'})
            self.assertEqual(second.json()['seasons'], [1])
            send.assert_called_once()
            self.assertEqual(send.call_args.kwargs['timeout'], http.METADATA_TIMEOUT)
            http.metadata_session().get('https://api.themoviedb.org/3/tv/1', params={'api_key': 'different-key'})
            self.assertEqual(send.call_count, 2)

    def test_transient_failure_retries_only_request_then_caches_success(self):
        with patch.object(requests.Session, 'request', side_effect=[response({}, 503), response({'id': 1})]) as send, \
             patch.object(http.time, 'sleep') as sleep:
            session = http.metadata_session()
            url = 'https://api.bgm.tv/v0/subjects/1'
            self.assertEqual(session.get(url).json(), {'id': 1})
            self.assertEqual(session.get(url).json(), {'id': 1})
            self.assertEqual(send.call_count, 2)
            sleep.assert_called_once_with(.5)

    def test_timeout_is_bounded_not_cached_and_does_not_disclose_key(self):
        with patch.object(requests.Session, 'request', side_effect=requests.Timeout('url?api_key=secret')) as send, \
             patch.object(http.time, 'sleep') as sleep:
            with self.assertRaises(http.MetadataRequestError) as failure:
                http.metadata_session().get('https://api.bgm.tv/v0/subjects/1')
            self.assertNotIn('secret', str(failure.exception))
            self.assertIn('超时', str(failure.exception))
            self.assertEqual(send.call_count, 3)
            self.assertEqual(sleep.call_args_list, [call(.5), call(1.0)])
            send.side_effect = None
            send.return_value = response({'id': 1})
            self.assertEqual(http.metadata_session().get('https://api.bgm.tv/v0/subjects/1').json()['id'], 1)
            self.assertEqual(send.call_count, 4)

    def test_empty_results_and_permanent_errors_do_not_retry(self):
        url = 'https://api.bgm.tv/v0/search/subjects'
        with patch.object(requests.Session, 'request', side_effect=[response({'data': []}), response({}, 401)]) as send, \
             patch.object(http.time, 'sleep') as sleep:
            self.assertEqual(http.metadata_session().post(url, json={'keyword': 'missing'}).json()['data'], [])
            with self.assertRaisesRegex(http.MetadataRequestError, '401'):
                http.metadata_session().post(url, json={'keyword': 'missing'})
            self.assertEqual(send.call_count, 2)
            sleep.assert_not_called()

    def test_long_retry_after_fails_promptly_without_retrying_early(self):
        with patch.object(requests.Session, 'request', return_value=response({}, 429, {'Retry-After': '120'})) as send, \
             patch.object(http.time, 'sleep') as sleep:
            with self.assertRaisesRegex(http.MetadataRequestError, '限流'):
                http.metadata_session().get('https://api.bgm.tv/v0/subjects/1')
            send.assert_called_once()
            sleep.assert_not_called()

    def test_cache_ttl_and_memory_limits(self):
        cache = http.ResponseCache(ttl=10, max_entries=1, max_bytes=100)
        with patch.object(http.time, 'monotonic', return_value=0) as clock:
            cache.put('a', response({'id': 1}))
            cache.put('b', response({'id': 2}))
            self.assertIsNone(cache.get('a'))
            self.assertEqual(cache.get('b').json()['id'], 2)
            clock.return_value = 10
            self.assertIsNone(cache.get('b'))
            self.assertEqual(cache.total_bytes, 0)

    def test_tmdb_detail_and_season_cache_survive_new_search_instances(self):
        import tmdbsimple
        details = {'id': 1, 'name': 'Series', 'seasons': [{'season_number': 1}]}
        season = {'id': 2, 'name': 'Season 1', 'episodes': [{'episode_number': 1}]}
        with patch('src.rename.get_info.cm.get_config', return_value='test-key'), \
             patch.object(tmdbsimple, 'API_KEY', 'test-key'), \
             patch.object(requests.Session, 'request', side_effect=[response(details), response(season)]) as send:
            search = Search()
            name, info = search.get_tv_info_by_id(1)
            self.assertEqual(name, 'Series')
            search.fill_season_info(info)
            self.assertEqual(len(info['seasons'][0]['episodes']), 1)
            name, fresh = Search().get_tv_info_by_id(1)
            self.assertNotIn('episodes', fresh['seasons'][0])
            self.assertNotIn('session', fresh)
            Search().get_season_info(1, 1)
            self.assertEqual(send.call_count, 2)

    def test_missing_seasons_cannot_recursively_repeat_search(self):
        import tmdbsimple
        with patch('src.rename.get_info.cm.get_config', return_value='test-key'), \
             patch.object(tmdbsimple, 'API_KEY', 'test-key'), \
             patch.object(requests.Session, 'request', return_value=response({'id': 1, 'name': 'Series'})) as send:
            self.assertEqual(Search().fill_season_info({'id': 1, 'name': 'Series'}), {'id': 1, 'name': 'Series'})
            send.assert_called_once()

    def test_bangumi_search_year_filter_uses_same_cached_response(self):
        data = {'data': [{'id': 1, 'name': 'Series', 'date': '2025-01-01'}]}
        with patch.object(requests.Session, 'request', return_value=response(data)) as send:
            self.assertEqual(Search().search_bangumi_subjects('Series', 2025)[0]['id'], 1)
            self.assertEqual(Search().search_bangumi_subjects('Series', 0)[0]['id'], 1)
            send.assert_called_once()

    def test_jikan_uses_the_same_timeout_and_cache(self):
        from jikanpy import Jikan
        with patch.object(requests.Session, 'request', return_value=response({'data': [{'mal_id': 1}]})) as send:
            Jikan(session=http.metadata_session()).search('anime', 'Series', page=1)
            Jikan(session=http.metadata_session()).search('anime', 'Series', page=1)
            send.assert_called_once()
            self.assertEqual(send.call_args.kwargs['timeout'], http.METADATA_TIMEOUT)

    def test_ai_client_reuses_connections_with_explicit_timeout_and_retry_limit(self):
        from src.ai import openai_client
        settings = {'ai_enabled': True, 'ai_api_key': 'test-key',
                    'ai_base_url': 'https://example.test/v1', 'ai_auto_save': False}
        openai_client._sdk_client.cache_clear()
        self.addCleanup(openai_client._sdk_client.cache_clear)
        with patch.object(openai_client.cm, 'get_config', side_effect=settings.get), \
             patch.object(openai_client, 'OpenAI') as sdk:
            first = openai_client.OpenAIClient()
            second = openai_client.OpenAIClient()
            self.assertIs(first.client, second.client)
            sdk.assert_called_once()
            kwargs = sdk.call_args.kwargs
            self.assertEqual(kwargs['max_retries'], 1)
            self.assertEqual(kwargs['timeout'].connect, 5)
            self.assertEqual(kwargs['timeout'].read, 120)
            settings['ai_api_key'] = 'changed-key'
            openai_client.OpenAIClient()
            self.assertEqual(sdk.call_count, 2)


if __name__ == '__main__':
    unittest.main()
