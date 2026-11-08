import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

import requests

from src.resource_search import dispatch, parse_feed, resolve, search_batch, torrent_info_hash, website_page
from src.resource_ext import check_page, search_document, handle


class ResourceSearchTests(unittest.TestCase):
    def test_mikan_rss_prefers_origin_and_rewrites_fallback_links(self):
        h = 'a' * 40
        xml = f'<rss><channel><item><title>Release</title><link>http://mikanani.me/Home/Episode/{h}</link><enclosure url="https://mikanani.me/Download/{h}.torrent"/></item></channel></rss>'
        for failure in (None, requests.Timeout('timeout'), requests.HTTPError('503'), b'<html>unavailable</html>'):
            with self.subTest(failure=failure):
                responses = [xml] if failure is None else [failure, xml]
                with patch('src.resource_search.fetch', side_effect=responses) as fetch:
                    result = search_batch('mikan', 'test', None)
                origin = 'https://mikanani.me' if failure is None else 'https://mikan.sakuramoe.dev'
                self.assertEqual(fetch.call_args_list[0].args[0], 'https://mikanani.me/RSS/Search')
                self.assertEqual(fetch.call_count, len(responses))
                self.assertEqual(result['rows'][0]['page'], origin + '/Home/Episode/' + h)
                self.assertEqual(result['rows'][0]['torrent'], origin + '/Download/' + h + '.torrent')

    def test_mikan_empty_results_do_not_trigger_mirror(self):
        for action, body in [('search', '<rss><channel/></rss>'), ('mikan-web', '<p>找不到对应结果</p>')]:
            responses = [body, '<p>找不到对应结果</p>'] if action == 'search' else [body]
            with patch('src.resource_search.fetch', side_effect=responses) as fetch:
                self.assertEqual(dispatch(dict(action=action, source='mikan', query='none')), {'rows': [], 'next': None})
            self.assertEqual(fetch.call_count, 1 if action == 'mikan-web' else 2)
            self.assertTrue(all(call.args[0].startswith('https://mikanani.me/') for call in fetch.call_args_list))

    def test_mikan_web_falls_back_on_invalid_page(self):
        h = 'b' * 40
        html = f'<tr class="js-search-results-row"><td><a href="/Home/Episode/{h}">Release</a><a href="/Download/{h}.torrent">Download</a></td><td>Group</td><td>1 GB</td><td>today</td></tr>'
        with patch('src.resource_search.fetch', side_effect=['<title>Unavailable</title>', html]) as fetch:
            result = website_page('mikan', 'test', 1)
        self.assertEqual([call.args[0] for call in fetch.call_args_list], [
            'https://mikanani.me/Home/Search', 'https://mikan.sakuramoe.dev/Home/Search'])
        self.assertTrue(result['rows'][0]['page'].startswith('https://mikan.sakuramoe.dev/'))

    def test_mikan_torrent_fallback_preserves_path_and_hash_checks(self):
        info = b'd6:lengthi12e4:name4:teste'
        h = hashlib.sha1(info).hexdigest()
        torrent = b'd4:info' + info + b'e'
        row = dict(source='mikan', torrent='https://mikan.sakuramoe.dev/Download/test.torrent?q=1', hash=h)
        for failure in (requests.exceptions.SSLError('EOF'), b'invalid torrent'):
            with patch('src.resource_search.fetch', side_effect=[failure, torrent]) as fetch:
                self.assertEqual(dispatch(dict(action='files', row=row))['files'][0]['path'], 'test')
            self.assertEqual([call.args[0] for call in fetch.call_args_list], [
                'https://mikanani.me/Download/test.torrent?q=1',
                'https://mikan.sakuramoe.dev/Download/test.torrent?q=1'])
        with patch('src.resource_search.fetch') as fetch, self.assertRaisesRegex(ValueError, '来源站'):
            dispatch(dict(action='files', row=dict(row, torrent='https://example.org/test.torrent')))
        fetch.assert_not_called()

    def test_mikan_reports_failure_when_both_hosts_fail(self):
        with patch('src.resource_search.fetch', side_effect=[requests.Timeout('origin'), requests.Timeout('mirror')]) as fetch:
            with self.assertRaisesRegex(requests.Timeout, 'mirror'):
                search_batch('mikan', 'test', None)
        self.assertEqual(fetch.call_count, 2)

    def test_mikan_web_results_are_returned_in_bounded_batches(self):
        items = []
        for index in range(245):
            h = f'{index:040x}'
            items.append(f'''<tr class="js-search-results-row"><td>
                <a href="/Home/Episode/{h}">Release {index}</a>
                <a href="/Download/{h}.torrent">Download</a></td>
                <td>Group</td><td>1 GB</td><td>2026/11/07</td></tr>''')
        html = '<table>' + ''.join(items) + '</table>'
        batches = []
        with patch('src.resource_search.fetch', return_value=html):
            for page in range(1, 5):
                batches.append(website_page('mikan', '高达', page))
            full = dispatch(dict(action='mikan-web', source='mikan', query='高达'))
        self.assertEqual(len(full['rows']), 245)
        self.assertIsNone(full['next'])
        self.assertEqual([len(batch['rows']) for batch in batches], [100, 100, 45, 0])
        self.assertEqual([batch['next'] for batch in batches], [2, 3, None, None])
        titles = [row['title'] for batch in batches for row in batch['rows']]
        self.assertEqual(titles, [f'Release {index}' for index in range(245)])

    def test_knaben_returns_normalized_hashes_magnets_and_pagination(self):
        info_hash = '472f3cee48ea1ec5af989241738d9fbb7f452af6'
        hit = dict(title='Release', hash='I4XTZ3SI5IPMLL4YSJAXHDM7XN7UKKXW',
                   bytes=12345, seeders=3, date='2026-08-21T00:00:00Z', tracker='Nyaa.si')
        payload = dict(hits=[hit]*50, total=dict(value=101, relation='eq'))
        with patch('src.resource_search.fetch', return_value=json.dumps(payload).encode()) as fetch:
            batch = search_batch('knaben', 'Arcane', 50)
        fetch.assert_called_once_with('https://api.knaben.org/v2/search', params={
            'q':'Arcane', 's':50, 'f':50, 'o':'date', 'd':'desc', 'dead':''})
        row = batch['rows'][0]
        self.assertEqual(row['hash'], info_hash)
        self.assertEqual(row['source'], 'knaben')
        self.assertEqual(row['origin'], 'Nyaa.si')
        self.assertEqual(urlparse(row['page']).hostname, 'knaben.org')
        self.assertEqual(batch['next'], 100)
        with patch('src.resource_search.fetch') as fetch:
            resolved = resolve(row, None)
        fetch.assert_not_called()
        self.assertTrue(resolved['magnet'].startswith('magnet:?xt=urn:btih:'+info_hash))

    def test_knaben_skips_missing_and_conflicting_hashes_and_keeps_empty_page_cursor(self):
        payload = dict(hits=[dict(title='Unknown', hash=None)]*50, total=dict(value=60, relation='eq'))
        with patch('src.resource_search.fetch', return_value=json.dumps(payload).encode()):
            batch = search_batch('knaben', 'Arcane', None)
        self.assertEqual(batch, {'rows':[], 'next':50})
        hits = [dict(title='Wrong',hash='a'*40,magnetUrl='magnet:?xt=urn:btih:'+'b'*40),
                dict(title='Valid',hash=None,magnetUrl='magnet:?xt=urn:btih:'+'c'*40)]
        with patch('src.resource_search.fetch', return_value=json.dumps(dict(hits=hits,total=dict(value=2,relation='eq'))).encode()):
            batch = search_batch('knaben', 'Arcane', None)
        self.assertEqual([r['title'] for r in batch['rows']], ['Valid'])
        self.assertIsNone(batch['next'])

    def test_ext_search_requests_one_unfiltered_page(self):
        html = '''<table><tr><td><a class="torrent-title-link" href="/release-123/">Release</a>
            <span class="related-posted"><a href="/games/">Games</a></span></td>
            <td>1 GB</td><td>1</td><td>today</td><td>10</td></tr></table>
            <a href="/browse/?q=Arcane&amp;page=3">Next</a>'''
        response = Mock()
        response.json.return_value = {'status': 'ok', 'solution': {'status': 200, 'response': html}}
        for cursor, number in [(None, 1), ({'all': 2}, 2), ({'anime': 2, 'all': 2}, 2)]:
            with self.subTest(cursor=cursor), patch('src.resource_ext.requests.post', return_value=response) as post:
                batch = handle(dict(action='search', query='Arcane', port=1234, cursor=cursor))
                post.assert_called_once()
                query = parse_qs(urlparse(post.call_args.kwargs['json']['url']).query)
                self.assertNotIn('cat', query)
                self.assertEqual(query['page'], [str(number)])
                self.assertEqual([row['title'] for row in batch['rows']], ['Release'])
                self.assertEqual(batch['next'], {'all': 3} if number == 2 else None)

    def test_dmhy_falls_back_to_rss_on_first_and_later_pages(self):
        xml = '<rss><channel><item><category>季度全集</category><title>合集</title><link>https://share.dmhy.org/topics/view/1</link></item></channel></rss>'
        for cursor in (None, 2):
            with patch('src.resource_search.website_page', side_effect=ValueError('网页不可用')), patch('src.resource_search.fetch', return_value=xml) as fetch:
                batch = search_batch('dmhy', 'arcane', cursor)
                self.assertEqual([row['title'] for row in batch['rows']], ['合集'])
                self.assertIsNone(batch['next'])
                fetch.assert_called_once_with('https://share.dmhy.org/topics/rss/rss.xml', params={'keyword':'arcane','sort_id':'2'})

    def test_ext_separates_challenges_and_unknown_pages_from_empty_searches(self):
        with self.assertRaisesRegex(ValueError, '站点验证'):
            check_page(dict(status=200, response='<title>请稍候…</title><script>window._cf_chl_opt={}</script>'))
        with self.assertRaisesRegex(ValueError, '搜索页'):
            search_document('<html>Unavailable</html>')
        empty = search_document('<div class="nothing-found-title">No results found</div>')
        self.assertEqual(empty.select('a.torrent-title-link'), [])

    def test_animation_categories_and_base32_hash(self):
        def item(category):
            return f'<item><title>Release</title><category>{category}</category><link>https://share.dmhy.org/1</link><enclosure url="magnet:?xt=urn:btih:I4XTZ3SI5IPMLL4YSJAXHDM7XN7UKKXW"/></item>'
        xml = '<rss><channel>' + ''.join(item(c) for c in ['動畫', '季度全集', '音樂']) + '</channel></rss>'
        rows = parse_feed('dmhy', xml)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['hash'], '472f3cee48ea1ec5af989241738d9fbb7f452af6')

    def test_preview_lists_nested_paths_and_sizes_without_saving(self):
        info = b'd4:name4:Show5:filesld6:lengthi12e4:pathl3:sub6:01.mkveed6:lengthi0e4:pathl7:log.txteeee'
        row = dict(source='mikan', hash=hashlib.sha1(info).hexdigest(), torrent='https://mikan.sakuramoe.dev/test.torrent')
        with patch('src.resource_search.fetch', return_value=b'd4:info'+info+b'e'):
            self.assertEqual(dispatch(dict(action='files', row=row)), {'size': 12, 'files': [
                {'path': 'Show/sub/01.mkv', 'size': 12}, {'path': 'Show/log.txt', 'size': 0}]})
            with self.assertRaisesRegex(ValueError, '哈希'):
                dispatch(dict(action='files', row=dict(row, hash='a'*40)))

    def test_torrent_reuse_and_reject_changed_metadata(self):
        info = b'd4:name4:teste'
        torrent = b'd8:announce4:test4:info' + info + b'e'
        h = hashlib.sha1(info).hexdigest()
        self.assertEqual(torrent_info_hash(torrent), h)
        row = dict(source='mikan', torrent='https://mikan.sakuramoe.dev/test.torrent', hash=h, title='test', magnet='')
        with tempfile.TemporaryDirectory() as root, patch('src.resource_search.fetch', return_value=torrent):
            for _ in range(2):
                self.assertEqual(Path(resolve(row, root)['file']).read_bytes(), torrent)
            self.assertEqual(len(list(Path(root).iterdir())), 1)
            with self.assertRaisesRegex(ValueError, '哈希'):
                resolve(dict(row, hash='a'*40), root)

    def test_no_category_required_on_unfiltered_sources(self):
        xml = '<rss><channel><item><title>Release</title><link>https://mikan.sakuramoe.dev/1</link><comments>https://anibt.net/release/1</comments></item></channel></rss>'
        for source in ('mikan', 'anibt'):
            self.assertEqual(len(parse_feed(source, xml)), 1)
        self.assertEqual(parse_feed('nyaa', xml), [])
