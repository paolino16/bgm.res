"""Persist Bangumi subjects as independent tasks after a reviewed mixed pack."""
import copy
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .plan_resolution import task_context
from .task_schema import atomic_write

MOVIE_PLATFORMS = {'剧场版', 'MOVIE', '电影'}


def subject_task_uuid(parent_uuid, subject_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'bangumi-subject-task:{parent_uuid}:{subject_id}'))


def _target(entry):
    return Path(entry if isinstance(entry, str) else entry['target'])


def _source_path(parent_path, bindings):
    parent = Path(parent_path)
    candidates = [str(Path(b['source'])) for b in bindings
                  if Path(b['source']).drive.casefold() == parent.drive.casefold()
                  and (Path(b['source']) == parent or Path(b['source']).is_relative_to(parent))]
    if not candidates:
        return str(parent)
    if len(candidates) == 1:
        return candidates[0]
    common = Path(os.path.commonpath(candidates))
    return str(common.parent if common.suffix else common)


def split_completed_native_task(task_path, record_path, context):
    """Split a just-completed reviewed plan; media paths are already independent."""
    task_path, record_path = Path(task_path), Path(record_path)
    task, record = json.loads(task_path.read_bytes()), json.loads(record_path.read_bytes())
    subject_ids = sorted({str(b['subject_id']) for b in task.get('episode_bindings', [])
                          if b.get('category') != 'skipped'})
    if task.get('layout') != 'bangumi' or len(subject_ids) <= 1:
        if context.get('platform'):
            task['platform'] = context['platform']
        task['subject_ids'] = subject_ids or [str(task.get('subject_id'))]
        atomic_write(task_path, task)
        return [task['uuid']]

    primary = str(task['subject_id'])
    definitions = {primary: {
        'name': context.get('name') or task['name'],
        'work_path': context['work_path'],
        'platform': context.get('platform') or ('剧场版' if task.get('is_movie') else 'TV'),
        'first_air_date': context.get('first_air_date') or task.get('year') or '',
        'relations': task.get('relations', []),
    }}
    definitions.update({str(key): value for key, value in context.get('subjects', {}).items()})
    missing = set(subject_ids) - set(definitions)
    if missing:
        raise ValueError(f'缺少条目拆分信息：{sorted(missing)}')
    roots = {sid: Path(definitions[sid]['work_path']) for sid in subject_ids}
    entries = {sid: {} for sid in subject_ids}
    for source, entry in record.get('entries', {}).items():
        target = _target(entry)
        matches = [sid for sid, root in roots.items() if target.is_relative_to(root)]
        if len(matches) != 1:
            raise ValueError(f'输出不能唯一归属条目：{source} -> {target}')
        entries[matches[0]][source] = copy.deepcopy(entry)

    payloads = {}
    for sid in subject_ids:
        definition = definitions[sid]
        bindings = [copy.deepcopy(b) for b in task['episode_bindings'] if str(b['subject_id']) == sid]
        uid = task['uuid'] if sid == primary else subject_task_uuid(task['uuid'], sid)
        child_path = task_path.parent / f'{uid}.json'
        child_record_path = record_path.parent / f'{uid}.json'
        if uid != task['uuid'] and (child_path.exists() or child_record_path.exists()):
            raise ValueError(f'条目任务编号已存在：{uid}')
        child = copy.deepcopy(task)
        child.update(uuid=uid, path=_source_path(task['path'], bindings),
                     name=definition['name'], bangumi_name=definition['name'],
                     bgm_id=sid, subject_id=sid, subject_ids=[sid], season_id=None,
                     output_dir=str(roots[sid]), episode_bindings=bindings,
                     is_movie=str(definition.get('platform') or '').upper() in MOVIE_PLATFORMS,
                     platform=definition.get('platform') or '',
                     year=str(definition.get('first_air_date') or '')[:4],
                     relations=definition.get('relations', []), error=None, use_ai=False)
        for field in ('identification', 'file_decisions', 'file_plan_context', 'skipped_files'):
            child.pop(field, None)
        child['migration'] = copy.deepcopy(child.get('migration') or {})
        child['migration'].update(state='native', split_from=task['uuid'])
        child['migration']['recognition_context'] = task_context(child)
        child_record = {'schema_version': 2, 'status': 'completed', 'metadata_source': 'bangumi',
                        'subject_id': sid, 'entries': entries[sid], 'episode_bindings': bindings}
        for field in ('bulk_journal', 'migration_journal'):
            if record.get(field):
                child_record[field] = record[field]
        payloads[uid] = (child_path, child, child_record_path, child_record)

    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = task_path.parent.parent / 'migrations' / 'task-splits' / f'{stamp}-{task["uuid"]}'
    backup.mkdir(parents=True, exist_ok=False)
    (backup / 'task.json').write_bytes(task_path.read_bytes())
    (backup / 'record.json').write_bytes(record_path.read_bytes())
    atomic_write(backup / 'manifest.json', {'parent': task['uuid'], 'subjects': subject_ids,
                                            'tasks': list(payloads)})
    written = []
    try:
        for uid, (child_path, child, child_record_path, child_record) in payloads.items():
            atomic_write(child_path, child)
            atomic_write(child_record_path, child_record)
            written.append(uid)
    except Exception:
        for uid in written:
            child_path, _, child_record_path, _ = payloads[uid]
            if uid == task['uuid']:
                child_path.write_bytes((backup / 'task.json').read_bytes())
                child_record_path.write_bytes((backup / 'record.json').read_bytes())
            else:
                child_path.unlink(missing_ok=True)
                child_record_path.unlink(missing_ok=True)
        raise
    return list(payloads)
