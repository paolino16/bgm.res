"""Stage, commit, verify and recover a whole-library metadata migration."""

import copy
import hashlib
import json
import os
import re
import shutil
import uuid
from collections import defaultdict
from pathlib import Path

from .bulk_migration import read, old_root
from .rename_strategy import append_version, edition_label
from .task_schema import atomic_write
from .utils import VIDEO_SUFFIX
from ..utils.path import DATA_PATH
from ..utils.utils import extract_record_entries


def key(path):
    return os.path.normcase(os.path.abspath(path))


def identity(path):
    stat = Path(path).lstat()
    return [stat.st_dev, stat.st_ino]


def resolve_versions(tasks):
    destinations = defaultdict(dict)
    origins = {}
    for task in tasks:
        for original, entry in {**extract_record_entries(task['record']), **task.get('add_entries', {})}.items():
            source = entry if isinstance(entry, str) else entry.get('target')
            if source:
                origins[(task['uuid'], key(source))] = original
        for source, target in task['mapping'].items():
            if Path(source).suffix.lower() in VIDEO_SUFFIX:
                destinations[key(target)][key(source)] = (task, source, target)
    changes = []
    for versions in destinations.values():
        if len(versions) < 2:
            continue
        signatures = []
        for index, (task, source, target) in enumerate(versions.values(), 1):
            original = Path(origins[(task['uuid'], key(source))])
            label = edition_label(original)
            if not label:
                match = re.search(r'(?i)\bDC\s+Ver\.?|TV放送版|DVDフォーマット版|ビデオフォーマット版|オンエアフォーマット版', original.stem)
                label = match.group() if match else ''
            if label in signatures or not label:
                label = f'发行版 {index}'
            signatures.append(label)
            replacement = append_version(Path(target), label)
            # Update all owners of the same physical output plus its companions.
            for owner in tasks:
                for old, planned in list(owner['mapping'].items()):
                    if key(old) == key(source):
                        owner['mapping'][old] = str(replacement)
                    elif Path(old).parent == Path(source).parent and Path(old).name.startswith(Path(source).stem + '.'):
                        suffix = Path(old).name[len(Path(source).stem):]
                        owner['mapping'][old] = str(replacement.with_name(replacement.stem + suffix))
            changes.append({'source': source, 'target': str(replacement), 'version': label})
    return changes


def compile_plan(run_dir):
    run_dir = Path(run_dir).resolve()
    prepared = read(run_dir / 'plan.json')
    tasks = copy.deepcopy([t for t in prepared['tasks'] if t['state'] == 'ready'])
    versions = resolve_versions(tasks)
    operations, destinations, unavailable, issues = {}, {}, [], []
    for task in tasks:
        root = old_root(extract_record_entries(task['record'])).absolute()
        library = root.parent
        recoveries = {key(r['current']): r for r in task['recoveries']}
        for source_value, target_value in task['mapping'].items():
            source, target = Path(source_value).absolute(), Path(target_value).absolute()
            recovery = recoveries.get(key(source))
            if recovery and recovery['kind'] == 'unavailable':
                unavailable.append({'task': task['uuid'], **recovery})
                continue
            archive = task.get('allow_archive') and target.is_relative_to(run_dir / 'aliases')
            if not source.is_relative_to(root) or not (target.is_relative_to(library) or archive):
                issues.append(f'路径超出此任务的媒体库：{source} → {target}')
                continue
            if key(source) == key(target):
                continue
            if key(source) in operations:
                if key(operations[key(source)]['target']) != key(target):
                    issues.append(f'共享源文件目标不一致：{source}')
                continue
            if key(target) in destinations and destinations[key(target)] != key(source):
                issues.append(f'多个输出冲突：{target}')
                continue
            if source.drive != target.drive:
                issues.append(f'不执行跨盘移动：{source} → {target}')
                continue
            operation = {'source': str(source), 'target': str(target), 'task': task['uuid'],
                         'kind': recovery['kind'] if recovery else 'move',
                         'stage': str(run_dir / 'staging' / f'{len(operations):06d}'),
                         'directory': source.is_dir() and not source.is_symlink()}
            if recovery:
                operation['fallback'] = recovery['fallback']
            else:
                if not source.exists() and not source.is_symlink():
                    issues.append(f'源文件已不可用：{source}')
                    continue
                operation['identity'] = identity(source)
                if source.is_symlink() and not Path(os.readlink(source)).is_absolute():
                    issues.append(f'相对软链接需单独处理：{source}')
                    continue
            operations[key(source)] = operation
            destinations[key(target)] = key(source)
    # If an owned directory moves as one unit, child records follow that move.
    directories = [op for op in operations.values() if op['directory']]
    for source_key, op in list(operations.items()):
        for parent in directories:
            if source_key == key(parent['source']):
                continue
            if Path(op['source']).is_relative_to(Path(parent['source'])):
                expected = Path(parent['target']) / Path(op['source']).relative_to(parent['source'])
                if key(expected) != key(op['target']):
                    issues.append(f'目录与子文件映射不同：{op["source"]}')
                else:
                    operations.pop(source_key, None)
                break
    sources = set(operations)
    for op in operations.values():
        target = Path(op['target'])
        if (target.exists() or target.is_symlink()) and key(target) not in sources:
            issues.append(f'目标已有未纳入移动的文件：{target}')
        if os.name == 'nt' and any(len(part.encode('utf-16-le')) // 2 > 255 for part in target.parts):
            issues.append(f'目标文件名过长：{target}')
    result = {'state': 'prepared', 'tasks': tasks, 'operations': list(operations.values()),
              'versions': versions, 'unavailable': unavailable, 'issues': issues,
              'pending': [{'uuid': t['uuid'], 'name': t['name'], 'problems': t.get('problems', [])}
                          for t in prepared['tasks'] if t['state'] != 'ready']}
    atomic_write(run_dir / 'execution.json', result)
    return {'tasks': len(tasks), 'operations': len(operations), 'versions': len(versions),
            'recoveries': sum(op['kind'] != 'move' for op in operations.values()),
            'unavailable_annotations': len(unavailable), 'issues': issues, 'pending': len(result['pending'])}


def build_metadata(task, run_dir, unavailable):
    entries = copy.deepcopy(extract_record_entries(task['record']))
    entries.update(copy.deepcopy(task.get('add_entries', {})))
    missing = {key(r['current']) for r in unavailable if r['task'] == task['uuid']}
    archived_missing = {}
    for original, entry in list(entries.items()):
        source = entry if isinstance(entry, str) else entry.get('target')
        if not source:
            continue
        if key(source) in missing:
            archived_missing[original] = entries.pop(original)
            continue
        target = task.get('logical_mapping', {}).get(source) or task['mapping'].get(source)
        if target:
            if isinstance(entry, str):
                entries[original] = target
            else:
                entry['target'] = target
    record = {'schema_version': 2, 'status': 'completed', 'metadata_source': 'bangumi',
              'subject_id': task['new_task']['subject_id'], 'entries': entries,
              'episode_bindings': task['bindings'], 'bulk_journal': str(run_dir / 'execution.json')}
    if archived_missing or task['record'].get('unavailable_entries'):
        record['unavailable_entries'] = {**task['record'].get('unavailable_entries', {}), **archived_missing}
    metadata = copy.deepcopy(task['new_task'])
    metadata['migration'].update(bulk_journal=str(run_dir / 'execution.json'),
                                 state='native_with_missing_history' if archived_missing else 'native')
    # Preserve previous explicit decisions in the backup instead of replaying
    # season-based decisions against a newly split subject layout.
    for field in ('file_decisions', 'file_plan_context', 'skipped_files'):
        metadata.pop(field, None)
    from .plan_resolution import task_context
    metadata['migration']['recognition_context'] = task_context(metadata)
    return metadata, record


def execute(run_dir):
    run_dir = Path(run_dir).resolve()
    journal_path = run_dir / 'execution.json'
    journal = read(journal_path)
    if journal['state'] != 'prepared' or journal['issues']:
        raise ValueError('执行方案状态错误或有未处理冲突')
    for task in journal['tasks']:
        for folder, expected in (('task', task['task']), ('record', task['record'])):
            path = DATA_PATH / folder / f'{task["uuid"]}.json'
            if read(path) != expected:
                raise ValueError(f'记录已改变，请重新准备：{path}')
    for op in journal['operations']:
        if op['kind'] == 'move' and identity(op['source']) != op['identity']:
            raise ValueError(f'文件身份已改变：{op["source"]}')
    # Exact-byte snapshots precede every media mutation.
    for folder in ('task', 'record', 'rename_plans'):
        for path in (DATA_PATH / folder).glob('*.json'):
            destination = run_dir / 'before' / folder / path.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(path.read_bytes())
    after = {}
    for task in journal['tasks']:
        metadata, record = build_metadata(task, run_dir, journal['unavailable'])
        after[task['uuid']] = {'task': metadata, 'record': record}
        for folder, value in (('task', metadata), ('record', record)):
            atomic_write(run_dir / 'after' / folder / f'{task["uuid"]}.json', value)
    journal['state'] = 'staging'
    atomic_write(journal_path, journal)
    (run_dir / 'staging').mkdir(exist_ok=True)
    progress = open(run_dir / 'moves.jsonl', 'a', encoding='utf-8')
    try:
        for index, op in enumerate(journal['operations'], 1):
            if op['kind'] == 'move':
                os.replace(op['source'], op['stage'])
            progress.write(json.dumps({'phase': 'staged', 'source': op['source']}) + '\n')
            if index % 100 == 0:
                progress.flush()
                print(json.dumps({'phase': 'staging', 'files': index, 'total': len(journal['operations'])}), flush=True)
        journal['state'] = 'placing'
        atomic_write(journal_path, journal)
        for index, op in enumerate(sorted(journal['operations'], key=lambda o: len(Path(o['target']).parts)), 1):
            target = Path(op['target'])
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() or target.is_symlink():
                raise FileExistsError(str(target))
            if op['kind'] == 'move':
                os.replace(op['stage'], target)
            elif op['kind'] == 'hardlink':
                os.link(op['fallback'], target)
            elif op['kind'] == 'symlink':
                os.symlink(op['fallback'], target)
            progress.write(json.dumps({'phase': 'placed', 'target': str(target)}) + '\n')
            if index % 100 == 0:
                progress.flush()
                print(json.dumps({'phase': 'placing', 'files': index, 'total': len(journal['operations'])}), flush=True)
        progress.flush()
        journal['state'] = 'committing'
        atomic_write(journal_path, journal)
        for task in journal['tasks']:
            for folder, data in after[task['uuid']].items():
                atomic_write(DATA_PATH / folder / f'{task["uuid"]}.json', data)
            plan = DATA_PATH / 'rename_plans' / f'{task["uuid"]}.json'
            if plan.exists():
                value = read(plan)
                if value.get('state') == 'pending':
                    value['state'] = 'superseded'
                    atomic_write(plan, value)
        journal['state'] = 'completed'
        atomic_write(journal_path, journal)
    except Exception as exc:
        journal.update(state='interrupted', error=str(exc))
        atomic_write(journal_path, journal)
        raise
    finally:
        progress.close()
    return {'state': 'completed', 'tasks': len(journal['tasks']), 'operations': len(journal['operations'])}


def rollback(run_dir):
    run_dir = Path(run_dir).resolve()
    journal = read(run_dir / 'execution.json')
    # Prevalidate all identities and metadata before reversing any operation.
    restore = []
    for op in journal['operations']:
        source, stage, target = map(Path, (op['source'], op['stage'], op['target']))
        if op['kind'] != 'move':
            if target.exists() or target.is_symlink():
                if op['kind'] == 'symlink' and (not target.is_symlink() or os.readlink(target) != op['fallback']):
                    raise ValueError(f'恢复目标已改变：{target}')
                if op['kind'] == 'hardlink' and not target.samefile(op['fallback']):
                    raise ValueError(f'恢复目标已改变：{target}')
                restore.append(('remove_created', target, None))
            continue
        locations = [p for p in (source, stage, target) if (p.exists() or p.is_symlink()) and identity(p) == op['identity']]
        if len(locations) != 1:
            raise ValueError(f'无法唯一定位原文件：{source}')
        current = locations[0]
        if current != source:
            if source.exists() or source.is_symlink():
                raise ValueError(f'原路径已被占用：{source}')
            restore.append(('move_back', current, source))
    for task in journal['tasks']:
        for folder in ('task', 'record'):
            path = DATA_PATH / folder / f'{task["uuid"]}.json'
            before, after = run_dir / 'before' / folder / path.name, run_dir / 'after' / folder / path.name
            if path.read_bytes() not in (before.read_bytes(), after.read_bytes()):
                raise ValueError(f'迁移后记录已修改：{path}')
    for kind, current, source in reversed(restore):
        if kind == 'remove_created':
            current.unlink()
        else:
            source.parent.mkdir(parents=True, exist_ok=True)
            os.replace(current, source)
    for task in journal['tasks']:
        for folder in ('task', 'record', 'rename_plans'):
            path = DATA_PATH / folder / f'{task["uuid"]}.json'
            before = run_dir / 'before' / folder / path.name
            if before.exists():
                path.write_bytes(before.read_bytes())
    journal['state'] = 'rolled_back'
    atomic_write(run_dir / 'execution.json', journal)
    return {'state': 'rolled_back', 'operations': len(restore)}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    result = rollback(args.run) if args.rollback else execute(args.run) if args.execute else compile_plan(args.run)
    print(json.dumps(result, ensure_ascii=False, indent=2))
