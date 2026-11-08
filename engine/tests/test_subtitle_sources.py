import base64
import io
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch, Mock
import zipfile
import zlib

from bs4 import BeautifulSoup
import py7zr
import rarfile
from src import subtitle_sources as s


def doc(html):
    return BeautifulSoup(html, 'html.parser')


def aid(value):
    return base64.b64encode(f'{value}|signature|time|0|13925'.encode()).decode()


def stored_rar(files):
    """Small RAR3 stored fixtures built from our own text, without a RAR writer."""
    def header(kind, flags, payload):
        data = struct.pack('<BHH', kind, flags, 7 + len(payload)) + payload
        return struct.pack('<H', zlib.crc32(data) & 0xffff) + data
    result = b'Rar!\x1a\x07\x00' + header(0x73, 0, b'\0' * 6)
    for name, body in files:
        name = name.encode('ascii')
        payload = struct.pack('<IIBIIBBHI', len(body), len(body), 3, zlib.crc32(body),
                              0, 20, 0x30, len(name), stat.S_IFREG | 0o600) + name
        result += header(0x74, 0x8000, payload) + body
    return result + header(0x7b, 0, b'')


class SubtitleSourcesTests(unittest.TestCase):
    def test_search_preserves_summary_and_metadata(self):
        rows = s.parse_forum_search(doc('''<div id="threadlist"><ul><li><h3><a href="forum.php?mod=viewthread&amp;tid=13925">淡岛百景</a></h3>
        <p>0 个回复 - 100 次查看</p><p>匹配 BDMV，不需要调轴</p>
        <p><span>2026-9-2</span><span>Nazuna</span><span>ACG字幕分享</span></p></li></ul></div>'''))
        self.assertEqual(rows[0]['id'], '13925')
        self.assertIn('BDMV', rows[0]['summary'])
        self.assertEqual(rows[0]['author'], 'Nazuna')

    def test_search_rejects_login_and_rate_pages(self):
        with self.assertRaisesRegex(ValueError, '等待'):
            s.parse_forum_search(doc('<div id="messagetext">请等待 30 秒</div>'))
        self.assertEqual(s.parse_forum_search(doc('<p>找到相关内容 0 个</p>')), [])

    def test_each_floor_keeps_its_own_body_notes_and_files(self):
        html = ''.join(f'''<div id="post_{pid}"><div class="authi"><a>{author}</a></div>
        <td class="t_f">{body}<br><b>字体说明</b><script>secret()</script><a href="https://pan.baidu.com/s/example">字体包，密码 1234</a></td>
        <dl><dt><a href="forum.php?mod=attachment&amp;aid={aid(pid)}">{name}.7z</a></dt><dd>{note}</dd></dl></div>'''
                       for pid, author, body, name, note in [(11, '楼主', 'BDMV 版', 'original', '简繁'), (12, '修订者', '修正时间轴', 'retimed', '修订版')])
        result = s.parse_forum_detail(doc(html), '13925')
        self.assertEqual(len(result['posts']), 2)
        first, second = result['posts']
        self.assertIn('BDMV', first['body'])
        self.assertIn('字体说明', first['body'])  # Non-void <br> markup must not discard following content.
        self.assertNotIn('secret', first['body'])
        self.assertEqual(first['files'][0]['id'], '11')
        self.assertIn('简繁', first['files'][0]['note'])
        self.assertIn('修正时间轴', second['body'])
        self.assertEqual(second['files'][0]['postId'], '12')
        self.assertEqual(first['links'][0]['label'], '字体包，密码 1234')

    def test_thread_pagination_and_images_are_not_subtitle_downloads(self):
        result = s.parse_forum_detail(doc(f'''<span id="thread_subject">标题</span><div id="post_1"><td class="t_f">正文</td>
        <a href="forum.php?mod=attachment&amp;aid={aid(2)}">cover.jpg</a></div><div class="pg"><a href="thread-13925-2-1.html">2</a></div>'''), '13925')
        self.assertEqual(result['next'], 2)
        self.assertEqual(result['posts'], [])

    def test_attachment_metadata_stays_with_each_file_and_body_keeps_names(self):
        for wrapper in ('<div class="pattl">{}</div>', '{}'):
            with self.subTest(wrapper=wrapper):
                attachments = ''.join(
                    f'<dl><dt><a href="forum.php?mod=attachment&amp;aid={aid(index)}">{name}</a>'
                    f' ({size}, 下载次数: {count})</dt><dd>{stamp} 上传</dd>'
                    '<dd>点击文件名下载附件</dd></dl>'
                    for index, name, size, count, stamp in [
                        (20, '物语系列.rar', '7.41 MB', 83, '2026-9-6 20:42'),
                        (21, '诸神 物语系列.rar', '1.17 MB', 54, '2026-9-6 21:28')])
                html = '<div id="post_1"><div class="t_f">适配说明，保留正文。' + wrapper.format(attachments) + '<p>字体说明也保留。</p></div></div>'
                post = s.parse_forum_detail(doc(html), '13925')['posts'][0]
                for name in ['物语系列.rar', '诸神 物语系列.rar', '适配说明', '字体说明']:
                    self.assertIn(name, post['body'])
                for metadata in ['7.41 MB', '1.17 MB', '下载次数', '2026-9-6', '点击文件名']:
                    self.assertNotIn(metadata, post['body'])
                self.assertIn('7.41 MB', post['files'][0]['note'])
                self.assertIn('下载次数: 83', post['files'][0]['note'])
                self.assertIn('2026-9-6 20:42', post['files'][0]['note'])
                self.assertNotIn('1.17 MB', post['files'][0]['note'])
                self.assertIn('1.17 MB', post['files'][1]['note'])

    def test_rich_body_preserves_tables_and_semantics_without_forum_styles(self):
        html = f'''<div id="post_1"><div class="t_f"><p><b>角色配色</b>与<i>适配版本</i></p>
        <table style="color:red" onclick="evil()"><tr><th>角色</th><th>RGB</th><th>HTML</th></tr>
        <tr><td>战场原黑仪\ufeff</td><td>(129,60,133)</td><td><font color="red">#813C85</font></td></tr>
        <tr><td colspan="2">字幕来源</td><td rowspan="2">华盟字幕社</td></tr></table>
        <ul><li>保留列表</li></ul><script>evil()</script><img src="https://example.com/tracker">
        <a href="forum.php?mod=attachment&amp;aid={aid(20)}">show.rar</a></div></div>'''
        post = s.parse_forum_detail(doc(html), '13925')['posts'][0]
        encoded = json.dumps(post['bodyNodes'], ensure_ascii=False)
        for value in ['"tag": "table"', '"tag": "tr"', '"tag": "strong"', '"tag": "em"',
                      '"tag": "li"', '"colspan": 2', '"rowspan": 2', '#813C85', '战场原黑仪', 'show.rar']:
            self.assertIn(value, encoded)
        for value in ['onclick', 'style', 'evil()', 'tracker', '\ufeff', '"tag": "font"']:
            self.assertNotIn(value, encoded)

    def test_rich_body_limits_untrusted_depth_and_text(self):
        nodes = s.forum_body_nodes(doc('<p>' + 'x' * 70000 + '</p>'))
        self.assertEqual(len(nodes[0]['children'][0]), 60000)
        nodes = s.forum_body_nodes(doc('<div>' * 100 + 'deep' + '</div>' * 100))
        self.assertNotIn('deep', json.dumps(nodes))

    def test_discuz_nonvoid_br_does_not_hide_the_rest_of_rich_body(self):
        html = f'''<div id="post_1"><td class="t_f"><br><font>为不同角色设置颜色
        <table><tr><td>战场原黑仪</td><td>#813C85</td></tr></table>
        <dl><a href="forum.php?mod=attachment&amp;aid={aid(20)}">show.rar</a></dl>
        </font></br></td></div>'''
        nodes = s.parse_forum_detail(doc(html), '13925')['posts'][0]['bodyNodes']
        self.assertEqual(nodes[0], {'tag': 'br', 'children': []})
        def visible_text(items):
            return ''.join(item if isinstance(item, str) else visible_text(item['children'])
                           if item['tag'] != 'br' else '' for item in items)
        self.assertIn('为不同角色设置颜色', visible_text(nodes))
        self.assertIn('战场原黑仪', visible_text(nodes))
        self.assertIn('#813C85', visible_text(nodes))
        self.assertIn('show.rar', visible_text(nodes))

    def test_inline_discuz_attachments_move_metadata_out_of_body(self):
        attachments = ''.join(
            f'''<ignore_js_op><img src="rar.gif"><span id="attach_{index}">
            <a href="forum.php?mod=attachment&amp;aid={aid(index)}">{name}</a>
            <em class="xg1">({size}, 下载次数: {count})</em></span>
            <div class="tip" id="attach_{index}_menu"><div class="tip_c">
            <div class="y">{stamp} 上传</div>点击文件名下载附件</div></div></ignore_js_op>'''
            for index, name, size, count, stamp in [
                (20, '[VCB-Studio] 物语系列 monogatari series 华盟&amp;诸神&amp;喵萌.rar', '7.41 MB', 83, '2026-9-6 20:42'),
                (21, '诸神 物语系列.rar', '1.17 MB', 54, '2026-9-6 21:28')])
        post = s.parse_forum_detail(doc('<div id="post_1"><td class="t_f">保留适配说明<br>' + attachments + '</br></td></div>'), '13925')['posts'][0]
        for value in ['保留适配说明', '[VCB-Studio] 物语系列 monogatari series 华盟&诸神&喵萌.rar', '诸神 物语系列.rar']:
            self.assertIn(value, post['body'])
        for value in ['7.41 MB', '1.17 MB', '下载次数', '2026-9-6', '点击文件名下载附件']:
            self.assertNotIn(value, post['body'])
            self.assertNotIn(value, json.dumps(post['bodyNodes'], ensure_ascii=False))
        for file, size, count, stamp in zip(post['files'], ['7.41 MB', '1.17 MB'], [83, 54], ['20:42', '21:28']):
            self.assertIn(size, file['note'])
            self.assertIn(f'下载次数: {count}', file['note'])
            self.assertIn(stamp, file['note'])

    def test_thread_omits_replies_without_subtitle_attachments(self):
        html = f'''<div id="post_1"><td class="t_f">谢谢分享</td></div>
        <div id="post_2"><td class="t_f">字幕说明</td><dl><a href="forum.php?mod=attachment&amp;aid={aid(20)}">show.ass</a></dl></div>
        <div id="post_3"><td class="t_f">截图回复</td><a href="forum.php?mod=attachment&amp;aid={aid(30)}">image.png</a></div>'''
        result = s.parse_forum_detail(doc(html), '13925')
        self.assertEqual([post['id'] for post in result['posts']], ['2'])

    def response(self, data, status=200, headers=None):
        response = Mock(status_code=status, headers=headers or {})
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = [json.dumps(data).encode()]
        return response

    def test_api_rate_errors_include_retry_delay(self):
        for status, data in [(503, {'status': 30900}), (429, None)]:
            client = Mock()
            client.get.return_value = self.response(data, status, {'Retry-After': '90'})
            with self.assertRaises(s.SourceError) as caught:
                s.assrt(client, 'sub/search', 'a' * 32, q='test')
            self.assertEqual(caught.exception.code, 'rate_limit')
            self.assertEqual(caught.exception.retry_after, 90)
            self.assertFalse(client.get.call_args.kwargs['allow_redirects'])
            self.assertNotIn('token', client.get.call_args.kwargs['params'])

    def test_api_invalid_token_is_actionable(self):
        client = Mock()
        client.get.return_value = self.response({'status': 20001})
        with self.assertRaises(s.SourceError) as caught:
            s.assrt(client, 'sub/search', 'a' * 32)
        self.assertEqual(caught.exception.code, 'token')

    def test_detail_does_not_expose_expiring_download_urls(self):
        item = {'id': 100001, 'native_name': 'Title', 'url': 'https://file0.assrt.net/temporary', 'filename': 'pack.zip',
                'videoname': 'BD EP01', 'lang': {'desc': '中日'}, 'producer': {'source': '人工校订'},
                'filelist': [{'f': 'EP01.ass', 'url': 'https://file0.assrt.net/temporary2', 's': '20KB'}]}
        with patch.object(s, 'assrt', return_value={'sub': {'subs': [item]}}):
            result, _ = s.assrt_detail('a' * 32, '100001')
        self.assertNotIn('temporary', json.dumps(result))
        self.assertIn('人工校订', result['posts'][0]['body'])
        self.assertEqual(len(result['posts'][0]['files']), 2)

    def test_download_redirect_allowlist(self):
        for url in ['file:///etc/passwd', 'https://localhost/sub.ass', 'https://evil.assrt.net.evil.test/a', 'https://user:pass@bbs.acgrip.com/a', 'https://bbs.acgrip.com:999/a']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                s.allowed_url(url, 'acgrip', True)
        client = Mock()
        response = Mock(status_code=302, headers={'Location': 'http://127.0.0.1/private'})
        client.request.return_value = response
        with self.assertRaises(ValueError):
            s.request(client, s.FORUM, 'acgrip')
        self.assertEqual(client.request.call_count, 1)

    def test_assrt_extraction_failure_suggests_package_and_removes_partial_folder(self):
        item = {'filelist': [{'f': '01.ass', 'url': 'https://file1.assrt.net/onthefly/123/01.ass'}]}
        response = self.response({}, 493)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(s, 'assrt_detail', return_value=({}, item)), \
                patch.object(s, 'request', return_value=response):
            with self.assertRaisesRegex(ValueError, 'HTTP 493.*整个字幕包'):
                s.download({'source': 'assrt', 'token': 'a' * 32, 'directory': directory,
                            'file': {'entryId': '123', 'id': 'file:01.ass'}})
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_archive_paths_are_checked_with_windows_rules(self):
        for value in ['../escape.ass', '..\\escape.ass', '/absolute.ass', 'C:/escape.ass', 'CON.ass', 'dir/NUL', 'dir/file.ass:stream', 'dir/end.']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                s.safe_member(value)

    def test_zip_and_7z_return_subtitles_and_keep_fonts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subtitle = root / 'EP01.ass'
            subtitle.write_text('[Script Info]', encoding='utf-8')
            for suffix in ('.zip', '.7z'):
                archive = root / ('pack' + suffix)
                if suffix == '.zip':
                    with zipfile.ZipFile(archive, 'w') as package:
                        package.write(subtitle, 'show/EP01.ass')
                        package.writestr('font.ttf', b'font')
                else:
                    with py7zr.SevenZipFile(archive, 'w') as package:
                        package.write(subtitle, 'show/EP01.ass')
                result = s.unpack(archive, root / suffix[1:])
                self.assertEqual(len(result), 1)
                self.assertEqual(Path(result[0]).read_text(), '[Script Info]')

    def test_zip_symlink_and_case_duplicates_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'pack.zip'
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr('EP01.ass', 'a')
                package.writestr('ep01.ass', 'b')
            with self.assertRaises(ValueError):
                s.unpack(archive, root / 'duplicate')
            info = zipfile.ZipInfo('link.ass')
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr(info, '../outside')
            with self.assertRaises(ValueError):
                s.unpack(archive, root / 'symlink')

    def test_rar_download_extracts_bracket_names_and_preserves_fonts(self):
        try:
            s.rar_tool()
        except ValueError:
            self.skipTest('RAR integration requires Windows tar or bsdtar')
        raw = stored_rar([('[Group]/[Group] Show - 01.ass', b'[Script Info]\nDialogue: text'),
                          ('[Group]/font.ttf', b'font')])
        response = self.response({}, 200)
        response.iter_content.return_value = [raw]
        item = {'url': 'https://file0.assrt.net/package.rar', 'filename': 'subtitles.rar'}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(s, 'assrt_detail', return_value=({}, item)), \
                patch.object(s, 'request', return_value=response):
            result = s.download({'source': 'assrt', 'token': 'a' * 32, 'directory': directory,
                                 'file': {'entryId': '123', 'id': 'package'}})
            self.assertEqual(result['warning'], '')
            self.assertEqual(len(result['files']), 1)
            self.assertEqual(Path(result['files'][0]).read_bytes(), b'[Script Info]\nDialogue: text')
            self.assertTrue(Path(result['archive']).is_file())
            self.assertEqual((Path(result['files'][0]).parent / 'font.ttf').read_bytes(), b'font')

    def test_rar_rejects_traversal_duplicates_and_size_before_native_tool(self):
        for files, limit in [([('../outside.ass', b'x')], s.MAX_EXPANDED),
                             ([('EP01.ass', b'a'), ('ep01.ass', b'b')], s.MAX_EXPANDED),
                             ([('EP01.ass', b'large')], 1)]:
            with self.subTest(files=files), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'pack.rar'
                archive.write_bytes(stored_rar(files))
                with patch.object(s, 'MAX_EXPANDED', limit), patch.object(s.subprocess, 'Popen') as native:
                    with self.assertRaises(ValueError):
                        s.unpack(archive, root / 'files')
                    native.assert_not_called()
                self.assertFalse((root.parent / 'outside.ass').exists())

    def test_rar_rejects_links_encryption_and_split_files(self):
        info = Mock(filename='EP01.ass', file_size=10, mode=stat.S_IFREG | 0o600,
                    file_redir=None, flags=0)
        info.is_file.return_value = True
        info.is_dir.return_value = False
        info.is_symlink.return_value = False
        for kind in ['link', 'password', 'split', 'device']:
            info.file_redir = (4, 0, 'target') if kind == 'link' else None
            info.flags = rarfile.RAR_FILE_SPLIT_AFTER if kind == 'split' else 0
            info.mode = stat.S_IFCHR if kind == 'device' else stat.S_IFREG | 0o600
            package = Mock()
            package.__enter__ = Mock(return_value=package)
            package.__exit__ = Mock(return_value=False)
            package.infolist.return_value = [info]
            package.volumelist.return_value = ['pack.rar']
            package.needs_password.return_value = kind == 'password'
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory, \
                    patch.object(rarfile, 'RarFile', return_value=package), \
                    patch.object(s.subprocess, 'Popen') as native:
                with self.assertRaises(ValueError):
                    s.unpack(Path('pack.rar'), Path(directory) / 'out')
                native.assert_not_called()

    def test_rar_failure_preserves_archive_and_discards_partial_extraction(self):
        raw = stored_rar([('EP01.ass', b'[Script Info]')])
        response = self.response({}, 200)
        response.iter_content.return_value = [raw]
        item = {'url': 'https://file0.assrt.net/package.rar', 'filename': 'subtitles.rar'}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(s, 'assrt_detail', return_value=({}, item)), \
                patch.object(s, 'request', return_value=response), \
                patch.object(s, 'rar_tool', side_effect=ValueError('未找到 RAR 解压工具')):
            result = s.download({'source': 'assrt', 'token': 'a' * 32, 'directory': directory,
                                 'file': {'entryId': '123', 'id': 'package'}})
            self.assertTrue(Path(result['archive']).is_file())
            self.assertFalse((Path(result['folder']) / 'files').exists())
            self.assertEqual(result['files'], [])
            self.assertIn('未找到 RAR 解压工具', result['warning'])

    def test_rar_checksum_corruption_is_rejected(self):
        try:
            s.rar_tool()
        except ValueError:
            self.skipTest('RAR integration requires Windows tar or bsdtar')
        original = stored_rar([('EP01.ass', b'[Script Info]')])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'pack.rar'
            archive.write_bytes(original.replace(b'[Script Info]', b'[Script Xnfo]'))
            with self.assertRaises(ValueError):
                s.unpack(archive, root / 'files')


class LocalSubtitlePackageTests(unittest.TestCase):
    def test_local_zip_copies_into_inbox_and_keeps_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'local.zip'
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr('nested/Show 01.ass', b'[Script Info]')
                package.writestr('fonts/font.ttf', b'font')
            original = archive.read_bytes()
            result = s.run({'action': 'extract-local', 'archive': str(archive), 'directory': str(root / 'inbox')})
            self.assertEqual(len(result['files']), 1)
            self.assertTrue((Path(result['folder']) / 'files/fonts/font.ttf').exists())
            self.assertEqual(archive.read_bytes(), original)
            self.assertNotEqual(Path(result['archive']), archive)
            s.shutil.rmtree(result['folder'])
            self.assertEqual(archive.read_bytes(), original)

    def test_local_7z_uses_existing_unpacker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subtitle = root / 'Show 01.ass'
            subtitle.write_bytes(b'[Script Info]')
            archive = root / 'local.7z'
            with py7zr.SevenZipFile(archive, 'w') as package:
                package.write(subtitle, 'Show 01.ass')
            result = s.extract_local({'archive': str(archive), 'directory': str(root / 'inbox')})
            self.assertEqual(Path(result['files'][0]).read_bytes(), subtitle.read_bytes())
            self.assertTrue(archive.exists())

    def test_local_unsafe_zip_keeps_archive_but_discards_partial_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr('../escape.ass', b'bad')
            result = s.extract_local({'archive': str(archive), 'directory': str(root / 'inbox')})
            self.assertEqual(result['files'], [])
            self.assertIn('未能解压', result['warning'])
            self.assertTrue(Path(result['archive']).exists() and archive.exists())
            self.assertFalse((Path(result['folder']) / 'files').exists())
            self.assertFalse((root / 'inbox' / 'escape.ass').exists())


if __name__ == '__main__':
    unittest.main()
