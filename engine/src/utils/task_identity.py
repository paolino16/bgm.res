"""Path identity without disk probes, including Windows case/separator rules."""

import os


def task_path_key(path):
    if not str(path or '').strip():
        return ''
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(path))))
