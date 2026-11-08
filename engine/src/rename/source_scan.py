"""Request-scoped directory snapshots; execution checks use fresh disk state."""
from contextlib import contextmanager
from contextvars import ContextVar
import os
from pathlib import Path

from .utils import VIDEO_SUFFIX

_snapshot = ContextVar('source_snapshot', default=None)


_selection = ContextVar('selected_source_files', default=None)


def selected_paths():
    return _selection.get()


def source_entries(root, recursive=False):
    """Enumerate only the downloaded manifest, including its parent directories."""
    selected = selected_paths()
    if selected is None:
        return root.rglob('*') if recursive else root.iterdir()
    entries = {}
    for file in selected:
        if root not in file.parents:
            continue
        relative = file.relative_to(root)
        entry = file if recursive else root / relative.parts[0]
        entries[entry] = None
    return iter(entries)


@contextmanager
def scan_scope(files=None):
    token = _snapshot.set({})
    selection = _selection.set(None if files is None else tuple(map(Path, files)))
    try:
        yield
    finally:
        _snapshot.reset(token)
        _selection.reset(selection)


def files_in(root, recursive=True):
    root = Path(root)
    if selected_paths() is not None:
        return [p for p in source_entries(root, recursive) if p.is_file()]
    cache = _snapshot.get()
    key = (os.path.normcase(os.path.abspath(root)), recursive)
    if cache is not None and key in cache:
        return list(cache[key])
    files = []
    pending = [root]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.is_file():
                    files.append(Path(entry.path))
                elif recursive and entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
    if cache is not None:
        cache[key] = tuple(files)
    return files


def has_video(root):
    root = Path(root)
    if root.is_file():
        return root.suffix.lower() in VIDEO_SUFFIX
    if not root.is_dir():
        return False
    if selected_paths() is not None:
        return any(p.suffix.lower() in VIDEO_SUFFIX for p in files_in(root))
    pending = [root]
    while pending:
        with os.scandir(pending.pop()) as entries:
            directories = []
            for entry in entries:
                # Check direct videos before opening any nested directories.
                if Path(entry.name).suffix.lower() in VIDEO_SUFFIX and entry.is_file():
                    return True
                if entry.is_dir(follow_symlinks=False):
                    directories.append(entry.path)
            pending.extend(directories)
    return False
