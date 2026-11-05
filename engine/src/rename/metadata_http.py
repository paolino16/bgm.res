"""Bounded metadata caching, connection reuse, and request-level retries."""

import copy
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import threading
import time
from collections import OrderedDict
from urllib.parse import urlsplit

import requests
from ..utils.path import DATA_PATH


METADATA_TIMEOUT = (3.05, 12)
CACHE_TTL = 600
CACHE_ENTRIES = 256
CACHE_BYTES = 16 * 1024 * 1024
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
_local = threading.local()
_budget = ContextVar('metadata_budget', default=None)
_disk_lock = threading.Lock()


@contextmanager
def recognition_budget(seconds=20, attempts=2):
    token = _budget.set((time.monotonic() + seconds, attempts))
    try:
        yield
    finally:
        _budget.reset(token)


def _persistent(method, host, url, kwargs, session):
    return (_budget.get() is not None and method == 'GET' and host == 'api.bgm.tv'
            and urlsplit(url).path.startswith(('/v0/subjects/', '/v0/episodes'))
            and not kwargs.get('auth') and not session.auth
            and not any(k.lower() in {'authorization', 'cookie'} for k in
                        [*session.headers, *(kwargs.get('headers') or {})])
            and not session.cookies)


def _disk_response(key, response=None):
    """Best-effort bounded public metadata cache; never reuse expired catalogs."""
    folder = DATA_PATH / 'metadata_cache'
    file = folder / (key.hex() + '.json')
    with _disk_lock:
        try:
            if response is None:
                if file.stat().st_size > CACHE_BYTES:
                    return None
                saved = json.loads(file.read_text(encoding='utf-8'))
                age = time.time() - saved['saved']
                if not 0 <= age < CACHE_TTL:
                    return None
                result = requests.Response()
                result.status_code = 200
                result._content = saved['body'].encode('utf-8')
                result.encoding = 'utf-8'
                return result if _cacheable(result) else None
            folder.mkdir(parents=True, exist_ok=True)
            payload = json.dumps({'saved': time.time(), 'body': response.text}, ensure_ascii=False)
            if len(payload.encode('utf-8')) > CACHE_BYTES:
                return None
            temp = file.with_suffix('.tmp')
            temp.write_text(payload, encoding='utf-8')
            temp.replace(file)
            files = sorted(folder.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
            total = 0
            for index, entry in enumerate(files):
                total += entry.stat().st_size
                if index >= CACHE_ENTRIES or total > CACHE_BYTES:
                    entry.unlink(missing_ok=True)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
    return None


class MetadataRequestError(requests.RequestException):
    """A user-readable failure that never includes credentials in the URL."""


class ResponseCache:
    def __init__(self, ttl=CACHE_TTL, max_entries=CACHE_ENTRIES, max_bytes=CACHE_BYTES):
        self.ttl = ttl
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.entries = OrderedDict()
        self.total_bytes = 0
        self.lock = threading.Lock()

    def _remove(self, key):
        _, response = self.entries.pop(key)
        self.total_bytes -= len(response.content)

    def get(self, key):
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return None
            expires, response = entry
            if time.monotonic() >= expires:
                self._remove(key)
                return None
            self.entries.move_to_end(key)
            return self._clone(response)

    def put(self, key, response):
        if len(response.content) > self.max_bytes:
            return
        with self.lock:
            if key in self.entries:
                self._remove(key)
            self.entries[key] = (time.monotonic() + self.ttl, self._clone(response))
            self.total_bytes += len(response.content)
            while len(self.entries) > self.max_entries or self.total_bytes > self.max_bytes:
                self._remove(next(iter(self.entries)))

    @staticmethod
    def _clone(source):
        # Response.json() parses fresh dictionaries, so season enrichment cannot
        # mutate cached data shared with another task.
        response = requests.Response()
        response.status_code = source.status_code
        response._content = source.content
        response._content_consumed = True
        response.headers = copy.copy(source.headers)
        response.encoding = source.encoding
        response.url = source.url
        response.reason = source.reason
        return response


_CACHE = ResponseCache()


def _cacheable(response):
    if response.status_code != 200:
        return False
    try:
        data = response.json()
    except ValueError:
        return False
    if isinstance(data, list):
        return True
    if not isinstance(data, dict) or not data:
        return False
    # A successful empty search is not a network error, nor a durable match.
    return all(data[key] for key in ('results', 'data') if key in data)


class MetadataSession(requests.Session):
    def request(self, method, url, **kwargs):
        method = method.upper()
        host = urlsplit(url).hostname
        supported = host in {'api.themoviedb.org', 'api.bgm.tv', 'api.jikan.moe', 'api.tenrai.org'}
        if not supported or method not in {'GET', 'POST'} or kwargs.get('stream'):
            kwargs['timeout'] = kwargs.get('timeout') or METADATA_TIMEOUT
            return super().request(method, url, **kwargs)
        # Credentials participate in isolation but are not retained as cache keys.
        identity = (method, url, kwargs.get('params'), kwargs.get('data'), kwargs.get('json'),
                    dict(self.headers), kwargs.get('headers'), kwargs.get('auth'), self.auth)
        key = hashlib.sha256(json.dumps(identity, sort_keys=True, default=str).encode()).digest()
        cached = _CACHE.get(key)
        persistent = _persistent(method, host, url, kwargs, self)
        if cached is None and persistent:
            cached = _disk_response(key)
            if cached is not None:
                _CACHE.put(key, cached)
        if cached is not None:
            return cached
        kwargs['timeout'] = kwargs.get('timeout') or METADATA_TIMEOUT
        budget = _budget.get()
        attempts = budget[1] if budget else 3
        for attempt in range(attempts):
            if budget:
                remaining = budget[0] - time.monotonic()
                if remaining <= 0:
                    raise MetadataRequestError(f'{host}：本次识别联网等待已达上限，请重试或指定 BGM ID')
                configured = kwargs['timeout']
                connect, read = configured if isinstance(configured, tuple) else (configured, configured)
                kwargs['timeout'] = (min(connect, remaining / 2), min(read, remaining / 2))
            try:
                response = super().request(method, url, **kwargs)
            except (requests.Timeout, requests.ConnectionError) as exc:
                if attempt == attempts - 1:
                    reason = '连接超时' if isinstance(exc, requests.Timeout) else '网络连接失败'
                    raise MetadataRequestError(f'{host}：{reason}，已尝试 {attempts} 次') from None
                time.sleep(0.5 * (2 ** attempt))
                continue
            except requests.RequestException as exc:
                raise MetadataRequestError(f'{host}：请求失败（{type(exc).__name__}）') from None
            if response.status_code in RETRYABLE_STATUS and attempt < attempts - 1:
                delay = 0.5 * (2 ** attempt)
                try:
                    requested_delay = float(response.headers.get('Retry-After', 0))
                    if requested_delay > 5:
                        response.close()
                        raise MetadataRequestError(f'{host}：服务暂时限流，请稍后重试')
                    delay = max(delay, requested_delay)
                except ValueError:
                    pass
                response.close()
                time.sleep(delay)
                continue
            if response.status_code >= 400:
                status = response.status_code
                response.close()
                detail = '密钥无效或没有权限' if status in {401, 403} else '请求失败'
                raise MetadataRequestError(f'{host}：{detail}（HTTP {status}）')
            if _cacheable(response):
                _CACHE.put(key, response)
                if persistent:
                    _disk_response(key, response)
            return response


def metadata_session():
    # requests.Session is kept per worker thread, while response data is shared.
    if not hasattr(_local, 'session'):
        _local.session = MetadataSession()
    return _local.session
