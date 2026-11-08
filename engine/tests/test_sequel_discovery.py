import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock
from src.rename.subject_discovery import discover_ambiguous, sequel_candidates


def catalog(start, end):
    return [{'type': 0, 'sort': i} for i in range(start, end + 1)]


def pending(numbers, folder='Show', kind=0):
    return [{'source': f'{folder}/Show {i}.mkv', 'category': 'unresolved',
             'episode_type': kind, 'episode': i} for i in numbers]


class SequelDiscoveryTests(unittest.TestCase):
    links = [{'id': 2, 'type': 2, 'relation': '续集', 'name': 'Second'}]

    def test_uncovered_run_checks_sequel_without_requiring_episode_zero(self):
        search = Mock()
        for episodes, reason in ((catalog(13, 24), '对应集号'), (catalog(1, 12), '请核对')):
            search.get_bangumi_all_episodes.return_value = episodes
            rows = pending(range(13, 25))
            result = sequel_candidates(rows, catalog(1, 12), self.links, search)
            self.assertEqual([s['id'] for s in result], [2])
            self.assertIn(reason, result[0]['suggestion_reason'])
            self.assertEqual({r['category'] for r in rows}, {'unresolved'})

    def test_covered_earlier_special_fractional_and_separate_folder_rows_are_quiet(self):
        search = Mock()
        for rows in (pending(range(1, 13)), pending([13]), pending([13, 15]),
                     pending([13, 14], kind=1), pending([13.5, 14]),
                     pending([13], 'A') + pending([14], 'B')):
            self.assertFalse(sequel_candidates(rows, catalog(1, 12), self.links, search))
        self.assertFalse(sequel_candidates(pending(range(1, 12)), catalog(12, 23), self.links, search))
        search.get_bangumi_all_episodes.assert_not_called()

    def test_ambiguous_title_does_not_fetch_catalog_for_numbered_release(self):
        with TemporaryDirectory() as folder:
            for ep in range(26):
                (Path(folder) / f'Show [{ep:02}].mkv').touch()
            search = Mock(network_error=None, last_bangumi_candidates=[{'id': 1}, {'id': 2, 'season': 2}])
            discover_ambiguous(Path(folder), search)
            search.get_bangumi_all_episodes.assert_not_called()
            search.get_bangumi_relations.assert_not_called()
