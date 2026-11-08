import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from src.rename.process import Rename
from src.rename.get_info import Search
from src.utils.title_matching import title_score


class HistoricalIdentityTests(unittest.TestCase):
    def test_query_separates_release_descriptors_and_year(self):
        worker = Rename.__new__(Rename)
        with tempfile.TemporaryDirectory() as tmp:
            for title, expected in (
                ('Bakemonogatari 2009 [BD 1080p FLAC] - mawen1250', ('Bakemonogatari', 2009)),
                ('Millennium Actress [2001] 2160p Hybrid BDRip x265', ('Millennium Actress', 2001)),
                ('機動戦士ガンダム 逆襲のシャア Ver.2018 4Kリマスター[BDRip HEVC 1080p]', ('機動戦士ガンダム 逆襲のシャア', 0)),
                ('[Group] Perfect Blue 4K Remaster Edition BD-BOX [4K SDR] - Movie + SP', ('Perfect Blue', 0)),
            ):
                root = Path(tmp) / title
                root.mkdir()
                self.assertEqual(worker.build_search_candidates(root)[0], expected)

    def test_full_alias_is_not_rejected_by_another_alias_movie_marker(self):
        search = Search()
        movie = {'id': 1, 'name': 'たまこラブストーリー', 'aliases': ['Tamako Love Story', '玉子市场 剧场版']}
        self.assertTrue(search._special_intent_matches(movie, 'Tamako Love Story'))
        self.assertTrue(search._bangumi_compatible(movie, 'Tamako Love Story', 0))
        self.assertFalse(search._special_intent_matches({'name': 'Nichijou'}, 'Nichijou OAD'))

    def test_container_and_technical_blocks_do_not_replace_the_title(self):
        worker = Rename.__new__(Rename)
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'SAC'
            folder.mkdir()
            (folder / '[Group][Ghost in the Shell STAND ALONE COMPLEX][BDRip][1080p].mkv').touch()
            self.assertEqual(worker.build_search_candidates(folder)[0][0], 'Ghost in the Shell STAND ALONE COMPLEX')
            movie = Path(tmp) / '[Group][4K_HDR][攻壳机动队][1995版][2160P][BDRip]'
            movie.mkdir()
            self.assertEqual(worker.build_search_candidates(movie), [('攻壳机动队', 1995)])
            special = Path(tmp) / 'Seikai Suru Kado 正解するカド 第12.5話 (TV未放送) (YT 1080p AVC).mp4'
            special.touch()
            self.assertEqual(worker.build_search_candidates(special), [('正解するカド 第12.5話', 0)])

    def test_cross_catalog_alias_keeps_the_strongest_native_mapping(self):
        entry = {'mal_id': 42, 'title': 'Series G', 'title_japanese': 'Native G'}
        items = [{'id': 1, 'name': 'Native Next'}, {'id': 2, 'name': 'Native G'}]
        search = Search()
        with patch.object(search, '_tenrai_request', return_value=[entry]), \
             patch.object(search, '_bangumi_request', return_value={'data': items}), \
             patch('src.rename.get_info.match_entries', side_effect=lambda item, _: [(entry, 9.5 if item['id'] == 2 else 2.9)]), \
             patch('src.rename.get_info.title_cache.write'):
            self.assertEqual([item['id'] for item in search._tenrai_recall('Series G', 0)], [2])

    def test_release_title_keeps_sequel_punctuation_and_parenthesized_subtitle(self):
        worker = Rename.__new__(Rename)
        with tempfile.TemporaryDirectory() as tmp:
            for title in ('NEW GAME!!', "WORKING'!!", 'K-ON!!', '向阳素描×☆☆☆'):
                root = Path(tmp) / ('[Group] ' + title + ' [Ma10p_1080p]')
                root.mkdir()
                self.assertEqual(worker.build_search_candidates(root)[0][0], title)
            video = Path(tmp) / '[Group] Kono Sekai no (Sara ni Ikutsumo no) Katasumi ni [1080p].mkv'
            video.touch()
            self.assertIn(('Kono Sekai no (Sara ni Ikutsumo no) Katasumi ni', 0), worker.build_search_candidates(video))

    def test_punctuation_is_identity_not_a_universal_first_season_alias(self):
        self.assertEqual(title_score(['NEW GAME!'], 'NEW GAME!!')[0], 4)
        self.assertEqual(title_score(['NEW GAME!!'], 'NEW GAME!!')[0], 5)
        self.assertFalse(Search()._bangumi_compatible({'name': '向阳素描'}, '向阳素描×☆☆☆', 0))
        self.assertTrue(Search()._bangumi_compatible({'name': '向阳素描×☆☆☆', 'aliases':['向阳素描 第三季']}, '向阳素描×☆☆☆', 0))

    def test_special_video_and_calendar_parent_supply_identity_evidence(self):
        worker = Rename.__new__(Rename)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'2026-01'/'黄金神威';root.mkdir(parents=True)
            self.assertEqual(worker.build_search_candidates(root)[0], ('黄金神威', 2026))
            movie = Path(tmp) / '[Group][Space Runaway Ideon][BDRip][Movie][1080p].mkv'
            movie.touch()
            self.assertIn('剧场版', worker.search_folder_context(movie)[1])
            for tag in ('00', '11.5', 'OAD(00)', '13(OAD)'):
                video=Path(tmp)/f'[Group] Show [{tag}][1080p].mkv';video.touch()
                self.assertEqual(worker.build_search_candidates(video)[0][0], 'Show OAD')
