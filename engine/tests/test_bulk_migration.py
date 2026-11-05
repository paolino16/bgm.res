import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.rename import bulk_executor as executor
from src.rename.bulk_migration import choose_episode
from src.rename.task_schema import atomic_write


class BulkMigrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.data = Path(temporary.name) / 'data'
        self.run = self.data / 'migrations' / 'run'
        self.run.mkdir(parents=True)
        for name in ('task', 'record', 'rename_plans'):
            (self.data / name).mkdir()
        p = patch.object(executor, 'DATA_PATH', self.data)
        p.start()
        self.addCleanup(p.stop)
        self.source = self.data / 'media' / 'Show (2025)' / 'Season 1' / 'old.mkv'
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b'original media')
        self.target = self.source.parent.parent / 'Show EP01.mkv'

    def task(self, task_id='one', source=None, target=None):
        source, target = source or self.source, target or self.target
        task = {'uuid': task_id, 'name': 'Show', 'layout': 'legacy', 'season_id': 1}
        record = {'status': 'completed', 'entries': {'original.mkv': {'target': str(source)}}}
        atomic_write(self.data / 'task' / f'{task_id}.json', task)
        atomic_write(self.data / 'record' / f'{task_id}.json', record)
        return {'uuid': task_id, 'name': 'Show', 'state': 'ready', 'task': task, 'record': record,
                'new_task': {**task, 'layout': 'bangumi', 'subject_id': '123', 'season_id': None,
                             'migration': {}}, 'bindings': [], 'mapping': {str(source): str(target)},
                'recoveries': [], 'problems': []}

    def prepare(self, tasks):
        atomic_write(self.run / 'plan.json', {'tasks': tasks})
        result = executor.compile_plan(self.run)
        self.assertEqual(result['issues'], [])
        return result

    def test_moves_media_and_updates_original_history_key(self):
        self.prepare([self.task()])
        result = executor.execute(self.run)
        self.assertEqual(result['state'], 'completed')
        self.assertEqual(self.target.read_bytes(), b'original media')
        self.assertFalse(self.source.exists())
        record = json.loads((self.data / 'record/one.json').read_bytes())
        self.assertEqual(record['entries']['original.mkv']['target'], str(self.target))
        self.assertEqual(executor.rollback(self.run)['state'], 'rolled_back')
        self.assertEqual(self.source.read_bytes(), b'original media')

    def test_interrupted_placement_can_be_recovered(self):
        self.prepare([self.task()])
        replace = os.replace
        def interrupt(source, target):
            if Path(target) == self.target:
                raise OSError('simulated interruption')
            return replace(source, target)
        with patch.object(executor.os, 'replace', side_effect=interrupt):
            with self.assertRaises(OSError):
                executor.execute(self.run)
        self.assertFalse(self.source.exists())
        self.assertEqual(executor.rollback(self.run)['state'], 'rolled_back')
        self.assertEqual(self.source.read_bytes(), b'original media')

    def test_shared_output_moves_once_and_updates_both_records(self):
        result = self.prepare([self.task('one'), self.task('two')])
        self.assertEqual(result['operations'], 1)
        executor.execute(self.run)
        for task_id in ('one', 'two'):
            record = json.loads((self.data / 'record' / f'{task_id}.json').read_bytes())
            self.assertEqual(record['entries']['original.mkv']['target'], str(self.target))

    def test_owned_directory_and_contents_can_move_and_roll_back(self):
        source = self.source.parent.parent / 'extra' / 'Scans'
        source.mkdir(parents=True)
        (source / 'cover.png').write_bytes(b'image')
        target = self.source.parent.parent / 'Extras' / 'Scans'
        self.prepare([self.task(source=source, target=target)])
        executor.execute(self.run)
        self.assertEqual((target / 'cover.png').read_bytes(), b'image')
        executor.rollback(self.run)
        self.assertEqual((source / 'cover.png').read_bytes(), b'image')

    def test_special_never_uses_regular_season_offset(self):
        model = {'id': '1', 'platform': 'TV', 'episodes': [
            {'id': 1, 'type': 0, 'sort': 3, 'name': 'Main'},
        ]}
        selected, category, _ = choose_episode(Path('Show SP03.mkv'), [model], 2, {'_catalog_offset': 0})
        self.assertIsNone(selected)
        self.assertEqual(category, 'special')

    def test_extra_episode_number_wins_over_title_sequel_number(self):
        model = {'id': '1', 'platform': 'TV', 'episodes': [
            {'id': 1, 'type': 1, 'sort': 1, 'name': 'First'},
            {'id': 3, 'type': 1, 'sort': 3, 'name': 'Third'},
        ]}
        selected, _, _ = choose_episode(Path('Show 3 [Extra Episode 01].mkv'), [model], 2, {})
        self.assertEqual(selected[1]['id'], 1)

    def test_unchanged_migrated_retry_keeps_confirmed_subject_bindings(self):
        from src.rename.reprocess import reprocess_task
        from src.rename.plan_resolution import task_context
        task = {'uuid': 'one', 'path': 'missing-download', 'layout': 'bangumi', 'bgm_id': '123'}
        task['migration'] = {'bulk_journal': 'journal.json', 'recognition_context': task_context(task)}
        record = {'entries': {'original': {'target': str(self.source)}}}
        with patch('src.utils.utils.get_record', return_value=record), \
             patch('src.rename.reprocess.Rename') as recognition:
            self.assertIsNone(reprocess_task(task))
        recognition.assert_not_called()

    def test_supplement_can_register_and_archive_a_duplicate_old_alias(self):
        task = self.task()
        alias = self.source.with_name('unregistered.mkv')
        os.link(self.source, alias)
        archive = self.run / 'aliases' / 'unregistered.mkv'
        task.update(mapping={str(alias): str(archive)}, allow_archive=True,
                    logical_mapping={str(alias): str(self.source)},
                    add_entries={str(alias): {'target': str(alias), 'provenance': 'discovered_legacy_output'}})
        self.prepare([task])
        executor.execute(self.run)
        record = json.loads((self.data / 'record/one.json').read_bytes())
        self.assertEqual(record['entries'][str(alias)]['target'], str(self.source))
        self.assertTrue(archive.exists())
        executor.rollback(self.run)
        self.assertTrue(alias.exists())



if __name__ == '__main__':
    unittest.main()
