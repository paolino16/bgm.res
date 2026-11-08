import re
import copy
import requests
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from urllib.parse import quote
from typing import Any, Dict, List, Optional

import tmdbsimple as tmdb

from ..logger import logger
from ..config.config_manager import cm
from .cleaner import is_chinese_percentage_sufficient
from .metadata_http import METADATA_TIMEOUT, metadata_session, MetadataRequestError
from . import title_cache
from .title_evidence import match_entries, reading, clean_evidence
from ..utils.title_matching import identity_suffix, normalize_title, title_score, season_hint, candidate_season, title_parts


class Search:
    BANGUMI_API_BASE = 'https://api.bgm.tv'
    BANGUMI_HEADERS = {
        'Content-Type': 'application/json',
        'User-Agent': 'Bangumi-Auto-Rename/1.0',
    }

    def __init__(self) -> None:
        self.TMDB_KEY = cm.get_config('api_key')
        tmdb.API_KEY = self.TMDB_KEY
        self.last_error = None
        self.network_error = None
        self.defer_episodes = False
        self.requested_season = None
        self.requested_platforms = None
        self.last_bangumi_candidates = []
        self.recall_warnings = []
        self._bangumi_search_details = {}

    def _tmdb(self, resource):
        self.last_error = None
        resource.session = metadata_session()
        resource.timeout = METADATA_TIMEOUT
        return resource

    def _normalize_title(self, text: Any) -> str:
        return normalize_title(text)

    def _extract_year(self, date_text: Any) -> int:
        date_str = str(date_text or '')
        if re.match(r'^\d{4}', date_str):
            return int(date_str[:4])
        return 0

    def _score_search_result(
        self,
        result: Dict[str, Any],
        query: str,
        year: int,
    ) -> tuple:
        relevance = title_score([result.get(key) for key in ('name', 'original_name', 'title', 'original_title')],
                                query, year=year, date=result.get('first_air_date') or result.get('release_date'),
                                requested_season=self.requested_season)
        vote_count = int(result.get('vote_count') or 0)
        popularity = float(result.get('popularity') or 0)

        return (
            *relevance,
            vote_count,
            popularity,
        )

    def _pick_best_result(
        self,
        results: List[Dict[str, Any]],
        query: str,
        year: int,
    ) -> Optional[Dict[str, Any]]:
        if not results:
            return None
        candidates = [item for item in results if self._score_search_result(item, query, year)[0] >= 2]
        return sorted(
            candidates,
            key=lambda item: self._score_search_result(item, query, year),
            reverse=True,
        )[0] if candidates else None

    def _is_animation_info(self, info: Optional[Dict[str, Any]]) -> bool:
        if not info:
            return False
        for genre in info.get('genres', []):
            genre_name = str(genre.get('name', '')).lower()
            if genre_name in {'animation', 'anime'}:
                return True
        return False

    def _extract_bangumi_platform(self, subject: Dict[str, Any]) -> str:
        platform = str(subject.get('platform') or '').strip()
        if platform:
            return platform

        infobox = subject.get('infobox')
        if isinstance(infobox, list):
            for item in infobox:
                key = str(item.get('key') or '').strip().lower()
                if key in {'放送形式', '播放形式', '平台', '媒介'}:
                    value = item.get('value')
                    if isinstance(value, list) and value:
                        first_value = value[0]
                        if isinstance(first_value, dict):
                            extracted = str(first_value.get('v') or '').strip()
                        else:
                            extracted = str(first_value).strip()
                    else:
                        extracted = str(value or '').strip()
                    if extracted:
                        return extracted
        return 'TV'

    def is_bangumi_movie_info(self, info: Optional[Dict[str, Any]]) -> bool:
        if not info:
            return False
        platform = str(info.get('platform') or '').strip().upper()
        if platform == 'OVA':
            count = info.get('episodes_total') or info.get('eps') or info.get('total_episodes') or 0
            try:
                return int(count) <= 1
            except (TypeError, ValueError):
                return True
        return platform in {'OVA', '剧场版', 'MOVIE', '电影'}

    def _bangumi_request(
        self,
        endpoint: str,
        method: str = 'GET',
        payload: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        self.last_error = None
        try:
            response = metadata_session().request(
                method, f'{self.BANGUMI_API_BASE}{endpoint}',
                json=payload, headers=self.BANGUMI_HEADERS,
            )
            return response.json()
        except Exception as exc:
            self.last_error = f'[Bangumi] {exc}'
            if isinstance(exc, MetadataRequestError) and 'HTTP 404' not in str(exc):
                self.network_error = self.last_error
            logger.warning(self.last_error)
            return None

    def _subject_details(self, ids):
        """Bounded I/O parallelism; worker errors never race on this Search."""
        def fetch(subject_id):
            worker = copy.copy(self)
            worker.last_error = worker.network_error = None
            return subject_id, worker.get_bangumi_subject_by_id(subject_id), worker.last_error, worker.network_error
        if len(ids) < 2:
            results = [fetch(sid) for sid in ids]
        else:
            with ThreadPoolExecutor(max_workers=3, thread_name_prefix='bgm-candidate') as pool:
                futures = [pool.submit(copy_context().run, fetch, sid) for sid in ids]
                results = [future.result() for future in futures]
        details = {}
        for sid, detail, error, network_error in results:
            if detail:
                details[sid] = detail
            if error:
                self.last_error = error
            if network_error:
                self.network_error = network_error
        return details

    def _score_bangumi_subject(
        self,
        subject: Dict[str, Any],
        query: str,
        year: int,
    ) -> tuple:
        relevance = title_score(self._bangumi_titles(subject), query, year=year,
                                date=subject.get('date') or subject.get('air_date'),
                                requested_season=self.requested_season)
        rating = subject.get('rating') if isinstance(subject.get('rating'), dict) else {}
        rank = int(subject.get('rank') or rating.get('rank') or 999999)
        score = float(subject.get('score') or rating.get('score') or 0)
        evidence = subject.get('recall_evidence') or []
        native = dict(subject, aliases=[])
        native_match = title_score(self._bangumi_titles(native), query)[0] >= 2
        trusted = native_match or any(e.get('verified', False)
                    and title_score([e.get('title'), e.get('english')], query)[0] >= 2 for e in evidence)
        reliability = 2 if not evidence or trusted else 1
        mapping_score = max((e.get('match_score', 0) for e in evidence if e.get('source') == 'tenrai'
                             and e.get('verified') and title_score([e.get('title'), e.get('english')], query)[0] >= 2), default=0)

        return (
            relevance[0], reliability,
            int(any(unicodedata.normalize('NFKC', t).casefold().strip() == unicodedata.normalize('NFKC', query).casefold().strip()
                    for t in self._bangumi_titles(subject))),
            mapping_score,
            *relevance[1:],
            -rank,
            score,
        )

    def _bangumi_titles(self, subject):
        titles = [subject.get('name'), subject.get('name_cn')]
        aliases = subject.get('aliases') or []
        if isinstance(aliases, str):
            aliases = [aliases]
        titles.extend(alias for alias in aliases if isinstance(alias, str))
        for item in subject.get('infobox') or []:
            if not isinstance(item, dict) or item.get('key') != '别名':
                continue
            values = item.get('value') or []
            if not isinstance(values, list):
                values = [values]
            for value in values:
                alias = value.get('v') if isinstance(value, dict) else value
                if isinstance(alias, str):
                    titles.append(alias)
        return [title for title in titles if title]

    def _remember_bangumi_candidates(self, results):
        previous = {int(item['id']): item for item in self.last_bangumi_candidates}
        current = []
        for item in results:
            if not item.get('id') or any(int(c['id']) == int(item['id']) for c in current):
                continue
            candidate = {
                'id': item['id'],
                'name': item.get('name') or '',
                'name_cn': item.get('name_cn') or '',
                'date': item.get('date') or item.get('air_date') or '',
                'season': candidate_season(self._bangumi_titles(item)) or 1,
            }
            if item.get('recall_evidence'):
                candidate['recall_evidence'] = clean_evidence(item['recall_evidence'])
            current.append(candidate)
            previous.pop(int(item['id']), None)
        self.last_bangumi_candidates = current + list(previous.values())

    def _tenrai_request(self, query):
        cached = title_cache.read('tenrai', query.casefold().strip(), 7 * 86400)
        if isinstance(cached, list):
            return cached
        try:
            response = metadata_session().get('https://api.tenrai.org/v1/anime',
                params={'q': query, 'limit': 10}, timeout=(3.05, 5))
            response.raise_for_status()
            result = response.json()
            entries = result.get('data', []) if isinstance(result, dict) else []
            if isinstance(entries, list) and entries:
                title_cache.write('tenrai', query.casefold().strip(), entries)
            return entries
        except (MetadataRequestError, requests.RequestException, ValueError, OSError) as exc:
            self.recall_warnings.append('Tenrai 补充搜索失败：' + str(exc))
            return []

    def _tenrai_recall(self, query, year):
        """Use MAL names for recall; add aliases only after independent cross-checks."""
        self._rejected_tenrai_ids = set()
        entries = self._tenrai_request(query)
        if not isinstance(entries, list):
            return []
        entries = [entry for entry in entries if isinstance(entry, dict) and entry.get('title_japanese')]
        entries.sort(key=lambda e: title_score([e.get('title'), e.get('title_english')], query), reverse=True)
        recalled = {}
        queried = {}
        retries = {}
        for entry in entries[:3]:
            japanese = entry['title_japanese']
            if japanese not in queried:
                result = self._bangumi_request('/v0/search/subjects?limit=30', 'POST',
                    {'keyword': japanese, 'sort': 'match', 'filter': {'type': [2]}})
                queried[japanese] = result.get('data', []) if isinstance(result, dict) else []
            for raw in queried[japanese]:
                if not isinstance(raw, dict) or not raw.get('id'):
                    continue
                item = dict(raw)
                scored = match_entries(item, entries)
                matched_entry, match_score = scored[0] if scored else (entry, 0)
                # 7.5 is a retry threshold, not an acceptance/identity threshold.
                # Bound independent native-title retries to preserve the shared
                # interactive network budget. Irrelevant seed hits are discarded.
                native = item.get('name') or ''
                if 2.5 <= match_score < 7.5 and native:
                    if native not in retries and len(retries) < 3:
                        extra_entries = self._tenrai_request(native)
                        retries[native] = extra_entries if isinstance(extra_entries, list) else []
                    expanded = [e for e in retries.get(native, []) if isinstance(e, dict) and e.get('title_japanese')]
                    rescored = match_entries(item, expanded)
                    if rescored and rescored[0][1] > match_score:
                        matched_entry, match_score = rescored[0]
                if match_score < 2.5:
                    self._rejected_tenrai_ids.add(int(item['id']))
                    continue
                evidence = {'source': 'tenrai', 'mal_id': matched_entry.get('mal_id'),
                            'title': matched_entry.get('title'), 'japanese': matched_entry.get('title_japanese'),
                            'english': matched_entry.get('title_english'),
                            'verified': True, 'match_score': round(match_score, 4)}
                item['recall_evidence'] = [evidence]
                item['aliases'] = list(dict.fromkeys([*(item.get('aliases') or []),
                    *[t for t in (matched_entry.get('title'), matched_entry.get('title_english')) if t]]))
                sid = int(item['id'])
                previous = recalled.get(sid)
                if previous and previous['recall_evidence'][0]['match_score'] >= match_score:
                    continue
                recalled[sid] = item
        best_mapping = {}
        for item in recalled.values():
            evidence = item['recall_evidence'][0]
            key = evidence.get('mal_id')
            best_mapping[key] = max(best_mapping.get(key, 0), evidence['match_score'])
        recalled = {sid: item for sid, item in recalled.items()
                    if item['recall_evidence'][0]['match_score'] == best_mapping[item['recall_evidence'][0].get('mal_id')]}
        for item in recalled.values():
            self._rejected_tenrai_ids.discard(int(item['id']))
            title_cache.write('mapping', item['id'], {
                'name': item.get('name'), 'date': item.get('date'),
                'aliases': item['aliases'], 'recall_evidence': item['recall_evidence']})
        return list(recalled.values())

    def _special_intent_matches(self, subject, query):
        titles = self._bangumi_titles(subject)
        special = title_parts(query)[2]
        return (special == any(title_parts(title)[2] for title in titles)
                or any(title_parts(title)[2] == special and title_score([title], query)[0] == 5
                       for title in titles))

    def _bangumi_compatible(self, subject, query, year):
        titles = self._bangumi_titles(subject)
        exact_original = (unicodedata.normalize('NFKC', str(subject.get('name') or '')).casefold().strip()
                          == unicodedata.normalize('NFKC', query).casefold().strip())
        if title_score(titles, query)[0] < 2:
            return False
        if not exact_original and not self._special_intent_matches(subject, query):
            return False
        if self.requested_platforms:
            platform = self._extract_bangumi_platform(subject).upper()
            if platform not in self.requested_platforms:
                return False
        if identity_suffix(query) and not any(identity_suffix(t) == identity_suffix(query) for t in titles):
            return False
        verified_native = any(e.get('verified') and e.get('match_score', 0) >= 7.5
                              and title_score([e.get('title'), e.get('english')], query)[0] == 5
                              for e in subject.get('recall_evidence', []))
        requested = season_hint(query)
        if requested is None:
            requested = self.requested_season
        season = candidate_season(titles)
        if requested is not None:
            return (season if season is not None else 1) == requested
        # An explicit year can intentionally select a sequel; popularity alone cannot.
        return verified_native or exact_original or any(str(t).casefold().strip() == query.casefold().strip() for t in titles) or season is None or season <= 1 or bool(year and self._extract_year(subject.get('date') or subject.get('air_date')) == year)

    def _build_bangumi_info(
        self,
        subject: Dict[str, Any],
        episodes: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        display_name = str(subject.get('name_cn') or subject.get('name') or '').strip()
        original_name = str(subject.get('name') or display_name).strip()
        air_date = str(subject.get('date') or '')
        raw_eps = [
            episode for episode in (episodes or [])
            if int(episode.get('type', 0) or 0) == 0
        ]
        episode_count = len(raw_eps) or int(subject.get('eps') or subject.get('eps_count') or 0)
        season_number = 1
        platform = self._extract_bangumi_platform(subject)
        formatted_eps = []
        for episode in raw_eps:
            ep_number = int(episode.get('ep') or episode.get('sort') or 0)
            if ep_number <= 0:
                continue
            formatted_eps.append(
                {
                    'air_date': episode.get('airdate'),
                    'episode_number': ep_number,
                    'episode_type': 'regular',
                    'name': episode.get('name_cn') or episode.get('name') or '',
                    'overview': episode.get('desc', ''),
                    'runtime': episode.get('duration'),
                    'season_number': season_number,
                }
            )

        return {
            'id': subject.get('id'),
            'name': display_name,
            'original_name': original_name,
            'name_cn': str(subject.get('name_cn') or ''),
            'first_air_date': air_date,
            'release_date': air_date,
            'genres': [{'name': 'Animation'}],
            'titles': [
                {'type': 'Default', 'title': display_name},
                {'type': 'Synonym', 'title': original_name},
            ],
            'seasons': [
                {
                    'season_number': season_number,
                    'name': display_name or original_name,
                    'episode_count': episode_count,
                    'episodes': formatted_eps,
                }
            ],
            'episodes_total': episode_count,
            'platform': platform,
            'is_movie': self.is_bangumi_movie_info({'platform': platform, 'episodes_total': episode_count}),
            'source': 'bgm',
            'source_id': subject.get('id'),
        }

    def get_bangumi_subject_by_id(
        self,
        bgm_id: int,
    ) -> Optional[Dict[str, Any]]:
        response = self._bangumi_request(f'/v0/subjects/{bgm_id}')
        return response if isinstance(response, dict) else None

    def get_bangumi_episodes(
        self,
        bgm_id: int,
    ) -> List[Dict[str, Any]]:
        response = self._bangumi_request(
            f'/v0/episodes?subject_id={bgm_id}&type=0&limit=200'
        )
        if not isinstance(response, dict):
            return []
        data = response.get('data', [])
        return data if isinstance(data, list) else []

    def get_bangumi_all_episodes(self, bgm_id):
        """Fetch every chapter type and page; never use a partial catalog."""
        episodes, seen = [], set()
        offset = 0
        while True:
            response = self._bangumi_request(
                f'/v0/episodes?subject_id={int(bgm_id)}&limit=100&offset={offset}'
            )
            if not isinstance(response, dict) or not isinstance(response.get('data'), list):
                return None
            page = response['data']
            for episode in page:
                if not isinstance(episode, dict) or not episode.get('id') or episode['id'] in seen:
                    self.last_error = '[Bangumi] 章节分页数据不完整或重复，请重试'
                    return None
                seen.add(episode['id'])
                episodes.append({
                    'id': episode['id'], 'subject_id': int(bgm_id),
                    'type': int(episode.get('type', 0)), 'sort': episode.get('sort'),
                    'ep': episode.get('ep'), 'name': episode.get('name_cn') or episode.get('name') or '',
                })
            offset += len(page)
            total = response.get('total')
            if total is not None and offset >= int(total):
                return episodes
            if not page:
                if total is not None and offset < int(total):
                    self.last_error = '[Bangumi] 章节分页提前结束，请重试'
                    return None
                return episodes
            if total is None and len(page) < 100:
                return episodes

    def get_bangumi_relations(self, bgm_id):
        result = self._bangumi_request(f'/v0/subjects/{int(bgm_id)}/subjects')
        return result if isinstance(result, list) else []

    def get_bangumi_info(
        self,
        query: str,
        year: int,
        bgm_id: Optional[int] = None,
    ) -> tuple[str, Optional[Dict[str, Any]]]:
        self.network_error = None
        subject: Optional[Dict[str, Any]] = None
        if bgm_id is not None:
            subject = self.get_bangumi_subject_by_id(bgm_id)
            if subject:
                logger.info(f'[Bangumi] 通过 bgm_id 获取成功: {bgm_id}')
        else:
            results = self.search_bangumi_subjects(query, year)
            self._remember_bangumi_candidates(results)
            results = [item for item in results if self._bangumi_compatible(item, query, year)]
            # A partial title or tied top matches are suggestions, not identity.
            results.sort(key=lambda item: self._score_bangumi_subject(item, query, year), reverse=True)
            confident = bool(results and title_score(self._bangumi_titles(results[0]), query)[0] == 5)
            if confident:
                top = results[0]
                native = dict(top, aliases=[])
                if (top.get('recall_evidence') and title_score(self._bangumi_titles(native), query)[0] < 5
                    and not any(e.get('verified', False) and title_score([e.get('title'), e.get('english')], query)[0] >= 2 for e in top['recall_evidence'])):
                    confident = False
                # Special markers are identity evidence even when removed for
                # lexical matching (Nichijou versus Nichijou OAD, for example).
                if not self._special_intent_matches(top, query) and unicodedata.normalize('NFKC', query).casefold().strip() != unicodedata.normalize('NFKC', str(top.get('name') or '')).casefold().strip():
                    confident = False
                if year and not str(top.get('date') or '').startswith(str(year)):
                    confident = False
            if len(results) > 1 and self._score_bangumi_subject(results[0], query, year)[:-2] == self._score_bangumi_subject(results[1], query, year)[:-2]:
                confident = False
            if confident:
                subject = sorted(
                    results,
                    key=lambda item: self._score_bangumi_subject(item, query, year),
                    reverse=True,
                )[0]
                detail = (self._bangumi_search_details.get(int(subject['id']))
                          or self.get_bangumi_subject_by_id(int(subject['id'])))
                subject = detail
            elif not self.last_error or (not self.network_error and 'HTTP 404' in self.last_error):
                self.last_error = '[Bangumi] 无法唯一确认作品，请补充原名、季号、年份或指定 BGM ID'
                if self.last_bangumi_candidates:
                    self.last_error += '；可在「编辑任务」中查看并选择候选条目'

        if not subject:
            return '', None

        episodes = [] if self.defer_episodes else self.get_bangumi_episodes(int(subject.get('id')))
        info = self._build_bangumi_info(subject, episodes)
        return info['name'], info

    def get_tv_info_by_id(
        self,
        tmdb_id: int,
    ) -> tuple[str, Optional[Dict[str, Any]]]:
        try:
            tv = self._tmdb(tmdb.TV(tmdb_id))
            info = tv.info(language='zh-CN')
            logger.info(f'[TMDB] 通过 TV ID 获取成功: {tmdb_id}')
            return info.get('name', ''), info
        except Exception as e:
            self.last_error = str(e)
            logger.warning(f'[TMDB] 通过 TV ID 获取失败 {tmdb_id}: {e}')
            return '', None

    def get_movie_info_by_id(
        self,
        tmdb_id: int,
    ) -> tuple[str, Optional[Dict[str, Any]]]:
        try:
            movie = self._tmdb(tmdb.Movies(tmdb_id))
            info = movie.info(language='zh-CN')
            logger.info(f'[TMDB] 通过 Movie ID 获取成功: {tmdb_id}')
            return info.get('title', ''), info
        except Exception as e:
            self.last_error = str(e)
            logger.warning(f'[TMDB] 通过 Movie ID 获取失败 {tmdb_id}: {e}')
            return '', None

    def _search_tv_once(
        self,
        query: str,
        year: int,
        anime_only: bool = False,
    ) -> tuple[str, Optional[Dict[str, Any]]]:
        search = self._tmdb(tmdb.Search())
        search.tv(
            query=query,
            language='zh-CN',
            first_air_date_year=year if year != 0 else None,
        )
        target_list = search.__dict__['results']
        if target_list:
            ranked_results = sorted(
                target_list,
                key=lambda item: self._score_search_result(item, query, year),
                reverse=True,
            )
            for target in ranked_results[:5]:
                if self._score_search_result(target, query, year)[0] < 2:
                    continue
                tv = self._tmdb(tmdb.TV(target['id']))
                info = tv.info(language='zh-CN')
                logger.debug(str(tv.__dict__))
                if anime_only and not self._is_animation_info(info):
                    continue
                return target['name'], info
        return '', None

    def search_bangumi_subjects(
        self,
        query: str,
        year: int = 0,
    ) -> List[Dict[str, Any]]:
        payload = {
            'keyword': query,
            'sort': 'match',
            'filter': {'type': [2]},
        }
        self._bangumi_search_details = {}
        if not title_parts(query)[0]:
            return []
        result = self._bangumi_request('/v0/search/subjects?limit=30', 'POST', payload)
        if not isinstance(result, dict):
            result = {}

        data = result.get('data', [])
        if not isinstance(data, list):
            data = []
        data = [item for item in data if isinstance(item, dict)]
        native_prefix = re.match(r'[\u3040-\u30ff\u3400-\u9fff]{4,}', query)
        if (native_prefix and len(native_prefix[0]) < len(query)
                and not any(self._bangumi_compatible(item, query, year)
                            and title_score(self._bangumi_titles(item), query)[0] == 5 for item in data)):
            expanded = self._bangumi_request('/v0/search/subjects?limit=30', 'POST',
                                             {**payload, 'keyword': native_prefix[0]})
            if isinstance(expanded, dict):
                known = {item.get('id') for item in data}
                data.extend(item for item in expanded.get('data', []) if isinstance(item, dict)
                            and item.get('id') and item['id'] not in known)
        # Some indexes accept the series name but do not understand release Sxx syntax.
        series_query = re.sub(r'(?i)\s+S\d{1,2}\b', '', query).strip()
        if (series_query != query and not self.network_error
                and not any(self._bangumi_compatible(item, query, year) for item in data)):
            extra = self._bangumi_request('/v0/search/subjects?limit=30', 'POST',
                                         {**payload, 'keyword': series_query})
            known = {item.get('id') for item in data}
            if isinstance(extra, dict):
                data.extend(item for item in extra.get('data', []) if isinstance(item, dict)
                            and item.get('id') and item['id'] not in known)
        for item in data:
            cached = title_cache.read('mapping', item.get('id'), 30 * 86400)
            if (isinstance(cached, dict) and cached.get('name') == item.get('name')
                    and cached.get('date') == item.get('date')):
                item['aliases'] = list(dict.fromkeys([*(item.get('aliases') or []), *cached.get('aliases', [])]))
                item['recall_evidence'] = cached.get('recall_evidence', [])
        # Preserve API relevance order when choosing which details to fetch.
        # Most searches match directly; romanized queries need infobox aliases.
        detail_error = None
        needed = [int(item['id']) for item in data[:5] if item.get('id') and
                  (title_score(self._bangumi_titles(item), query)[0] < 2
                   or (self.requested_platforms and not item.get('platform')))]
        details = self._subject_details(list(dict.fromkeys(needed)))
        if re.search(r'(?i)\b(?:OVA|OAD)\b', query) and not self.network_error:
            seed = next((item for item in data[:5] if item.get('id')
                         and title_score(self._bangumi_titles(item), query)[0] >= 2), None)
            if seed and not any(self._bangumi_compatible(item, query, year)
                                and title_score(self._bangumi_titles(item), query)[0] == 5 for item in data):
                known = {item.get('id') for item in data}
                linked = [item for item in self.get_bangumi_relations(seed['id'])
                          if item.get('type') == 2 and item.get('relation') in {'番外篇', '前传'}
                          and item.get('id') not in known]
                for item in linked:
                    detail = self.get_bangumi_subject_by_id(item['id'])
                    if detail and self._extract_bangumi_platform(detail).upper() in {'OVA', 'OAD'}:
                        data.append(detail)
        for index, item in enumerate(data[:5]):
            needs_platform = self.requested_platforms and not item.get('platform')
            if (title_score(self._bangumi_titles(item), query)[0] >= 2 and not needs_platform) or not item.get('id'):
                continue
            detail = details.get(int(item['id']))
            if detail and detail.get('id') == item['id']:
                data[index] = {**item, **detail}
                self._bangumi_search_details[int(item['id'])] = data[index]
            elif self.last_error:
                detail_error = self.last_error
        if self.network_error and not any(self._bangumi_compatible(item, query, year) for item in data):
            self.last_error = self.network_error
            self._remember_bangumi_candidates(data)
            return []
        if not any(self._bangumi_compatible(item, query, year) for item in data):
            # The legacy search index can find romanized titles missing from v0.
            # Results still need title/season validation; otherwise offer them to
            # the user rather than treating the search keyword as an alias.
            legacy_queries = [query]
            # A full romanized name may be absent from the index even when a
            # distinctive word finds it. Broaden only an empty search, and keep
            # validation against the original full query.
            words = re.findall(r"[A-Za-z]+", query)
            if (not data and re.fullmatch(r"[A-Za-z\s'-]+", query)
                    and len(words) > 1):
                keyword = next((word for word in words if len(word) >= 4), None)
                if keyword:
                    legacy_queries.append(keyword)
            for legacy_query in legacy_queries:
                legacy = self._bangumi_request(
                    f'/search/subject/{quote(legacy_query, safe="")}?type=2&responseGroup=small&max_results=5'
                )
                detail_error = self.last_error or detail_error
                legacy_items = legacy.get('list', []) if isinstance(legacy, dict) else []
                if isinstance(legacy_items, list):
                    known = {item.get('id'): item for item in data}
                    extra = []
                    needed = [int(item['id']) for item in legacy_items[:5]
                              if isinstance(item, dict) and item.get('id') and item.get('type', 2) == 2
                              and int(item['id']) not in known]
                    details = self._subject_details(list(dict.fromkeys(needed)))
                    for item in legacy_items[:5]:
                        if not isinstance(item, dict) or not item.get('id') or item.get('type', 2) != 2:
                            continue
                        subject_id = int(item['id'])
                        if subject_id in known:
                            extra.append(known.pop(subject_id))
                            continue
                        detail = details.get(subject_id)
                        if detail and detail.get('id') == subject_id:
                            item = {**item, **detail}
                            self._bangumi_search_details[subject_id] = item
                        elif self.last_error:
                            detail_error = self.last_error
                        extra.append(item)
                    data = extra + list(known.values())
                if self.network_error:
                    self.last_error = self.network_error
                    self._remember_bangumi_candidates(data)
                    return []
                if data:
                    break
        if not any(self._bangumi_compatible(item, query, year)
                   and title_score(self._bangumi_titles(item), query)[0] == 5
                   and title_parts(query)[2] == any(title_parts(t)[2] for t in self._bangumi_titles(item))
                   for item in data):
            # Supplement Latin/romanized queries; native titles already use the
            # authoritative index directly. Always validate against original query.
            if re.search(r'[A-Za-z]', query):
                saved_error, saved_network = self.last_error, self.network_error
                extra = self._tenrai_recall(query, year)
                self.last_error, self.network_error = saved_error, saved_network
                by_id = {int(item['id']): item for item in data if item.get('id')}
                for item in extra:
                    sid = int(item['id'])
                    old = by_id.get(sid, {})
                    by_id[sid] = {**old, **item,
                        'aliases': list(dict.fromkeys([*(old.get('aliases') or []), *(item.get('aliases') or [])])),
                        'recall_evidence': clean_evidence([*old.get('recall_evidence', []), *item.get('recall_evidence', [])])}
                data = list(by_id.values())
                data = [item for item in data if int(item['id']) not in getattr(self, '_rejected_tenrai_ids', set())
                        or title_score(self._bangumi_titles(item), query)[0] >= 2]
        if re.search(r'[A-Za-z]', query):
            for item in data:
                if title_score(self._bangumi_titles(item), query)[0] < 2:
                    generated = reading(str(item.get('name') or ''))
                    if generated:
                        item['aliases'] = list(dict.fromkeys([*(item.get('aliases') or []), generated]))
                        item.setdefault('recall_evidence', []).append({
                            'source': 'reading', 'title': generated, 'verified': False, 'confident': False})
        if (series_query != query and not self.network_error
                and not any(self._bangumi_compatible(item, query, year) for item in data)):
            known = {item.get('id') for item in data}
            for seed in data[:3]:
                for linked in self.get_bangumi_relations(seed['id']):
                    if (linked.get('type') == 2 and linked.get('relation') in {'续集', '前传'}
                            and linked.get('id') not in known):
                        detail = self.get_bangumi_subject_by_id(linked['id'])
                        if detail:
                            data.append(detail)
                            known.add(linked['id'])
        needs_native_recall = (series_query != query or re.search(r'(?i)\b(?:OVA|OAD)\b|[()]', query))
        if (needs_native_recall and data and not self.network_error
                and not any(self._bangumi_compatible(item, query, year)
                            and title_score(self._bangumi_titles(item), query)[0] == 5 for item in data)):
            native_words = re.findall(r'[\u3040-\u30ff\u3400-\u9fffー]{4,}', str(data[0].get('name') or ''))
            if native_words:
                native_query = max(native_words, key=len)
                if '(' in query:
                    native_query = native_query[:6]
                expanded = self._bangumi_request('/v0/search/subjects?limit=30', 'POST',
                                                 {**payload, 'keyword': native_query})
                if isinstance(expanded, dict):
                    known = {item.get('id') for item in data}
                    data.extend(item for item in expanded.get('data', []) if isinstance(item, dict)
                                and item.get('id') and item['id'] not in known)
        self.last_error = detail_error
        data = sorted((item for item in data if isinstance(item, dict)),
                      key=lambda item: (int(self._bangumi_compatible(item, query, year)),
                                        self._score_bangumi_subject(item, query, year)
                                        if title_score(self._bangumi_titles(item), query)[0] >= 1 else (0,)),
                      reverse=True)
        return data

    def get_bangumi_search_terms(
        self,
        query: str,
        year: int,
    ) -> Dict[str, List[str]]:
        original_terms: List[str] = []
        chinese_terms: List[str] = []
        seen = set()
        for item in self.search_bangumi_subjects(query, year):
            if not self._bangumi_compatible(item, query, year):
                continue
            for bucket, candidate in (
                (original_terms, item.get('name')),
                (chinese_terms, item.get('name_cn')),
            ):
                candidate_text = str(candidate or '').strip()
                if not candidate_text or candidate_text in seen:
                    continue
                seen.add(candidate_text)
                bucket.append(candidate_text)
        if original_terms or chinese_terms:
            logger.info(
                '[Bangumi搜索] 获取到候选标题: '
                f'原始={original_terms}, 中文={chinese_terms}'
            )
        return {
            'original': original_terms,
            'chinese': chinese_terms,
        }

    def get_season_info(
        self, tv_id: int, season_number: int
    ) -> Optional[Dict[str, Any]]:
        """
        获取指定季度的详细信息，包括剧集列表

        Args:
            tv_id: 电视剧ID
            season_number: 季度号

        Returns:
            筛选后的季度信息字典，失败返回None
        """
        try:
            season = self._tmdb(tmdb.TV_Seasons(tv_id, season_number))
            season_info = season.info(language="zh-CN")

            if not season_info:
                logger.warning(f"[季度信息] 未获取到Season {season_number}的信息")
                return None

            # 筛选季度信息，只保留需要的字段
            filtered_season = {
                "air_date": season_info.get("air_date"),
                "episode_count": season_info.get("episode_count", 0),
                "id": season_info.get("id"),
                "name": season_info.get("name", ""),
                "overview": season_info.get("overview", ""),
                "season_number": season_info.get("season_number", season_number),
                "episodes": [],
            }

            # 处理剧集信息
            episodes: List[Dict] = season_info.get("episodes", [])
            for episode in episodes:
                filtered_episode = {
                    "air_date": episode.get("air_date"),
                    "episode_number": episode.get("episode_number"),
                    "episode_type": episode.get("episode_type", "regular"),
                    "name": episode.get("name", ""),
                    "overview": episode.get("overview", ""),
                    "runtime": episode.get("runtime"),
                    "season_number": episode.get("season_number", season_number),
                }
                filtered_season["episodes"].append(filtered_episode)

            logger.info(
                f'[季度信息] 获取Season {season_number}信息成功，包含{len(filtered_season["episodes"])}集'
            )
            return filtered_season

        except Exception as e:
            self.last_error = str(e)
            logger.warning(
                f"[季度信息] 获取Season {season_number}信息失败，{str(e)}"
            )

        logger.error(f"[季度信息] 获取Season {season_number}信息最终失败")
        return None

    def get_tv_info_with_seasons(
        self, query: str, year: int
    ) -> tuple[str, Optional[Dict[str, Any]]]:
        """
        获取电视剧信息，包含详细的季度和剧集信息

        Args:
            query: 搜索关键词
            year: 年份

        Returns:
            (剧集名称, 包含详细季度信息的tv_info字典)
        """
        # 首先获取基本的电视剧信息
        name, tv_info = self.get_tv_info(query, year)

        if not name or not tv_info:
            return name, tv_info

        # 填充季度信息
        tv_info = self.fill_season_info(tv_info)
        return name, tv_info

    def fill_season_info(self, tv_info: Dict[str, Any]) -> Dict[str, Any]:
        """
        填充电视剧信息中的季度信息

        Args:
            tv_info: 包含电视剧基本信息的字典

        Returns:
            填充后的tv_info字典
        """
        if not tv_info or "id" not in tv_info:
            logger.error("[季度信息] 无效的电视剧信息，无法填充季度信息")
            return tv_info

        tv_id = tv_info["id"]
        seasons = tv_info.get("seasons", [])

        if not seasons:
            # A missing list must not recursively re-run the same search.
            _, detailed_tv_info = self.get_tv_info_by_id(tv_id)
            if not detailed_tv_info or not detailed_tv_info.get('seasons'):
                logger.warning('[季度信息] 电视剧未提供季度列表，保留已有信息')
                return tv_info
            tv_info.update(detailed_tv_info)
            seasons = tv_info['seasons']

        # 获取每个季度的详细信息
        for season in seasons:
            season_number = season.get("season_number")
            if season_number is None:
                logger.warning(f"[季度信息] 跳过无效季度: {season}")
                continue

            logger.info(f"[季度信息] 正在获取Season {season_number}的详细信息...")
            detailed_season = self.get_season_info(tv_id, season_number)

            if detailed_season:
                season.update(detailed_season)
            else:
                logger.warning(
                    f"[季度信息] Season {season_number}获取详细信息失败，使用原始数据"
                )

        logger.info(
            f'[季度信息] 电视剧《{tv_info["name"]}》的季度信息填充完成，共{len(seasons)}个季度'
        )
        return tv_info

    def get_movie_info(
        self,
        query: str,
        year: int,
    ):
        try:
            search = self._tmdb(tmdb.Search())
            search.movie(
                query=query,
                language='zh-CN',
                year=year if year != 0 else None,
            )
            target_list = search.__dict__['results']
            if target_list:
                target = self._pick_best_result(target_list, query, year)
                if not target:
                    return '', None
                name = target['title']
                movie = self._tmdb(tmdb.Movies(target['id']))
                info = movie.info()
                logger.debug(str(movie.__dict__))
                return name, info
            return '', None
        except Exception as exc:
            self.last_error = f'[电影搜索] {exc}'
            logger.warning(self.last_error)
        return '', None

    def get_tv_info(
        self,
        query: str,
        year: int,
        anime_only: bool = False,
    ):
        try:
            primary_terms: List[str] = []
            if query not in primary_terms:
                primary_terms.append(query)
            if is_chinese_percentage_sufficient(query):
                simplified_query = re.sub(r'[a-zA-Z]', '', query).strip()
                if simplified_query and simplified_query not in primary_terms:
                    primary_terms.append(simplified_query)

            for term in primary_terms:
                name, info = self._search_tv_once(term, year, anime_only)
                if name and info:
                    logger.info(f'[电视剧搜索] 使用关键词命中: {term}')
                    return name, info

            bangumi_terms = self.get_bangumi_search_terms(query, year)
            fallback_terms: List[str] = []
            for term in bangumi_terms['original']:
                if term not in fallback_terms:
                    fallback_terms.append(term)
            for term in bangumi_terms['chinese']:
                if term not in fallback_terms:
                    fallback_terms.append(term)

            for term in fallback_terms:
                name, info = self._search_tv_once(term, year, anime_only)
                if name and info:
                    logger.info(f'[电视剧搜索] 使用 Bangumi 回退关键词命中: {term}')
                    return name, info
            return '', None
        except Exception as exc:
            self.last_error = f'[电视剧搜索] {exc}'
            logger.warning(self.last_error)
        return '', None
