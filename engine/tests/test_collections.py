import tempfile
import unittest
from pathlib import Path

from src.rename.plan_resolution import build_adjusted_mapping
from src.rename.bangumi_native import collection_episodes


class CollectionTests(unittest.TestCase):
    def test_collection_and_subtitle_live_under_main_work(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            video = root / 'combined.mkv'
            video.touch()
            subtitle = root / 'combined.chs.ass'
            subtitle.touch()
            episodes = [{'id': 11, 'type': 0, 'sort': 1}, {'id': 12, 'type': 0, 'sort': 2}]
            row = {'source': str(video), 'original_target': '', 'category': 'unresolved'}
            plan = {'rows': [row], 'mapping': {}, 'context': {
                'layout': 'bangumi', 'subject_id': '1', 'name': '再见绝望先生',
                'work_path': str(root / 'library'), 'subtitle_group': 'Group', 'episodes': episodes}}
            edited = dict(row, category='collection', episode_ids=[12, 11])
            mapping, skipped = build_adjusted_mapping(plan, [edited])
            target = root / 'library' / '合集' / '再见绝望先生 [Group].mkv'
            self.assertEqual(mapping[video], target)
            self.assertEqual(mapping[subtitle], target.with_suffix('.chs.ass'))
            self.assertFalse(skipped)
            edited['episode_ids'] = [11, 99]
            with self.assertRaises(ValueError):
                build_adjusted_mapping(plan, [edited])

    def test_collection_requires_multiple_distinct_known_chapters(self):
        subject = {'episodes': [{'id': 1, 'type': 0, 'sort': 1}]}
        for ids in ([], [1], [1, 1], [1, 2]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                collection_episodes(subject, {'episode_ids': ids})
