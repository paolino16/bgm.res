"""Work-wide subtitle versions, explicit replacements and recoverable file operations."""
import hashlib
import json
import os
import shutil
from pathlib import Path
from uuid import uuid4

from . import subtitle_import as sub
from .task_schema import atomic_write
from .task_deletion import recycle_batch, check_delete_access


def key(value):
    return os.path.normcase(os.path.abspath(value))


def fingerprint(path):
    path = Path(path)
    stat = path.lstat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns,
            os.readlink(path) if path.is_symlink() else '']


def records(ids):
    import re
    if not isinstance(ids, list) or not ids or len(ids) > 200:
        raise ValueError('请选择有效整理记录')
    if any(not re.fullmatch(r'[\w-]+', str(value)) for value in ids):
        raise ValueError('无效整理记录')
    return {value: sub.get_record(value) for value in dict.fromkeys(ids)}


def inventory(ids, selected=None):
    loaded = records(ids)
    allowed = {}
    for task, record in loaded.items():
        for entry in sub.extract_record_entries(record).values():
            video = entry if isinstance(entry, str) else entry.get('target')
            if video and Path(video).suffix.lower() in sub.VIDEO_SUFFIX:
                allowed[key(video)] = (video, task)
    if selected is not None:
        if not isinstance(selected, list) or any(key(video) not in allowed for video in selected):
            raise ValueError('视频不属于当前整理记录')
        allowed = {key(video): allowed[key(video)] for video in selected}
    groups = {}
    for video, task in allowed.values():
        video = Path(video)
        entries = dict(sub.extract_record_entries(loaded[task]))
        for folder in (video.parent, video.parent / 'Subs', video.parent / 'Subtitles'):
            if not folder.is_dir() or folder.is_symlink():
                continue
            video_stems = {p.stem.casefold() for p in video.parent.iterdir()
                           if p.suffix.lower() in sub.VIDEO_SUFFIX}
            for path in folder.iterdir():
                if not path.is_file() or path.suffix.lower() not in sub.SUBTITLES:
                    continue
                base, stem = video.stem.casefold(), path.stem.casefold()
                if stem != base and not stem.startswith(base + '.'):
                    continue
                if any(stem.startswith(other + '.') or stem == other
                       for other in video_stems if len(other) > len(base)):
                    continue
                suffix = path.stem[len(video.stem):].lstrip('.')
                group = groups.setdefault(suffix.casefold(), {'id': suffix.casefold(),
                    'suffix': suffix, 'files': [], 'formats': set(), 'videos': set()})
                sources = [str(source) for source, entry in entries.items()
                           if key(entry if isinstance(entry, str) else entry.get('target', '')) == key(path)]
                source = sources[0] if len(sources) == 1 else None
                # Never treat the video itself as an imported companion.
                if source and Path(source).suffix.lower() not in sub.SUBTITLES:
                    source = None
                source_entry = entries.get(source) if source else None
                mirror = source_entry.get('mirror') if isinstance(source_entry, dict) else None
                group['files'].append({'video': str(video), 'path': str(path), 'source': source,
                    'mirror': mirror, 'mirrorIdentity': fingerprint(mirror) if mirror and os.path.lexists(mirror) else None,
                    'ambiguousSources': sources if len(sources) > 1 else [],
                    'task': task, 'identity': fingerprint(path),
                    'sourceIdentity': fingerprint(source) if source and os.path.lexists(source) else None})
                group['formats'].add(path.suffix[1:].upper())
                group['videos'].add(str(video))
    result = []
    for group in groups.values():
        group['formats'] = sorted(group['formats'])
        group['videos'] = sorted(group['videos'])
        group['token'] = hashlib.sha256(json.dumps(group, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        result.append(group)
    return {'groups': sorted(result, key=lambda group: group['id']), 'videos': [value[0] for value in allowed.values()]}


def pending_cleanup():
    folder = sub.DATA_PATH / 'subtitle_operations'
    if not folder.exists():
        return []
    return [str(path) for path in folder.glob('*/journal.json')
            if json.loads(path.read_text(encoding='utf-8')).get('state') not in ('completed', 'rolled_back')]


def execute(body, *, recycle=recycle_batch):
    """Prepare every change, commit records, then recycle displaced subtitles."""
    ids, rows = body['ids'], body.get('rows', [])
    loaded = records(ids)
    current = inventory(ids, body.get('videos'))
    mode = body.get('mode', 'add')
    if mode not in ('add', 'replace', 'remove'):
        raise ValueError('无效字幕操作')
    old_group = None
    if mode != 'add':
        old_group = next((group for group in current['groups'] if group['id'] == body.get('group')), None)
        if not old_group or old_group['token'] != body.get('token'):
            raise ValueError('字幕文件已变化，请刷新后重新预览')
    if pending_cleanup():
        raise ValueError('有未完成字幕操作，请先在字幕页恢复或重试清理')
    selected = {key(video) for video in current['videos']}
    planned, destination_keys = [], set()
    for row in rows:
        if not row.get('video'):
            continue
        if key(row['video']) not in selected:
            raise ValueError('目标视频不属于当前作品')
        source = Path(row['source'])
        if source.suffix.lower() not in sub.SUBTITLES or not source.is_file():
            raise ValueError('字幕源文件不存在')
        task = next(task for task, record in loaded.items() if row['video'] in sub.library_videos(record))
        original, output = sub.import_targets(source, row['video'], sub.library_videos(loaded[task]), row.get('suffix'))
        mirror = sub.subtitle_mirror(row['video'], original, output)
        for target in dict.fromkeys((original, output, *([mirror] if mirror else []))):
            if key(target) in destination_keys:
                raise ValueError('多份字幕目标重名，请添加不同后缀')
            destination_keys.add(key(target))
        planned.append({'source': str(source), 'original': str(original), 'target': str(output),
                        'mirror': str(mirror) if mirror else None, 'video': row['video'], 'task': task})
    if mode != 'remove' and not planned:
        raise ValueError('请至少匹配一份字幕')
    planned_assets = {(key(row['source']), key(row['video'])) for row in planned}
    for row in planned:
        source = Path(row['source'])
        companion = source.with_suffix('.sub' if source.suffix.lower() == '.idx' else '.idx')
        if source.suffix.lower() == '.idx' or (source.suffix.lower() == '.sub' and companion.exists()):
            if (key(companion), key(row['video'])) not in planned_assets:
                raise ValueError('IDX/SUB 字幕需要成对选择并匹配到同一视频：' + str(source))
    replaced_videos = {key(row['video']) for row in planned}
    old_rows = [row for row in (old_group or {}).get('files', [])
                if mode == 'remove' or key(row['video']) in replaced_videos]
    if mode == 'replace':
        for video in replaced_videos:
            matches = [row for row in old_rows if key(row['video']) == video]
            # IDX/SUB form one subtitle asset; other duplicate formats need a choice.
            if len(matches) > 1 and {Path(row['path']).suffix.lower() for row in matches} != {'.idx', '.sub'}:
                raise ValueError('同一视频有多个旧字幕候选，请先处理重复文件')
    displaced = {}
    for row in old_rows:
        if row.get('ambiguousSources'):
            raise ValueError('同一字幕对应多个原文件，请先核对整理记录：' + row['path'])
        for value in (row['path'], row['source'], row.get('mirror')):
            if value and os.path.lexists(value):
                displaced[key(value)] = str(value)
    for row in planned:
        for target in dict.fromkeys((row['original'], row['target'], *([row['mirror']] if row.get('mirror') else []))):
            if os.path.lexists(target):
                if Path(target).is_dir():
                    raise ValueError('字幕目标是目录，无法替换：' + target)
                # Confirming the import replaces exact name collisions in place.
                # Keep unrelated formats, versions and unmatched episodes intact.
                displaced[key(target)] = str(target)
    for row in planned:
        if key(row['source']) in displaced:
            raise ValueError('新字幕不能同时作为被替换的旧字幕，请先复制到独立位置')
    # A recorded original can serve several library outputs. Do not break unselected uses.
    for record_path in sub.RECORD_PATH.glob('*.json'):
        record = json.loads(record_path.read_text(encoding='utf-8'))
        for source, entry in sub.extract_record_entries(record).items():
            target = entry if isinstance(entry, str) else entry.get('target', '')
            mirror = entry.get('mirror') if isinstance(entry, dict) else None
            if (key(source) in displaced or mirror and key(mirror) in displaced) and key(target) not in displaced:
                raise ValueError('旧字幕还被其他视频使用，未扩大移除范围：' + str(source))
    if os.name == 'nt':
        check_delete_access([Path(value) for value in displaced.values()])
    operation = sub.DATA_PATH / 'subtitle_operations' / uuid4().hex
    operation.mkdir(parents=True)
    journal = {'state': 'preparing', 'moves': [], 'prepared': [], 'created': [], 'records': {}, 'updatedRecords': {}, 'imports': [],
               'videos': current['videos'], 'operation': str(operation)}
    def save():
        atomic_write(operation / 'journal.json', journal)
    for task, record in loaded.items():
        journal['records'][task] = record
    save()
    try:
        for index, value in enumerate(displaced.values()):
            path = Path(value)
            # Keep staging on the same volume and preserve the original basename in the recycle bin.
            staging = path.parent / ('.bgm-subtitle-' + operation.name + '-' + str(index))
            staging.mkdir()
            moved = staging / path.name
            journal['moves'].append({'source': str(path), 'staged': str(moved), 'identity': fingerprint(path)})
            save()
            if path.is_symlink():
                os.symlink(os.readlink(path), moved)
            else:
                try:
                    os.link(path, moved)
                except OSError:
                    shutil.copy2(path, moved)
        # Validate all new content before recycling anything. Temporary copies live
        # beside the destination, so a full disk fails before the old set is touched.
        for index, row in enumerate(planned):
            temporary_folder = Path(row['original']).parent / ('.bgm-subtitle-new-' + operation.name + '-' + str(index))
            temporary_folder.mkdir()
            temporary = temporary_folder / Path(row['original']).name
            journal['prepared'].append(str(temporary))
            save()
            signature = fingerprint(row['source'])
            with temporary.open('xb') as output, open(row['source'], 'rb') as source:
                shutil.copyfileobj(source, output)
            if fingerprint(row['source']) != signature:
                raise ValueError('字幕源文件在导入中发生变化，请重新预览')
        # Recycle at the real paths so Windows Restore uses the expected locations.
        if displaced:
            recycle([Path(value) for value in displaced.values()])
        journal['state'] = 'installing'
        save()
        for row, prepared in zip(planned, journal['prepared']):
            original, target = Path(row['original']), Path(row['target'])
            with original.open('xb') as output, open(prepared, 'rb') as source:
                journal['created'].append({'path': str(original), 'identity': fingerprint(original)[:2]})
                save()
                shutil.copyfileobj(source, output)
            mirror = Path(row['mirror']) if row.get('mirror') else None
            if mirror:
                os.link(original, mirror)
                journal['created'].append({'path': str(mirror), 'identity': fingerprint(mirror)[:2]})
                save()
            if original != target:
                if mirror:
                    os.symlink(mirror.absolute(), target)
                else:
                    try:
                        os.link(original, target)
                    except OSError:
                        os.symlink(original.absolute(), target)
                journal['created'].append({'path': str(target), 'identity': fingerprint(target)[:2]})
                save()
            with original.open('rb') as copied:
                digest = hashlib.file_digest(copied, 'sha256').hexdigest()
            journal['imports'].append({'source': row['source'], 'target': str(target), 'hash': digest})
        for task, record in loaded.items():
            entries = dict(sub.extract_record_entries(record))
            entries = {str(source): entry for source, entry in entries.items()
                       if key(source) not in displaced and key(entry if isinstance(entry, str) else entry.get('target', '')) not in displaced}
            for row in planned:
                if row['task'] == task:
                    entries[row['original']] = {'target': row['target']}
                    if row.get('mirror'):
                        entries[row['original']]['mirror'] = row['mirror']
            updated = dict(record) if isinstance(record.get('entries'), dict) else {}
            updated['entries'] = entries
            journal['updatedRecords'][task] = updated
            save()
            atomic_write(sub.RECORD_PATH / (task + '.json'), updated)
        journal['state'] = 'committed'
        save()
    except Exception:
        rollback(journal, operation)
        raise
    warning = finish_cleanup(journal, operation)
    return {'count': len(planned) if mode != 'remove' else len(old_rows),
            'videos': current['videos'], 'warning': warning,
            'sources': list(dict.fromkeys(row['source'] for row in planned))}


def rollback(journal, operation):
    for task, record in journal['records'].items():
        current = sub.get_record(task)
        if current != record and current != journal.get('updatedRecords', {}).get(task):
            raise ValueError('整理记录已被另外修改，未覆盖；恢复文件仍保留在：' + str(operation))
    for value in reversed(journal['created']):
        path = Path(value['path'])
        if os.path.lexists(path):
            if fingerprint(path)[:2] != value['identity']:
                raise ValueError('恢复时发现文件已被替换，未删除：' + str(path))
            path.unlink()
    for row in reversed(journal['moves']):
        staged, source = Path(row['staged']), Path(row['source'])
        if os.path.lexists(staged):
            if os.path.lexists(source):
                if fingerprint(source) != row['identity']:
                    raise ValueError('恢复位置被占用，原字幕仍保留在：' + str(staged))
                staged.unlink()
            else:
                staged.replace(source)
        if staged.parent.exists():
            staged.parent.rmdir()
    for task, record in journal['records'].items():
        atomic_write(sub.RECORD_PATH / (task + '.json'), record)
    for value in journal.get('prepared', []):
        path = Path(value)
        path.unlink(missing_ok=True)
        if path.parent.exists():
            path.parent.rmdir()
    journal['state'] = 'rolled_back'
    atomic_write(operation / 'journal.json', journal)


def finish_cleanup(journal, operation):
    targets = [Path(row['staged']) for row in journal['moves'] if os.path.lexists(row['staged'])]
    try:
        for path in targets:
            path.unlink()
        for row in journal['moves']:
            folder = Path(row['staged']).parent
            if folder.exists():
                folder.rmdir()
        for value in journal.get('prepared', []):
            path = Path(value)
            path.unlink(missing_ok=True)
            if path.parent.exists():
                path.parent.rmdir()
        journal['state'] = 'completed'
        atomic_write(operation / 'journal.json', journal)
        return ''
    except Exception as error:
        return '字幕已更新，临时文件待清理：' + str(error)


def recover():
    warnings, videos = [], []
    for value in pending_cleanup():
        path = Path(value)
        journal = json.loads(path.read_text(encoding='utf-8'))
        videos.extend(journal['videos'])
        if journal['state'] == 'committed':
            warning = finish_cleanup(journal, path.parent)
            if warning:
                warnings.append(warning)
        else:
            rollback(journal, path.parent)
    return {'warning': '；'.join(warnings), 'videos': list(dict.fromkeys(videos))}
