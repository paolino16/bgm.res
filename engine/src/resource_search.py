"""Search and resolve public releases for the Electron desktop."""
import base64
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse
import xml.etree.ElementTree as ET

import requests

MIKAN_ORIGINS = ('https://mikanani.me', 'https://mikan.sakuramoe.dev')

FEEDS = {
    'dmhy': ('https://share.dmhy.org/topics/rss/rss.xml', 'keyword', {'sort_id': '2'}),
    'mikan': (MIKAN_ORIGINS[0] + '/RSS/Search', 'searchstr', {}),
    'anibt': ('https://anibt.net/torznab/api', 'q', {'t': 'search'}),
    'nyaa': ('https://nyaa.si/', 'q', {'page': 'rss', 'f': '0', 'c': '1_0'}),
}


def fetch(url, **kwargs):
    with requests.get(url, timeout=(6, 18), stream=True, **kwargs) as response:
        response.raise_for_status()
        body = bytearray()
        for chunk in response.iter_content(65536):
            body.extend(chunk)
            if len(body) > 16 * 1024 * 1024:
                raise ValueError('站点返回的数据过大')
        return bytes(body)


def normalize_hash(value):
    value = (value or '').strip()
    if re.fullmatch('[0-9a-fA-F]{40}', value):
        return value.lower()
    if re.fullmatch('[A-Z2-7]{32}', value.upper()):
        return base64.b32decode(value.upper()).hex()
    return ''


def mikan_attempt(operation):
    for index, origin in enumerate(MIKAN_ORIGINS):
        try:
            return operation(origin)
        except (requests.RequestException, ValueError, ET.ParseError):
            if index == len(MIKAN_ORIGINS) - 1:
                raise


def mikan_url(url, origin):
    parsed = urlparse(url)
    if parsed.scheme in ('http', 'https') and parsed.netloc in (
            urlparse(host).netloc for host in MIKAN_ORIGINS):
        return urlparse(origin)._replace(path=parsed.path, query=parsed.query, fragment=parsed.fragment).geturl()
    return urljoin(origin, url)


def magnet_hash(uri):
    for xt in parse_qs(urlparse(uri).query).get('xt', []):
        if xt.lower().startswith('urn:btih:'):
            return normalize_hash(xt[9:])
    return ''


def parse_feed(source, xml):
    root = ET.fromstring(xml)
    if root.find('channel') is None:
        raise ValueError('站点未返回搜索列表')
    rows = []
    for item in root.findall('./channel/item'):
        category = item.findtext('category')
        if source == 'dmhy' and category not in ('動畫', '季度全集'):
            continue
        if source == 'nyaa' and item.findtext('{*}categoryId') not in ('1_2', '1_3', '1_4'):
            continue
        enc = item.find('enclosure')
        attachment = enc.get('url', '') if enc is not None else item.findtext('link', '')
        attrs = {e.get('name'): e.get('value') for e in item.findall('{*}attr')}
        magnet = attachment if attachment.startswith('magnet:?') else ''
        info_hash = normalize_hash(attrs.get('infohash') or item.findtext('{*}infoHash')) or magnet_hash(magnet)
        page = item.findtext('link', '')
        if source == 'mikan':
            info_hash = normalize_hash(Path(urlparse(attachment).path).stem)
        if source == 'nyaa':
            page = item.findtext('guid', '')
        if source == 'anibt':
            page = item.findtext('comments', '')
        if not page or not item.findtext('title'):
            continue
        rows.append(dict(source=source, title=item.findtext('title'), page=page, hash=info_hash,
                         magnet=magnet, torrent='' if magnet else attachment,
                         date=item.findtext('pubDate') or item.findtext('.//{*}pubDate', ''),
                         size=item.findtext('{*}size') or attrs.get('size') or item.findtext('.//{*}contentLength') or
                              (enc.get('length') if enc is not None and source != 'dmhy' else None),
                         seeds=attrs.get('seeders') or item.findtext('{*}seeders')))
    return rows


def website_page(source, query, page, _origin=None):
    if source == 'mikan' and _origin is None:
        return mikan_attempt(lambda origin: website_page(source, query, page, origin))
    from bs4 import BeautifulSoup
    origin = _origin or 'https://' + urlparse(FEEDS[source][0]).netloc
    if source == 'dmhy':
        url, params = f'{origin}/topics/list/page/{page}', {'keyword': query, 'sort_id': 2}
    elif source == 'nyaa':
        url, params = origin+'/', {'q': query, 'c': '1_0', 'p': page}
    else:
        url, params = origin+'/Home/Search', {'searchstr': query}
    doc = BeautifulSoup(fetch(url, params=params), 'html.parser')
    rows = []
    if source == 'dmhy':
        table = doc.select_one('#topic_list')
        if table is None:
            raise ValueError('动漫花园未返回搜索列表')
        for tr in table.select('tbody tr'):
            cells = tr.find_all('td', recursive=False)
            link = tr.select_one('td.title a[href*="/topics/view/"]')
            magnet = tr.select_one('a[href^="magnet:"]')
            if not link or not magnet or len(cells)<6 or cells[1].get_text(strip=True) not in ('動畫','季度全集'):
                continue
            date = cells[0].find('span') or cells[0]
            count = cells[5].get_text(strip=True).replace(',', '')
            rows.append(dict(source=source, title=link.get_text(strip=False).strip(), page=urljoin(origin,link['href']),
                             magnet=magnet['href'], hash=magnet_hash(magnet['href']), torrent='',
                             size=cells[4].get_text(strip=True), seeds=count if count.isdecimal() else None,
                             date=date.get_text(strip=True)))
        more = doc.select_one(f'a[href^="/topics/list/page/{page+1}?"]')
    elif source == 'nyaa':
        if not doc.select_one('.torrent-list') and 'No results found' not in doc.get_text():
            raise ValueError('Nyaa 未返回搜索列表')
        for tr in doc.select('.torrent-list tbody tr'):
            cells = tr.find_all('td', recursive=False)
            if len(cells)<8 or not cells[0].select_one('a[href$="1_2"],a[href$="1_3"],a[href$="1_4"]'):
                continue
            link = cells[1].select_one('a[href^="/view/"]:not([href*="#"])')
            magnet = cells[2].select_one('a[href^="magnet:"]')
            if not link or not magnet:
                continue
            rows.append(dict(source=source, title=link.get_text(strip=True), page=urljoin(origin,link['href']),
                             magnet=magnet['href'], hash=magnet_hash(magnet['href']), torrent='',
                             date=cells[4].get_text(strip=True)+' UTC',size=cells[3].get_text(strip=True),
                             seeds=cells[5].get_text(strip=True)))
        more = any(parse_qs(urlparse(a['href']).query).get('p') == [str(page+1)]
                   for a in doc.select('.pagination a[href]'))
    else:
        if not doc.select_one('tr.js-search-results-row') and '找不到对应结果' not in doc.get_text():
            raise ValueError('蜜柑未返回搜索列表')
        for tr in doc.select('tr.js-search-results-row'):
            cells = tr.find_all('td', recursive=False)
            link = tr.select_one('a[href^="/Home/Episode/"]')
            torrent = tr.select_one('a[href^="/Download/"]')
            if not link or not torrent or len(cells)<4:
                continue
            rows.append(dict(source=source, title=link.get_text(strip=True), page=urljoin(origin,link['href']),
                             magnet='', hash=normalize_hash(Path(link['href']).name),
                             torrent=urljoin(origin,torrent['href']), date=cells[3].get_text(strip=True),
                             size=cells[2].get_text(strip=True), seeds=None))
        # Mikan's HTML search returns the whole result set without remote pagination.
        # Match the RSS batch size when continuing through those results.
        more = False
        if page is not None:
            end = page * 100
            more = end < len(rows)
            rows = rows[end-100:end]
    return {'rows': rows, 'next': page+1 if more else None}


def search_batch(source, query, cursor):
    if source == 'knaben':
        offset = cursor or 0
        data = json.loads(fetch('https://api.knaben.org/v2/search', params={
            'q': query, 's': 50, 'f': offset, 'o': 'date', 'd': 'desc', 'dead': ''}))
        hits = data.get('hits')
        if not isinstance(hits, list):
            raise ValueError('Knaben 未返回搜索列表')
        rows = []
        for hit in hits:
            title = hit.get('title')
            magnet = hit.get('magnetUrl') or ''
            h = normalize_hash(hit.get('hash')) or magnet_hash(magnet)
            if not title or not h or (magnet and (not magnet.startswith('magnet:?') or magnet_hash(magnet) != h)):
                continue
            rows.append(dict(source=source, title=title,
                             page='https://knaben.org/search/index.php?' + urlencode({'q': title}) + '#' + h,
                             hash=h, magnet=magnet or 'magnet:?xt=urn:btih:' + h + '&dn=' + quote(title),
                             torrent='', date=hit.get('date') or '', size=hit.get('bytes'),
                             seeds=hit.get('seeders'), origin=hit.get('tracker') or ''))
        end = offset + len(hits)
        total = data.get('total') or {}
        more = end < total.get('value', end) or (len(hits) == 50 and total.get('relation') != 'eq')
        return {'rows': rows, 'next': end if hits and more else None}
    if source == 'dmhy':
        try:
            batch = website_page(source, query, cursor or 1)
            if cursor or batch['rows'] or batch['next']:
                return batch
        except (ValueError, requests.RequestException):
            pass  # The RSS feed can also supply releases when a later web page fails.
        url, key, params = FEEDS[source]
        return {'rows': parse_feed(source, fetch(url, params={**params, key: query})), 'next': None}
    if cursor and source in ('mikan', 'nyaa'):
        return website_page(source, query, cursor)
    url, key, params = FEEDS[source]
    params = {**params, key: query}
    if source == 'anibt':
        params.update(limit=50, offset=cursor or 0)
    if source == 'mikan':
        def load(origin):
            xml = fetch(origin + '/RSS/Search', params=params)
            rows = parse_feed(source, xml)
            for row in rows:
                row['page'] = mikan_url(row['page'], origin)
                if row['torrent']:
                    row['torrent'] = mikan_url(row['torrent'], origin)
            return xml, rows
        xml, rows = mikan_attempt(load)
    else:
        xml = fetch(url, params=params)
        rows = parse_feed(source, xml)
    channel = ET.fromstring(xml).find('channel')
    raw_count = len(channel.findall('item'))
    if source == 'anibt':
        info = channel.find('{*}response')
        end = params['offset'] + raw_count
        total = int(info.get('total', end)) if info is not None else end+int(raw_count==50)
        return {'rows': rows, 'next': end if raw_count and end < total else None}
    if not rows:
        return website_page(source, query, 1)
    # A full feed can truncate older releases. Start the web continuation at
    # its first page because its page size and ordering may differ from RSS.
    return {'rows': rows, 'next': 1 if raw_count >= {'nyaa':75, 'mikan':100}[source] else None}


def torrent_info_hash(data):
    from .torrent_metainfo import read_metainfo
    return read_metainfo(data)[0]


def fetch_metainfo(row):
    from .torrent_metainfo import read_metainfo
    url = urlparse(row['torrent'])
    origins = MIKAN_ORIGINS if row['source'] == 'mikan' else (FEEDS[row['source']][0],)
    if url.scheme != 'https' or url.netloc not in {urlparse(origin).netloc for origin in origins}:
        raise ValueError('种子地址不属于来源站')
    def load(address):
        data = fetch(address, allow_redirects=False)
        actual, info = read_metainfo(data)
        if row.get('hash') and actual != row['hash'].lower():
            raise ValueError('种子哈希与搜索结果不符')
        return data, actual, info
    if row['source'] == 'mikan':
        return mikan_attempt(lambda origin: load(mikan_url(row['torrent'], origin)))
    return load(row['torrent'])


def resolve(row, save_dir):
    torrent = row.get('torrent')
    h = row['hash']
    if torrent and (save_dir or not h):
        data, h, _ = fetch_metainfo(row)
        if save_dir:
            folder = Path(save_dir)
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / (h + '.torrent')
            if not target.is_file() or target.read_bytes() != data:
                stream = tempfile.NamedTemporaryFile(dir=folder, delete=False)
                temp = Path(stream.name)
                try:
                    with stream:
                        stream.write(data)
                    os.replace(temp, target)
                finally:
                    temp.unlink(missing_ok=True)
            return dict(hash=h, file=str(target))
    h = normalize_hash(h)
    if not h:
        raise ValueError('没有可用的磁链')
    direct = row.get('magnet', '')
    if direct and (not direct.startswith('magnet:?') or magnet_hash(direct) != h):
        raise ValueError('磁链与资源哈希不符')
    return dict(hash=h, magnet=direct or 'magnet:?xt=urn:btih:'+h+'&dn='+quote(row['title']))


def dispatch(args):
    action = args['action']
    if action == 'files':
        from .torrent_metainfo import file_listing
        return file_listing(fetch_metainfo(args['row'])[2])
    if action == 'mikan-web':
        return website_page('mikan', args['query'], None)
    if action == 'romaji':
        from pykakasi import kakasi
        return ' '.join(p['hepburn'] for p in kakasi().convert(args['name'])).strip()
    if action == 'setup':
        from .resource_ext import install
        return install()
    if args.get('source') == 'ext':
        from .resource_ext import handle
        return handle(args)
    if action == 'search':
        return search_batch(args['source'], args['query'], args.get('cursor'))
    return resolve(args['row'], args.get('saveDir'))


if __name__ == '__main__':
    try:
        print(json.dumps({'value': dispatch(json.load(sys.stdin))}, ensure_ascii=True))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
