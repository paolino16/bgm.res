"""Read-only subtitle discovery and isolated downloads for the desktop client."""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from uuid import uuid4
import zipfile
import zlib

import requests
from bs4 import BeautifulSoup, Comment, NavigableString

FORUM = 'https://bbs.acgrip.com/'
API = 'https://api.assrt.net/v1/'
SUBTITLES = {'.ass', '.ssa', '.srt', '.vtt', '.sub', '.idx', '.sup', '.smi', '.sami', '.ttml'}
PACKAGES = {'.zip', '.7z', '.rar'}
MAX_DOWNLOAD = 100 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
MAX_FILES = 2000


class SourceError(ValueError):
    def __init__(self, message, code=None, retry_after=None):
        super().__init__(message)
        self.code, self.retry_after = code, retry_after


def session():
    client = requests.Session()
    client.headers['User-Agent'] = 'bgm.res/0.19 SubtitleSearch'
    return client


def allowed_url(url, source, download=False):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    valid = host == 'bbs.acgrip.com' if source == 'acgrip' else (
        host == 'api.assrt.net' or (download and (host == 'assrt.net' or host.endswith('.assrt.net'))))
    if parsed.scheme not in ('https', 'http') or not valid or parsed.username or parsed.password or parsed.port not in (None, 80, 443):
        raise ValueError('来源返回了不受支持的链接，请打开原网页查看')
    return url


def request(client, url, source, *, data=None, download=False):
    # Validate each redirect before following it; never send a Token to a download host.
    for _ in range(6):
        allowed_url(url, source, download)
        response = client.request('POST' if data is not None else 'GET', url, data=data,
                                  timeout=(6, 25), stream=True, allow_redirects=False)
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get('Location', '')
            response.close()
            if not location:
                raise ValueError('来源返回了无效跳转')
            url, data = urljoin(url, location), None
            continue
        return response
    raise ValueError('来源跳转次数过多')


def body(response, limit=8 * 1024 * 1024):
    with response:
        response.raise_for_status()
        result = bytearray()
        for chunk in response.iter_content(65536):
            result.extend(chunk)
            if len(result) > limit:
                raise ValueError('来源返回的数据过大')
        return bytes(result)


def document(client, url, data=None):
    response = request(client, url, 'acgrip', data=data)
    final = response.url
    return BeautifulSoup(body(response), 'html.parser'), final


def text(node):
    return node.get_text(' ', strip=True) if node else ''


def number(value, label='编号'):
    value = str(value)
    if not re.fullmatch(r'[1-9]\d{0,11}', value):
        raise ValueError('无效的' + label)
    return value


def forum_message(doc):
    node = doc.select_one('#messagetext, .alert_error, .alert_info')
    return text(node)[:400] or '论坛未返回预期内容，请打开原网页查看'


def parse_forum_search(doc):
    listing = doc.select_one('#threadlist')
    if listing is None:
        if re.search(r'没有找到|未找到|相关内容\s*0\s*个', text(doc)):
            return []
        raise ValueError(forum_message(doc))
    rows = []
    for item in listing.select('li'):
        title = item.select_one('h3 a[href]')
        if not title:
            continue
        href = title['href']
        tid = parse_qs(urlparse(href).query).get('tid', [''])[0]
        if not tid:
            match = re.search(r'thread-(\d+)-', href)
            tid = match[1] if match else ''
        if not tid.isdecimal():
            continue
        paragraphs = item.find_all('p', recursive=False)
        metadata = paragraphs[-1].find_all('span', recursive=False) if paragraphs else []
        rows.append({'id': tid, 'source': 'acgrip', 'title': text(title),
                     'page': FORUM + f'thread-{tid}-1-1.html',
                     'summary': text(paragraphs[1]) if len(paragraphs) > 2 else '',
                     'stats': text(paragraphs[0]) if paragraphs else '',
                     'date': text(metadata[0]) if metadata else '',
                     'author': text(metadata[1]) if len(metadata) > 1 else '',
                     'board': text(metadata[2]) if len(metadata) > 2 else ''})
    return rows


def forum_search(query, page=1):
    client = session()
    form, _ = document(client, FORUM + 'search.php?mod=forum')
    field = form.select_one('input[name=formhash]')
    if not field:
        raise ValueError(forum_message(form))
    doc, result_url = document(client, FORUM + 'search.php?mod=forum',
                               {'formhash': field.get('value', ''), 'srchtxt': query, 'searchsubmit': 'yes'})
    if page > 1:
        params = parse_qs(urlparse(result_url).query)
        if not params.get('searchid'):
            raise ValueError('论坛搜索已过期，请重新搜索')
        params['page'] = [str(page)]
        doc, _ = document(client, FORUM + 'search.php?' + urlencode(params, doseq=True))
    rows = parse_forum_search(doc)
    more = any(parse_qs(urlparse(a['href']).query).get('page') == [str(page + 1)]
               for a in doc.select('.pg a[href]'))
    return {'rows': rows, 'next': page + 1 if more else None}


def attachment_id(href):
    aid = parse_qs(urlparse(href).query).get('aid', [''])[0]
    try:
        raw = base64.b64decode(aid + '=' * (-len(aid) % 4)).decode('ascii').split('|')[0]
        return raw if raw.isdecimal() else ''
    except (ValueError, UnicodeError):
        return ''


def forum_body_nodes(root):
    """Preserve document structure without transmitting executable HTML or styles."""
    allowed = {'p', 'div', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li',
               'blockquote', 'pre', 'code', 'table', 'caption', 'thead', 'tbody',
               'tfoot', 'tr', 'th', 'td', 'h4'}
    aliases = {'b': 'strong', 'i': 'em', 'strike': 's', **{f'h{i}': 'h4' for i in range(1, 7)}}
    remaining = [60000, 4000]

    def visit(node, depth=0):
        if depth > 32 or remaining[0] <= 0 or remaining[1] <= 0 or isinstance(node, Comment):
            return []
        remaining[1] -= 1
        if isinstance(node, NavigableString):
            value = str(node).replace('\ufeff', '')[:remaining[0]]
            remaining[0] -= len(value)
            return [value] if value else []
        if node.name in {'script', 'style', 'iframe', 'object', 'embed', 'svg', 'form', 'input', 'button', 'img'}:
            return []
        children = [child for item in node.children for child in visit(item, depth + 1)]
        tag = aliases.get(node.name, node.name)
        # Discuz can emit non-void <br> tags that html.parser wraps around
        # the rest of a post. Those descendants must remain visible siblings.
        if tag == 'br':
            return [{'tag': 'br', 'children': []}, *children]
        if tag not in allowed:
            return children
        result = {'tag': tag, 'children': children}
        if tag in {'th', 'td'}:
            for attribute in ('colspan', 'rowspan'):
                value = str(node.get(attribute, ''))
                if value.isdecimal() and 1 < int(value) <= 50:
                    result[attribute] = int(value)
        return [result]

    return [child for node in root.children for child in visit(node)]


def parse_forum_detail(doc, tid, page=1):
    posts = []
    had_posts = False
    for post in doc.select('div[id^="post_"]'):
        match = re.fullmatch(r'post_(\d+)', post.get('id', ''))
        content = post.select_one('.t_f')
        if not match or not content:
            continue
        had_posts = True
        pid = match[1]
        files, seen = [], set()
        for link in post.select('a[href*="mod=attachment"]'):
            name, aid = text(link), attachment_id(link['href'])
            if not aid or aid in seen or Path(name).suffix.lower() not in SUBTITLES | PACKAGES:
                continue
            seen.add(aid)
            container = link.find_parent('dl') or link.find_parent('ignore_js_op') or link.find_parent('p') or link.parent
            files.append({'id': aid, 'name': name, 'note': text(container)[:1600],
                          'postId': pid, 'entryId': tid, 'source': 'acgrip'})
        if not files:
            continue
        links, seen_links = [], set()
        for link in content.select('a[href]'):
            href = urljoin(FORUM, link['href'])
            parsed = urlparse(href)
            if parsed.scheme not in ('http', 'https') or 'mod=attachment' in href or href in seen_links:
                continue
            seen_links.add(href)
            links.append({'url': href, 'label': text(link) or href})
        # Parse into an allowlisted document tree; retain plain text as a fallback.
        clean = BeautifulSoup(str(content), 'html.parser')
        for node in clean.select('script, style, .aimg_tip'):
            node.decompose()
        # Attachment widgets repeat their size, download count and upload date
        # in the post body. Keep their names here; metadata belongs to the file.
        def file_names(names):
            block = clean.new_tag('div')
            for name in dict.fromkeys(names):
                paragraph = clean.new_tag('p')
                paragraph.string = name
                block.append(paragraph)
            return block

        for widget in clean.select('.pattl, ignore_js_op'):
            if widget.parent is None:
                continue
            names = [text(link) for link in widget.select('a[href*="mod=attachment"]')
                     if attachment_id(link['href']) in seen]
            if names or 'pattl' in widget.get('class', []):
                widget.replace_with(file_names(names))
        for link in list(clean.select('a[href*="mod=attachment"]')):
            if link.parent is None or attachment_id(link['href']) not in seen:
                continue
            container = link.find_parent('dl') or link.find_parent('p') or link
            names = [text(anchor) for anchor in container.select('a[href*="mod=attachment"]')
                     if attachment_id(anchor['href']) in seen] if container is not link else [text(link)]
            container.replace_with(file_names(names))
        body_nodes = forum_body_nodes(clean.select_one('.t_f') or clean)
        # Some Discuz pages use non-void <br> tags. Unwrap instead of replacing
        # the node, so malformed markup cannot swallow the rest of the post.
        for line in clean.select('br'):
            line.insert_before('\n')
            line.unwrap()
        for block in clean.select('p, div, li, pre'):
            block.insert_before('\n')
            block.insert_after('\n')
        description = clean.get_text().replace('\r', '')
        description = '\n'.join(line.strip() for line in description.split('\n'))
        author = post.select_one('.authi a.xw1, .authi a, .pls .authi a')
        stamp = post.select_one('[id^="authorposton"]')
        floor = post.select_one('.pi strong a')
        posts.append({'id': pid, 'author': text(author), 'date': text(stamp),
                      'floor': text(floor) or ('楼主' if page == 1 and not posts else '楼层'),
                      'body': re.sub(r'\n{3,}', '\n\n', description).strip()[:60000],
                      'bodyNodes': body_nodes,
                      'page': FORUM + f'forum.php?mod=viewthread&tid={tid}&page={page}#pid{pid}',
                      'files': files, 'links': links})
    if not posts and not had_posts:
        raise ValueError(forum_message(doc))
    more = any(parse_qs(urlparse(a['href']).query).get('page') == [str(page + 1)]
               or re.search(rf'thread-{tid}-{page + 1}-', a['href'])
               for a in doc.select('.pg a[href]'))
    return {'id': tid, 'source': 'acgrip', 'title': text(doc.select_one('#thread_subject')),
            'posts': posts, 'next': page + 1 if more else None}


def forum_detail(tid, page=1, client=None):
    tid = number(tid, '帖子编号')
    doc, _ = document(client or session(), FORUM + f'forum.php?mod=viewthread&tid={tid}&page={page}')
    return parse_forum_detail(doc, tid, page), doc


def assrt(client, endpoint, token, **params):
    if not re.fullmatch(r'[a-zA-Z0-9]{32}', token or ''):
        raise SourceError('请先配置射手网 API Token', 'token')
    url = API + endpoint
    # No redirects: bearer tokens must remain on the documented API origin.
    with client.get(url, params=params, headers={'Authorization': 'Bearer ' + token},
                    timeout=(6, 25), stream=True, allow_redirects=False) as response:
        retry = response.headers.get('Retry-After', '')
        if response.status_code == 429:
            raise SourceError('射手网额度暂时用尽，稍后可重试', 'rate_limit',
                              min(3600, max(1, int(retry))) if retry.isdecimal() else 60)
        try:
            data = json.loads(body_without_status(response))
        except (ValueError, UnicodeError):
            response.raise_for_status()
            raise ValueError('射手网未返回有效数据') from None
        if not isinstance(data, dict):
            raise ValueError('射手网未返回有效数据')
        status = data.get('status')
        if status == 30900 or response.status_code == 429:
            raise SourceError('射手网额度暂时用尽，稍后可重试', 'rate_limit',
                              min(3600, max(1, int(retry))) if retry.isdecimal() else 60)
        if status == 20001:
            raise SourceError('射手网 Token 无效，请重新配置', 'token')
        if status != 0:
            raise ValueError('射手网：' + str(data.get('errmsg') or f'错误 {status}')[:250])
        response.raise_for_status()
        return data


def body_without_status(response):
    result = bytearray()
    for chunk in response.iter_content(65536):
        result.extend(chunk)
        if len(result) > 8 * 1024 * 1024:
            raise ValueError('射手网返回的数据过大')
    return bytes(result)


def assrt_row(item):
    sid = str(item['id'])
    return {'source': 'assrt', 'id': sid, 'title': item.get('native_name') or item.get('title') or item.get('videoname') or sid,
            'page': 'https://assrt.net/xml/sub/' + sid + '.xml', 'date': item.get('upload_time', ''),
            'summary': item.get('videoname', ''), 'language': (item.get('lang') or {}).get('desc', ''),
            'format': item.get('subtype', ''), 'group': item.get('release_site', '')}


def assrt_detail(token, sid):
    sid = number(sid, '字幕编号')
    data = assrt(session(), 'sub/detail', token, id=sid)
    items = data.get('sub', {}).get('subs', [])
    if not items:
        raise ValueError('射手网未返回字幕详情')
    item = items[0]
    result = assrt_row(item)
    files = []
    if item.get('url'):
        files.append({'id': 'package', 'name': item.get('filename') or '字幕包', 'note': '整个字幕包',
                      'entryId': sid, 'source': 'assrt'})
    for index, file in enumerate(item.get('filelist') or []):
        if file.get('url') and Path(file.get('f', '')).suffix.lower() in SUBTITLES:
            files.append({'id': 'file:' + file['f'], 'name': file['f'], 'note': str(file.get('s', '')),
                          'entryId': sid, 'source': 'assrt'})
    producer = item.get('producer') or {}
    description = '\n'.join(label + '：' + str(value) for label, value in [
        ('适配视频文件名', item.get('videoname')), ('语言', result['language']),
        ('字幕组', result['group']), ('格式', result['format']),
        ('制作者', producer.get('producer')),
        ('校订者', producer.get('verifier')), ('来源', producer.get('source'))] if value)
    result.update(posts=[{'id': sid, 'floor': '字幕详情', 'author': producer.get('uploader') or producer.get('producer') or '',
                          'date': result['date'], 'body': description + '\n\n适配与调轴说明：以原网页为准；API 未提供完整自由文本介绍。',
                          'page': result['page'], 'files': files, 'links': []}], next=None)
    return result, item


def safe_member(name):
    # Apply Windows path rules even when tests run on another OS.
    name = name.replace('\\', '/')
    path = PurePosixPath(name)
    if not name or path.is_absolute() or any(part in ('..', '.') or ':' in part or
            any(c in part for c in '<>"|?*') or part.endswith((' ', '.')) or
            re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.I)
            for part in path.parts):
        raise ValueError('压缩包包含不安全的文件路径')
    return path


def rar_tool():
    # Prefer the Windows tool over an executable in the download directory.
    system = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'tar.exe'
    candidate = str(system) if os.name == 'nt' and system.is_file() else shutil.which('bsdtar')
    if not candidate:
        raise ValueError('未找到支持 RAR 的解压工具，需要 Windows 自带的 tar 或 bsdtar')
    return candidate


def rar_pattern(name):
    # bsdtar treats member selectors as patterns, even when passed as argv.
    return ''.join('\\' + char if char in '*?[]' else char for char in name.replace('\\', '/'))


def unpack_rar(archive, destination):
    import rarfile
    with rarfile.RarFile(archive, errors='strict') as package:
        if package.needs_password():
            raise ValueError('RAR 字幕包已加密，请手动输入密码解压')
        infos = package.infolist()
        if len(package.volumelist()) != 1:
            raise ValueError('RAR 字幕包包含多个分卷，请下载完整分卷后手动解压')
        if len(infos) > MAX_FILES or sum(info.file_size for info in infos) > MAX_EXPANDED:
            raise ValueError('字幕包解压后过大')
        seen = set()
        for info in infos:
            relative = safe_member(info.filename)
            key = str(relative).casefold()
            special = stat.S_IFMT(info.mode) not in (0, stat.S_IFREG, stat.S_IFDIR)
            if key in seen or special or info.is_symlink() or info.file_redir is not None or not (info.is_file() or info.is_dir()):
                raise ValueError('字幕包包含重复路径、链接或特殊文件')
            if info.flags & (rarfile.RAR_FILE_SPLIT_BEFORE | rarfile.RAR_FILE_SPLIT_AFTER):
                raise ValueError('RAR 字幕包包含分卷文件，请下载完整分卷后手动解压')
            seen.add(key)
        tool = rar_tool()
        written = 0
        for info in infos:
            target = destination.joinpath(*safe_member(info.filename).parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            # The native tool only writes stdout. Paths, links and overwrites
            # remain under our control; no native archive extraction to disk.
            with tempfile.TemporaryFile() as errors, target.open('xb') as output:
                process = subprocess.Popen([tool, '-x', '--to-stdout', '-f', str(archive.resolve()),
                                            '--', rar_pattern(info.filename)],
                                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors,
                                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                timer = threading.Timer(30, process.kill)
                timer.daemon = True
                timer.start()
                size, checksum = 0, 0
                try:
                    for chunk in iter(lambda: process.stdout.read(65536), b''):
                        size += len(chunk)
                        written += len(chunk)
                        if size > info.file_size or written > MAX_EXPANDED:
                            raise ValueError('字幕包解压数据超出声明大小或总量限制')
                        checksum = zlib.crc32(chunk, checksum)
                        output.write(chunk)
                    if process.wait() != 0:
                        raise ValueError('RAR 解压失败，文件可能已损坏、读取超时或使用了系统工具不支持的压缩方式')
                    if size != info.file_size or (info.CRC is not None and checksum != info.CRC):
                        raise ValueError('RAR 文件校验失败，字幕包可能已损坏')
                finally:
                    timer.cancel()
                    if process.poll() is None:
                        process.kill()
                    process.wait()
                    process.stdout.close()


def unpack(archive, destination):
    destination.mkdir()
    suffix = archive.suffix.lower()
    if suffix == '.zip':
        with zipfile.ZipFile(archive) as package:
            infos = package.infolist()
            if len(infos) > MAX_FILES or sum(f.file_size for f in infos) > MAX_EXPANDED:
                raise ValueError('字幕包解压后过大')
            seen = set()
            for info in infos:
                relative = safe_member(info.filename)
                key = str(relative).casefold()
                if key in seen or stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError('字幕包包含重复路径或链接')
                seen.add(key)
            written = 0
            for info in infos:
                target = destination.joinpath(*safe_member(info.filename).parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(info) as source, target.open('xb') as output:
                    for chunk in iter(lambda: source.read(65536), b''):
                        written += len(chunk)
                        if written > MAX_EXPANDED:
                            raise ValueError('字幕包解压后过大')
                        output.write(chunk)
    elif suffix == '.7z':
        import py7zr
        with py7zr.SevenZipFile(archive) as package:
            infos = package.list()
            if any(file.is_junction or file.is_socket or file.is_symlink for file in package.files):
                raise ValueError('字幕包包含链接或特殊文件')
            if len(infos) > MAX_FILES or sum(f.uncompressed or 0 for f in infos) > MAX_EXPANDED:
                raise ValueError('字幕包解压后过大')
            seen = set()
            for info in infos:
                key = str(safe_member(info.filename)).casefold()
                if key in seen or info.is_symlink or (not info.is_directory and not info.is_file):
                    raise ValueError('字幕包包含重复路径或链接')
                seen.add(key)
            package.extractall(path=destination)
    elif suffix == '.rar':
        unpack_rar(archive, destination)
    else:
        raise ValueError('不支持的字幕压缩包格式')
    return [str(file.resolve()) for file in sorted(destination.rglob('*'))
            if file.is_file() and file.suffix.lower() in SUBTITLES]


def forum_attachment(args, client, sid, selected):
    detail, doc = forum_detail(sid, int(args.get('page') or 1), client)
    match = next((f for post in detail['posts'] if post['id'] == str(selected['postId'])
                  for f in post['files'] if f['id'] == str(selected['id'])), None)
    if match is None:
        raise ValueError('附件已变更，请刷新帖子详情')
    link = next((a['href'] for a in doc.select('a[href*="mod=attachment"]')
                 if attachment_id(a['href']) == match['id']), None)
    url, name = urljoin(FORUM, link), match['name']
    client.headers['Referer'] = FORUM + f'thread-{sid}-1-1.html'
    return url, name


def assrt_attachment(args, client, sid, selected):
    _, item = assrt_detail(args.get('token'), sid)
    if selected['id'] == 'package':
        url, name = item.get('url'), item.get('filename', '')
    else:
        file = next((f for f in item.get('filelist', []) if 'file:' + f.get('f', '') == selected['id']), None)
        if not file:
            raise ValueError('字幕文件已变更，请刷新详情')
        url, name = file.get('url'), file['f']
    return url, name


def download(args):
    source, selected = args['source'], args['file']
    client = session()
    url, name = PROVIDERS[source]['attachment'](args, client, number(selected['entryId']), selected)
    name = name.replace('\\', '/').split('/')[-1]
    safe_member(name)
    if Path(name).suffix.lower() not in SUBTITLES | PACKAGES:
        raise ValueError('下载项不是支持的字幕或压缩包')
    root = Path(args['directory']).resolve() / uuid4().hex
    root.mkdir(parents=True)
    target = root / name
    try:
        with request(client, url, source, download=True) as response:
            if source == 'assrt' and response.status_code == 493 and selected['id'] != 'package':
                raise ValueError('射手网暂时无法从压缩包提取单个字幕（HTTP 493），请尝试下载整个字幕包')
            response.raise_for_status()
            if 'text/html' in response.headers.get('Content-Type', '').lower():
                raise ValueError('来源返回了登录或验证页面，请打开原网页下载')
            size = 0
            with target.open('xb') as output:
                for chunk in response.iter_content(65536):
                    size += len(chunk)
                    if size > MAX_DOWNLOAD:
                        raise ValueError('字幕下载超过 100 MiB 限制')
                    output.write(chunk)
        if not size:
            raise ValueError('下载到的文件为空')
    except Exception:
        shutil.rmtree(root)
        raise
    if target.suffix.lower() in SUBTITLES:
        return {'folder': str(root), 'archive': str(target), 'files': [str(target)], 'warning': ''}
    expanded = root / 'files'
    try:
        files = unpack(target, expanded)
        return {'folder': str(root), 'archive': str(target), 'files': files,
                'warning': '' if files else '已保存并解压，但未找到支持的字幕文件；可打开目录查看字体等配套资源'}
    except Exception as error:
        shutil.rmtree(expanded, ignore_errors=True)
        return {'folder': str(root), 'archive': str(target), 'files': [],
                'warning': '压缩包已保存，未能自动解压：' + str(error)[:300] + '。可打开目录后手动解压。'}


def assrt_search(args, query, page):
    if len(query) < 3:
        raise ValueError('射手网搜索词至少需要 3 个字符')
    position = (page - 1) * 15
    data = assrt(session(), 'sub/search', args.get('token'), q=query, pos=position, cnt=15, filelist=1)
    items = data.get('sub', {}).get('subs') or []
    return {'rows': [assrt_row(item) for item in items], 'next': page + 1 if len(items) == 15 else None}


PROVIDERS = {
    'acgrip': {
        'search': lambda args, query, page: forum_search(query, page),
        'detail': lambda args, page: forum_detail(args['id'], page)[0],
        'attachment': forum_attachment,
    },
    'assrt': {
        'search': assrt_search,
        'detail': lambda args, page: assrt_detail(args.get('token'), args['id'])[0],
        'attachment': assrt_attachment,
    },
}


def extract_local(args):
    archive = Path(args.get('archive') or '').expanduser().resolve()
    if not archive.is_file() or archive.suffix.lower() not in PACKAGES:
        raise ValueError('请选择 ZIP、7Z 或 RAR 字幕压缩包')
    if archive.stat().st_size > MAX_DOWNLOAD:
        raise ValueError('字幕压缩包超过 100 MiB 限制')
    root = Path(args['directory']).resolve() / uuid4().hex
    root.mkdir(parents=True)
    target = root / archive.name
    try:
        shutil.copy2(archive, target)
    except Exception:
        shutil.rmtree(root)
        raise
    expanded = root / 'files'
    try:
        files = unpack(target, expanded)
        return {'folder': str(root), 'archive': str(target), 'files': files,
                'warning': '' if files else '压缩包内未找到支持的字幕文件，可在收件箱打开目录查看'}
    except Exception as error:
        shutil.rmtree(expanded, ignore_errors=True)
        return {'folder': str(root), 'archive': str(target), 'files': [],
                'warning': '字幕包副本已保留在收件箱，未能解压：' + str(error)[:300]}


def run(args):
    source, action = args.get('source'), args.get('action')
    if action == 'extract-local':
        return extract_local(args)
    if source not in PROVIDERS:
        raise ValueError('不支持的字幕来源')
    page = args.get('cursor') or 1
    if not isinstance(page, int) or isinstance(page, bool) or page < 1 or page > 10000:
        raise ValueError('无效的分页')
    if action == 'search':
        query = str(args.get('query') or '').strip()[:100]
        if not query:
            raise ValueError('请输入作品名')
        return PROVIDERS[source]['search'](args, query, page)
    if action == 'detail':
        return PROVIDERS[source]['detail'](args, page)
    if action == 'download':
        return download(args)
    raise ValueError('不支持的字幕操作')


if __name__ == '__main__':
    try:
        print(json.dumps({'value': run(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        # Do not expose request URLs or credentials through requests exception messages.
        message = '连接字幕来源失败，请稍后重试或打开原网页' if isinstance(error, requests.RequestException) else str(error)
        print(json.dumps({'error': message, 'code': getattr(error, 'code', None),
                          'retryAfter': getattr(error, 'retry_after', None)}, ensure_ascii=False))
