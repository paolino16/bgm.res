"""Numbered OVA releases should be recognized without changing mixed TV packs."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.rename.process import Rename


class StandaloneOVATests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'MKV'
        self.source.mkdir()
        self.worker = Rename.__new__(Rename)
        self.worker.R = {}
        log = patch('src.rename.process.logger')
        log.start()
        self.addCleanup(log.stop)

    def files(self, *names):
        paths = []
        for name in names:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
            paths.append(path)
        return paths

    def plan(self, season=1):
        # The first Kuromi OVA is cataloged separately with only one episode.
        self.worker._process_traditional(
            self.source, 'Kuromi-chan', self.root / 'library', '动画制作进行 黑美',
            season, 'Kamigami', {'seasons': [{'season_number': 1, 'episode_count': 1}]},
        )
        return self.worker.R

    def test_kuromi_pack_keeps_both_numbers_and_subtitles(self):
        prefix = '[Kamigami] Animation Seisaku Shinkou Kuromi-chan - '
        a, b, sub, archive = self.files(
            prefix + 'OVA01 [DVD 720p x265 Ma10p AC3].mkv',
            prefix + 'OVA02 [DVD 720p x265 Ma10p AC3].mkv',
            prefix + 'OVA02 [DVD 720p x265 Ma10p AC3].chs.ass',
            prefix + 'Fonts.zip',
        )
        mapping = self.plan()
        self.assertEqual(mapping[a].name, '动画制作进行 黑美 S01E01 [Kamigami].mkv')
        self.assertEqual(mapping[b].name, '动画制作进行 黑美 S01E02 [Kamigami].mkv')
        self.assertEqual(mapping[b].parent.name, 'Season 1')
        self.assertEqual(mapping[sub], mapping[b].with_suffix('.chs.ass'))
        self.assertNotIn(archive, mapping)

    def test_oad_and_custom_season(self):
        a, b = self.files('Show OAD_01.MKV', 'Show OAD-02.mkv')
        mapping = self.plan(season=3)
        self.assertIn('S03E01', mapping[a].name)
        self.assertIn('S03E02', mapping[b].name)

    def test_mixed_tv_pack_keeps_ova_as_special(self):
        tv, ova = self.files('Show - 01.mkv', 'OVA/Show OVA01.mkv')
        mapping = self.plan()
        self.assertEqual(mapping[tv].parent.name, 'Season 1')
        self.assertEqual(mapping[ova].parent.name, 'Season 0')
        self.assertEqual(mapping[ova].name, ova.name)

    def test_unnumbered_ova_and_specials_remain_special(self):
        for name in ('Show OVA.mkv', 'Show SP01.mkv', 'Show OVA00.mkv'):
            with self.subTest(name=name):
                video, = self.files(name)
                self.worker.R = {}
                self.assertEqual(self.plan()[video].parent.name, 'Season 0')
                video.unlink()

    def test_single_file_checks_tv_siblings_before_promoting_ova(self):
        tv, ova = self.files('Show - 01.mkv', 'Show OVA01.mkv')
        self.worker._process_traditional(
            ova, 'Show', self.root / 'library', 'Show', 1, '',
        )
        self.assertEqual(self.worker.R[ova].parent.name, 'Season 0')

    def test_explicit_extra_tag_keeps_priority_over_ova_number(self):
        video, = self.files('Show OVA01 NCOP.mkv')
        self.assertEqual(self.plan()[video].parent.name, 'extra')


if __name__ == '__main__':
    unittest.main()
