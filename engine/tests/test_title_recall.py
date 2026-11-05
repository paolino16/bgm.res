import tempfile
import json
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

from src.rename.get_info import Search
from src.rename import title_cache
from src.rename.process import Rename


class RecallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = patch.object(title_cache, 'DATA_PATH', Path(self.temp.name))
        self.cache.start()
        self.addCleanup(self.cache.stop)
        self.search = Search()

    def entry(self, title='Minami-ke', japanese='みなみけ', date='2007-10-08', type='TV'):
        return {'mal_id': 2963, 'title': title, 'title_japanese': japanese,
                'type': type, 'aired': {'from': date}}

    def test_tenrai_recalls_missing_subject_and_keeps_wrong_candidates(self):
        correct = {'id': 283, 'name': 'みなみけ', 'name_cn': '南家三姐妹', 'date': '2007-10-07', 'platform': 'TV'}
        wrong = {'id': 314426, 'name': 'それいけ! アンパンマン みなみの海をすくえ!', 'name_cn': '面包超人'}
        def request(endpoint, method=None, payload=None):
            if endpoint.startswith('/v0/search/'):
                return {'data': [correct] if payload['keyword'] == 'みなみけ' else [wrong]}
            if endpoint.startswith('/search/'):
                return {'list': []}
            return correct if endpoint.endswith('/283') else wrong
        with patch.object(self.search, '_tenrai_request', return_value=[self.entry()]), \
             patch.object(self.search, '_bangumi_request', side_effect=request), \
             patch.object(self.search, 'get_bangumi_episodes', return_value=[]):
            _, info = self.search.get_bangumi_info('Minami-ke', 0)
        self.assertEqual(info['id'], 283)
        self.assertEqual({c['id'] for c in self.search.last_bangumi_candidates}, {283, 314426})
        self.assertTrue(self.search.last_bangumi_candidates[0]['recall_evidence'][0]['verified'])
        self.assertEqual(title_cache.read('mapping', 283, 30 * 86400)['aliases'], ['Minami-ke'])

    def test_script_style_scoring_adopts_titles_without_exact_date_or_type(self):
        for date, platform in [('2009-01-01', 'TV'), ('2007-10-07', 'OVA'), ('', 'TV')]:
            with self.subTest(date=date, platform=platform), \
                 patch.object(self.search, '_tenrai_request', return_value=[self.entry()]), \
                 patch.object(self.search, '_bangumi_request', return_value={'data': [
                     {'id': 283, 'name': 'みなみけ', 'date': date, 'platform': platform}]}):
                result = self.search._tenrai_recall('Minami-ke', 0)
                self.assertTrue(result[0]['recall_evidence'][0]['verified'])
                self.assertIn('Minami-ke', result[0]['aliases'])
                self.assertNotIn('confident', result[0]['recall_evidence'][0])

    def test_nichijou_repeated_prefix_matches_script_phrases(self):
        from src.rename.title_evidence import match_entries, reading
        subject = {'name': '日常 日常の0話', 'date': '2011-03-12', 'platform': 'OVA'}
        entry = self.entry('Nichijou: Nichijou no 0-wa', '日常の０話', '2011-03-12', 'OVA')
        self.assertGreaterEqual(match_entries(subject, [entry])[0][1], 7.5)
        self.assertEqual(reading('みなみけ おかえり'), 'minamike okaeri')

    def test_adoption_and_retry_thresholds_are_independent(self):
        entry = self.entry()
        subject = {'id': 283, 'name': 'みなみけ', 'date': '2007-10-07', 'platform': 'TV'}
        for score in (0, .7, 2.49, 2.5, 6.5, 7.5, 9.5):
            with self.subTest(score=score), \
                 patch.object(self.search, '_tenrai_request', return_value=[entry]) as fetch, \
                 patch.object(self.search, '_bangumi_request', return_value={'data': [subject]}), \
                 patch('src.rename.get_info.match_entries', return_value=[(entry, score)]):
                result = self.search._tenrai_recall('Minami-ke', 0)
                self.assertEqual(bool(result), score >= 2.5)
                self.assertEqual(fetch.call_count, 2 if 2.5 <= score < 7.5 else 1)
                if result:
                    self.assertEqual(result[0]['recall_evidence'][0]['match_score'], score)

    def test_native_retry_can_improve_adopted_mapping(self):
        seed = self.entry(date='2009-01-01')
        better = {**self.entry(), 'mal_id': 999}
        subject = {'id': 283, 'name': 'みなみけ', 'date': '2007-10-07', 'platform': 'TV'}
        with patch.object(self.search, '_tenrai_request', side_effect=lambda q: [seed] if q == 'Minami-ke' else [better]), \
             patch.object(self.search, '_bangumi_request', return_value={'data': [subject]}):
            result = self.search._tenrai_recall('Minami-ke', 0)
        self.assertEqual(result[0]['recall_evidence'][0]['mal_id'], 999)
        self.assertEqual(result[0]['recall_evidence'][0]['match_score'], 9.5)

    def test_repeated_queries_do_not_duplicate_subject_or_evidence(self):
        entry = self.entry()
        subject = {'id': 283, 'name': 'みなみけ', 'date': '2007-10-07', 'platform': 'TV'}
        entries = [entry, {**entry, 'mal_id': 999}, {**entry, 'mal_id': 1000}]
        with patch.object(self.search, '_tenrai_request', return_value=entries), \
             patch.object(self.search, '_bangumi_request', return_value={'data': [subject]}):
            result = self.search._tenrai_recall('Minami-ke', 0)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0]['recall_evidence']), 1)

    def test_historical_evidence_is_filtered_without_rewriting_task(self):
        from src import integration_api
        root = Path(self.temp.name)
        accepted = {'source': 'tenrai', 'mal_id': 3468, 'title': 'Maria-sama ga Miteru Specials', 'verified': True, 'match_score': 6.5}
        task = {'uuid': 'test', 'path': 'source', 'bangumi_candidates': [{'id': 107917, 'recall_evidence': [
            {'source': 'tenrai', 'mal_id': 2954, 'verified': False, 'match_score': .7}, accepted, accepted]},
            {'id': 84801, 'recall_evidence': [{'source': 'tenrai', 'mal_id': 2954, 'verified': False, 'match_score': .7}]}]}
        file = root / 'test.json'
        file.write_text(json.dumps(task), encoding='utf-8')
        before = file.read_bytes()
        with patch.object(integration_api, 'TASK_PATH', root):
            result = integration_api.read_task('test')
        self.assertEqual(result['bangumi_candidates'][0]['recall_evidence'], [accepted])
        self.assertEqual(len(result['bangumi_candidates']), 1)
        self.assertEqual(file.read_bytes(), before)

    def test_adopted_alias_below_retry_threshold_is_not_rejected(self):
        subject = {'id': 283, 'name': 'みなみけ', 'aliases': ['Minami-ke'],
                   'recall_evidence': [{'source': 'tenrai', 'title': 'Minami-ke', 'verified': True, 'match_score': 6.5}]}
        with patch.object(self.search, 'search_bangumi_subjects', return_value=[subject]), \
             patch.object(self.search, 'get_bangumi_subject_by_id', return_value=subject), \
             patch.object(self.search, 'get_bangumi_episodes', return_value=[]):
            self.assertEqual(self.search.get_bangumi_info('Minami-ke', 0)[1]['id'], 283)

    def test_strong_mapping_ranks_above_weak_alias_and_native_title_still_confirms(self):
        good = {'id': 283, 'name': 'みなみけ', 'aliases': ['Minami-ke'],
                'recall_evidence': [{'source': 'tenrai', 'title': 'Minami-ke', 'verified': True, 'match_score': 9.5}]}
        weak = {'id': 9, 'name': '別作品', 'aliases': ['Minami-ke'],
                'recall_evidence': [{'source': 'tenrai', 'title': 'Minami-ke', 'verified': True, 'match_score': 2.5}]}
        self.assertGreater(self.search._score_bangumi_subject(good, 'Minami-ke', 0),
                           self.search._score_bangumi_subject(weak, 'Minami-ke', 0))
        with patch.object(self.search, 'search_bangumi_subjects', return_value=[good]), \
             patch.object(self.search, 'get_bangumi_subject_by_id', return_value=good), \
             patch.object(self.search, 'get_bangumi_episodes', return_value=[]):
            self.assertEqual(self.search.get_bangumi_info('みなみけ', 0)[1]['id'], 283)

    def test_partial_ambiguous_and_special_only_matches_require_selection(self):
        for query, subjects in [
            ('Minami-ke', [{'id': 1, 'name': 'Minami-ke Okaeri'}]),
            ('Minami-ke', [{'id': 1, 'name': 'Minami-ke'}, {'id': 2, 'name': 'Minami-ke'}]),
            ('Nichijou OAD', [{'id': 1, 'name': 'Nichijou'}]),
        ]:
            with self.subTest(query=query), patch.object(self.search, 'search_bangumi_subjects', return_value=subjects):
                self.search.last_error = None
                self.assertEqual(self.search.get_bangumi_info(query, 0), ('', None))
                self.assertIn('编辑任务', self.search.last_error)

    def test_all_candidates_preserved_and_ids_deduplicated(self):
        self.search._remember_bangumi_candidates([{'id': i, 'name': str(i)} for i in range(1, 40)])
        self.search._remember_bangumi_candidates([{'id': 30, 'name': 'updated'}])
        self.assertEqual(len(self.search.last_bangumi_candidates), 39)
        self.assertEqual(self.search.last_bangumi_candidates[0]['name'], 'updated')

    def test_punctuation_distinguishes_original_sequel_title(self):
        first = {'id': 1424, 'name': 'けいおん！', 'name_cn': '轻音少女'}
        second = {'id': 3774, 'name': 'けいおん！！', 'name_cn': '轻音少女 第二季'}
        with patch.object(self.search, 'search_bangumi_subjects', return_value=[first, second]), \
             patch.object(self.search, 'get_bangumi_subject_by_id', side_effect=lambda sid: second if sid == 3774 else first), \
             patch.object(self.search, 'get_bangumi_episodes', return_value=[]):
            self.assertEqual(self.search.get_bangumi_info('けいおん！！', 0)[1]['id'], 3774)

    def test_success_and_failure_task_data_keep_candidates(self):
        worker = Rename.__new__(Rename)
        worker.search = self.search
        self.search.last_bangumi_candidates = [{'id': 283, 'name': 'みなみけ'}]
        for error in (None, '[Bangumi] 请确认'):
            task = worker.build_task_data(Path('source'), 'task', True, False, 'Show', 1, error=error)
            self.assertEqual(task['bangumi_candidates'], self.search.last_bangumi_candidates)

    def test_cache_hits_expire_and_failures_are_not_written(self):
        title_cache.write('tenrai', 'test', [self.entry()])
        with patch('src.rename.get_info.metadata_session') as session:
            self.assertEqual(self.search._tenrai_request('TEST'), [self.entry()])
            session.assert_not_called()
        with patch.object(title_cache.time, 'time', return_value=0):
            self.assertIsNone(title_cache.read('tenrai', 'test', 30))
        with patch('src.rename.get_info.metadata_session') as session:
            session.return_value.get.side_effect = OSError('offline')
            self.assertEqual(self.search._tenrai_request('offline'), [])
            self.assertIsNone(title_cache.read('tenrai', 'offline', 86400))
            self.assertTrue(self.search.recall_warnings)


if __name__ == '__main__':
    unittest.main()
