"""Incremental, thread-safe index of the existing JSON task files."""

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from collections import defaultdict
from .task_identity import task_path_key


@dataclass
class TaskSnapshot:
    rows: list[dict]
    successful: int
    failed: int
    duplicates: int = 0


class TaskIndex:
    def __init__(self, directory: Path):
        self.directory = directory
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[tuple[int, int], dict]] = {}
        self._dirty: set[str] = set()

    def refresh(self) -> TaskSnapshot:
        with self._lock:
            present = set()
            with os.scandir(self.directory) as entries:
                for entry in entries:
                    if not entry.name.endswith('.json') or not entry.is_file():
                        continue
                    present.add(entry.name)
                    try:
                        metadata = entry.stat()
                        version = (metadata.st_mtime_ns, metadata.st_size)
                        previous = self._entries.get(entry.name)
                        if previous and previous[0] == version and entry.name not in self._dirty:
                            continue
                        path = Path(entry.path)
                        data = json.loads(path.read_text(encoding='utf-8'))
                        after = path.stat()
                        if not isinstance(data, dict) or version != (after.st_mtime_ns, after.st_size):
                            self._dirty.add(entry.name)
                            continue
                        data.setdefault('uuid', path.stem)
                        self._entries[entry.name] = (version, data)
                        self._dirty.discard(entry.name)
                    except (OSError, ValueError):
                        # Keep the last complete record during an in-place write.
                        # Its old version ensures we retry reading next time.
                        self._dirty.add(entry.name)
                        continue
            for name in self._entries.keys() - present:
                del self._entries[name]
            self._dirty.intersection_update(present)
            records = sorted(self._entries.items(), key=lambda item: (-item[1][0][0], item[0]))
            rows = []
            failed = 0
            for index, (_, (_, task)) in enumerate(records, start=1):
                from ..rename.task_schema import normalize_task
                task = normalize_task(task)
                error = task.get('error')
                failed += bool(error)
                rows.append({
                    'id': index, 'uuid': task['uuid'], 'path': task.get('path', ''),
                    'name': task.get('name'), 'season': task.get('season_id'),
                    'bgm_id': task.get('subject_id') or task.get('bgm_id', ''),
                    'subject_ids': task.get('subject_ids') or ([str(task.get('subject_id') or task.get('bgm_id'))]
                                                            if task.get('subject_id') or task.get('bgm_id') else []),
                    'layout': task.get('layout', 'legacy'),
                    'platform': task.get('platform') or '—',
                    'output_dir': task.get('output_dir', ''),
                    'subtitle_group': task.get('subtitle_group', ''),
                    'status': str(error) if error else '成功',
                    'has_error': bool(error),
                    'is_anime': task.get('is_anime'), 'is_movie': task.get('is_movie'),
                    'value': '操作',
                })
            groups = defaultdict(list)
            for row in rows:
                path_key = task_path_key(row['path'])
                # A source pack can legitimately contain multiple Bangumi subjects.
                # After subject-native splitting those are separate tasks, not duplicates.
                key = (path_key, str(row.get('bgm_id') or '')) if row.get('layout') == 'bangumi' else (path_key, '')
                if path_key:
                    groups[key].append(row)
            for row in rows:
                path_key = task_path_key(row['path'])
                key = (path_key, str(row.get('bgm_id') or '')) if row.get('layout') == 'bangumi' else (path_key, '')
                group = groups.get(key, [])
                row['duplicate_count'] = len(group) if len(group) > 1 else 0
                row['duplicate_task_ids'] = [item['uuid'] for item in group] if len(group) > 1 else []
            duplicates = sum(len(group) - 1 for group in groups.values())
            return TaskSnapshot(rows, len(rows) - failed, failed, duplicates)
