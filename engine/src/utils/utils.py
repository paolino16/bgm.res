import json
import os
from pathlib import Path
from typing import Any, Dict, Optional, Set

from .path import TASK_PATH, RECORD_PATH


def get_record(uuid: str) -> Optional[dict]:
    path = RECORD_PATH / f'{uuid}.json'
    if path.exists():
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    else:
        return None


def extract_record_entries(record: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(record, dict):
        return {}

    entries = record.get('entries')
    if isinstance(entries, dict):
        return entries

    # Backward compatibility for the legacy flat record format:
    # {source_path: {"target": "...", "mirror": "..."}, ...}
    return {
        key: value
        for key, value in record.items()
        if key not in {'status', 'entries', 'updated_at'}
    }


def extract_record_targets(record: Optional[Dict[str, Any]]) -> Set[Path]:
    targets: Set[Path] = set()
    for entry in extract_record_entries(record).values():
        if isinstance(entry, str):
            targets.add(Path(entry))
            continue
        if isinstance(entry, dict):
            for key in ('target', 'mirror'):
                value = entry.get(key)
                if value:
                    targets.add(Path(value))
    return targets


def remove_empty_dirs(
    directories: Set[Path],
    max_levels: Optional[int] = None,
) -> int:
    removed_dirs = 0
    checked_dirs = sorted(
        {path for path in directories if isinstance(path, Path)},
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for directory in checked_dirs:
        current = directory
        removed_levels = 0
        while current.is_dir():
            try:
                if any(current.iterdir()):
                    break
                current.rmdir()
                removed_dirs += 1
                removed_levels += 1
            except OSError:
                break

            if max_levels is not None and removed_levels >= max_levels:
                break
            parent = current.parent
            if parent == current:
                break
            current = parent
    return removed_dirs


def collect_cleanup_directories(paths: Set[Path]) -> Set[Path]:
    directories: Set[Path] = set()
    for path in paths:
        if not isinstance(path, Path):
            continue

        current = path
        while True:
            if os.path.ismount(current):
                break
            directories.add(current)
            parent = current.parent
            if parent == current:
                break
            current = parent
    return directories


def cleanup_output_targets(
    targets: Set[Path],
    extra_dirs: Optional[Set[Path]] = None,
    max_levels: Optional[int] = None,
) -> Dict[str, int]:
    stats = {'outputs': 0, 'dirs': 0}

    for target_path in targets:
        try:
            if target_path.is_file() or target_path.is_symlink():
                target_path.unlink()
                stats['outputs'] += 1
        except FileNotFoundError:
            continue
        except OSError:
            continue

    directories = collect_cleanup_directories(
        {target_path.parent for target_path in targets}
    )
    if extra_dirs:
        directories.update(collect_cleanup_directories(extra_dirs))
    if directories:
        stats['dirs'] = remove_empty_dirs(directories, max_levels=max_levels)
    return stats


def prepare_retry_process_inputs(task_data: Dict[str, Any]) -> Dict[str, Any]:
    skip_search = bool(task_data.get('skip_search', False))
    return {
        'name': task_data.get('name'),
        'season_id': task_data.get('season_id'),
        'subtitle_group': task_data.get('subtitle_group') or None,
        'year': task_data.get('year') if skip_search else None,
        'tmdb_id': task_data.get('tmdb_id') or None,
        'bgm_id': task_data.get('bgm_id') or None,
        'skip_search': skip_search,
    }


def custom_sort(key):
    if key == 'is_anime':
        return (0, key)
    elif key == 'is_movie':
        return (1, key)
    else:
        return (2, key)


def get_task(uuid: str) -> dict:
    path = TASK_PATH / f'{uuid}.json'
    if path.exists():
        with open(path, 'r', encoding='utf-8') as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                # A worker may still be writing this task; its completion will
                # refresh the table again with the finished record.
                return {}
            if 'is_movie' not in data:
                data['is_movie'] = None
            if 'year' not in data:
                data['year'] = ''
            if 'skip_search' not in data:
                data['skip_search'] = False
            from ..rename.task_schema import normalize_task
            data = normalize_task(data)
            sorted_keys = sorted(data.keys(), key=custom_sort)
            sorted_dict = {key: data[key] for key in sorted_keys}
            return sorted_dict
    else:
        return {}


def write_task(uuid: str, data: dict) -> None:
    path = TASK_PATH / f'{uuid}.json'
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
