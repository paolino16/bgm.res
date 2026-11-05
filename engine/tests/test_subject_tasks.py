import json
import tempfile
import unittest
from pathlib import Path

from src.rename.subject_tasks import split_completed_native_task, subject_task_uuid


class SubjectTaskSplitTests(unittest.TestCase):
    def test_reviewed_pack_becomes_one_task_and_record_per_subject(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tasks, records = root / 'task', root / 'record'
            tasks.mkdir()
            records.mkdir()
            source = root / 'source'
            source.mkdir()
            first_source, movie_source = source / 'Show 01.mkv', source / 'Movie.mkv'
            first_source.write_bytes(b'first')
            movie_source.write_bytes(b'movie')
            first_root, movie_root = root / 'tv/Show (2025)', root / 'movies/Movie (2026)'
            first_target, movie_target = first_root / 'Show EP01.mkv', movie_root / 'Movie EP01.mkv'
            first_target.parent.mkdir(parents=True)
            movie_target.parent.mkdir(parents=True)
            first_target.write_bytes(b'first')
            movie_target.write_bytes(b'movie')
            task = {
                'uuid': 'parent', 'path': str(source), 'name': 'Show', 'bgm_id': '1',
                'subject_id': '1', 'subject_ids': ['1', '2'], 'layout': 'bangumi',
                'metadata_source': 'bangumi', 'output_dir': str(first_root), 'is_anime': True,
                'episode_bindings': [
                    {'source': str(first_source), 'subject_id': '1', 'episode_id': 11,
                     'episode': 1, 'episode_type': 0, 'category': 'episode'},
                    {'source': str(movie_source), 'subject_id': '2', 'episode_id': 21,
                     'episode': 1, 'episode_type': 0, 'category': 'episode'},
                ], 'migration': {},
            }
            record = {'schema_version': 2, 'status': 'completed', 'metadata_source': 'bangumi',
                      'subject_id': '1', 'entries': {
                          str(first_source): {'target': str(first_target)},
                          str(movie_source): {'target': str(movie_target)},
                      }, 'episode_bindings': task['episode_bindings']}
            task_path, record_path = tasks / 'parent.json', records / 'parent.json'
            task_path.write_text(json.dumps(task), encoding='utf-8')
            record_path.write_text(json.dumps(record), encoding='utf-8')
            context = {
                'name': 'Show', 'work_path': str(first_root), 'platform': 'TV',
                'subjects': {'2': {'name': 'Movie', 'work_path': str(movie_root),
                                   'platform': '剧场版', 'first_air_date': '2026-01-01'}},
            }
            ids = split_completed_native_task(task_path, record_path, context)
            child_id = subject_task_uuid('parent', '2')
            self.assertEqual(set(ids), {'parent', child_id})
            primary = json.loads(task_path.read_bytes())
            child = json.loads((tasks / f'{child_id}.json').read_bytes())
            self.assertEqual(primary['subject_ids'], ['1'])
            self.assertEqual(child['subject_ids'], ['2'])
            self.assertTrue(child['is_movie'])
            self.assertEqual(child['output_dir'], str(movie_root))
            self.assertEqual(child['path'], str(movie_source))
            self.assertEqual(set(json.loads(record_path.read_bytes())['entries']), {str(first_source)})
            self.assertEqual(set(json.loads((records / f'{child_id}.json').read_bytes())['entries']),
                             {str(movie_source)})
            self.assertEqual(first_target.read_bytes(), b'first')
            self.assertEqual(movie_target.read_bytes(), b'movie')
