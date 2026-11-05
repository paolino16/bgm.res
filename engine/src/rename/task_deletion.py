"""Review exact recorded outputs before recycling; archive task metadata."""
import hashlib
import json
import os
import re
import stat as stat_types
import uuid
from pathlib import Path

from .task_schema import atomic_write
from ..config.config_manager import cm
from ..utils.path import DATA_PATH
from ..utils.utils import extract_record_entries, extract_record_targets


def identity(path):
    return os.path.normcase(os.path.abspath(path))


def read(path):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}


def metadata(task_id):
    if not re.fullmatch(r'[\w-]+', str(task_id)):
        raise ValueError('任务编号无效')
    return [DATA_PATH / directory / (task_id + '.json') for directory in
            ('task', 'record', 'rename_plans', 'recognition_reviews', 'identification')]


def cleanup_roots(task, plan, targets):
    """Resolve an explicit work boundary, including cross-drive mirror copies."""
    context = plan.get('context', {})
    known = [task.get('output_dir'), context.get('work_path'),
             *(s.get('work_path') for s in context.get('subjects', {}).values())]
    libraries = [Path(value) for key in ('anime_path', 'anime_movie_path', 'bangumi_path', 'movie_path')
                 if (value := cm.get_config(key)) and Path(value).is_absolute()]
    protected = {identity(DATA_PATH), *(identity(p) for p in libraries)}
    roots = set()
    for target in targets:
        if not target.is_absolute():
            continue
        choices = []
        for value in known:
            if not value or not Path(value).is_absolute():
                continue
            root = Path(value)
            # Trans mirrors keep the same path below the drive root.
            mirror_root = Path(target.anchor, *root.parts[1:])
            for candidate in (root, mirror_root):
                if target.is_relative_to(candidate) and (target != candidate or target.is_dir()):
                    choices.append(candidate)
        if not choices:
            # Historical records may predate stored output roots.
            choices = [p for p in ([target] if target.is_dir() else []) + list(target.parents) if re.search(r'\((?:19|20)\d{2}\)(?:\s*\[bgm-\d+\])?$', p.name)]
        if not choices:
            for library in libraries:
                base = Path(target.anchor, *library.parts[1:])
                if target.is_relative_to(base) and len(target.relative_to(base).parts) >= 2:
                    choices.append(base / target.relative_to(base).parts[0])
        if choices:
            root = Path(os.path.abspath(max(choices, key=lambda p: len(p.parts))))
            if (len(root.parts) >= 3 and root.parent != root and identity(root) not in protected
                    and (root != target or target.is_dir()) and not any(root == Path(root.anchor, *p.parts[1:]) for p in libraries)):
                roots.add(root)
    return sorted(roots, key=str)


def is_link_directory(path):
    # Includes Windows junctions on Python versions without Path.is_junction.
    try:
        return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & 0x400)
    except FileNotFoundError:
        return False


def cleanup_empty_directories(roots, protected_paths=()):
    removed, errors = [], []
    protected = set()
    protected_trees = [Path(value) for value in protected_paths if Path(value).is_dir()]
    for value in protected_paths:
        path = Path(value)
        protected.update(identity(p) for p in [path, *path.parents])
    for root in roots:
        root = Path(root)
        if not root.is_absolute() or root.parent == root or len(root.parts) < 3:
            continue
        if any(is_link_directory(p) for p in [root, *root.parents]):
            continue
        boundary = root.resolve()
        pending, directories = [root], []
        while pending:
            directory = pending.pop()
            try:
                if any(directory.is_relative_to(tree) for tree in protected_trees):
                    continue
                if (is_link_directory(directory) or os.path.ismount(directory)
                        or not directory.resolve().is_relative_to(boundary)):
                    continue
                if not directory.is_dir():
                    continue
                directories.append(directory)
                pending.extend(p for p in directory.iterdir() if p.is_dir() and not is_link_directory(p))
            except OSError as error:
                errors.append({'path': str(directory), 'error': str(error)})
        for directory in sorted(directories, key=lambda p: len(p.parts), reverse=True):
            if identity(directory) in protected:
                continue
            try:
                # Revalidate boundaries and never follow links introduced during the operation.
                if is_link_directory(directory) or not directory.resolve().is_relative_to(boundary):
                    continue
                if directory.is_dir() and not any(directory.iterdir()):
                    directory.rmdir()  # Empty only; never removes media or crosses the work root.
                    removed.append(str(directory))
            except OSError as error:
                errors.append({'path': str(directory), 'error': str(error)})
    return removed, errors


def preview(task_id, delete_outputs=False):
    paths = metadata(task_id)
    if not paths[0].is_file():
        raise ValueError('任务不存在或已删除')
    task, record = read(paths[0]), read(paths[1])
    entries = extract_record_entries(record)
    sources = {identity(source) for source in entries}
    other_targets = set()
    digest = hashlib.sha256()
    for file in sorted((DATA_PATH / 'record').glob('*.json')) if delete_outputs else ():
        raw = file.read_bytes(); digest.update(file.name.encode()); digest.update(raw)
        if file.stem != task_id:
            # Fail closed on unreadable history instead of deleting a shared output.
            other_targets.update(identity(target) for target in extract_record_targets(json.loads(raw)))
    for file in paths:
        digest.update(str(file).encode()); digest.update(file.read_bytes() if file.exists() else b'')
    rows = []
    for target in sorted(extract_record_targets(record), key=str):
        key = identity(target)
        reason, action, signature = '保留输出文件', 'keep', None
        if delete_outputs:
            try:
                info = target.lstat()
                signature = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]
            except FileNotFoundError:
                info = None
            if not target.is_absolute():
                reason = '相对输出路径需人工核对，保留'
            elif key in sources or task.get('path') and key == identity(task['path']):
                reason = '源路径，保留'
            elif any(identity(parent) in other_targets for parent in (Path(key), *Path(key).parents)):
                reason = '其他任务共用，保留'
            elif info is None:
                action, reason = 'missing', '文件已不存在'
            elif stat_types.S_ISDIR(info.st_mode) or (stat_types.S_ISLNK(info.st_mode) and target.is_dir()):
                reason = '目录保留内容，仅清理空目录'
            else:
                action, reason = 'trash', '移入回收站'
        rows.append({'path': str(target), 'action': action, 'reason': reason, 'signature': signature})
    roots = cleanup_roots(task, read(paths[2]), [Path(row['path']) for row in rows if row['action'] in {'trash', 'missing'} or row['reason'].startswith('目录保留')]) if delete_outputs else []
    candidates = sources | other_targets | ({identity(task['path'])} if task.get('path') else set())
    # Only intersecting paths can protect directories inside these cleanup boundaries.
    root_keys = [identity(root) for root in roots]
    protected_paths = sorted(value for value in candidates if any(
        value == root or value.startswith(root.rstrip(os.sep) + os.sep)
        or root.startswith(value.rstrip(os.sep) + os.sep) for root in root_keys))
    digest.update(json.dumps([bool(delete_outputs), rows, list(map(str, roots)), protected_paths], ensure_ascii=False, sort_keys=True).encode())
    return {'id': task_id, 'name': task.get('name') or task_id, 'source': task.get('path'),
            'delete_outputs': bool(delete_outputs), 'rows': rows, 'token': digest.hexdigest(),
            'trash_count': sum(row['action'] == 'trash' for row in rows),
            'keep_count': sum(row['action'] == 'keep' for row in rows),
            'cleanup_roots': list(map(str, roots)), 'protected_paths': protected_paths}


def recycle_batch(targets):
    if os.name != 'nt':
        raise ValueError('当前系统未配置回收站支持，未永久删除文件')
    import pythoncom
    from win32com.shell import shell, shellcon
    pythoncom.CoInitialize()
    try:
        operation = pythoncom.CoCreateInstance(shell.CLSID_FileOperation, None,
            pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IFileOperation)
        # FOFX_RECYCLEONDELETE explicitly requests recycling rather than destruction.
        operation.SetOperationFlags(0x00080000 | shellcon.FOFX_EARLYFAILURE |
            shellcon.FOF_ALLOWUNDO | shellcon.FOF_NOCONFIRMATION | shellcon.FOF_SILENT | shellcon.FOF_NOERRORUI)
        for target in targets:
            item = shell.SHCreateItemFromParsingName(str(target), None, shell.IID_IShellItem)
            operation.DeleteItem(item, None)
        operation.PerformOperations()
        if operation.GetAnyOperationsAborted() or any(target.exists() or target.is_symlink() for target in targets):
            raise OSError('回收站操作未完成')
    finally:
        pythoncom.CoUninitialize()


def recycle(target):
    recycle_batch([target])


def execute(task_id, token, delete_outputs=False, *, trash=recycle):
    current = preview(task_id, delete_outputs)
    if current['token'] != token:
        raise ValueError('记录或文件已变化，请重新预览后删除')
    paths = metadata(task_id)
    archive = DATA_PATH / 'deleted_tasks' / task_id / uuid.uuid4().hex
    archive.mkdir(parents=True)
    journal = {'id': task_id, 'state': 'prepared', 'preview': current, 'recycled': [], 'metadata': [], 'removed_dirs': []}
    # Snapshot before touching media or removing live records.
    for file in paths:
        if file.is_file():
            backup = archive / file.parent.name / file.name
            backup.parent.mkdir(parents=True); backup.write_bytes(file.read_bytes())
    atomic_write(archive / 'deletion.json', journal)
    try:
        targets = [Path(row['path']) for row in current['rows'] if row['action'] == 'trash']
        if trash is recycle:
            # Queue several shell items per operation rather than creating one COM session per file.
            for offset in range(0, len(targets), 32):
                batch = targets[offset:offset + 32]
                try:
                    recycle_batch(batch)
                finally:
                    # Shell operations may partially succeed before returning an error or cancellation.
                    journal['recycled'].extend(str(target) for target in batch
                                               if not target.exists() and not target.is_symlink())
                    atomic_write(archive / 'deletion.json', journal)
        else:
            for target in targets:
                trash(target)
                journal['recycled'].append(str(target))
                atomic_write(archive / 'deletion.json', journal)
        if delete_outputs:
            removed, errors = cleanup_empty_directories(current['cleanup_roots'], current['protected_paths'])
            journal.update(removed_dirs=removed, directory_errors=errors)
            atomic_write(archive / 'deletion.json', journal)
        for file in paths:
            if file.exists():
                file.unlink(); journal['metadata'].append(str(file))
        journal['state'] = 'completed'
        atomic_write(archive / 'deletion.json', journal)
    except Exception as error:
        journal.update(state='failed', error=str(error))
        # If metadata removal was interrupted, restore it for retry/review.
        for original in journal['metadata']:
            file = Path(original); file.write_bytes((archive / file.parent.name / file.name).read_bytes())
        atomic_write(archive / 'deletion.json', journal)
        raise ValueError('删除未完成，任务记录已保留；部分输出可能已移入回收站，请检查后重试：' + str(error)) from error
    return {'id': task_id, 'archive': str(archive), 'outputs': len(journal['recycled']), 'dirs': len(journal['removed_dirs']),
            'message': f'已删除任务记录，{len(journal["recycled"])} 个关联输出已移入回收站，清理 {len(journal["removed_dirs"])} 个空目录；其余文件保留'}
