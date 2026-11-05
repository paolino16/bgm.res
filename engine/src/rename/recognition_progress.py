from contextlib import contextmanager
from contextvars import ContextVar
import time

_state = ContextVar('recognition_progress', default=None)


def progress(stage):
    state = _state.get()
    if state is None:
        return
    now = time.perf_counter()
    if state['stage']:
        state['timings'].append({'stage': state['stage'], 'seconds': round(now - state['since'], 4)})
    state.update(stage=stage, since=now)
    if callable(state['callback']):
        state['callback'](stage, list(state['timings']))


@contextmanager
def progress_scope(callback=None):
    token = _state.set({'stage': None, 'since': time.perf_counter(), 'timings': [], 'callback': callback})
    try:
        yield
    finally:
        progress('识别结束')
        _state.reset(token)
