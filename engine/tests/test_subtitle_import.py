import tempfile
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from src.rename import subtitle_import as sub


class SubtitleImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.video = self.root / 'Show EP01.mkv'
        self.video.write_bytes(b'video')
        self.folder = self.root / 'subs'
        self.folder.mkdir()
        self.original = self.root / 'download' / 'original [01].mkv'
        self.original.parent.mkdir()
        self.original.write_bytes(b'video')
        self.record = {'entries': {str(self.original): {'target': str(self.video)}}}
        record_patch = patch.object(sub, 'RECORD_PATH', self.root)
        record_patch.start()
        self.addCleanup(record_patch.stop)

    def subtitle(self, name):
        path = self.folder / name
        path.write_bytes(b'subtitle')
        return path

    def test_keys(self):
        for name in ['Show [01].chs.ass', 'Show EP01.ass', 'Show 第01话.ass']:
            self.assertEqual(sub.episode_key(name)[1:], sub.episode_key(self.video)[1:])
        self.assertNotEqual(sub.episode_key('Show SP01.ass')[1:], sub.episode_key(self.video)[1:])
        self.assertIsNone(sub.episode_key('Show [01-12].ass'))
        self.assertIsNone(sub.episode_key('Show 1080p x265.ass'))

    def test_legacy_import_also_mirrors_subtitle_beside_symlink_video(self):
        mirror_video = self.root / 'mirror' / self.video.name
        mirror_video.parent.mkdir()
        os.link(self.original, mirror_video)
        self.video.unlink()
        os.symlink(mirror_video, self.video)
        source = self.subtitle('Show EP01.chs.ass')
        rows = [{'source': str(source), 'video': str(self.video), 'suffix': 'chs'}]
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root):
            sub.execute_import('task', rows)
        output = self.video.with_suffix('.chs.ass')
        mirror = mirror_video.with_suffix('.chs.ass')
        self.assertTrue(output.is_symlink())
        self.assertEqual(output.resolve(), mirror.resolve())
        self.assertTrue(os.path.samefile(mirror, self.original.with_suffix('.chs.ass')))
        saved = json.loads((self.root / 'task.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['entries'][str(self.original.with_suffix('.chs.ass'))]['mirror'], str(mirror))

    def test_multilanguage_preview_and_copy(self):
        first = self.subtitle('Other [01].chs.ass')
        self.subtitle('Other [01].cht.ass')
        _, rows = sub.preview_import(self.record, self.folder)
        self.assertTrue(all(row['video'] == str(self.video) for row in rows))
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root):
            self.assertEqual(sub.execute_import('task', rows), 2)
            with self.assertRaises(ValueError):
                sub.execute_import('task', rows)
        self.assertTrue(first.exists())
        self.assertEqual(self.video.with_suffix('.chs.ass').read_bytes(), b'subtitle')
        self.assertEqual(self.original.with_suffix('.chs.ass').read_bytes(), b'subtitle')
        self.assertTrue(os.path.samefile(self.original.with_suffix('.chs.ass'), self.video.with_suffix('.chs.ass')))
        self.assertEqual(len(list((self.root / 'subtitle_imports').glob('*.json'))), 1)

    def test_same_subtitle_imports_into_two_versions(self):
        source = self.subtitle('Show EP01.chs.ass')
        other_video = self.root / 'Show EP01 [Other].mkv'
        other_original = self.original.with_name('Other [01].mkv')
        other_video.write_bytes(b'video')
        other_original.write_bytes(b'video')
        self.record['entries'][str(other_original)] = {'target': str(other_video)}
        rows = [{'source': str(source), 'video': str(video), 'suffix': 'chs'}
                for video in [self.video, other_video]]
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root):
            self.assertEqual(sub.execute_import('task', rows), 2)
        for video in [self.video, other_video, self.original, other_original]:
            self.assertEqual(video.with_suffix('.chs.ass').read_bytes(), source.read_bytes())
        saved = json.loads((self.root / 'task.json').read_text(encoding='utf-8'))
        for original, video in [(self.original, self.video), (other_original, other_video)]:
            self.assertEqual(saved['entries'][str(original.with_suffix('.chs.ass'))]['target'],
                             str(video.with_suffix('.chs.ass')))

    def test_library_chapter_selects_all_versions_regardless_of_video_filename(self):
        self.subtitle('Show EP03.ass')
        other = self.root / 'Unnumbered.mkv'
        other.write_bytes(b'video')
        self.record['entries']['original EP99.mkv'] = str(other)
        chapters = [{'number': 1, 'videos': [str(self.video), str(other), str(self.root / 'offline.mkv')]}]
        _, rows = sub.preview_records([self.record], self.folder, -2, chapters=chapters)
        self.assertEqual(rows[0]['videos'], [str(self.video), str(other)])
        self.assertEqual(rows[0]['candidates'], rows[0]['videos'])
        self.assertIn('媒体库 EP1', rows[0]['reason'])

    def test_library_chapter_is_authoritative_and_does_not_fallback_to_video_name(self):
        self.subtitle('Show EP01.ass')
        _, rows = sub.preview_records([self.record], self.folder,
                                      chapters=[{'number': 2, 'videos': [str(self.video)]}])
        self.assertEqual(rows[0]['videos'], [])
        _, rows = sub.preview_records([self.record], self.folder, chapters=[])
        self.assertEqual(rows[0]['videos'], [])

    def test_conflicting_chapters_require_manual_selection(self):
        self.subtitle('Show EP01.ass')
        chapter = {'number': 1, 'videos': [str(self.video)]}
        _, rows = sub.preview_records([self.record], self.folder, chapters=[chapter, chapter])
        self.assertEqual(rows[0]['videos'], [])
        self.assertIn('歧义', rows[0]['reason'])

    def test_explicit_wrong_season_and_conflicting_seasons_do_not_auto_select(self):
        source = self.subtitle('Show S02E01.ass')
        seasonal = self.root / 'Show S01E01.mkv'
        seasonal.write_bytes(b'video')
        self.record['entries'][str(self.original)] = str(seasonal)
        chapters = [{'number': 1, 'videos': [str(seasonal)]}]
        _, rows = sub.preview_records([self.record], files=[str(source)], chapters=chapters)
        self.assertEqual(rows[0]['videos'], [])
        source.rename(source.with_name('Show S01E01.ass'))
        _, rows = sub.preview_records([self.record], self.folder, chapters=chapters)
        self.assertEqual(rows[0]['videos'], [str(seasonal)])
        other = self.root / 'Show S02E01.mkv'
        other.write_bytes(b'video')
        self.record['entries']['original.mkv'] = str(other)
        chapters[0]['videos'].append(str(other))
        _, rows = sub.preview_records([self.record], self.folder, chapters=chapters)
        self.assertEqual(rows[0]['videos'], [])

    def test_special_subtitle_never_matches_regular_library_episode(self):
        self.subtitle('Show SP01.ass')
        _, rows = sub.preview_records([self.record], self.folder,
                                      chapters=[{'number': 1, 'videos': [str(self.video)]}])
        self.assertEqual(rows[0]['video'], '')

    def test_offset_and_ambiguous_video(self):
        self.subtitle('Show [13].ass')
        _, rows = sub.preview_import(self.record, self.folder, -12)
        self.assertEqual(rows[0]['video'], str(self.video))
        second = self.root / 'Other EP01.mp4'
        second.write_bytes(b'video')
        self.record['entries']['other'] = str(second)
        _, rows = sub.preview_import(self.record, self.folder, -12)
        self.assertEqual(rows[0]['video'], '')

    def test_duplicate_targets_rejected_before_copy(self):
        self.subtitle('A EP01.ass')
        self.subtitle('B EP01.ass')
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record):
            with self.assertRaises(ValueError):
                sub.execute_import('task', rows)
        self.assertFalse(self.video.with_suffix('.ass').exists())
        self.assertFalse(self.original.with_suffix('.ass').exists())

    def test_retry_recreates_subtitle_from_original_directory(self):
        from src.rename.bangumi_native import plan_subject
        from src.rename import trans
        self.subtitle('Show EP01.chs.ass')
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root):
            sub.execute_import('task', rows)
        saved = json.loads((self.root / 'task.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['entries'][str(self.original.with_suffix('.chs.ass'))]['target'],
                         str(self.video.with_suffix('.chs.ass')))
        info = {'id': '1', 'name': 'Show', 'bangumi_episodes': [{'id': 1, 'type': 0, 'sort': 1}]}
        mapping, _ = plan_subject(self.original.parent, info, self.root, '')
        self.assertEqual(mapping[self.original.with_suffix('.chs.ass')], self.video.with_suffix('.chs.ass'))
        # Remove the library subtitle to prove retry rebuilds it from the
        # original-named companion, without the separately downloaded subtitle.
        self.video.with_suffix('.chs.ass').unlink()
        for path in self.folder.iterdir():
            path.unlink()
        with patch.object(trans, 'RECORD_PATH', self.root), patch.object(trans.cm, 'get_config', return_value='复制'):
            worker = trans.Trans(mapping, 'task', self.original.parent, save_plan=False)
            self.assertIsNone(worker.trans_file())
        self.assertEqual(self.video.with_suffix('.chs.ass').read_bytes(), b'subtitle')

    def test_original_directory_conflict_prevents_all_writes(self):
        self.subtitle('Show EP01.ass')
        existing = self.original.with_suffix('.ass')
        existing.write_bytes(b'existing')
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record):
            with self.assertRaises(ValueError):
                sub.execute_import('task', rows)
        self.assertFalse(self.video.with_suffix('.ass').exists())
        self.assertEqual(existing.read_bytes(), b'existing')

    def test_missing_original_video_prevents_import(self):
        self.subtitle('Show EP01.ass')
        self.original.unlink()
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record):
            with self.assertRaisesRegex(ValueError, '原视频'):
                sub.execute_import('task', rows)
        self.assertFalse(self.video.with_suffix('.ass').exists())

    def test_link_failure_rolls_back_original_copy(self):
        self.subtitle('Show EP01.ass')
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root), \
                patch.object(sub.os, 'link', side_effect=OSError('different volume')), \
                patch.object(sub.os, 'symlink', side_effect=OSError('link failed')):
            with self.assertRaises(OSError):
                sub.execute_import('task', rows)
        self.assertFalse(self.original.with_suffix('.ass').exists())
        self.assertFalse(self.video.with_suffix('.ass').exists())
        self.assertFalse((self.root / 'task.json').exists())

    def test_existing_library_subtitle_is_replaced_with_hardlink(self):
        self.subtitle('Show EP01.ass')
        target = self.video.with_suffix('.ass')
        target.write_bytes(b'old subtitle')
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root):
            sub.execute_import('task', rows)
        self.assertEqual(target.read_bytes(), b'subtitle')
        self.assertTrue(os.path.samefile(target, self.original.with_suffix('.ass')))
        self.assertFalse(list(self.root.glob('*.backup')))

    def test_record_failure_restores_existing_library_subtitle(self):
        self.subtitle('Show EP01.ass')
        target = self.video.with_suffix('.ass')
        target.write_bytes(b'old subtitle')
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root), \
                patch.object(sub, 'RECORD_PATH', self.root / 'missing'):
            with self.assertRaises(OSError):
                sub.execute_import('task', rows)
        self.assertEqual(target.read_bytes(), b'old subtitle')
        self.assertFalse(self.original.with_suffix('.ass').exists())

    def test_hardlink_failure_falls_back_to_symlink(self):
        self.subtitle('Show EP01.ass')
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root), \
                patch.object(sub.os, 'link', side_effect=OSError('different volume')):
            sub.execute_import('task', rows)
        target = self.video.with_suffix('.ass')
        self.assertTrue(target.is_symlink())
        self.assertEqual(target.resolve(), self.original.with_suffix('.ass').resolve())

    def test_multisegment_suffix(self):
        self.assertEqual(sub.subtitle_target('A.zh.forced.ass', self.video).name, 'Show EP01.zh.forced.ass')

    def test_custom_suffix_replaces_detected_suffix(self):
        self.assertEqual(sub.subtitle_target('A.chs.ass', self.video, '.cht.字幕组').name,
                         'Show EP01.cht.字幕组.ass')
        self.assertEqual(sub.subtitle_target('A.chs.ass', self.video, '').name, 'Show EP01.ass')

    def test_suffix_rejects_paths_and_empty_segments(self):
        for suffix in ['../evil', 'chs/evil', 'a\\b', 'chs..group', 'chs.', 'chs:group', 'chs\x00']:
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                sub.subtitle_target('A.ass', self.video, suffix)

    def test_custom_suffix_resolves_same_episode_collision_and_survives_planning(self):
        from src.rename.bangumi_native import plan_subject
        self.subtitle('GroupA EP01.ass')
        self.subtitle('GroupB EP01.ass')
        _, rows = sub.preview_import(self.record, self.folder)
        rows[0]['suffix'] = 'chs.GroupA'
        rows[1]['suffix'] = 'chs.GroupB'
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root):
            self.assertEqual(sub.execute_import('task', rows), 2)
        info = {'id': '1', 'name': 'Show', 'bangumi_episodes': [{'id': 1, 'type': 0, 'sort': 1}]}
        mapping, _ = plan_subject(self.original.parent, info, self.root, '')
        for suffix in ['.chs.GroupA.ass', '.chs.GroupB.ass']:
            original = self.original.with_suffix(suffix)
            target = self.video.with_suffix(suffix)
            self.assertTrue(os.path.samefile(original, target))
            self.assertEqual(mapping[original], target)

    def test_failed_copy_removes_partial_outputs(self):
        self.subtitle('Show EP01.ass')
        _, rows = sub.preview_import(self.record, self.folder)
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root), \
                patch.object(sub.shutil, 'copyfileobj', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                sub.execute_import('task', rows)
        self.assertFalse(self.video.with_suffix('.ass').exists())

    def test_single_file_does_not_import_sibling_subtitles(self):
        selected = self.subtitle('Show EP01.chs.ass')
        self.subtitle('Show EP01.cht.ass')
        _, rows = sub.preview_import(self.record, selected)
        self.assertEqual([row['source'] for row in rows], [str(selected)])
        self.assertEqual(rows[0]['video'], str(self.video))

    def test_explicit_files_from_multiple_folders_are_deduplicated(self):
        first = self.subtitle('Show EP01.chs.ass')
        second = self.root / 'Show EP01.cht.sup'; second.write_bytes(b'subtitle')
        self.subtitle('Not selected EP01.srt')
        _, rows = sub.preview_import(self.record, files=[str(first), str(second), str(first)])
        self.assertEqual({row['source'] for row in rows}, {str(first), str(second)})
        self.assertTrue(all(row['video'] == str(self.video) for row in rows))
        with patch.object(sub, 'get_record', return_value=self.record), patch.object(sub, 'DATA_PATH', self.root):
            self.assertEqual(sub.execute_import('task', rows), 2)

    def test_invalid_or_empty_file_selection_never_falls_back_to_directory(self):
        valid = self.subtitle('Show EP01.ass')
        for files in ([], [str(valid), str(self.folder / 'missing.srt')], [str(self.video)], str(valid)):
            with self.subTest(files=files), self.assertRaises(ValueError):
                sub.preview_import(self.record, self.folder, files=files)
        self.assertFalse(self.video.with_suffix('.ass').exists())

    def test_batch_preview_scans_once_and_parses_each_video_alias_once(self):
        from src.rename import source_scan
        for number in range(8):
            self.subtitle(f'Group{number} EP01.ass')
        with patch.object(source_scan, 'files_in', wraps=source_scan.files_in) as scan, \
             patch.object(sub, 'episode_key', wraps=sub.episode_key) as parse:
            _, rows = sub.preview_records([self.record, self.record], self.folder)
            self.assertEqual(len(rows), 8)
            self.assertEqual(scan.call_count, 1)
            self.assertEqual(parse.call_count, 10)  # two distinct aliases plus eight subtitles

    def test_batch_preview_keeps_ambiguity_across_records(self):
        selected = self.subtitle('Show EP01.ass')
        other = self.root / 'Other EP01.mkv'; other.write_bytes(b'video')
        _, rows = sub.preview_records([self.record, {'entries': {'other': str(other)}}], files=[str(selected)])
        self.assertEqual(rows[0]['video'], '')
        self.assertEqual(set(rows[0]['candidates']), {str(self.video), str(other)})

    def test_api_returns_and_validates_all_automatically_selected_versions(self):
        from src.integration_api import perform
        from src.utils import utils
        source = self.subtitle('Show EP01.ass')
        second = self.root / 'Other.mkv'
        original = self.original.with_name('Other original.mkv')
        second.write_bytes(b'video')
        original.write_bytes(b'video')
        self.record['entries'][str(original)] = str(second)
        chapters = [{'number': 1, 'videos': [str(self.video), str(second)]}]
        with patch.object(utils, 'get_record', return_value=self.record), \
             patch.object(sub, 'import_targets', wraps=sub.import_targets) as check:
            result = perform('subtitle-preview', {'ids': ['task'], 'files': [str(source)], 'chapters': chapters})
        row = result['rows'][0]
        self.assertEqual(row['videos'], [str(self.video), str(second)])
        self.assertEqual(check.call_count, 2)
        self.assertEqual([entry['video'] for entry in row['targets']], row['videos'])

    def test_api_batches_records_and_checks_original_once_for_multiple_languages(self):
        from src.integration_api import perform
        from src.utils import utils
        files = [str(self.subtitle('Show EP01.' + lang + '.ass')) for lang in ('chs', 'cht')]
        with patch.object(utils, 'get_record', return_value=self.record) as read, \
             patch.object(sub, 'import_targets', wraps=sub.import_targets) as check:
            result = perform('subtitle-preview', {'ids': ['first', 'second'], 'files': files})
        self.assertEqual(read.call_count, 2)
        self.assertEqual(check.call_count, 1)
        self.assertEqual(len(result['rows']), 2)
        self.assertTrue(all(row['target'].endswith('.ass') for row in result['rows']))
