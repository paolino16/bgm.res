"""Local EXT browser session and release lookup."""
import hashlib
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import urlencode, urljoin
import zipfile

from bs4 import BeautifulSoup
import requests

from .resource_search import magnet_hash

BASE = 'https://ext.to'
VERSION = '3.5.2'
SHA256 = '309abd7c821546325ae6c509b40d969c5e39034be2314d21b3f5e0517feda7a7'


def install():
    parent = Path(os.environ['LOCALAPPDATA']) / 'bgm.res' / 'runtime'
    target = parent / ('FlareSolverr-' + VERSION)
    exe = target / 'flaresolverr' / 'flaresolverr.exe'
    if not exe.is_file():
        parent.mkdir(parents=True, exist_ok=True)
        url = f'https://github.com/FlareSolverr/FlareSolverr/releases/download/v{VERSION}/flaresolverr_windows_x64.zip'
        with tempfile.TemporaryDirectory(dir=parent) as staging:
            archive = Path(staging) / 'runtime.zip'
            digest = hashlib.sha256()
            with requests.get(url, stream=True, timeout=60) as response, archive.open('wb') as out:
                response.raise_for_status()
                for block in response.iter_content(1024*1024):
                    digest.update(block)
                    out.write(block)
            if digest.hexdigest() != SHA256:
                raise ValueError('EXT 组件校验失败，请重试')
            with zipfile.ZipFile(archive) as package:
                package.extractall(Path(staging) / 'install')
            try:
                (Path(staging) / 'install').rename(target)
            except OSError:
                if not exe.is_file():
                    raise
    return str(exe)


def check_page(solution):
    html = solution.get('response', '')
    if 'window._cf_chl_opt' in html:
        raise ValueError('EXT 站点验证尚未完成，请稍后重试')
    if solution.get('status') != 200:
        raise ValueError(f"EXT 返回 HTTP {solution.get('status')}")
    return solution


def search_document(html):
    doc = BeautifulSoup(html, 'html.parser')
    if not doc.select_one('a.torrent-title-link, .nothing-found-title'):
        raise ValueError('EXT 未返回可识别的搜索页，请重试')
    return doc


def handle(args):
    endpoint = f"http://127.0.0.1:{int(args['port'])}/v1"
    def call(cmd, **params):
        r = requests.post(endpoint, json=dict(cmd=cmd, session='bgm', maxTimeout=45000, **params), timeout=55)
        r.raise_for_status()
        data = r.json()
        if data.get('status') != 'ok':
            raise ValueError(data.get('message', 'EXT 连接失败'))
        return data.get('solution', {})

    def page(url):
        return check_page(call('request.get', url=url))

    if args['action'] == 'warm':
        call('sessions.create')
        page(BASE + '/browse/?with_adult=0')
        return True
    if args['action'] == 'search':
        cursor = args.get('cursor') or {}
        number = cursor.get('all', 1)
        params = dict(q=args['query'], with_adult=0, sort='age', order='desc', page=number)
        doc = search_document(page(BASE + '/browse/?' + urlencode(params))['response'])
        more = any(re.search(r'[?&]page=' + str(number+1) + r'(?:&|$)', a['href'])
                   for a in doc.select('a[href*="page="]'))
        results = {}
        for tr in doc.select('tr'):
            title = tr.select_one('a.torrent-title-link')
            if not title or not re.fullmatch(r'/[^/?#]+-\d+/', title.get('href', '')):
                continue
            url = urljoin(BASE, title['href'])
            if url in results:
                continue
            cells = tr.find_all('td', recursive=False)
            if len(cells) < 5:
                continue
            date = tr.select_one('.mobile-info span[title]')
            results[url] = dict(source='ext', title=title.get_text(strip=False).strip(), page=url,
                                hash='', magnet='', torrent='', date=date.get('title') if date else '',
                                size=cells[1].get_text(strip=True).removeprefix('Size'),
                                seeds=cells[4].get_text(strip=True).removeprefix('Seeds'))
        return {'rows': list(results.values()), 'next': {'all': number+1} if more else None}
    row = args['row']
    url = row['page']
    release = re.fullmatch(r'https://ext\.to/[^/?#]+-(\d+)/', url)
    if not release:
        raise ValueError('无效的 EXT 资源地址')
    solution = page(url)
    html = solution['response']
    def token(name):
        match = re.search(r'window\.' + name + r"""\s*=\s*['"]([^'"]+)""", html)
        if not match:
            raise ValueError('EXT 下载信息已变更')
        return match[1]
    ident = release[1]
    stamp = str(int(time.time()))
    signature = hashlib.sha256(f"{ident}|{stamp}|{token('pageToken')}".encode()).hexdigest()
    r = requests.post(BASE+'/ajax/getTorrentMagnet.php', timeout=15,
                      data=dict(torrent_id=ident, action='get_magnet', timestamp=stamp, hmac=signature, sessid=token('csrfToken')),
                      headers={'User-Agent': solution['userAgent'], 'Referer': url, 'Origin': BASE, 'X-Requested-With': 'XMLHttpRequest'},
                      cookies={c['name']: c['value'] for c in solution['cookies']})
    r.raise_for_status()
    magnet = r.json().get('magnet', '')
    h = magnet_hash(magnet)
    if not magnet.startswith('magnet:?') or not h:
        raise ValueError('EXT 未返回有效磁链')
    return dict(hash=h, magnet=magnet)
