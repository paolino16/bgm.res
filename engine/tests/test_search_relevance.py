import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.utils.title_matching import normalize_title, title_parts, season_hint, title_score, relevant
from src.utils.task_index import TaskSnapshot
from src.rename.get_info import Search
from src.rename.process import Rename


class TitleTests(unittest.TestCase):
    def test_romanized_separators_and_joined_complete_titles(self):
        for title in ('Minami-ke', 'Minami ke', 'Minamike', 'ＭＩＮＡＭＩ－ＫＥ'):
            with self.subTest(title=title):
                self.assertEqual(title_score([title], 'Minami-ke')[0], 5)
        self.assertTrue(relevant(['Shangri La'], 'Shangri-La'))
        self.assertTrue(relevant(["Shin'ya"], 'Shinya'))
        self.assertTrue(relevant(['Minamike Okaeri'], 'Minami-ke Okaeri'))

    def test_romanized_words_cannot_match_scattered_substrings(self):
        wrong = 'Sore Ike! Anpanman: Minami no Umi o Sukue!'
        self.assertFalse(relevant([wrong], 'Minami-ke'))
        for title in ('Minami Okaeri Ke', 'Minami Keyboard',
                      'Ke Minami', 'Minami-ke'):
            with self.subTest(title=title):
                self.assertFalse(relevant([title], 'Minami-ke Okaeri'))
        self.assertFalse(relevant(['Planet'], 'Plan'))

    def test_romanized_contiguous_phrase_and_sequel_ranking(self):
        self.assertTrue(relevant(['The Minami-ke Collection'], 'Minami-ke'))
        self.assertTrue(relevant(['Minami-ke Okaeri'], 'Minami-ke'))
        self.assertGreater(title_score(['Minami-ke'], 'Minami-ke'),
                           title_score(['Minami-ke Okaeri'], 'Minami-ke'))
        self.assertFalse(relevant(['Minami-ke Okawari'], 'Minami-ke Okaeri'))

    def test_unicode_width_case_punctuation_and_kana_are_preserved(self):
        self.assertEqual(normalize_title('Ｒｅ：从零开始'), normalize_title('re 从零开始'))
        self.assertEqual(normalize_title('けいおん！'), 'けいおん')
        self.assertNotEqual(normalize_title('けいおん！'), normalize_title('ゆるゆり'))

    def test_explicit_season_notations(self):
        for title, expected in [('作品 第二季', 2), ('作品 第十二季', 12), ('作品 二期', 2),
                                ('作品 第2期', 2), ('Show S02', 2), ('Show S02E01', 2),
                                ('Show 2nd Season', 2), ('Show 3rd season', 3),
                                ('Show Season 4', 4), ('Show Second Season', 2), ('Show II', 2)]:
            with self.subTest(title=title):
                self.assertEqual(season_hint(title), expected)
        for title in ('86', '四季樱', '三月的狮子', '作品 2020', '007'):
            self.assertIsNone(season_hint(title))

    def test_unsuffixed_title_beats_popular_sequel(self):
        self.assertGreater(title_score(['作品'], '作品'), title_score(['作品 第二季'], '作品'))
        self.assertGreater(title_score(['作品 第一季'], '作品'), title_score(['作品 第二季'], '作品'))

    def test_explicit_season_matches_across_languages(self):
        self.assertGreater(title_score(['Show 第二季'], 'Show S02'), title_score(['Show'], 'Show S02'))
        self.assertGreater(title_score(['Show 2nd Season'], 'Show 第二季'), title_score(['Show 第三季'], 'Show 第二季'))

    def test_local_season_field_is_fallback_not_override(self):
        self.assertGreater(title_score(['作品'], '作品', fallback_season=1), title_score(['作品'], '作品', fallback_season=2))
        self.assertGreater(title_score(['作品 第二季'], '作品 S02', fallback_season=1), title_score(['作品'], '作品 S02', fallback_season=1))
        self.assertTrue(relevant(['作品 第二季 后半部分'], '作品 S02', fallback_season=1))
        self.assertFalse(relevant(['作品'], '作品 S02', fallback_season=1))
        self.assertTrue(relevant(['作品'], '作品 S02', fallback_season=2))
        self.assertTrue(relevant(['作品'], '作品 S02', fallback_season='2'))

    def test_alias_without_season_cannot_hide_known_sequel(self):
        self.assertGreater(title_score(['作品'], '作品'), title_score(['作品 第二季', '作品'], '作品'))

    def test_year_can_intentionally_select_sequel(self):
        self.assertGreater(title_score(['作品 第二季'], '作品', year=2022, date='2022-01-01'),
                           title_score(['作品'], '作品', year=2022, date='2020-01-01'))

    def test_exact_title_beats_unrelated_year_or_popularity(self):
        self.assertGreater(title_score(['作品'], '作品', year=2022, date='2020-01-01'),
                           title_score(['另一个作品'], '作品', year=2022, date='2022-01-01'))

    def test_partial_and_bilingual_queries_and_no_empty_matching(self):
        self.assertTrue(relevant(['Re：从零开始的异世界生活'], 're从零'))
        self.assertTrue(relevant(['香格里拉'], 'Shangri-La / 香格里拉'))
        self.assertFalse(relevant(['作品'], '???'))
        self.assertFalse(relevant(['完全不相关'], '作品'))

    def test_tv_title_precedes_movie_suffix_without_movie_intent(self):
        self.assertGreater(title_score(['作品'], '作品'), title_score(['作品 剧场版'], '作品'))
        self.assertGreater(title_score(['作品 剧场版'], '作品 剧场版'), title_score(['作品'], '作品 剧场版'))

    def test_season_marker_alone_is_never_title_evidence(self):
        for query in ('Season 1', 'S01', '第一季', '1st Season', 'OVA'):
            with self.subTest(query=query):
                self.assertEqual(title_score(['Ben 10 Season 1', '少年骇客 第一季', 'Season 1'], query)[0], 0)
                self.assertFalse(relevant(['Ben 10 Season 1'], query))
        self.assertEqual(title_parts('Season 1'), ('', 1, False))

    def test_marker_only_alias_cannot_validate_a_title_with_matching_season(self):
        self.assertEqual(title_score(['少年骇客 第一季', 'Season 1'], 'Unrelated Show Season 1')[0], 0)


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.search = Search()
        self.tenrai = patch.object(self.search, '_tenrai_request', return_value=[]).start()
        self.addCleanup(patch.stopall)

    def subject(self, id, name, **kwargs):
        return {'id': id, 'name': name, 'name_cn': name, **kwargs}

    def test_infobox_aliases_accept_strings_and_bangumi_value_lists(self):
        subject = self.subject(1, '作品', infobox=[
            {'key': '别名', 'value': [{'v': 'Romanized Title'}, {'v': None}, 'English Title']},
            {'key': '别名', 'value': 'Another Title'},
            {'key': '导演', 'value': 'Not a Title'}, None,
        ])
        self.assertEqual(self.search._bangumi_titles(subject),
                         ['作品', '作品', 'Romanized Title', 'English Title', 'Another Title'])

    def test_romanized_search_enriches_and_reuses_details_without_selecting_sequel(self):
        first = self.subject(1, '作品', infobox=[{'key': '别名', 'value': [{'v': 'Romanized Title'}]}])
        second = self.subject(2, '作品 第二季', infobox=[{'key': '别名', 'value': [{'v': 'Romanized Title 2nd Season'}]}])
        responses = {'/v0/search/subjects?limit=30': {'data': [self.subject(2, '作品 第二季'), self.subject(1, '作品')]},
                     '/v0/subjects/1': first, '/v0/subjects/2': second}
        with patch.object(self.search, '_bangumi_request', side_effect=lambda endpoint, *args: responses[endpoint]) as send, \
             patch.object(self.search, 'get_bangumi_episodes', return_value=[]):
            name, info = self.search.get_bangumi_info('Romanized Title', 0)
        self.assertEqual((name, info['id']), ('作品', 1))
        self.assertEqual(sum(call.args[0] == '/v0/subjects/1' for call in send.call_args_list), 1)

    def test_detail_fetch_is_bounded_and_uses_api_order(self):
        candidates = [self.subject(i, f'无关标题{i}') for i in range(1, 10)]
        with patch.object(self.search, '_bangumi_request', return_value={'data': candidates}), \
             patch.object(self.search, 'get_bangumi_subject_by_id', return_value=None) as detail:
            self.search.search_bangumi_subjects('Romanized Title')
        self.assertCountEqual([call.args[0] for call in detail.call_args_list], [1, 2, 3, 4, 5])

    def test_failed_details_preserve_network_error_and_candidates(self):
        def fail_detail(*args):
            self.search.last_error = '[Bangumi] 网络连接失败'
            return None
        with patch.object(self.search, '_bangumi_request', return_value={'data': [self.subject(1, '作品')]}), \
             patch.object(self.search, 'get_bangumi_subject_by_id', side_effect=fail_detail):
            self.assertEqual(self.search.get_bangumi_info('Romanized Title', 0), ('', None))
        self.assertIn('网络连接失败', self.search.last_error)
        self.assertEqual(self.search.last_bangumi_candidates[0]['id'], 1)

    def test_failure_candidates_include_titles_date_and_season(self):
        second = self.subject(2, '作品 第二季', date='2024-01-06')
        with patch.object(self.search, 'search_bangumi_subjects', return_value=[second]):
            self.search.get_bangumi_info('作品', 0)
        self.assertEqual(self.search.last_bangumi_candidates,
                         [{'id': 2, 'name': '作品 第二季', 'name_cn': '作品 第二季',
                           'date': '2024-01-06', 'season': 2}])
        self.assertIn('编辑任务', self.search.last_error)

    def test_legacy_search_adds_missing_candidate_without_assuming_title_match(self):
        wrong = self.subject(14153, '夏色的砂时计')
        correct = self.subject(26825, '夏色キセキ', date='2012-04-05')
        def request(endpoint, *args):
            if endpoint.startswith('/v0/search/'):
                return {'data': [wrong]}
            if endpoint.startswith('/search/subject/'):
                self.assertIn('Natsuiro%20Kiseki', endpoint)
                return {'list': [correct]}
            return {14153: wrong, 26825: correct}[int(endpoint.rsplit('/', 1)[1])]
        with patch.object(self.search, '_bangumi_request', side_effect=request):
            self.assertEqual(self.search.get_bangumi_info('Natsuiro Kiseki', 0), ('', None))
        self.assertEqual(self.search.last_bangumi_candidates[0]['id'], 26825)

    def test_legacy_search_can_match_verified_alias_and_avoid_duplicate_candidates(self):
        subject = self.subject(1, '作品', infobox=[{'key': '别名', 'value': 'Romanized Title'}])
        def request(endpoint, *args):
            if endpoint.startswith('/v0/search/'):
                return {'data': []}
            if endpoint.startswith('/search/subject/'):
                return {'list': [self.subject(1, '作品')]}
            return subject
        with patch.object(self.search, '_bangumi_request', side_effect=request), \
             patch.object(self.search, 'get_bangumi_episodes', return_value=[]):
            self.assertEqual(self.search.get_bangumi_info('Romanized Title', 0)[1]['id'], 1)

    def test_valid_primary_match_skips_legacy_search(self):
        with patch.object(self.search, '_bangumi_request', return_value={'data': [self.subject(1, '作品')]}) as send:
            self.search.search_bangumi_subjects('作品')
        send.assert_called_once()

    def test_empty_romanized_search_broadens_keyword_for_manual_candidates(self):
        correct = self.subject(118067, '六花の勇者', date='2015-07-04')
        endpoints = []
        def request(endpoint, *args):
            endpoints.append(endpoint)
            if endpoint.startswith('/v0/search/'):
                return {'data': []}
            if endpoint.startswith('/search/subject/Rokka%20no%20Yuusha?'):
                return {'code': 404, 'error': 'Not Found'}
            if endpoint.startswith('/search/subject/Rokka?'):
                return {'list': [correct]}
            if endpoint == '/v0/subjects/118067':
                return correct
            self.fail(f'Unexpected request: {endpoint}')
        with patch.object(self.search, '_bangumi_request', side_effect=request):
            self.assertEqual(self.search.get_bangumi_info('Rokka no Yuusha', 0), ('', None))
        self.assertEqual(self.search.last_bangumi_candidates[0]['id'], 118067)
        self.assertEqual(len(endpoints), 4)


    def test_bangumi_fetches_relevance_candidates_and_reranks_beyond_old_top_five(self):
        candidates = [self.subject(i, f'作品 第{i}季', rank=1) for i in range(2, 8)]
        candidates.append(self.subject(1, '作品', rank=9999))
        with patch.object(self.search, '_bangumi_request', return_value={'data': candidates}) as send:
            result = self.search.search_bangumi_subjects('作品')
        self.assertEqual(result[0]['id'], 1)
        self.assertIn('limit=30', send.call_args.args[0])
        self.assertEqual(send.call_args.args[2]['sort'], 'match')

    def test_bangumi_second_season_does_not_win_on_rating(self):
        first = self.subject(1, '作品', rank=99999, score=4)
        second = self.subject(2, '作品 第二季', rank=1, score=10)
        self.assertGreater(self.search._score_bangumi_subject(first, '作品', 0),
                           self.search._score_bangumi_subject(second, '作品', 0))

    def test_only_sequels_does_not_silently_select_wrong_subject(self):
        with patch.object(self.search, 'search_bangumi_subjects', return_value=[self.subject(2, '作品 第二季')]), \
             patch.object(self.search, 'get_bangumi_subject_by_id') as detail:
            self.assertEqual(self.search.get_bangumi_info('作品', 0), ('', None))
        detail.assert_not_called()
        self.assertIn('季号', self.search.last_error)

    def test_explicit_second_season_remains_second(self):
        second = self.subject(2, '作品 第二季')
        with patch.object(self.search, 'search_bangumi_subjects', return_value=[self.subject(1, '作品'), second]), \
             patch.object(self.search, 'get_bangumi_subject_by_id', return_value=second) as detail, \
             patch.object(self.search, 'get_bangumi_episodes', return_value=[]):
            self.assertEqual(self.search.get_bangumi_info('作品 S02', 0)[0], '作品 第二季')
        detail.assert_called_once_with(2)

    def test_season_intent_survives_stripped_query_fallback(self):
        self.search.requested_season = 2
        self.assertFalse(self.search._bangumi_compatible(self.subject(1, '作品'), '作品', 0))
        self.assertTrue(self.search._bangumi_compatible(self.subject(2, '作品 第二季'), '作品', 0))

    def test_explicit_id_bypasses_title_ranking(self):
        subject = self.subject(2, '作品 第二季')
        with patch.object(self.search, 'search_bangumi_subjects') as search, \
             patch.object(self.search, 'get_bangumi_subject_by_id', return_value=subject), \
             patch.object(self.search, 'get_bangumi_episodes', return_value=[]), \
             patch('src.rename.get_info.logger'):
            self.assertEqual(self.search.get_bangumi_info('作品', 0, bgm_id=2)[0], '作品 第二季')
        search.assert_not_called()

    def test_tmdb_exact_base_precedes_popular_second_season(self):
        results = [{'id': 2, 'name': '作品 第二季', 'vote_count': 99999},
                   {'id': 1, 'name': '作品', 'vote_count': 1}]
        self.assertEqual(self.search._pick_best_result(results, '作品', 0)['id'], 1)
        self.assertEqual(self.search._pick_best_result(results, '作品 S02', 0)['id'], 2)
        self.assertIsNone(self.search._pick_best_result([{'name': '完全不相关'}], '作品', 0))

    def test_no_query_never_requests_everything(self):
        with patch.object(self.search, '_bangumi_request') as send:
            self.assertEqual(self.search.search_bangumi_subjects('   '), [])
        send.assert_not_called()

    def test_season_only_bangumi_query_never_calls_search_api(self):
        with patch.object(self.search, '_bangumi_request') as send:
            self.assertEqual(self.search.get_bangumi_info('Season 1', 0), ('', None))
        send.assert_not_called()

    def test_explicit_id_bypasses_unsearchable_folder_title(self):
        for field in ('custom_bgm_id', 'custom_tmdb_id'):
            with self.subTest(field=field):
                rename = Rename.__new__(Rename)
                rename.search = SimpleNamespace()
                rename.build_search_candidates = Mock(return_value=[])
                rename.check_task_type = Mock(return_value=('超时空要塞 Dynamite 7', {}, True, False))
                result = rename.resolve_task_type('test', Path('OVA'), True, None, **{field: '3175'})
                self.assertEqual(result[2][0], '超时空要塞 Dynamite 7')
                rename.build_search_candidates.assert_not_called()
                rename.check_task_type.assert_called_once()

    def test_multi_episode_ova_is_a_series(self):
        subject = self.subject(3175, '超时空要塞 Dynamite 7', platform='OVA', eps=4)
        info = self.search._build_bangumi_info(subject)
        self.assertFalse(info['is_movie'])
        self.assertFalse(self.search.is_bangumi_movie_info(info))
        self.assertEqual(info['episodes_total'], 4)
        self.assertTrue(self.search.is_bangumi_movie_info({'platform': 'OVA', 'episodes_total': 1}))
        self.assertTrue(self.search.is_bangumi_movie_info({'platform': '剧场版', 'episodes_total': 4}))

    def test_season_folder_search_uses_parent_title_and_year(self):
        rename = Rename.__new__(Rename)
        path = Path('library/弹珠汽水瓶里的千岁同学 (2025)/Season 1')
        with patch('src.rename.process.logger'):
            self.assertEqual(rename.build_search_candidates(path), [('弹珠汽水瓶里的千岁同学', 2025)])

    def test_category_folders_use_parent_title(self):
        rename = Rename.__new__(Rename)
        for folder in ('TV', 'TVA', 'tv', 'OVA', 'OAD', 'ONA', 'Movie', '剧场版'):
            with self.subTest(folder=folder), patch('src.rename.process.logger'):
                self.assertEqual(rename.build_search_candidates(Path('library/作品 (2025)') / folder),
                                 [('作品', 2025)])

    def test_nested_category_folders_keep_season_and_platform_context(self):
        rename = Rename.__new__(Rename)
        rename.search = SimpleNamespace()
        rename.check_task_type = Mock(return_value=('作品', {}, True, False))
        with patch('src.rename.process.logger'):
            rename.resolve_task_type('test', Path('library/作品 (2025)/Season 2/OVA'), True, None)
        self.assertEqual(rename.search.requested_season, 2)
        self.assertEqual(rename.search.requested_platforms, ('OVA',))
        self.assertEqual(rename.check_task_type.call_args.args[1:3], ('作品', 2025))

    def test_collection_anniversary_is_removed_from_parent_search(self):
        rename = Rename.__new__(Rename)
        path = Path('[NEOQSW] Macross 7 35th Anniversary[BDrip HEVC 1080P]/OVA')
        with patch('src.rename.process.logger'):
            candidates = rename.build_search_candidates(path)
        self.assertEqual(candidates[0], ('Macross 7', 0))
        self.assertFalse(any('Anniversary' in name or name == 'OVA' for name, _ in candidates))

    def test_category_detection_requires_entire_folder_name(self):
        rename = Rename.__new__(Rename)
        with patch('src.rename.process.logger'):
            self.assertEqual(rename.build_search_candidates(Path('library/作品 OVA')), [('作品 OVA', 0)])
            self.assertEqual(rename.build_search_candidates(Path('library/作品/OVA'), '指定名称'), [('指定名称', 0)])

    def test_ova_context_does_not_accept_tv_subject_with_same_title(self):
        self.search.requested_platforms = ('OVA',)
        self.assertFalse(self.search._bangumi_compatible(self.subject(1, '作品', platform='TV'), '作品', 0))
        self.assertTrue(self.search._bangumi_compatible(self.subject(2, '作品', platform='OVA'), '作品', 0))

    def test_platform_context_fetches_details_even_when_title_already_matches(self):
        self.search.requested_platforms = ('OVA',)
        with patch.object(self.search, '_bangumi_request', return_value={'data': [self.subject(2, '作品')]}), \
             patch.object(self.search, 'get_bangumi_subject_by_id',
                          return_value=self.subject(2, '作品', platform='OVA')) as detail:
            results = self.search.search_bangumi_subjects('作品')
        detail.assert_called_once_with(2)
        self.assertTrue(self.search._bangumi_compatible(results[0], '作品', 0))

    def test_parent_title_preserves_season_intent_and_custom_name_override(self):
        rename = Rename.__new__(Rename)
        rename.search = SimpleNamespace()
        rename.check_task_type = Mock(return_value=('作品', {}, True, False))
        path = Path('library/作品 (2025)/Season 2')
        with patch('src.rename.process.logger'):
            result = rename.resolve_task_type('test', path, True, False)
        self.assertEqual(result[:2], ('作品', 2025))
        self.assertEqual(rename.search.requested_season, 2)
        self.assertEqual(rename.build_search_candidates(path, '手动名称'), [('手动名称', 0)])

    def test_season_folder_without_parent_title_does_not_search_container(self):
        rename = Rename.__new__(Rename)
        for path in (Path('2025-10/Season 1'), Path('Season 1/Season 2')):
            self.assertEqual(rename.build_search_candidates(path), [])

    def test_folder_with_dot_season_keeps_hint_when_search_falls_back(self):
        rename = Rename.__new__(Rename)
        rename.search = SimpleNamespace(requested_season=None)
        rename.build_search_candidates = Mock(return_value=[('Show S02', 0), ('Show', 0)])
        rename.check_task_type = Mock(return_value='not found')
        with patch.object(Path, 'is_dir', return_value=True), patch('src.rename.process.logger'):
            rename.resolve_task_type('test', Path('Show.S02'), True, False)
        self.assertEqual(rename.search.requested_season, 2)

    def test_new_task_clears_previous_search_candidates(self):
        rename = Rename.__new__(Rename)
        rename.search = SimpleNamespace(last_bangumi_candidates=[{'id': 123}])
        rename.build_search_candidates = Mock(return_value=[])
        rename.resolve_task_type('test', Path('Show'), True, False)
        self.assertEqual(rename.search.last_bangumi_candidates, [])

    def test_error_task_persists_candidates_for_edit_dialog(self):
        rename = Rename.__new__(Rename)
        rename.search = self.search
        candidates = [{'id': 2, 'name': '作品 第二季', 'name_cn': '', 'date': '2024-01-06', 'season': 2}]
        self.search.last_bangumi_candidates = candidates
        with tempfile.TemporaryDirectory() as directory, \
             patch('src.rename.process.TASK_PATH', Path(directory)):
            rename.error_reply('test', '[Bangumi] 没有匹配条目', Path('Show'))
            saved = json.loads((Path(directory) / 'test.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['bangumi_candidates'], candidates)




if __name__ == '__main__':
    unittest.main()
