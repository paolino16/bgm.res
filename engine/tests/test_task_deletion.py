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
