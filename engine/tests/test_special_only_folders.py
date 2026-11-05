"""Pure specials/extras packs must work at any directory depth."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.rename.process import Rename
from src.rename.preflight import expected_videos, inspect_plan


class SpecialOnlyFolderTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / 'Show'
        self.source.mkdir()
        self.output = self.root / 'library'
        self.worker = Rename.__new__(Rename)
        self.worker.R = {}
        log = patch('src.rename.process.logger')
        log.start()
        self.addCleanup(log.stop)

    def file(self, name):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        return path

    def plan(self, path=None):
        self.worker.R = {}
        self.worker._process_traditional(
            path or self.source, 'Show', self.output, 'Show', 1, '',
        )
        self.assertEqual(inspect_plan(self.worker.R, set(), '复制',
                                     videos=expected_videos(path or self.source)), [])
        return self.worker.R

    def test_category_search_uses_parent_title_without_requesting_season_zero(self):
        for category in ('Season 0', 'S00', 'Specials', '特别篇', 'extra', 'Extras', 'bonus', 'SP'):
            with self.subTest(category=category):
                folder = Path('library/Show (2025)/Season 2') / category
                self.assertEqual(self.worker.build_search_candidates(folder), [('Show', 2025)])
                self.assertEqual(self.worker.search_folder_context(folder)[2], 2)

    def test_direct_specials_folder_preserves_names_and_overrides_ova_promotion(self):
        for category in ('Season 0', 'Specials'):
            video = self.file(f'{category}/Show OVA01.mkv')
            subtitle = self.file(f'{category}/Show OVA01.chs.ass')
            mapping = self.plan(video.parent)
            self.assertEqual(mapping[video], self.output / 'Season 0' / video.name)
            self.assertEqual(mapping[subtitle], self.output / 'Season 0' / subtitle.name)

    def test_direct_extra_folder_keeps_all_files_and_nested_paths(self):
        video = self.file('extra/interview/01.mkv')
        subtitle = self.file('extra/interview/01.ass')
        image = self.file('extra/booklet/cover.png')
        mapping = self.plan(self.source / 'extra')
        for source in (video, subtitle, image):
            self.assertEqual(mapping[source], self.output / source.relative_to(self.source))

    def test_special_and_extra_subfolders_without_any_regular_episodes(self):
        special = self.file('Season 0/disc1/01.mkv')
        extra = self.file('extra/disc2/01.mkv')
        mapping = self.plan()
        self.assertEqual(mapping[special], self.output / special.relative_to(self.source))
        self.assertEqual(mapping[extra], self.output / extra.relative_to(self.source))

    def test_flat_specials_only_and_flat_extras_only(self):
        for names, category in ((('Show SP01.mkv', 'Show Special02.mkv'), 'Season 0'),
                                (('Show NCOP.mkv', 'Show NCED.mkv'), 'extra')):
            paths = [self.file(name) for name in names]
            mapping = self.plan()
            for video in paths:
                self.assertEqual(mapping[video], self.output / category / video.name)
                video.unlink()
            self.worker.R.clear()

    def test_ai_postprocessing_respects_explicit_folders(self):
        special = self.file('Specials/disc1/01.mkv')
        extra = self.file('extra/interview/01.mkv')
        self.worker.R = {special: self.output / 'Season 1' / 'wrong.mkv'}
        self.worker._map_sp_extra_folders(self.source, self.output)
        self.assertEqual(self.worker.R[special], self.output / 'Season 0/disc1/01.mkv')
        self.assertEqual(self.worker.R[extra], self.output / 'extra/interview/01.mkv')

    def test_public_entry_keeps_nested_category_as_one_task(self):
        video = self.file('Specials/disc1/01.mkv')
        self.worker._process = Mock(return_value=True)
        folder = video.parent.parent
        self.assertTrue(self.worker.process(folder, _tuuid='test'))
        self.assertEqual(self.worker._process.call_args.args[0], folder)

    def test_saved_task_points_to_actual_special_or_extra_output(self):
        self.worker.ANIME_PATH = self.worker.BANGUMI_PATH = self.output
        self.worker.ai_processor = Mock()
        self.worker.ai_processor.ai_client.is_available.return_value = False
        tasks = self.root / 'tasks'
        tasks.mkdir()
        for name, category in (('Show SP01.mkv', 'Season 0'), ('Show NCOP.mkv', 'extra')):
            video = self.file(name)
            with patch('src.rename.process.TASK_PATH', tasks), \
                 patch('src.rename.process.Trans') as transfer:
                transfer.return_value.trans_file.return_value = None
                result = self.worker.process(
                    self.source, True, False, 'test', 'Show', 1, '', '2025', skip_search=True,
                )
            self.assertTrue(result)
            saved = json.loads((tasks / 'test.json').read_text(encoding='utf-8'))
            self.assertEqual(Path(saved['output_dir']).name, category)
            video.unlink()


if __name__ == '__main__':
    unittest.main()
