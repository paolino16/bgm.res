"""Find all native subject output folders from owned operation records."""
from pathlib import Path


def native_output_directories(task, record):
    primary_value = task.get('output_dir')
    if task.get('layout') != 'bangumi' or not primary_value:
        return []
    primary = Path(primary_value)
    library = primary.parent
    directories = {primary} if primary.is_dir() else set()
    for entry in (record or {}).get('entries', {}).values():
        value = entry if isinstance(entry, str) else entry.get('target')
        if not value:
            continue
        target = Path(value)
        # Keep lexical paths: resolving links would expose mirror storage instead.
        if not target.is_relative_to(library):
            continue
        parts = target.relative_to(library).parts
        if len(parts) < 2:
            continue
        directory = library / parts[0]
        if directory.is_dir():
            directories.add(directory)
    return sorted(directories, key=lambda p: (p != primary, p.name.casefold()))
