"""Expiring, versioned public title metadata; never caches network failures."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

from ..utils.path import DATA_PATH


def read(kind, key, ttl):
    file = _path(kind, key)
    try:
        if file.stat().st_size > 2 * 1024 * 1024:
            return None
        saved = json.loads(file.read_text(encoding='utf-8'))
        if 0 <= time.time() - saved['saved'] < ttl:
            return saved['value']
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def _path(kind, key):
    digest = hashlib.sha256(str(key).encode()).hexdigest()
    version = 'v3' if kind == 'mapping' else 'v2'
    return DATA_PATH / 'title_cache' / f'{version}-{kind}-{digest}.json'


def write(kind, key, value):
    file = _path(kind, key)
    temporary = None
    try:
        file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=file.parent, delete=False) as stream:
            temporary = stream.name
            json.dump({'saved': time.time(), 'value': value}, stream, ensure_ascii=False)
        os.replace(temporary, file)
    except OSError:
        pass
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)
