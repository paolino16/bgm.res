import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.rename import subtitle_import as sub, subtitle_manage as manager


class SubtitleManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.record_path = self.root / 'records'
        self.record_path.mkdir()
        self.original = self.root / 'raw' / 'Raw 01.mkv'
        self.video = self.root / 'library' / 'Show 01.mkv'
        for value in (self.original, self.video):
            value.parent.mkdir()
            value.write_bytes(b'video')
        self.source = self.root / 'New 01.ass'
        self.source.write_bytes(b'new subtitles')
        self.record = {'entries': {str(self.original): {'target': str(self.video)}}}
        self.write_record(self.record)
        for name, value in [('DATA_PATH', self.root), ('RECORD_PATH', self.record_path)]:
            change = patch.object(sub, name, value)
            change.start()
            self.addCleanup(change.stop)
        change = patch.object(sub, 'get_record', side_effect=lambda task: json.loads((self.record_path / (task + '.json')).read_text()))
        change.start()
        self.addCleanup(change.stop)
        change = patch.object(manager, 'check_delete_access')
        change.start()
        self.addCleanup(change.stop)

    def write_record(self, record, task='task'):
        (self.record_path / (task + '.json')).write_text(json.dumps(record), encoding='utf-8')

    @staticmethod
    def recycle(paths):
        for path in paths:
            path.unlink()

    def old_subtitle(self):
        original = self.original.with_suffix('.chs.old.srt')
        output = self.video.with_suffix('.chs.old.srt')
        original.write_bytes(b'old subtitles')
        os.link(original, output)
        self.record['entries'][str(original)] = {'target': str(output)}
        self.write_record(self.record)
        return original, output

    def body(self, mode='add'):
        body = {'ids': ['task'], 'videos': [str(self.video)], 'mode': mode,
                'rows': [{'source': str(self.source), 'video': str(self.video), 'suffix': 'chs.new'}]}
        if mode != 'add':
            group = manager.inventory(['task'])['groups'][0]
            body.update(group=group['id'], token=group['token'])
        return body

    def mirrored_video(self):
        mirror = self.root / 'mirror' / self.video.name
        mirror.parent.mkdir()
        os.link(self.original, mirror)
        self.video.unlink()
        os.symlink(mirror, self.video)
        return mirror

    def test_symlink_video_import_creates_subtitle_beside_physical_video(self):
        mirror_video = self.mirrored_video()
        manager.execute(self.body(), recycle=self.recycle)
        mirror = mirror_video.with_suffix('.chs.new.ass')
        output = self.video.with_suffix('.chs.new.ass')
        original = self.original.with_suffix('.chs.new.ass')
        self.assertTrue(os.path.samefile(mirror, original))
        self.assertFalse(mirror.is_symlink())
        self.assertTrue(output.is_symlink())
        self.assertEqual(output.resolve(), mirror.resolve())
        self.assertEqual(sub.get_record('task')['entries'][str(original)]['mirror'], str(mirror))
        group = manager.inventory(['task'])['groups'][0]
        self.assertEqual(group['files'][0]['mirror'], str(mirror))

    def test_symlink_video_replacement_and_removal_manage_all_three_paths(self):
        mirror_video = self.mirrored_video()
        manager.execute(self.body(), recycle=self.recycle)
        self.source.write_bytes(b'updated subtitle')
        manager.execute(self.body(), recycle=self.recycle)
        mirror = mirror_video.with_suffix('.chs.new.ass')
        self.assertEqual(mirror.read_bytes(), b'updated subtitle')
        body = self.body('remove')
        body['rows'] = []
        manager.execute(body, recycle=self.recycle)
        for path in (mirror, self.video.with_suffix('.chs.new.ass'), self.original.with_suffix('.chs.new.ass')):
            self.assertFalse(os.path.lexists(path))
        self.assertTrue(self.video.is_file() and self.original.is_file() and mirror_video.is_file())

    def test_failed_symlink_install_restores_original_mirror_and_output(self):
        mirror_video = self.mirrored_video()
        manager.execute(self.body(), recycle=self.recycle)
        before = sub.get_record('task')
        self.source.write_bytes(b'new failed version')
        original_link = manager.os.symlink
        output = self.video.with_suffix('.chs.new.ass')
        def fail_output(source, target, *args, **kwargs):
            if Path(target) == output:
                raise OSError('link failed')
            return original_link(source, target, *args, **kwargs)
        with patch.object(manager.os, 'symlink', side_effect=fail_output):
            with self.assertRaisesRegex(OSError, 'link failed'):
                manager.execute(self.body(), recycle=self.recycle)
        self.assertEqual(output.read_bytes(), b'new subtitles')
        self.assertEqual(mirror_video.with_suffix('.chs.new.ass').read_bytes(), b'new subtitles')
        self.assertEqual(sub.get_record('task'), before)

    def test_add_copies_source_and_links_library_without_touching_other_versions(self):
        old = self.old_subtitle()
        result = manager.execute(self.body(), recycle=self.recycle)
        original = self.original.with_suffix('.chs.new.ass')
        output = self.video.with_suffix('.chs.new.ass')
        self.assertEqual(result['count'], 1)
        self.assertEqual(original.read_bytes(), b'new subtitles')
        self.assertTrue(os.path.samefile(original, output))
        self.assertTrue(all(value.exists() for value in old))
        self.assertTrue(self.source.exists())

    def test_replace_different_format_recycles_both_old_paths_and_updates_record(self):
        old = self.old_subtitle()
        result = manager.execute(self.body('replace'), recycle=self.recycle)
        self.assertFalse(any(value.exists() for value in old))
        self.assertTrue(self.video.with_suffix('.chs.new.ass').exists())
        record = sub.get_record('task')
        self.assertNotIn(str(old[0]), record['entries'])
        self.assertIn(str(self.original.with_suffix('.chs.new.ass')), record['entries'])
        self.assertEqual(result['warning'], '')

    def test_stale_preview_never_changes_files(self):
        old = self.old_subtitle()
        body = self.body('remove')
        old[0].write_bytes(b'user edit')
        with self.assertRaisesRegex(ValueError, '已变化'):
            manager.execute(body, recycle=self.recycle)
        self.assertEqual(old[1].read_bytes(), b'user edit')

    def test_remove_keeps_video_and_download_source(self):
        old = self.old_subtitle()
        body = self.body('remove')
        body['rows'] = []
        manager.execute(body, recycle=self.recycle)
        self.assertFalse(any(value.exists() for value in old))
        self.assertTrue(self.video.exists() and self.original.exists() and self.source.exists())
        self.assertEqual(manager.inventory(['task'])['groups'], [])

    def test_conflict_add_replaces_exact_paths_without_selecting_old_version(self):
        self.old_subtitle()
        body = self.body()
        body['rows'][0]['suffix'] = 'chs.old'
        body['rows'][0]['source'] = str(self.root / 'new.srt')
        Path(body['rows'][0]['source']).write_bytes(b'new')
        result = manager.execute(body, recycle=self.recycle)
        self.assertEqual(result['count'], 1)
        self.assertEqual(self.video.with_suffix('.chs.old.srt').read_bytes(), b'new')
        self.assertTrue(os.path.samefile(self.original.with_suffix('.chs.old.srt'), self.video.with_suffix('.chs.old.srt')))

    def test_automatic_replacement_preserves_other_formats_and_unmatched_episodes(self):
        self.old_subtitle()
        other = self.video.with_suffix('.chs.old.ass')
        other.write_bytes(b'other format')
        unmatched = self.video.with_name('Show 02.chs.old.srt')
        unmatched.write_bytes(b'other episode')
        body = self.body()
        body['rows'][0].update(suffix='chs.old', source=str(self.root / 'new.srt'))
        Path(body['rows'][0]['source']).write_bytes(b'new')
        manager.execute(body, recycle=self.recycle)
        self.assertEqual(other.read_bytes(), b'other format')
        self.assertEqual(unmatched.read_bytes(), b'other episode')

    def test_automatic_replacement_failure_restores_old_content(self):
        old = self.old_subtitle()
        body = self.body()
        body['rows'][0].update(suffix='chs.old', source=str(self.root / 'new.srt'))
        Path(body['rows'][0]['source']).write_bytes(b'new')
        copy = manager.shutil.copyfileobj
        calls = 0
        def fail_install(source, output):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('install failed')
            copy(source, output)
        with patch.object(manager.shutil, 'copyfileobj', side_effect=fail_install):
            with self.assertRaisesRegex(OSError, 'install failed'):
                manager.execute(body, recycle=self.recycle)
        self.assertTrue(all(path.exists() for path in old))
        self.assertEqual(old[0].read_bytes(), b'old subtitles')
        self.assertEqual(sub.get_record('task'), self.record)

    def test_failed_write_rolls_back_old_files_and_records(self):
        old = self.old_subtitle()
        before = (self.record_path / 'task.json').read_bytes()
        with patch.object(manager.shutil, 'copyfileobj', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                manager.execute(self.body('replace'), recycle=self.recycle)
        self.assertTrue(all(value.exists() for value in old))
        self.assertEqual(old[0].read_bytes(), b'old subtitles')
        self.assertEqual(json.loads(before), sub.get_record('task'))
        self.assertFalse(self.original.with_suffix('.chs.new.ass').exists())
        self.assertFalse(manager.pending_cleanup())

    def test_recycle_failure_rolls_back_entire_set_without_losing_old_subtitles(self):
        old = self.old_subtitle()
        def fail_after_first(paths):
            paths[0].unlink()
            raise OSError('busy')
        with self.assertRaisesRegex(OSError, 'busy'):
            manager.execute(self.body('replace'), recycle=fail_after_first)
        self.assertTrue(all(path.exists() for path in old))
        self.assertEqual(old[0].read_bytes(), b'old subtitles')
        self.assertFalse(self.video.with_suffix('.chs.new.ass').exists())
        self.assertFalse(manager.pending_cleanup())

    def test_recycling_uses_original_paths_for_windows_restore(self):
        old = self.old_subtitle()
        received = []
        def recycle(paths):
            received.extend(paths)
            self.recycle(paths)
        manager.execute(self.body('replace'), recycle=recycle)
        self.assertEqual(set(received), set(old))

    def test_replace_retains_unmatched_episodes(self):
        self.old_subtitle()
        raw2 = self.original.with_name('Raw 02.mkv')
        video2 = self.video.with_name('Show 02.mkv')
        raw2.write_bytes(b'video2')
        video2.write_bytes(b'video2')
        old2 = raw2.with_suffix('.chs.old.srt')
        out2 = video2.with_suffix('.chs.old.srt')
        old2.write_bytes(b'old2')
        os.link(old2, out2)
        self.record['entries'].update({str(raw2): {'target': str(video2)}, str(old2): {'target': str(out2)}})
        self.write_record(self.record)
        body = self.body('replace')
        body['videos'].append(str(video2))
        body['token'] = manager.inventory(['task'])['groups'][0]['token']
        manager.execute(body, recycle=self.recycle)
        self.assertTrue(old2.exists() and out2.exists())

    def test_shared_original_outside_scope_is_protected(self):
        old, output = self.old_subtitle()
        other = self.video.parent / 'Other 01.chs.old.srt'
        os.link(old, other)
        self.write_record({'entries': {str(old): {'target': str(other)}}}, 'other')
        with self.assertRaisesRegex(ValueError, '其他视频'):
            manager.execute(self.body('remove'), recycle=self.recycle)
        self.assertTrue(old.exists() and output.exists() and other.exists())

    def test_unregistered_video_is_rejected(self):
        body = self.body()
        body['videos'] = [str(self.root / 'unknown.mkv')]
        with self.assertRaisesRegex(ValueError, '不属于'):
            manager.execute(body, recycle=self.recycle)

    def test_interrupted_install_is_restored_from_persistent_journal(self):
        old = self.old_subtitle()
        original_write = manager.atomic_write
        def interrupt_record(path, value):
            if Path(path) == self.record_path / 'task.json':
                raise KeyboardInterrupt('simulated process exit')
            original_write(path, value)
        with patch.object(manager, 'atomic_write', side_effect=interrupt_record):
            with self.assertRaises(KeyboardInterrupt):
                manager.execute(self.body('replace'), recycle=self.recycle)
        self.assertTrue(manager.pending_cleanup())
        manager.recover()
        self.assertTrue(all(path.exists() for path in old))
        self.assertFalse(self.video.with_suffix('.chs.new.ass').exists())
        self.assertFalse(manager.pending_cleanup())

    def test_later_task_failure_rolls_back_all_tasks(self):
        raw2 = self.original.with_name('Raw 02.mkv')
        video2 = self.video.with_name('Show 02.mkv')
        raw2.write_bytes(b'video2')
        video2.write_bytes(b'video2')
        self.write_record({'entries': {str(raw2): {'target': str(video2)}}}, 'second')
        body = self.body()
        body['ids'].append('second')
        body['videos'].append(str(video2))
        body['rows'].append({**body['rows'][0], 'video': str(video2)})
        copy = manager.shutil.copyfileobj
        calls = 0
        def fail_last(source, target):
            nonlocal calls
            calls += 1
            if calls == 4:
                raise OSError('second task disk failure')
            copy(source, target)
        with patch.object(manager.shutil, 'copyfileobj', side_effect=fail_last):
            with self.assertRaisesRegex(OSError, 'second task'):
                manager.execute(body, recycle=self.recycle)
        for video in (self.video, video2):
            self.assertFalse(video.with_suffix('.chs.new.ass').exists())
        self.assertEqual(len(sub.get_record('task')['entries']), 1)
        self.assertEqual(len(sub.get_record('second')['entries']), 1)


if __name__ == '__main__':
    unittest.main()
