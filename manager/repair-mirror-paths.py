"""Audit/repair renamed cross-drive outputs without changing media contents.

Old mirror hardlinks are retained for recovery and other historical consumers.
Only current record/*.json documents are updated; migration archives stay intact.
"""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import uuid


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def key(path):
    value = os.path.abspath(path)
    if value.startswith('\\\\?\\UNC\\'):
        value = '\\\\' + value[8:]
    elif value.startswith('\\\\?\\'):
        value = value[4:]
    return os.path.normcase(value)


def identity(path):
    stat = Path(path).stat()
    return [stat.st_dev, stat.st_ino, stat.st_size]


def entries(record):
    return record.get('entries', record)


def validate(operation, allow_repaired=False):
    target, old, new = map(Path, (operation['target'], operation['old'], operation['new']))
    if not old.is_file() or old.is_symlink() or identity(old) != operation['identity']:
        raise ValueError(f'旧镜像身份变化：{old}')
    if not target.is_symlink() or not os.path.samefile(target, old):
        raise ValueError(f'目标已变化：{target}')
    allowed = {key(operation['link'])}
    if allow_repaired:
        allowed.add(key(new))
    if key(os.readlink(target)) not in allowed:
        raise ValueError(f'软链接指向已变化：{target}')
    if new.is_symlink() or (new.exists() and not os.path.samefile(new, old)):
        raise ValueError(f'新镜像路径冲突：{new}')


def scan(data):
    operations, records, issues = {}, {}, []
    total = 0
    for path in sorted((data / 'record').glob('*.json')):
        raw = path.read_bytes()
        record = json.loads(raw)
        changes = []
        for source, entry in entries(record).items():
            target_value = entry if isinstance(entry, str) else entry.get('target') if isinstance(entry, dict) else None
            if not target_value:
                continue
            target = Path(target_value)
            mirror_value = entry.get('mirror') if isinstance(entry, dict) else None
            if not mirror_value:
                if not target.is_symlink() or not target.is_file():
                    continue
                mirror_value = str(target.resolve())
                if Path(mirror_value).drive.lower() == target.drive.lower():
                    continue
            total += 1
            old = Path(mirror_value)
            # Use the live mirror's volume, not an obsolete original-source drive.
            new = Path(old.anchor).joinpath(*target.parts[1:])
            if key(old) == key(new):
                continue
            try:
                if not target.is_absolute() or not old.is_absolute() or old.drive.lower() == target.drive.lower():
                    raise ValueError('不是跨盘绝对路径')
                operation = {'target': str(target), 'old': str(old), 'new': str(new),
                             'identity': identity(old), 'link': os.readlink(target)}
                validate(operation)
                previous = operations.get(key(target))
                if previous and previous != operation:
                    raise ValueError('共享目标记录不一致')
                operations[key(target)] = operation
                changes.append({'source': source, 'old': str(old), 'new': str(new)})
            except (OSError, ValueError) as exc:
                issues.append({'record': path.name, 'source': source, 'target': str(target), 'error': str(exc)})
        if changes:
            records[path.name] = {'sha256': hashlib.sha256(raw).hexdigest(), 'changes': changes}
    return {'state': 'prepared', 'data': str(data), 'mirrors_checked': total,
            'operations': list(operations.values()), 'records': records, 'issues': issues}


def replace_link(target, destination):
    target = Path(target)
    temporary = target.with_name('.mirror-repair-' + uuid.uuid4().hex + '.tmp')
    try:
        os.symlink(destination, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def apply(run):
    journal = read(run / 'journal.json')
    if journal['state'] != 'prepared' or journal['issues']:
        raise ValueError('方案有冲突或已经执行')
    data = Path(journal['data'])
    for name, item in journal['records'].items():
        path = data / 'record' / name
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError(f'记录已变化：{name}')
        backup = run / 'before' / name
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_bytes(raw)
        updated = json.loads(raw)
        for change in item['changes']:
            current = entries(updated)[change['source']]
            if isinstance(current, str):
                current = entries(updated)[change['source']] = {'target': current}
            current['mirror'] = change['new']
        write(run / 'after' / name, updated)
    for operation in journal['operations']:
        validate(operation)
    journal['state'] = 'applying'
    write(run / 'journal.json', journal)
    try:
        with (run / 'progress.jsonl').open('a', encoding='utf-8') as progress:
            for index, operation in enumerate(journal['operations'], 1):
                validate(operation)
                new = Path(operation['new'])
                new.parent.mkdir(parents=True, exist_ok=True)
                if not new.exists():
                    os.link(operation['old'], new)
                replace_link(operation['target'], str(new))
                validate(operation, allow_repaired=True)
                progress.write(json.dumps({'target': operation['target']}, ensure_ascii=False) + '\n')
                if index % 250 == 0:
                    progress.flush()
                    print(json.dumps({'fixed': index, 'total': len(journal['operations'])}), flush=True)
        # Recheck concurrent changes before replacing any live record.
        for name, item in journal['records'].items():
            if hashlib.sha256((data / 'record' / name).read_bytes()).hexdigest() != item['sha256']:
                raise ValueError(f'记录在执行中改变：{name}')
        journal['state'] = 'committing'
        write(run / 'journal.json', journal)
        for name in journal['records']:
            write(data / 'record' / name, read(run / 'after' / name))
        for operation in journal['operations']:
            validate(operation, allow_repaired=True)
            if key(os.readlink(operation['target'])) != key(operation['new']):
                raise ValueError('链接验证失败')
        journal['state'] = 'completed'
        write(run / 'journal.json', journal)
    except Exception as exc:
        journal.update(state='interrupted', error=str(exc))
        write(run / 'journal.json', journal)
        raise
    return journal


def rollback(run):
    journal = read(run / 'journal.json')
    if journal['state'] not in {'applying', 'committing', 'interrupted', 'completed'}:
        raise ValueError('此状态不能恢复')
    data = Path(journal['data'])
    for operation in journal['operations']:
        validate(operation, allow_repaired=True)
    for name in journal['records']:
        live = (data / 'record' / name).read_bytes()
        if live not in ((run / 'before' / name).read_bytes(), (run / 'after' / name).read_bytes()):
            raise ValueError(f'记录在修复后变化，拒绝覆盖：{name}')
    for operation in journal['operations']:
        replace_link(operation['target'], operation['link'])
    for name in journal['records']:
        path = data / 'record' / name
        temporary = path.with_name(path.name + '.restore-' + uuid.uuid4().hex)
        temporary.write_bytes((run / 'before' / name).read_bytes())
        os.replace(temporary, path)
    journal['state'] = 'rolled_back'
    write(run / 'journal.json', journal)
    return journal


def summary(journal):
    return {'state': journal['state'], 'mirrors_checked': journal['mirrors_checked'],
            'files': len(journal['operations']), 'tasks': len(journal['records']),
            'issues': len(journal['issues']),
            'extensions': dict(collections.Counter(Path(op['target']).suffix.lower() for op in journal['operations']))}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--action', choices=['scan', 'apply', 'rollback'], default='scan')
    args = parser.parse_args()
    if args.action == 'scan':
        if not args.data or not args.data.is_dir():
            parser.error('--data 必须是现有整理数据目录')
        if (args.run / 'journal.json').exists():
            parser.error('日志已存在，请使用新的运行目录')
        result = scan(args.data.absolute())
        write(args.run / 'journal.json', result)
    else:
        result = apply(args.run) if args.action == 'apply' else rollback(args.run)
    print(json.dumps(summary(result), ensure_ascii=False), flush=True)
