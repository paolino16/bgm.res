import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

from src.rename import task_deletion as deletion
from src.rename.task_schema import atomic_write


class TaskDeletionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(patch.object(deletion, 'DATA_PATH', self.root))
        self.source = self.root / 'source.mkv'; self.source.write_bytes(b'source')
        self.output = self.root / 'output.mkv'; self.output.write_bytes(b'output')
        atomic_write(self.root / 'task/one.json', {'uuid': 'one', 'name': 'Show', 'path': str(self.source)})
        atomic_write(self.root / 'record/one.json', {'entries': {str(self.source): {'target': str(self.output)}}})
        atomic_write(self.root / 'rename_plans/one.json', {'state': 'pending'})
        atomic_write(self.root / 'recognition_reviews/one.json', {'state': 'active'})

    def test_records_only_retains_media_and_archives_metadata(self):
        preview = deletion.preview('one')
        self.assertEqual(preview['trash_count'], 0)
        trash = Mock(); result = deletion.execute('one', preview['token'], trash=trash)
        trash.assert_not_called()
        self.assertTrue(self.source.exists()); self.assertTrue(self.output.exists())
        for folder in ('task', 'record', 'rename_plans', 'recognition_reviews'):
            self.assertFalse((self.root / folder / 'one.json').exists())
            self.assertTrue((Path(result['archive']) / folder / 'one.json').exists())

    def test_only_own_recorded_outputs_are_recycled(self):
        other = self.root / 'unregistered.mkv'; other.write_bytes(b'keep')
        preview = deletion.preview('one', True); calls = []
        def trash(path): calls.append(path); path.unlink()
        result = deletion.execute('one', preview['token'], True, trash=trash)
        self.assertEqual(calls, [self.output]); self.assertEqual(result['outputs'], 1)
        self.assertTrue(self.source.exists()); self.assertTrue(other.exists())

    def test_originals_and_hardlinked_outputs_can_both_be_recycled(self):
        self.output.unlink(); self.output.hardlink_to(self.source)
        preview = deletion.preview('one', True, True)
        self.assertEqual(preview['source_count'], 1)
        self.assertEqual(preview['trash_count'], 2)
        result = deletion.execute('one', preview['token'], True, True, trash=lambda p: p.unlink())
        self.assertFalse(self.source.exists()); self.assertFalse(self.output.exists())
        self.assertIn('1 个原文件', result['message'])

    def test_originals_only_retains_outputs_and_unregistered_source_neighbors(self):
        neighbor = self.root / 'unregistered.ass'; neighbor.write_bytes(b'keep')
        preview = deletion.preview('one', False, True)
        self.assertEqual(preview['trash_count'], 1)
        deletion.execute('one', preview['token'], False, True, trash=lambda p: p.unlink())
        self.assertFalse(self.source.exists()); self.assertTrue(self.output.exists()); self.assertTrue(neighbor.exists())

    def test_other_tasks_sources_outputs_and_source_directories_are_protected(self):
        for reference in ('source', 'output', 'directory'):
            with self.subTest(reference=reference):
                atomic_write(self.root / 'record/two.json', {'entries': {
                    str(self.source if reference == 'source' else self.root / 'another.mkv'):
                        {'target': str(self.source if reference == 'output' else self.root / 'other.mkv')}}})
                atomic_write(self.root / 'task/two.json', {'path': str(self.root if reference == 'directory' else self.root / 'another.mkv')})
                preview = deletion.preview('one', False, True)
                row = next(row for row in preview['rows'] if row['kind'] == 'source')
                self.assertEqual(row['action'], 'keep'); self.assertIn('共用', row['reason'])

    def test_changed_original_options_and_new_task_invalidate_confirmation(self):
        preview = deletion.preview('one', True, False)
        with self.assertRaisesRegex(ValueError, '已变化'):
            deletion.execute('one', preview['token'], True, True, trash=Mock())
        preview = deletion.preview('one', False, True)
        self.source.write_bytes(b'changed original')
        with self.assertRaisesRegex(ValueError, '已变化'):
            deletion.execute('one', preview['token'], False, True, trash=Mock())
        preview = deletion.preview('one', False, True)
        atomic_write(self.root / 'task/two.json', {'path': str(self.source)})
        with self.assertRaisesRegex(ValueError, '已变化'):
            deletion.execute('one', preview['token'], False, True, trash=Mock())

    def test_missing_original_and_shared_source_output_are_deduplicated(self):
        self.source.unlink()
        preview = deletion.preview('one', True, True)
        self.assertEqual(preview['trash_count'], 1)
        self.assertEqual(next(row for row in preview['rows'] if row['kind'] == 'source')['action'], 'missing')
        atomic_write(self.root / 'record/one.json', {'entries': {str(self.output): {'target': str(self.output)}}})
        preview = deletion.preview('one', True, True)
        self.assertEqual(len(preview['rows']), 1)
        calls = []
        def trash(path): calls.append(path); path.unlink()
        deletion.execute('one', preview['token'], True, True, trash=trash)
        self.assertEqual(calls, [self.output])

    def test_original_directories_and_relative_sources_are_never_recycled(self):
        atomic_write(self.root / 'record/one.json', {'entries': {
            str(self.root): {'target': str(self.output)}, 'relative.mkv': {'target': str(self.output)}}})
        preview = deletion.preview('one', False, True)
        self.assertEqual(preview['trash_count'], 0)
        self.assertTrue(all(row['action'] == 'keep' for row in preview['rows']))

    def test_parent_symlink_does_not_allow_deleting_external_original(self):
        outside = self.root / 'outside'; outside.mkdir()
        original = outside / 'original.mkv'; original.write_bytes(b'keep')
        link = self.root / 'linked'
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('Directory symlinks unavailable')
        atomic_write(self.root / 'record/one.json', {'entries': {
            str(link / original.name): {'target': str(self.output)}}})
        preview = deletion.preview('one', False, True)
        row = next(row for row in preview['rows'] if row['kind'] == 'source')
        self.assertEqual(row['action'], 'keep'); self.assertIn('父目录', row['reason'])

    def test_original_recycle_failure_keeps_metadata_for_retry(self):
        preview = deletion.preview('one', False, True)
        with self.assertRaisesRegex(ValueError, '记录已保留'):
            deletion.execute('one', preview['token'], False, True, trash=Mock(side_effect=OSError('locked')))
        self.assertTrue(self.source.exists()); self.assertTrue((self.root / 'record/one.json').exists())

    @unittest.skipUnless(__import__('os').name == 'nt', 'Windows file sharing')
    def test_locked_file_blocks_all_batches_before_recycling(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateFileW(str(self.source), 0x80000000, 1, None, 3, 0, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
        try:
            preview = deletion.preview('one', True, True)
            with patch.object(deletion, 'recycle_batch') as recycle_batch:
                with self.assertRaisesRegex(ValueError, '0 个文件.*正被其他程序占用') as error:
                    deletion.execute('one', preview['token'], True, True)
                self.assertIn(str(self.source), str(error.exception))
                recycle_batch.assert_not_called()
            self.assertTrue(self.source.exists()); self.assertTrue(self.output.exists())
            self.assertTrue((self.root / 'task/one.json').exists())
            journal = json.loads(next((self.root / 'deleted_tasks').rglob('deletion.json')).read_text(encoding='utf-8'))
            self.assertEqual(journal['recycled'], [])
        finally:
            kernel.CloseHandle(handle)
        deletion.check_delete_access([self.source, self.output])

    def test_shell_sharing_error_explains_lock_and_preserves_unrelated_errors(self):
        error = Exception(-2144927705, 'OLE error 0x80270027')
        described = deletion.describe_recycle_error(error, [self.output])
        self.assertIn('正被其他程序占用', str(described)); self.assertIn(str(self.output), str(described))
        other = OSError('disk error')
        self.assertIs(deletion.describe_recycle_error(other, [self.output]), other)

    def test_api_forwards_explicit_original_deletion_for_preview_and_execution(self):
        from src.integration_api import perform
        for value, enabled in ((True, True), (False, False), ('true', False), (None, False)):
            with self.subTest(value=value), patch.object(deletion, 'preview') as preview, patch.object(deletion, 'execute') as execute:
                body = {'id': 'one', 'token': 'reviewed', 'delete_outputs': True, 'delete_sources': value}
                perform('delete-task-preview', body)
                preview.assert_called_once_with('one', True, enabled)
                perform('delete-task', body)
                execute.assert_called_once_with('one', 'reviewed', True, enabled)

    def test_shared_output_source_and_directories_are_protected(self):
        directory = self.root / 'extras'; directory.mkdir(); (directory / 'keep.txt').write_text('keep')
        atomic_write(self.root / 'record/two.json', {'entries': {'other': {'target': str(self.output)}}})
        record = {'entries': {str(self.source): {'target': str(self.output), 'mirror': str(self.source)},
                              'folder-source': {'target': str(directory)}}}
        atomic_write(self.root / 'record/one.json', record)
        preview = deletion.preview('one', True)
        self.assertEqual(preview['trash_count'], 0)
        self.assertTrue(any('共用' in row['reason'] for row in preview['rows']))
        self.assertTrue(any('源路径' in row['reason'] for row in preview['rows']))
        self.assertTrue(any('目录保留' in row['reason'] for row in preview['rows']))

    def test_new_reference_or_replaced_file_invalidates_confirmation(self):
        preview = deletion.preview('one', True)
        atomic_write(self.root / 'record/two.json', {'entries': {'other': {'target': str(self.output)}}})
        trash = Mock()
        with self.assertRaisesRegex(ValueError, '已变化'):
            deletion.execute('one', preview['token'], True, trash=trash)
        trash.assert_not_called()
        preview = deletion.preview('one', True); self.output.write_bytes(b'changed size')
        with self.assertRaises(ValueError): deletion.execute('one', preview['token'], True, trash=trash)

    def test_recycle_failure_retains_live_records_and_reports_partial_result(self):
        second = self.root / 'z.mkv'; second.write_bytes(b'media')
        atomic_write(self.root / 'record/one.json', {'entries': {
            str(self.source): {'target': str(self.output), 'mirror': str(second)}}})
        preview = deletion.preview('one', True)
        def trash(path):
            if path == second: raise OSError('locked')
            path.unlink()
        with self.assertRaisesRegex(ValueError, '记录已保留'):
            deletion.execute('one', preview['token'], True, trash=trash)
        self.assertTrue((self.root / 'task/one.json').exists()); self.assertTrue((self.root / 'record/one.json').exists())
        journal = json.loads(next((self.root / 'deleted_tasks').rglob('deletion.json')).read_text(encoding='utf-8'))
        self.assertEqual(journal['state'], 'failed'); self.assertEqual(len(journal['recycled']), 1)

    def test_task_path_traversal_and_corrupt_other_records_fail_closed(self):
        with self.assertRaises(ValueError): deletion.preview('../one', True)
        (self.root / 'record/two.json').write_text('bad json')
        with self.assertRaises(ValueError): deletion.preview('one', True)

    def test_records_only_does_not_stat_media_or_parse_unrelated_records(self):
        (self.root / 'record/two.json').write_text('unrelated corrupt json')
        with patch.object(Path, 'lstat', side_effect=AssertionError('media stat forbidden')):
            preview = deletion.preview('one')
        self.assertEqual(preview['rows'][0]['signature'], None)
        self.assertEqual(preview['keep_count'], 1)
        self.assertEqual(preview['protected_paths'], [])

    def test_output_inside_another_tasks_recorded_directory_is_protected(self):
        folder = self.root / 'shared'; folder.mkdir()
        target = folder / 'episode.mkv'; target.write_bytes(b'keep')
        atomic_write(self.root / 'record/one.json', {'entries': {str(self.source): {'target': str(target)}}})
        atomic_write(self.root / 'record/two.json', {'entries': {'other': {'target': str(folder)}}})
        preview = deletion.preview('one', True)
        self.assertEqual(preview['trash_count'], 0)
        self.assertIn('共用', preview['rows'][0]['reason'])

    def test_default_recycling_batches_files_and_records_completed_paths(self):
        outputs = [self.root / f'episode-{n:03}.mkv' for n in range(70)]
        for target in outputs:
            target.write_bytes(b'media')
        atomic_write(self.root / 'record/one.json', {'entries': {
            f'source-{n}': {'target': str(target)} for n, target in enumerate(outputs)}})
        preview = deletion.preview('one', True)
        def recycle_batch(targets):
            for target in targets:
                target.unlink()
        with patch.object(deletion, 'recycle_batch', side_effect=recycle_batch) as batches:
            result = deletion.execute('one', preview['token'], True)
        self.assertEqual(batches.call_count, 3)
        self.assertEqual(result['outputs'], 70)
        self.assertTrue(self.source.exists())

    def test_partial_shell_batch_failure_is_journaled_and_keeps_live_metadata(self):
        second = self.root / 'z.mkv'; second.write_bytes(b'media')
        atomic_write(self.root / 'record/one.json', {'entries': {
            str(self.source): {'target': str(self.output), 'mirror': str(second)}}})
        preview = deletion.preview('one', True)
        def partial(targets):
            targets[0].unlink()
            raise OSError('shell aborted')
        with patch.object(deletion, 'recycle_batch', side_effect=partial), self.assertRaisesRegex(ValueError, '记录已保留'):
            deletion.execute('one', preview['token'], True)
        journal = json.loads(next((self.root / 'deleted_tasks').rglob('deletion.json')).read_text(encoding='utf-8'))
        self.assertEqual(len(journal['recycled']), 1)
        self.assertEqual(journal['state'], 'failed')
        self.assertTrue((self.root / 'task/one.json').exists())
        self.assertTrue(second.exists())

    def prepare_nested_output(self):
        library = self.root / 'library'; work = library / 'Show (2025)'
        target = work / 'Specials' / 'Nested' / 'episode.mkv'
        target.parent.mkdir(parents=True); target.write_bytes(b'output')
        (work / 'Extras' / 'Empty').mkdir(parents=True)
        task = deletion.read(self.root / 'task/one.json'); task['output_dir'] = str(work)
        atomic_write(self.root / 'task/one.json', task)
        atomic_write(self.root / 'record/one.json', {'entries': {str(self.source): {'target': str(target)}}})
        return library, work, target

    def test_recursive_empty_cleanup_stops_at_work_boundary(self):
        library, work, target = self.prepare_nested_output()
        sibling = library / 'Other'; sibling.mkdir()
        preview = deletion.preview('one', True)
        self.assertEqual(preview['cleanup_roots'], [str(work)])
        result = deletion.execute('one', preview['token'], True, trash=lambda p: p.unlink())
        self.assertFalse(work.exists()); self.assertTrue(library.exists()); self.assertTrue(sibling.exists())
        self.assertEqual(result['dirs'], 5); self.assertTrue(self.source.exists())

    def test_records_only_never_cleans_empty_directories(self):
        _, work, target = self.prepare_nested_output()
        preview = deletion.preview('one')
        self.assertEqual(preview['cleanup_roots'], [])
        deletion.execute('one', preview['token'])
        self.assertTrue(target.exists()); self.assertTrue((work / 'Extras/Empty').exists())

    def test_source_directory_empty_children_are_not_cleaned(self):
        _, work, _ = self.prepare_nested_output()
        source_folder = work / 'source'; (source_folder / 'original-empty').mkdir(parents=True)
        removed, _ = deletion.cleanup_empty_directories([work], [str(source_folder)])
        self.assertTrue((source_folder / 'original-empty').exists())
        self.assertNotIn(str(source_folder), removed)

    def test_nonempty_directories_and_other_tasks_missing_outputs_are_preserved(self):
        _, work, _ = self.prepare_nested_output()
        cover = work / 'cover.jpg'; cover.write_bytes(b'keep')
        shared = work / 'Shared'; shared.mkdir()
        atomic_write(self.root / 'record/two.json', {'entries': {'other': {'target': str(shared / 'offline.mkv')}}})
        preview = deletion.preview('one', True)
        deletion.execute('one', preview['token'], True, trash=lambda p: p.unlink())
        self.assertTrue(cover.exists()); self.assertTrue(shared.exists())
        self.assertFalse((work / 'Extras').exists()); self.assertFalse((work / 'Specials').exists())

    def test_library_root_itself_is_not_a_cleanup_boundary(self):
        library, _, target = self.prepare_nested_output()
        with patch.object(deletion.cm, 'get_config', side_effect=lambda key: str(library) if key == 'anime_path' else ''):
            roots = deletion.cleanup_roots({'output_dir': str(library)}, {}, [target])
        self.assertNotIn(library, roots)

    def test_symlink_directory_tree_is_not_followed(self):
        _, work, _ = self.prepare_nested_output()
        outside = self.root / 'outside'; (outside / 'empty').mkdir(parents=True)
        link = work / 'link'
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('Directory symlinks unavailable')
        deletion.cleanup_empty_directories([work])
        self.assertTrue((outside / 'empty').exists()); self.assertTrue(link.is_symlink())

    def test_mirror_paths_get_their_own_work_boundary(self):
        if __import__('os').name != 'nt':
            self.skipTest('Windows drive mirrors')
        with patch.object(deletion.cm, 'get_config', return_value=''):
            roots = deletion.cleanup_roots({'output_dir': r'D:\library\Show (2025)'}, {},
                [Path(r'D:\library\Show (2025)\EP01.mkv'), Path(r'G:\library\Show (2025)\EP01.mkv')])
        self.assertEqual(set(roots), {Path(r'D:\library\Show (2025)'), Path(r'G:\library\Show (2025)')})
