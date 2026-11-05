import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from src.rename.release_parser import parse_release
from src.rename.bangumi_native import plan_subject
from src.rename.bulk_migration import choose_episode


class ReleaseParserTests(unittest.TestCase):
    def test_release_metadata_and_original_spans(self):
        p = parse_release('[Q_Vageena&Space][Gundam_ZZ][01][BDRIP][X264_FLAC][1492x1080][D6BCF8DC].mkv')
        self.assertEqual((p.kind, p.ordinal, p.conflicts), (None, '1', []))
        self.assertEqual(p.suffix, '.mkv')
        self.assertTrue({'group_candidate', 'technical', 'checksum'} <= {f['role'] for f in p.fields})
        for f in p.fields:
            self.assertEqual(p.stem[f['start']:f['end']], f['text'])

    def test_known_group_tokens_never_classify_the_episode(self):
        for group in ('OP', 'SP', 'CM', 'ED', 'Space'):
            with self.subTest(group=group):
                p = parse_release(f'Show [01] [{group}].mkv', group=group, titles=('Show',))
                self.assertEqual((p.kind, p.ordinal), (None, '1'))

    def test_title_sequel_is_weaker_than_bracket_number(self):
        p = parse_release('[VCB-Studio] Hibike! Euphonium 2 [03][Ma10p_1080p][x265_flac_2aac].mkv')
        self.assertEqual((p.ordinal, p.conflicts), ('3', []))
        p = parse_release('Special A [01].mkv', titles=('Special A',))
        self.assertEqual((p.kind, p.ordinal), (None, '1'))
        p = parse_release('[Group] Show [IV01_Show - 500 Days of Production I][1080p].mkv')
        self.assertIsNone(p.ordinal)

    def test_numbered_interviews_are_extras_not_special_episode_numbers(self):
        for token in ('IV01', 'IV39', 'IV01_Show - 500 Days of Production I', 'Interview 02', 'IV01 BD 1080p'):
            with self.subTest(token=token):
                result = parse_release(f'[VCB-Studio] Nichijou [{token}][Ma10p_1080p][x265_aac].mkv')
                self.assertEqual((result.kind, result.ordinal), ('extra', None))
        result = parse_release('[IV01][1080p].mkv')
        self.assertEqual(result.kind, 'extra')
        self.assertNotEqual(parse_release('Show IV [01].mkv').kind, 'extra')
        self.assertNotEqual(parse_release('Show [IV1080][01].mkv').kind, 'extra')
        result = parse_release('Show [01] [IV01].mkv', group='IV01')
        self.assertEqual((result.kind, result.ordinal), (None, '1'))

    def test_nichijou_interview_pack_does_not_require_individual_special_bindings(self):
        with TemporaryDirectory() as directory:
            root = Path(directory); extras = root / 'SPs'; extras.mkdir()
            for n in range(1, 40):
                (extras / f'[VCB-Studio] Nichijou [IV{n:02}][Ma10p_1080p][x265_aac].mkv').write_bytes(b'video')
            zero = root / '[VCB-Studio] Nichijou [00][Ma10p_1080p][x265_flac].mkv'; zero.write_bytes(b'video')
            mapping, rows = plan_subject(root, {'id': '9912', 'name': '日常', 'bangumi_episodes': [
                {'id': 1, 'sort': 1, 'type': 0, 'name': '第一话'}]}, root / 'output', 'VCB-Studio')
            self.assertEqual(sum(row['category'] == 'extra' for row in rows), 39)
            self.assertNotIn(zero, mapping)
            self.assertTrue(all('Extras' in target.parts for target in mapping.values()))

    def test_historical_extra_content_markers_override_package_numbers(self):
        tokens = ['SP00] Menu - 01', 'SP00] Chapter Select Menu - 03', 'Making01',
                  'Making Of 02', 'MV01', 'MV_Funwaka_Orange', 'Music Video', 'Lyric Video 01',
                  'Voice Sample 01', 'Game Scene 01', 'Eyecatch13', 'IV',
                  'BOCCHI THE TALK! 01', 'Special Studio Live', 'SP07] EP.01 Premiere Talk Show Digest']
        for token in tokens:
            with self.subTest(token=token):
                result = parse_release(f'[Group] Show [{token}][Ma10p_1080p][x265_aac].mkv')
                self.assertEqual((result.kind, result.ordinal, result.conflicts), ('extra', None, []))
        self.assertEqual(parse_release('[IV][1080p].mkv').kind, 'extra')
        self.assertEqual(parse_release('[MV01 BD 1080p].mkv').kind, 'extra')
        for title in ['#01 次回予告 30秒バージョン', '#05放送版次回予告', 'BD発売告知スボット', '番宣トレーラー', '特報']:
            self.assertEqual(parse_release(f'[Group] Show {title} (H264 1920x1080 FLAC).mkv').kind, 'extra')

    def test_creditless_full_names_use_opening_and_ending_catalogs(self):
        for token, expected in [('Creditless Opening 2', (2, '2')), ('Creditless Ending 1', (3, '1')),
                                ('Textless OP03', (2, '3')), ('Textless Ending', (3, None)),
                                ('SP08] Creditless Ending 2_EP45', (3, '2'))]:
            with self.subTest(token=token):
                result = parse_release(f'[Group] Show [{token}][1080p].mkv')
                self.assertEqual((result.kind, result.ordinal), expected)
                self.assertFalse(result.conflicts)
        self.assertTrue(parse_release('Show [Creditless Opening 1] [Creditless Ending 2].mkv').conflicts)

    def test_extra_rules_do_not_consume_story_titles_versions_or_release_groups(self):
        for token in ['OVA01', 'SP01', 'Scene 01ex', 'Extra Episode 01', 'Picture_Drama',
                      'Recap', '総集篇', 'IV', 'IV1080', 'MakingLove', 'MenuSubs', 'Extra Stage']:
            with self.subTest(token=token):
                self.assertNotEqual(parse_release(f'[Group] Show {token} [1080p].mkv').kind, 'extra')
        for group in ['Menu', 'IV', 'MV', 'Making01']:
            result = parse_release(f'Show [01] [{group}].mkv', group=group)
            self.assertEqual((result.kind, result.ordinal), (None, '1'))
        result = parse_release('Making Of [01].mkv', titles=('Making Of',))
        self.assertEqual((result.kind, result.ordinal), (None, '1'))

    def test_conflicting_number_or_kind_requires_review(self):
        for name in ('Show EP03 [04].mkv', 'Show EP03 SP03.mkv',
                     '[Moozzi2] Golden Kamuy S3 - 01 [ 25 ] (BD 1920x1080 x265).mkv'):
            with self.subTest(name=name):
                p = parse_release(name)
                self.assertTrue(p.conflicts)
                self.assertIsNone(p.ordinal)

    def test_opening_ending_applicability_is_not_a_second_episode(self):
        for token, expected in [('NCED02_EP45', (3, '2')), ('SP08_NCED', (3, None)),
                                ('NCOP_EP01', (2, None)), ('NCOP][02', (2, '2'))]:
            with self.subTest(token=token):
                p = parse_release(f'[Group] Show 3 [{token}][1080p].mkv')
                self.assertEqual((p.kind, p.ordinal), expected)
                self.assertFalse(p.conflicts)

    def test_year_checksum_resolution_and_audio_do_not_supply_numbers(self):
        p = parse_release('[Group] Movie [2001] (H264 1920x1080 FLAC 5.1ch)[05169375].mkv')
        self.assertIsNone(p.ordinal)
        p = parse_release('[sam] Cross Game - 14 [WEB 720p AC3] [74680120].mkv')
        self.assertEqual(p.ordinal, '14')
        p = parse_release('[AI-Raws] Show #14 (H264 1440x1080 FLAC)[35454750].mkv')
        self.assertEqual(p.ordinal, '14')

    def test_preserve_content_markers_in_technical_blocks(self):
        p = parse_release('[Group] Show (BD menu Vol 1) 02 [BDRip 1920x1080].mkv')
        self.assertEqual(p.kind, 'extra')

    def test_real_markers_versions_and_fractional_numbers(self):
        for token, kind, number in [('SP01', 1, '1'), ('Special 01', 1, '1'),
                                    ('S00E12.5', 1, '12.5'), ('S02E03', 0, '3'),
                                    ('OVA01', None, '1'), ('OAD02', None, '2'),
                                    ('Extra Episode 01', 1, '1'), ('01v2', None, '1')]:
            with self.subTest(token=token):
                p = parse_release(f'[Group][Show][{token}][BDRIP].mkv')
                self.assertEqual((p.kind, p.ordinal, p.conflicts), (kind, number, []))

    def test_conflict_cannot_use_single_episode_or_title_fallback(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / 'First EP01 [02].mkv'
            video.write_bytes(b'video')
            episodes = [{'id': 101, 'sort': 1, 'type': 0, 'name': 'First'}]
            mapping, decisions = plan_subject(root, {'id': '1', 'name': 'Show', 'bangumi_episodes': episodes}, root / 'out', '')
            self.assertNotIn(video, mapping)
            self.assertEqual(decisions[0]['category'], 'unresolved')
            self.assertTrue(decisions[0]['recognition']['conflicts'])
            selected, category, _ = choose_episode(video, [{'id': '1', 'name': 'Show', 'platform': 'TV', 'episodes': episodes}], 1, {})
            self.assertIsNone(selected)
            self.assertEqual(category, 'unresolved')

    def test_bulk_and_native_share_group_exclusion(self):
        episodes = [{'id': 101, 'sort': 1, 'type': 0, 'name': 'First'}]
        selected, _, _ = choose_episode(Path('[Space&OP][Show][01][BDRIP].mkv'),
            [{'id': '1', 'name': 'Show', 'platform': 'TV', 'episodes': episodes}], 2, {})
        self.assertEqual(selected[1]['id'], 101)

    def test_explicit_regular_marker_keeps_verified_catalog_offset(self):
        episodes = [{'id': 101, 'sort': 25, 'type': 0, 'name': 'First'}]
        selected, _, _ = choose_episode(Path('Show EP01.mkv'),
            [{'id': '1', 'name': 'Show', 'platform': 'TV', 'episodes': episodes}], 2, {'_catalog_offset': 24})
        self.assertEqual(selected[1]['id'], 101)


if __name__ == '__main__':
    unittest.main()
