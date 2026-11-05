"""Windowless desktop-only API with explicit ownership and graceful draining.

The Electron desktop is the sole application interface.
"""
import asyncio
from contextlib import asynccontextmanager, contextmanager
import hashlib
import os
from pathlib import Path
import socket
import time

from fastapi import FastAPI
import uvicorn

from .utils.path import DATA_PATH, PROJECT_PATH

REVISION = 5


def source_signature():
    digest = hashlib.sha256()
    root = PROJECT_PATH / 'src'
    for file in sorted(root.rglob('*.py'), key=lambda p: p.relative_to(root).as_posix()):
        digest.update(file.relative_to(root).as_posix().encode())
        digest.update(b'\0')
        digest.update(file.read_bytes())
    return digest.hexdigest()


def process_alive(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5  # access denied does not mean dead
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0x102
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class Lifecycle:
    def __init__(self):
        self.owners = set()
        self.jobs = {}
        self.draining = False
        self.started = time.monotonic()
        self.stop = lambda: None

    def active_jobs(self):
        """Both waiting and executing work keep the service alive."""
        return sum(job['state'] in {'queued', 'running'} for job in self.jobs.values())

    def tick(self):
        self.owners = {pid for pid in self.owners if process_alive(pid)}
        owner_gone = not self.owners and time.monotonic() - self.started > 30
        if (self.draining or owner_gone) and not self.active_jobs():
            self.stop()


def create_app(lifecycle=None):
    lifecycle = lifecycle or Lifecycle()
    signature = source_signature()

    @asynccontextmanager
    async def lifespan(app):
        async def watch():
            while True:
                await asyncio.sleep(1)
                lifecycle.tick()
        monitor = asyncio.create_task(watch())
        try:
            yield
        finally:
            monitor.cancel()
            try:
                await monitor
            except asyncio.CancelledError:
                pass

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get('/integration/status')
    async def status():
        return {'service': 'bangumi-rename', 'api_version': 1, 'engine_revision': REVISION,
                'engine_path': str(PROJECT_PATH.resolve()), 'data_path': str(DATA_PATH.resolve()),
                'mode': 'desktop', 'pid': os.getpid(), 'source_signature': signature,
                'draining': lifecycle.draining, 'active_jobs': lifecycle.active_jobs()}

    from .integration_api import register
    register(app, lifecycle)
    return app


@contextmanager
def service_lock():
    # Prevent a second process from replacing the live API token for this data.
    with (DATA_PATH / 'desktop-service.lock').open('a+b') as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def main():
    with service_lock(), socket.socket() as listener:
        listener.bind((os.environ.get('BGM_RENAME_HOST', '127.0.0.1'), int(os.environ.get('BGM_RENAME_PORT', '5999'))))
        listener.listen(128)
        lifecycle = Lifecycle()
        app = create_app(lifecycle)
        server = uvicorn.Server(uvicorn.Config(app, log_config=None, access_log=False))
        lifecycle.stop = lambda: setattr(server, 'should_exit', True)
        server.run(sockets=[listener])


if __name__ == '__main__':
    main()
