import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.rename import bangumi_native as native, layout_migration as migration
from src.rename import plan_resolution as plans, process, trans
from src.rename.get_info import Search
from src.rename.task_schema import migrate_metadata, normalize_task, restore_metadata


def info():
    return {'source': 'bgm', 'id': 123, 'name': 'Show', 'platform': 'OVA',
            'first_air_date': '2025-01-01', 'release_date': '2025-01-01',
            'seasons': [], 'genres': [{'name': 'Animation'}],
            'bangumi_episodes': [
                {'id': 101, 'type': 0, 'sort': 1, 'ep': 1, 'name': 'First'},
                {'id': 102, 'type': 0, 'sort': 2, 'ep': 2, 'name': 'Second'},
                {'id': 103, 'type': 1, 'sort': 12.5, 'ep': 12.5, 'name': 'Special'},
                {'id': 104, 'type': 2, 'sort': 1, 'ep': None, 'name': 'Opening'},
            ]}


class NativeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.output = self.root / 'output'
        for folder in ('task', 'record', 'rename_plans'):
            (self.root / folder).mkdir()
        for target, key, value in (
            (process, 'TASK_PATH', self.root / 'task'),
            (plans, 'TASK_PATH', self.root / 'task'), (plans, 'PLAN_PATH', self.root / 'rename_plans'),
            (trans, 'RECORD_PATH', self.root / 'record'),
            (migration, 'TASK_PATH', self.root / 'task'), (migration, 'RECORD_PATH', self.root / 'record'),
            (migration, 'DATA_PATH', self.root),
        ):
            p = patch.object(target, key, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(process, 'logger')
        p.start()
        self.addCleanup(p.stop)

    def file(self, name, parent=None):
        path = (parent or self.source) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(name.encode())
        return path

    def test_torrent_manifest_survives_review_and_duplicate_completion(self):
        from src import integration_api as api
        videos = [self.file('Show [01].mkv'), self.file('Show [02].mkv')]
        subtitle = self.file('Show [01].chs.ass')
        self.file('Show [03].mkv')
        self.file('Show [01].eng.ass')
        files = list(map(str, [*videos, subtitle]))
        body = {'torrent': '1' * 40, 'path': str(self.source), 'files': files, 'title': 'Show'}
        worker = process.Rename.__new__(process.Rename)
        worker.ANIME_PATH = worker.ANIME_MOVIE_PATH = self.output
        worker.ai_processor = Mock()
        worker.ai_processor.ai_client.is_available.return_value = False
        worker.search = Mock()
        worker.search.get_bangumi_all_episodes.return_value = info()['bangumi_episodes']
        worker.search.get_bangumi_relations.return_value = []
        worker.resolve_task_type = Mock(return_value=('Show', 2025, ('Show', info(), True, False)))
        with patch.object(process, 'Rename', return_value=worker), patch.object(api, 'TASK_PATH', self.root / 'task'):
            result = api.recognize(body)
            task_id = result['task_id']
            self.assertIsNone(result['error'])
            plan = plans.load_plan(task_id)
            self.assertEqual(set(plan['mapping']), set(files))
            checked = plans.check_saved_plan(task_id, plan['revision'], plan['rows'])
            self.assertEqual(set(checked['mapping']), set(map(Path, files)))
            self.assertFalse(checked['issues'])
            self.assertEqual(api.recognize(body), result)
            self.assertEqual(plans.load_plan(task_id)['revision'], plan['revision'])
            worker.resolve_task_type.assert_called_once()
            self.assertFalse(self.output.exists())

    def test_multiple_selected_subjects_require_explicit_file_assignment(self):
        from src.integration_api import reviewing
        first = self.file('TV/Show [01].mkv')
        second = self.file('OVA/Show [01].mkv')
        worker = process.Rename.__new__(process.Rename)
        worker.R = {}
        worker.ANIME_PATH = worker.ANIME_MOVIE_PATH = self.output
        worker.ai_processor = Mock()
        worker.ai_processor.ai_client.is_available.return_value = False
        worker.selected_subject_ids = ['123', '456']
        worker.search = Mock()
        worker.search.get_bangumi_all_episodes.return_value = info()['bangumi_episodes']
        worker.search.get_bangumi_relations.return_value = []
        worker.resolve_task_type = Mock(return_value=('Show', 2025, ('Show', info(), True, False)))
        extra = {'subject_id': '456', 'name': 'Other Show', 'platform': 'OVA',
                 'episodes': [{'id': 201, 'type': 0, 'sort': 1, 'ep': 1}],
                 'work_path': str(self.output / 'Other Show (2025)')}
        with patch.object(trans.cm, 'get_config', return_value='复制'), \
             patch.object(plans, 'load_subject_context', return_value=extra), reviewing():
            worker.process(self.source, True, False, 'multi')
        plan = plans.load_plan('multi')
        self.assertEqual(plan['state'], 'pending')
        self.assertEqual(plan['context']['subjects']['456'], extra)
        self.assertTrue(plan['context']['requires_subject_assignment'])
        self.assertEqual(plan['mapping'], {})
        self.assertEqual(len(plan['rows']), 2)
        self.assertTrue(all(not row['subject_id'] and row['category'] == 'unresolved' for row in plan['rows']))
        task = json.loads((self.root / 'task/multi.json').read_text(encoding='utf-8'))
        self.assertEqual(task['subject_ids'], ['123', '456'])
        with self.assertRaisesRegex(ValueError, '请选择归属作品'):
            plans.build_adjusted_mapping(plan, plan['rows'])
        rows = copy.deepcopy(plan['rows'])
        for row in rows:
            row.update(subject_id='123' if row['source'] == str(first) else '456',
                       episode_id=101 if row['source'] == str(first) else 201, category='episode', manual_mapping=True)
        mapping, _ = plans.build_adjusted_mapping(plan, rows)
        self.assertEqual(mapping[first].parent, self.output / 'Show (2025)')
        self.assertEqual(mapping[second].parent, self.output / 'Other Show (2025)')
        with patch.object(trans.cm, 'get_config', return_value='复制'):
            checked = plans.check_saved_plan('multi', plan['revision'], rows, collect_errors=True)
        self.assertEqual(checked['row_errors'], {})
        self.assertEqual(checked['issues'], [])
        self.assertTrue(first.exists() and second.exists())
        self.assertFalse(self.output.exists())

    def test_subject_chapters_have_no_seasons_and_keep_decimal_specials(self):
        a = self.file('Show OVA01.mkv')
        b = self.file('Show OVA02.mkv')
        special = self.file('Specials/Show SP12.5.mkv')
        opening = self.file('Show NCOP.mkv')
        sub = self.file('Show OVA01.chs.ass')
        mapping, bindings = native.plan_subject(self.source, info(), self.output, 'Group')
        self.assertEqual(mapping[a], self.output / 'Show EP01 [Group].mkv')
        self.assertEqual(mapping[b], self.output / 'Show EP02 [Group].mkv')
        self.assertEqual(mapping[special], self.output / 'Specials/Show SP12.5 [Group].mkv')
        self.assertEqual(mapping[opening], self.output / 'Extras/Show OP01 [Group].mkv')
        self.assertEqual(mapping[sub], mapping[a].with_suffix('.chs.ass'))
        self.assertEqual({b['episode_id'] for b in bindings}, {101, 102, 103, 104})

    def test_space_release_group_does_not_mark_regular_episodes_as_specials(self):
        files = [self.file(f'[Q_Vageena&Space][Gundam_ZZ][{n:02}][BDRIP][X264_FLAC][1492x1080][D6BCF8DC].mkv')
                 for n in (1, 2)]
        mapping, bindings = native.plan_subject(self.source, info(), self.output, 'Q_Vageena')
        self.assertEqual([b['episode_id'] for b in bindings], [101, 102])
        self.assertTrue(all(b['episode_type'] == 0 for b in bindings))
        self.assertTrue(all(mapping[p].parent == self.output for p in files))
        for marker in ('SP01', 'Special01', 'SP 01', 'Special 01'):
            self.assertEqual(native.file_hint(self.source / (marker + '.mkv'), self.source), (1, '1'))

    def test_unmatched_video_is_not_silently_a_special(self):
        unknown = self.file('Show OVA99.mkv')
        mapping, bindings = native.plan_subject(self.source, info(), self.output, '')
        self.assertNotIn(unknown, mapping)
        self.assertEqual(bindings[0]['category'], 'unresolved')

    def test_extra_pack_preserves_nested_resources(self):
        video = self.file('extra/interview/01.mkv')
        image = self.file('extra/booklet/cover.png')
        mapping, _ = native.plan_subject(self.source, info(), self.output, '')
        self.assertEqual(mapping[video], self.output / 'Extras/interview/01.mkv')
        self.assertEqual(mapping[image], self.output / 'Extras/booklet/cover.png')

    def test_new_non_ai_task_uses_native_model_end_to_end(self):
        self.file('Show OVA01.mkv')
        worker = process.Rename.__new__(process.Rename)
        worker.R = {}
        worker.ANIME_PATH = worker.ANIME_MOVIE_PATH = self.output
        worker.ai_processor = Mock()
        worker.ai_processor.ai_client.is_available.return_value = False
        worker.search = Mock()
        worker.search.get_bangumi_all_episodes.return_value = info()['bangumi_episodes']
        worker.search.get_bangumi_relations.return_value = [{'id': 456, 'relation': '续集'}]
        worker.resolve_task_type = Mock(return_value=('Show', 2025, ('Show', info(), True, False)))
        with patch.object(trans.cm, 'get_config', return_value='复制'):
            self.assertTrue(worker.process(self.source, True, False, 'new'))
        task = json.loads((self.root / 'task/new.json').read_text(encoding='utf-8'))
        self.assertEqual(task['layout'], 'bangumi')
        self.assertIsNone(task['season_id'])
        self.assertEqual(task['subject_id'], '123')
        self.assertEqual(task['episode_bindings'][0]['episode_id'], 101)
        self.assertTrue((self.output / 'Show (2025)/Show EP01.mkv').exists())

    def test_old_task_keeps_legacy_layout_on_retry(self):
        self.file('Show - 01.mkv')
        (self.root / 'task/old.json').write_text(json.dumps({'uuid': 'old', 'bgm_id': '123'}))
        worker = process.Rename.__new__(process.Rename)
        worker.R = {}
        worker.ANIME_PATH = worker.BANGUMI_PATH = self.output
        worker.ai_processor = Mock()
        worker.ai_processor.ai_client.is_available.return_value = False
        worker.search = Mock()
        worker.resolve_task_type = Mock(return_value=('Show', 2025, ('Show', info(), True, False)))
        with patch.object(trans.cm, 'get_config', return_value='复制'):
            self.assertTrue(worker.process(self.source, True, False, 'old'))
        worker.search.get_bangumi_all_episodes.assert_not_called()
        self.assertTrue((self.output / 'Show (2025)/Season 1/Show S01E01.mkv').exists())
        saved = json.loads((self.root / 'task/old.json').read_bytes())
        self.assertEqual(saved['metadata_source'], 'bangumi')
        self.assertEqual(saved['subject_id'], '123')

    def test_all_chapter_types_and_pages_are_fetched(self):
        search = Search.__new__(Search)
        search.last_error = None
        episodes = info()['bangumi_episodes']
        with patch.object(search, '_bangumi_request', side_effect=[
            {'total': 4, 'data': episodes[:2]}, {'total': 4, 'data': episodes[2:]},
        ]) as send:
            self.assertEqual(len(search.get_bangumi_all_episodes(123)), 4)
        self.assertIn('offset=2', send.call_args.args[0])
        self.assertNotIn('type=0', send.call_args.args[0])

    def test_partial_catalog_is_rejected(self):
        search = Search.__new__(Search)
        with patch.object(search, '_bangumi_request', side_effect=[
            {'total': 2, 'data': info()['bangumi_episodes'][:1]}, {'total': 2, 'data': []},
        ]):
            self.assertIsNone(search.get_bangumi_all_episodes(123))

    def test_catalog_sort_wins_over_different_sequential_ep_field(self):
        video = self.file('Show EP01.mkv')
        model = info()
        model['bangumi_episodes'] = [
            {'id': 1, 'type': 0, 'sort': 0, 'ep': 1, 'name': 'Prologue'},
            {'id': 2, 'type': 0, 'sort': 1, 'ep': 2, 'name': 'Episode one'},
        ]
        _, decisions = native.plan_subject(self.source, model, self.output, '')
        self.assertEqual(decisions[0]['episode_id'], 2)

    def test_explicit_bgm_id_overrides_old_non_anime_flag(self):
        worker = process.Rename.__new__(process.Rename)
        worker.search = Mock()
        worker.search.get_bangumi_info.return_value = ('Show', info())
        worker.search.is_bangumi_movie_info.return_value = False
        result = worker.check_task_type('old', 'Show', 0, self.source,
                                        is_anime=False, custom_bgm_id='123')
        self.assertEqual(result[2], True)
        worker.search.get_bangumi_info.assert_called_once()
        worker.search.get_tv_info.assert_not_called()

    def test_metadata_migration_backs_up_without_touching_media_or_history(self):
        task = {'uuid': 'old', 'bgm_id': '123', 'season_id': 2, 'output_dir': 'old/Season 2'}
        raw = json.dumps(task).encode()
        (self.root / 'task/old.json').write_bytes(raw)
        record = self.root / 'record/old.json'
        record.write_bytes(b'{"original": "old/output.mkv"}')
        video = self.file('untouched.mkv')
        original_video = video.read_bytes()
        self.assertFalse(migrate_metadata(self.root)['applied'])
        report = migrate_metadata(self.root, apply=True)
        self.assertTrue(report['applied'])
        self.assertEqual((Path(report['backup']) / 'task/old.json').read_bytes(), raw)
        self.assertEqual(record.read_bytes(), b'{"original": "old/output.mkv"}')
        self.assertEqual(video.read_bytes(), original_video)
        upgraded = json.loads((self.root / 'task/old.json').read_bytes())
        self.assertEqual(upgraded['layout'], 'legacy')
        self.assertEqual(upgraded['migration']['legacy_season_id'], 2)
        self.assertEqual(upgraded, normalize_task(upgraded))
        self.assertEqual(migrate_metadata(self.root, apply=True)['tasks'], 0)
        self.assertEqual(restore_metadata(self.root, report['backup']), {'restored': 1})
        self.assertEqual((self.root / 'task/old.json').read_bytes(), raw)

    def test_metadata_restore_refuses_to_overwrite_later_edits(self):
        path = self.root / 'task/old.json'
        path.write_text('{"uuid": "old", "bgm_id": "123"}')
        report = migrate_metadata(self.root, apply=True)
        path.write_text('{"uuid": "old", "name": "Edited"}')
        with self.assertRaisesRegex(ValueError, '修改'):
            restore_metadata(self.root, report['backup'])

    def test_metadata_upgrade_preserves_explicit_legacy_plan_context(self):
        task = {'uuid': 'old', 'bgm_id': '123', 'season_id': 2}
        task['file_plan_context'] = plans.task_context(task)
        # Simulate decisions written before layout/subject_id existed.
        task['file_plan_context'].pop('layout')
        task['file_plan_context'].pop('subject_id')
        upgraded = normalize_task(task)
        self.assertEqual(upgraded['file_plan_context'], plans.task_context(upgraded))

    def migration_plan(self, count=1):
        old_root = self.output / 'Show (2025)'
        paths = [self.file(f'Season 1/Show S01E{n:02d}.mkv', old_root) for n in range(1, count + 1)]
        mirror = self.file('mirror/Show01.mkv', self.root)
        task = {'uuid': 'old', 'path': str(self.root / 'missing-original'), 'name': 'Show',
                'bgm_id': '123', 'season_id': 1, 'output_dir': str(old_root / 'Season 1'), 'use_ai': False}
        entries = {str(self.root / f'missing-original/{n}.mkv'): {'target': str(path)}
                   for n, path in enumerate(paths, 1)}
        entries[next(iter(entries))]['mirror'] = str(mirror)
        record = {'status': 'completed', 'entries': entries}
        (self.root / 'task/old.json').write_text(json.dumps(task), encoding='utf-8')
        (self.root / 'record/old.json').write_text(json.dumps(record), encoding='utf-8')
        search = Mock()
        search.get_bangumi_info.return_value = ('Show', info())
        search.get_bangumi_all_episodes.return_value = info()['bangumi_episodes']
        search.get_bangumi_relations.return_value = []
        with patch.object(migration, 'Search', return_value=search):
            plan = migration.prepare_layout_migration('old')
        return plan, paths, task, record, mirror

    def test_migrate_recorded_outputs_even_when_originals_are_gone(self):
        plan, paths, task, record, mirror = self.migration_plan()
        self.assertTrue(paths[0].exists())  # Preview has no media side effects.
        rows = copy.deepcopy(plan['rows'])
        checked = plans.check_saved_plan('old', plan['revision'], rows)
        self.assertEqual(checked['issues'], [])
        self.assertIsNone(plans.execute_saved_plan('old', plan['revision'], rows, checked['token']))
        updated = json.loads((self.root / 'record/old.json').read_bytes())
        original = next(iter(record['entries']))
        self.assertEqual(updated['entries'][original]['mirror'], str(mirror))
        self.assertTrue(mirror.exists())
        self.assertTrue(Path(updated['entries'][original]['target']).exists())
        self.assertFalse(paths[0].exists())
        self.assertEqual(updated['episode_bindings'][0]['source'], original)
        self.assertTrue(Path(updated['migration_journal']).exists())

    def test_migration_conflict_keeps_old_outputs_and_records(self):
        plan, paths, task, record, _ = self.migration_plan()
        target = Path(plan['rows'][0]['original_target'])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'unrelated')
        checked = plans.check_saved_plan('old', plan['revision'], plan['rows'])
        self.assertTrue(checked['issues'])
        self.assertIsInstance(plans.execute_saved_plan('old', plan['revision'], plan['rows'], checked['token']), str)
        self.assertTrue(paths[0].exists())
        self.assertEqual(target.read_bytes(), b'unrelated')
        self.assertEqual(json.loads((self.root / 'record/old.json').read_bytes()), record)
        self.assertEqual(json.loads((self.root / 'task/old.json').read_bytes()), task)

    def test_review_can_assign_a_file_to_another_subject(self):
        plan, paths, task, record, _ = self.migration_plan()
        search = Mock()
        other = {**info(), 'id': 456, 'name': 'Show sequel'}
        search.get_bangumi_info.return_value = ('Show sequel', other)
        search.get_bangumi_all_episodes.return_value = [
            {'id': 201, 'type': 0, 'sort': 1, 'ep': 1, 'name': 'Sequel opening'},
        ]
        with patch('src.rename.get_info.Search', return_value=search):
            plans.add_plan_subject('old', plan['revision'], 456)
        rows = copy.deepcopy(plan['rows'])
        rows[0].update(subject_id='456', episode_id=201, category='episode')
        checked = plans.check_saved_plan('old', plan['revision'], rows)
        self.assertEqual(checked['issues'], [])
        self.assertIn('Show sequel (2025)', str(checked['mapping'][paths[0]]))
        self.assertIsNone(plans.execute_saved_plan('old', plan['revision'], rows, checked['token']))
        updated = json.loads((self.root / 'task/old.json').read_bytes())
        self.assertEqual(updated['episode_bindings'][0]['subject_id'], '456')
        self.assertEqual(updated['episode_bindings'][0]['episode_id'], 201)

    def test_migration_never_moves_an_unrecorded_companion(self):
        plan, paths, task, record, _ = self.migration_plan()
        unowned = paths[0].with_suffix('.chs.ass')
        unowned.write_bytes(b'unrelated subtitle')
        checked = plans.check_saved_plan('old', plan['revision'], plan['rows'])
        self.assertNotIn(unowned, checked['mapping'])



    def test_migration_rolls_back_first_move_when_second_fails(self):
        plan, paths, task, record, _ = self.migration_plan(count=2)
        checked = plans.check_saved_plan('old', plan['revision'], plan['rows'])
        replace = os.replace
        def fail_second(source, target):
            if Path(source) == paths[1]:
                raise OSError('simulated move failure')
            return replace(source, target)
        with patch.object(migration.os, 'replace', side_effect=fail_second):
            result = plans.execute_saved_plan('old', plan['revision'], plan['rows'], checked['token'])
        self.assertIn('已回退', result)
        self.assertTrue(all(path.exists() for path in paths))
        self.assertEqual(json.loads((self.root / 'record/old.json').read_bytes()), record)
        self.assertEqual(json.loads((self.root / 'task/old.json').read_bytes()), task)

    def test_completed_migration_can_be_rolled_back_from_its_journal(self):
        plan, paths, task, record, _ = self.migration_plan()
        checked = plans.check_saved_plan('old', plan['revision'], plan['rows'])
        self.assertIsNone(plans.execute_saved_plan('old', plan['revision'], plan['rows'], checked['token']))
        updated = json.loads((self.root / 'record/old.json').read_bytes())
        result = migration.recover_layout_migration(updated['migration_journal'])
        self.assertEqual(result['restored_files'], 1)
        self.assertTrue(paths[0].exists())
        self.assertEqual(json.loads((self.root / 'record/old.json').read_bytes()), record)
        self.assertEqual(json.loads((self.root / 'task/old.json').read_bytes()), task)

    def test_recovery_finds_move_that_happened_before_journal_update(self):
        plan, paths, task, record, _ = self.migration_plan()
        source = paths[0]
        target = Path(plan['rows'][0]['original_target'])
        stat = source.lstat()
        journal = {'state': 'prepared', 'task_id': 'old', 'task': task, 'record': record,
                   'operations': {str(source): str(target)}, 'completed': [],
                   'identities': {str(source): [stat.st_dev, stat.st_ino]}}
        path = self.root / 'interrupted.json'
        path.write_text(json.dumps(journal))
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
        self.assertEqual(migration.recover_layout_migration(path)['restored_files'], 1)
        self.assertTrue(source.exists())


if __name__ == '__main__':
    unittest.main()
