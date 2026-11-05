import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.rename import plan_resolution as plans, trans
from src.rename.rename_strategy import distinguish_versions, companions


class StrategyTests(unittest.TestCase):
    def test_subtitles_belong_to_longest_video_stem(self):
        a, b = Path('Show.mkv'), Path('Show.01.mkv')
        sub = Path('Show.01.chs.ass')
        self.assertEqual(companions(a, [a, b, sub]), [])
        self.assertEqual(companions(b, [a, b, sub]), [sub])
    def test_explicit_quality_versions_and_companions(self):
        a = Path('source/[Group] Show 01 1080p.mkv')
        b = Path('source/[Group] Show 01 720p.mkv')
        sub = a.with_suffix('.chs.ass')
        other = Path('other') / sub.name
        target = Path('library/Season 1/Show S01E01.mkv')
        mapping, changes = distinguish_versions({a: target, b: target,
                                                sub: target.with_suffix('.chs.ass'), other: Path('other/keep.ass')})
        self.assertEqual(len(changes), 2)
        self.assertIn('1080p', mapping[a].name)
        self.assertEqual(mapping[sub].stem, mapping[a].stem + '.chs')
        self.assertEqual(mapping[other], Path('other/keep.ass'))

    def test_ambiguous_files_remain_colliding(self):
        target = Path('Show S01E01.mkv')
        original = {Path('Show 01.mkv'): target, Path('Show 02.mkv'): target}
        mapping, changes = distinguish_versions(original)
        self.assertEqual(mapping, original)
        self.assertEqual(changes, [])

    def test_release_v2_distinguishes_default_v1(self):
        target = Path('Show S01E01.mkv')
        mapping, changes = distinguish_versions({Path('Show 01.mkv'): target, Path('Show 01 v2.mkv'): target})
        self.assertEqual(len(changes), 2)
        self.assertEqual(len(set(mapping.values())), 2)
        self.assertTrue(any('[v1]' in p.name for p in mapping.values()))

    def test_different_episode_hints_are_not_hidden_by_quality_versions(self):
        target = Path('Show S01E01.mkv')
        original = {Path('Show 01 1080p.mkv'): target, Path('Show 02 720p.mkv'): target}
        self.assertEqual(distinguish_versions(original), (original, []))

    def test_macross_named_cuts_and_their_own_subtitles(self):
        prefix = '[VCB-Studio] Macross Frontier '
        normal = Path('source') / f'{prefix}[01][Ma10p_1080p][x265_flac].mkv'
        deculture = Path('source') / f'{prefix}[01 (Deculture Ver.)][Ma10p_1080p][x265_flac].mkv'
        yack = Path('source') / f'{prefix}[01 (Yack Deculture Ver.)][Ma10p_1080p][x265_flac_aac].mkv'
        target = Path('library/Season 1/超时空要塞F S01E01 [VCB-Studio].mkv')
        original = {normal: target, deculture: target, yack: target}
        subtitles = {normal: normal.with_suffix('.sc.ass'), deculture: deculture.with_suffix('.sc.ass'),
                     yack: yack.with_suffix('.ass')}
        for video, subtitle in subtitles.items():
            original[subtitle] = target.with_suffix('.sc.ass' if subtitle.name.endswith('.sc.ass') else '.ass')
        mapping, changes = distinguish_versions(original)
        self.assertEqual(mapping[normal], target)
        self.assertEqual(mapping[deculture].name, '超时空要塞F S01E01 [VCB-Studio] [Deculture Ver.].mkv')
        self.assertEqual(mapping[yack].name, '超时空要塞F S01E01 [VCB-Studio] [Yack Deculture Ver.].mkv')
        self.assertEqual(len(set(mapping.values())), len(mapping))
        self.assertEqual(len(changes), 2)
        for video, subtitle in subtitles.items():
            suffix = '.sc.ass' if subtitle.name.endswith('.sc.ass') else '.ass'
            self.assertEqual(mapping[subtitle].name, mapping[video].stem + suffix)

    def test_named_cut_is_preserved_even_without_collision(self):
        source = Path('Show [01 (Deculture Ver.)] [1080p].mkv')
        target = Path('Show S01E01.mkv')
        mapping, changes = distinguish_versions({source: target})
        self.assertEqual(mapping[source].name, 'Show S01E01 [Deculture Ver.].mkv')
        self.assertEqual(changes[0]['version'], 'Deculture Ver.')
        self.assertEqual(distinguish_versions(mapping), (mapping, []))

    def test_duplicate_same_cut_still_requires_resolution(self):
        target = Path('Show S01E01.mkv')
        sources = [Path('a/Show 01 (Deculture Ver.).mkv'), Path('b/Show 01 (Deculture Ver.).mkv')]
        mapping, _ = distinguish_versions(dict.fromkeys(sources, target))
        self.assertEqual(mapping[sources[0]], mapping[sources[1]])

    def test_cut_names_do_not_hide_wrong_episode_mapping(self):
        target = Path('Show S01E01.mkv')
        original = {Path('Show 01 (Deculture Ver.).mkv'): target,
                    Path('Show 02 (Yack Deculture Ver.).mkv'): target}
        self.assertEqual(distinguish_versions(original), (original, []))

    def test_screenshot_names_are_parsed_as_episode_one(self):
        from src.rename.process import Rename
        rename = Rename.__new__(Rename)
        for edition in ('', ' (Deculture Ver.)', ' (Yack Deculture Ver.)'):
            source = Path(f'[VCB-Studio] Macross Frontier [01{edition}][Ma10p_1080p][x265_flac].mkv')
            self.assertEqual(rename._extract_episode_identity(source, 'Macross Frontier', 1), (1, 1))

    def test_macross_cut_mapping_and_copy_keep_every_video_and_subtitle(self):
        from src.rename.process import Rename
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            records = root / 'records'
            records.mkdir()
            videos = []
            for edition in ('', ' (Deculture Ver.)', ' (Yack Deculture Ver.)'):
                video = source / f'[VCB-Studio] Macross Frontier [01{edition}][Ma10p_1080p][x265_flac].mkv'
                video.write_bytes(('video' + edition).encode())
                video.with_suffix('.sc.ass').write_bytes(('subtitle' + edition).encode())
                videos.append(video)
            rename = Rename.__new__(Rename)
            rename.R = {}
            with patch('src.rename.process.logger'):
                for video in videos:
                    rename.process_sub('Macross Frontier', None, video, list(source.iterdir()),
                                       root / 'library', '超时空要塞F', 1, 'VCB-Studio')
            self.assertEqual(len(rename.R), 6)
            self.assertTrue(all(target.parent.name == 'Season 1' for target in rename.R.values()))
            with patch.object(trans, 'RECORD_PATH', records), \
                 patch.object(trans.cm, 'get_config', return_value='复制'), patch.object(trans, 'logger'):
                worker = trans.Trans(rename.R, 'cuts', source_root=source, save_plan=False)
                self.assertIsNone(worker.trans_file())
            self.assertEqual(len(set(worker.R.values())), 6)
            for original, target in worker.R.items():
                self.assertEqual(original.read_bytes(), target.read_bytes())


class ResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.records = self.root / 'records'
        self.records.mkdir()
        self.tasks = self.root / 'tasks'
        self.tasks.mkdir()
        self.work = self.root / 'library' / 'Example'
        self.target = self.work / 'Season 1' / 'Example S01E01.mkv'
        self.a = self.source / 'Show 01.mkv'
        self.b = self.source / 'Show 01 duplicate.mkv'
        for source in (self.a, self.b):
            source.write_bytes(source.name.encode())
            source.with_suffix('.chs.ass').write_bytes(b'subtitle')
        for p in (patch.object(plans, 'PLAN_PATH', self.root / 'plans'),
                  patch.object(plans, 'TASK_PATH', self.tasks),
                  patch.object(trans, 'RECORD_PATH', self.records),
                  patch.object(trans, 'logger'),
                  patch.object(trans.cm, 'get_config', return_value='复制')):
            p.start()
            self.addCleanup(p.stop)
        self.task = {'uuid': 'task', 'path': str(self.source), 'name': 'Example', 'season_id': 1, 'error': '冲突'}
        (self.tasks / 'task.json').write_text(json.dumps(self.task), encoding='utf-8')
        self.worker = trans.Trans({self.a: self.target, self.b: self.target}, 'task', self.source,
                                  plan_context={'work_path': str(self.work), 'name': 'Example'})
        self.assertIn('执行前检查未通过', self.worker.trans_file())
        self.plan = plans.load_plan('task')

    def rows(self):
        return sorted(copy.deepcopy(self.plan['rows']), key=lambda r: (
            0 if r['source'] == str(self.a) else 1 if r['source'] == str(self.b) else 2, r['source']))

    def test_human_confirmation_metadata_is_saved_without_retargeting_or_bypassing_conflict(self):
        rows = self.rows()
        before = self.check(rows)
        rows[0]['manual_mapping'] = True
        rows[0]['mapping_confirmation'] = 'accepted-current-mapping'
        checked = self.check(rows)
        self.assertEqual(checked['mapping'], before['mapping'])
        self.assertEqual(checked['issues'], before['issues'])
        self.assertTrue(checked['issues'])
        self.assertNotEqual(checked['token'], before['token'])
        saved = plans.load_plan('task')['draft_rows']
        self.assertEqual(saved[0]['mapping_confirmation'], 'accepted-current-mapping')
        self.assertFalse(self.target.exists())
        self.assertTrue(self.a.exists())
        with self.assertRaisesRegex(ValueError, '调整已改变'):
            plans.execute_saved_plan('task', self.plan['revision'], rows, before['token'])
        self.assertFalse(self.target.exists())

    def check(self, rows):
        return plans.check_saved_plan('task', self.plan['revision'], rows)

    def apply(self, rows):
        checked = self.check(rows)
        self.assertEqual(checked['issues'], [])
        return plans.execute_saved_plan('task', self.plan['revision'], rows, checked['token'])

    def test_manual_episode_correction_and_subtitles(self):
        rows = self.rows()
        rows[1]['episode'] = 2
        self.assertIsNone(self.apply(rows))
        target2 = self.target.with_name('Example S01E02.mkv')
        self.assertEqual(target2.read_bytes(), self.b.read_bytes())
        self.assertEqual(target2.with_suffix('.chs.ass').read_bytes(), b'subtitle')
        task = json.loads((self.tasks / 'task.json').read_text())
        self.assertIsNone(task['error'])
        self.assertEqual(task['file_decisions'], rows)

    def test_version_choice_preserves_both_videos(self):
        rows = self.rows()
        rows[0]['version'] = 'v1'
        rows[1]['version'] = 'v2'
        self.assertIsNone(self.apply(rows))
        self.assertTrue(self.target.with_name('Example S01E01 [v1].mkv').exists())
        self.assertTrue(self.target.with_name('Example S01E01 [v2].chs.ass').exists())

    def test_skip_one_keeps_old_outputs_and_companions(self):
        old = self.work / 'old.mkv'
        old.parent.mkdir(parents=True)
        old.write_bytes(b'keep old')
        (self.records / 'task.json').write_text(json.dumps({'entries': {str(self.b): {'target': str(old)}}}))
        rows = self.rows()
        rows[1]['skip'] = True
        preview = self.check(rows)['preview']
        self.assertTrue(any(item['source'] == str(self.b) and item['action'] == '跳过' for item in preview))
        self.assertIsNone(self.apply(rows))
        self.assertEqual(old.read_bytes(), b'keep old')
        self.assertTrue(self.b.with_suffix('.chs.ass').exists())
        record = json.loads((self.records / 'task.json').read_text())
        self.assertIn(str(self.b), record['entries'])

    def test_skip_all_does_not_delete_old_outputs(self):
        rows = self.rows()
        for row in rows:
            row['skip'] = True
        self.assertIsNone(self.apply(rows))
        self.assertFalse(self.work.exists())
        self.assertTrue(self.a.exists())

    def test_occupied_target_rename_or_skip_without_overwrite(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b'another task')
        rows = self.rows()
        rows[0]['version'] = 'my-version'
        rows[1]['skip'] = True
        self.assertIsNone(self.apply(rows))
        self.assertEqual(self.target.read_bytes(), b'another task')

    def test_unmapped_video_can_be_assigned_episode(self):
        extra = self.source / 'unrecognized.mkv'
        extra.write_bytes(b'extra')
        self.worker.trans_file()
        self.plan = plans.load_plan('task')
        rows = self.rows()
        for index, row in enumerate(rows, 1):
            row.update(season=1, episode=index)
        self.assertIsNone(self.apply(rows))
        self.assertEqual(len(list(self.work.rglob('*.mkv'))), 3)

    def test_changed_decisions_require_recheck(self):
        rows = self.rows()
        rows[1]['episode'] = 2
        token = self.check(rows)['token']
        rows[1]['episode'] = 3
        with self.assertRaisesRegex(ValueError, '重新检查'):
            plans.execute_saved_plan('task', self.plan['revision'], rows, token)
        self.assertFalse(self.work.exists())

    def test_disk_conflict_after_review_is_rechecked(self):
        rows = self.rows()
        rows[1]['skip'] = True
        token = self.check(rows)['token']
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b'occupied later')
        result = plans.execute_saved_plan('task', self.plan['revision'], rows, token)
        self.assertIn('目标文件已存在', result)
        self.assertEqual(self.target.read_bytes(), b'occupied later')
        self.assertEqual(json.loads((self.tasks / 'task.json').read_text(encoding='utf-8'))['error'], result)

    def test_stale_or_completed_plan_cannot_execute_twice(self):
        rows = self.rows()
        rows[1]['skip'] = True
        self.apply(rows)
        with self.assertRaisesRegex(ValueError, '失效'):
            self.check(rows)

    def test_draft_persists_and_mode_does_not_follow_settings(self):
        rows = self.rows()
        rows[1]['version'] = 'v2'
        with patch.object(trans.cm, 'get_config', return_value='剪切'):
            checked = self.check(rows)
        self.assertEqual(checked['worker'].mode, '复制')
        self.assertEqual(plans.load_plan('task')['draft_rows'], rows)

    def test_invalid_filename_episode_and_tampered_source_rejected(self):
        for invalid in ('../oops.mkv', 'CON.mkv', 'oops.exe'):
            rows = self.rows()
            rows[0]['filename'] = invalid
            with self.assertRaises(ValueError):
                self.check(rows)
        rows = self.rows()
        rows[0]['episode'] = 1.5
        with self.assertRaises(ValueError):
            self.check(rows)
        rows = self.rows()
        rows[0]['source'] = 'unrelated.mkv'
        with self.assertRaises(ValueError):
            self.check(rows)

    def test_long_version_is_reported_before_any_copy(self):
        if os.name != 'nt':
            self.skipTest('Windows component limit')
        rows = self.rows()
        rows[0]['version'] = 'version' * 50
        rows[1]['skip'] = True
        checked = self.check(rows)
        self.assertTrue(any('过长' in item['reason'] for item in checked['issues']))
        self.assertFalse(self.work.exists())

    def test_movie_without_mapping_accepts_custom_filename(self):
        plan = copy.deepcopy(self.plan)
        plan['context']['is_movie'] = True
        plan['rows'][0].update(original_target='', season=None, episode=None)
        rows = copy.deepcopy(plan['rows'])
        rows[0]['filename'] = 'My Movie.mkv'
        rows[1]['skip'] = True
        mapping, _ = plans.build_adjusted_mapping(plan, rows)
        self.assertEqual(mapping[Path(rows[0]['source'])], self.work / 'My Movie.mkv')

    def test_cut_retry_missing_source_never_deletes_completed_output(self):
        self.plan['mode'] = '剪切'
        plans._write(plans._path('task'), self.plan)
        rows = self.rows()
        rows[1]['skip'] = True
        self.assertIsNone(self.apply(rows))
        self.assertFalse(self.a.exists())
        content = self.target.read_bytes()
        task = json.loads((self.tasks / 'task.json').read_text(encoding='utf-8'))
        handled, error = plans.retry_decided_task(task)
        self.assertTrue(handled)
        self.assertIn('源文件不存在', error)
        self.assertEqual(self.target.read_bytes(), content)

    def test_ai_companions_only_from_same_directory(self):
        from src.rename.ai_processor import AIProcessor
        from src.ai.models import AIAnalysisResult, EpisodeMapping
        outside = self.source / 'other'
        outside.mkdir()
        other_sub = outside / self.a.with_suffix('.chs.ass').name
        other_sub.write_bytes(b'other season')
        result = AIAnalysisResult(confidence='High', reason='test', file_mapping=[
            EpisodeMapping(file_path=self.a.name, tmdb_season=1, tmdb_episode=1)])
        processor = AIProcessor.__new__(AIProcessor)
        with patch('src.rename.ai_processor.logger'):
            mapping = processor.apply_ai_mapping(result, self.source, self.work)
        self.assertIn(self.a.with_suffix('.chs.ass'), mapping)
        self.assertNotIn(other_sub, mapping)

    def test_same_source_hardlink_is_not_recreated(self):
        self.target.parent.mkdir(parents=True)
        os.link(self.a, self.target)
        old_stat = self.target.stat()
        (self.records / 'reuse.json').write_text(json.dumps({'entries': {str(self.a): {'target': str(self.target)}}}))
        worker = trans.Trans({self.a: self.target}, 'reuse', self.a)
        worker.mode = '链接'
        with patch.object(trans.os, 'link') as link, patch.object(worker, '_ensure_target_available') as ensure:
            self.assertIsNone(worker.trans_file())
        link.assert_not_called()
        ensure.assert_not_called()
        self.assertEqual(old_stat.st_ino, self.target.stat().st_ino)
        self.assertTrue(os.path.samefile(self.a, self.target))

    def test_saved_decisions_survive_retry_but_not_metadata_edits(self):
        rows = self.rows()
        rows[1]['episode'] = 2
        self.apply(rows)
        task = json.loads((self.tasks / 'task.json').read_text())
        handled, result = plans.retry_decided_task(task)
        self.assertTrue(handled)
        self.assertIsNone(result)
        task['season_id'] = 2
        self.assertEqual(plans.retry_decided_task(task), (False, None))

    def test_desktop_open_returns_mapping_and_conflicts_without_executing(self):
        result = plans.desktop_review_plan('task')
        self.assertIn('review', result)
        self.assertTrue(result['review']['issues'])
        self.assertTrue(any(row['source'] == str(self.a) for row in result['review']['preview']))
        self.assertTrue(any(row['source'] == str(self.b) for row in result['review']['preview']))
        self.assertFalse(self.target.exists())
        self.assertTrue(self.a.exists())

    def test_desktop_review_retains_valid_mapping_around_invalid_custom_name(self):
        rows = self.rows()
        rows[0]['filename'] = 'bad.exe'
        rows[1]['episode'] = 2
        self.plan['draft_rows'] = rows
        plans._write(plans._path('task'), self.plan)
        result = plans.desktop_review_plan('task')['review']
        self.assertIn(str(self.a), result['row_errors'])
        self.assertTrue(any(row['source'] == str(self.b) and 'S01E02' in row['target'] for row in result['preview']))
        self.assertFalse(any(row['source'] == str(self.a) for row in result['preview']))
        with self.assertRaises(ValueError):
            plans.execute_saved_plan('task', self.plan['revision'], rows, result['token'])
        self.assertFalse(self.work.exists())

    def test_native_unresolved_episode_does_not_hide_valid_rows(self):
        plan = copy.deepcopy(self.plan)
        plan['context'].update(layout='bangumi', subject_id='42', name='Show', episodes=[{'id': 100, 'sort': 1, 'type': 0, 'name': 'One'}], task_metadata={})
        for index, row in enumerate(plan['rows']):
            row.update(subject_id='42', category='episode' if index == 0 else 'unresolved', episode_id=100 if index == 0 else None)
        plans._write(plans._path('task'), plan)
        result = plans.desktop_review_plan('task')['review']
        self.assertEqual(len(result['row_errors']), 1)
        self.assertTrue(any(row['source'] == plan['rows'][0]['source'] for row in result['preview']))
        self.assertFalse(self.work.exists())


if __name__ == '__main__':
    unittest.main()


class CustomFilenameTests(unittest.TestCase):
    def test_title_gets_group_and_original_extension(self):
        from src.rename.rename_strategy import custom_filename
        self.assertEqual(custom_filename('[AI-Raws] source.mkv', '新世纪福音战士 剧场版 合集', 'AI-Raws'), '新世纪福音战士 剧场版 合集 [AI-Raws].mkv')
        self.assertEqual(custom_filename('source.mp4', 'Title', ''), 'Title.mp4')

    def test_existing_group_and_extension_are_not_duplicated(self):
        from src.rename.rename_strategy import custom_filename
        self.assertEqual(custom_filename('source.mkv', 'Title [AI-RAWS].MKV', 'AI-Raws'), 'Title [AI-RAWS].mkv')
        self.assertEqual(custom_filename('source.mkv', 'Title [AI-Raws]', 'AI-Raws'), 'Title [AI-Raws].mkv')

    def test_dots_in_titles_are_preserved_and_type_changes_rejected(self):
        from src.rename.rename_strategy import custom_filename
        self.assertEqual(custom_filename('source.mkv', 'EVANGELION 1.11', 'AI-Raws'), 'EVANGELION 1.11 [AI-Raws].mkv')
        self.assertEqual(custom_filename('source.mkv', 'Dr.STONE', ''), 'Dr.STONE.mkv')
        for name in ('Title.mp4', 'Title.exe', '../Title', 'CON', 'CON .mkv'):
            with self.assertRaises(ValueError):
                custom_filename('source.mkv', name, 'AI-Raws')
