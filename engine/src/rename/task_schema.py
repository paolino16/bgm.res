"""Version task metadata without rewriting historical file-operation records."""

import copy
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

VERSION = 2


def normalize_task(task):
    result = copy.deepcopy(task)
    if result.get('schema_version', 1) >= VERSION:
        return result
    result['schema_version'] = VERSION
    result.setdefault('layout', 'legacy')
    bgm = str(result.get('bgm_id') or '').strip()
    source = 'bangumi' if bgm and not result.get('tmdb_id') else 'tmdb' if result.get('tmdb_id') else 'unknown'
    result.setdefault('metadata_source', source)
    if source == 'bangumi':
        result.setdefault('subject_id', bgm)
    if isinstance(result.get('file_plan_context'), dict):
        result['file_plan_context'].setdefault('layout', result['layout'])
        result['file_plan_context'].setdefault('subject_id', result.get('subject_id'))
    result['migration'] = {
        'from_version': task.get('schema_version', 1), 'state': 'legacy_preserved',
        'legacy_season_id': task.get('season_id'),
        'legacy_output_dir': task.get('output_dir', ''),
    }
    return result


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f'{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        temp.write_bytes(json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8'))
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def migrate_metadata(data_path, apply=False):
    """Back up exact bytes before an idempotent metadata-only upgrade.

    Records/plans are archived for recovery but never converted into guessed
    episode identities. No media paths are created, moved, or removed here.
    """
    data_path = Path(data_path)
    changes, errors = [], []
    for path in sorted((data_path / 'task').glob('*.json')):
        try:
            raw = path.read_bytes()
            original = json.loads(raw)
            if not isinstance(original, dict):
                raise ValueError('任务记录不是对象')
            upgraded = normalize_task(original)
            if original != upgraded:
                changes.append((path, raw, upgraded, path.stat()))
        except (OSError, ValueError) as exc:
            errors.append({'file': str(path), 'error': str(exc)})
    report = {'tasks': len(changes), 'errors': errors, 'applied': False, 'backup': None}
    if not apply or not changes or errors:
        return report
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = data_path / 'migrations' / f'{stamp}-{uuid.uuid4().hex[:8]}'
    manifest = {'schema_version': VERSION, 'files': []}
    changed = {path.relative_to(data_path).as_posix(): upgraded for path, _, upgraded, _ in changes}
    # Snapshot all metadata before changing any task, including decisions/history.
    for folder in ('task', 'record', 'rename_plans'):
        for path in sorted((data_path / folder).glob('*.json')):
            raw = path.read_bytes()
            relative = path.relative_to(data_path)
            target = backup / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            entry = {'path': relative.as_posix(), 'sha256': hashlib.sha256(raw).hexdigest()}
            if relative.as_posix() in changed:
                encoded = json.dumps(changed[relative.as_posix()], ensure_ascii=False, indent=2).encode('utf-8')
                entry['after_sha256'] = hashlib.sha256(encoded).hexdigest()
                entry['mtime_ns'] = path.stat().st_mtime_ns
            manifest['files'].append(entry)
    atomic_write(backup / 'manifest.json', manifest)
    # A concurrently updated task must never be overwritten by a stale snapshot.
    for path, raw, _, _ in changes:
        if path.read_bytes() != raw:
            raise RuntimeError(f'任务已变化，请重新运行迁移：{path}')
    for path, _, upgraded, stat in changes:
        atomic_write(path, upgraded)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    report.update(applied=True, backup=str(backup))
    atomic_write(backup / 'report.json', report)
    return report


def restore_metadata(data_path, backup):
    """Restore only upgraded tasks, refusing to overwrite subsequent edits."""
    data_path, backup = Path(data_path).resolve(), Path(backup).resolve()
    manifest = json.loads((backup / 'manifest.json').read_text(encoding='utf-8'))
    changes = []
    for entry in manifest['files']:
        if 'after_sha256' not in entry:
            continue
        destination = (data_path / entry['path']).resolve()
        archived = (backup / entry['path']).resolve()
        if not destination.is_relative_to(data_path / 'task') or not archived.is_relative_to(backup):
            raise ValueError('备份包含非法任务路径')
        raw = archived.read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise ValueError(f'备份校验失败：{archived}')
        current = hashlib.sha256(destination.read_bytes()).hexdigest()
        if current == entry['sha256']:
            continue
        if current != entry['after_sha256']:
            raise ValueError(f'任务已在升级后修改，不能覆盖：{destination}')
        changes.append((destination, raw, entry['mtime_ns']))
    for destination, raw, modified in changes:
        temp = destination.with_name(f'{destination.name}.{uuid.uuid4().hex}.tmp')
        temp.write_bytes(raw)
        temp.replace(destination)
        os.utime(destination, ns=(modified, modified))
    return {'restored': len(changes)}


if __name__ == '__main__':
    import argparse
    from ..utils.path import DATA_PATH
    parser = argparse.ArgumentParser(description='升级任务元数据；默认仅预览，不改媒体文件')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--data', type=Path, default=DATA_PATH)
    parser.add_argument('--restore', type=Path, help='恢复某次元数据升级；拒绝覆盖升级后的修改')
    args = parser.parse_args()
    result = restore_metadata(args.data, args.restore) if args.restore else migrate_metadata(args.data, args.apply)
    print(json.dumps(result, ensure_ascii=False, indent=2))
