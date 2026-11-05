import tempfile
import unittest
from pathlib import Path

from src.utils.output_locations import native_output_directories


class OutputLocationTests(unittest.TestCase):
    def test_native_task_includes_sequel_and_nested_extras_without_mirror(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            primary, sequel, mirror = (base / name for name in ('library/Show', 'library/Show Part2', 'mirror/Show'))
            for directory in (primary, sequel / 'Extras', mirror):
                directory.mkdir(parents=True)
            task = {'layout': 'bangumi', 'output_dir': str(primary)}
            record = {'entries': {'a': {'target': str(primary / 'EP01.mkv'), 'mirror': str(mirror / 'old.mkv')},
                                  'b': {'target': str(sequel / 'EP12.mkv')},
                                  'c': {'target': str(sequel / 'Extras/NCOP.mkv')}}}
            self.assertEqual(native_output_directories(task, record), [primary, sequel])

    def test_ignores_unavailable_or_outside_library_locations(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            primary = base / 'library/Show'
            primary.mkdir(parents=True)
            outside = base / 'outside'
            outside.mkdir()
            task = {'layout': 'bangumi', 'output_dir': str(primary)}
            record = {'entries': {'a': str(base / 'library/Missing/EP01.mkv'), 'b': str(outside / 'EP02.mkv')}}
            self.assertEqual(native_output_directories(task, record), [primary])

    def test_legacy_task_uses_existing_season_directory_behavior(self):
        self.assertEqual(native_output_directories({'layout': 'legacy', 'output_dir': 'anything'}, {}), [])
