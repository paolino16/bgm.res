import re
import json
import uuid
from collections import Counter
from pathlib import Path
from difflib import SequenceMatcher
from typing import Any, Dict, List, Tuple, Union, Optional

from jikanpy import Jikan

from .trans import Trans
from ..logger import logger
from .get_info import Search
from .metadata_http import metadata_session
from .source_scan import has_video, source_entries, selected_paths
from .recognition_progress import progress
from .task_schema import normalize_task
from .bangumi_native import plan_subject, subject_directory
from .rename_strategy import companions, edition_label
from .subject_discovery import discover_ambiguous, related_candidates, sequel_candidates, prioritize
from .task_submission import existing_task, ExistingTasks
from ..utils.title_matching import season_hint, title_parts
from ..utils.path import TASK_PATH
from .ai_processor import AIProcessor
from ..config.config_manager import cm
from ..ai.models import AIAnalysisResult
from .utils import (
    S0_TAG,
    EXTRA_TAG,
    IGNORE_DIR,
    VIDEO_SUFFIX,
    IGNORE_SUFFIX,
    is_sp_extra_dir_name,
    is_special_dir_name,
    format_episode_filename,
    sanitize_path_component,
    get_regular_season_episode_counts,
    remap_episode_by_season_counts,
)
from .cleaner import (
    remove_tag,
    to_sim_max,
    remove_code,
    remove_season,
    divide_by_year,
    extract_number,
    extract_season,
    remove_episode,
    extract_base_num,
    extract_trailing_bare_episode,
    match_and_extract,
    remove_similar_part,
    find_unique_parts_in_videos,
)

FOLDER_PLATFORMS = {
    'tv': ('TV',), 'tva': ('TV',), 'ova': ('OVA',), 'oad': ('OVA', 'OAD'),
    'ona': ('WEB', 'ONA'), 'movie': ('剧场版', 'MOVIE', '电影'),
    'movies': ('剧场版', 'MOVIE', '电影'), '剧场版': ('剧场版', 'MOVIE', '电影'),
}

NUMBERED_OVA = re.compile(r'(?i)(?<![a-z0-9])(?:ova|oad)[\s._-]?(\d{1,3})(?![a-z0-9]|\.\d)')


def bracketed_release(name):
    """Read [group][title]...[year][release tags] as separate fields."""
    if not re.fullmatch(r'(?:\s*\[[^\[\]]+\])+\s*', name):
        return None
    from .release_group import valid_group, technical_group
    blocks = [block.strip() for block in re.findall(r'\[([^\[\]]+)\]', name)]
    blocks = [block for block in blocks if not re.fullmatch(r'(?i)[248]K(?:[_ -]HDR)?', block)]
    if len(blocks) < 2:
        return None
    if not valid_group(blocks[0]):
        return None
    for index in range(2, len(blocks)):
        if not re.fullmatch(r'(?:19|20)\d{2}版?', blocks[index]):
            continue
        titles = [title for title in blocks[1:index] if title and not technical_group(title)
                  and title.casefold() not in FOLDER_PLATFORMS]
        if titles:
            year = int(blocks[index][:4])
            platforms = next((FOLDER_PLATFORMS[tag.casefold()] for tag in blocks[index+1:]
                              if tag.casefold() in FOLDER_PLATFORMS), None)
            return list(dict.fromkeys((title, year) for title in titles)), platforms
    if len(blocks) >= 3 and not technical_group(blocks[1]):
        tags = blocks[2:]
        if any(technical_group(tag) or tag.casefold() in FOLDER_PLATFORMS for tag in tags):
            platforms = next((FOLDER_PLATFORMS[tag.casefold()] for tag in tags
                              if tag.casefold() in FOLDER_PLATFORMS), None)
            return [(blocks[1], 0)], platforms
    return None


class Rename:
    def __init__(self):
        self.BANGUMI_PATH = Path(cm.get_config('bangumi_path'))
        self.MOVIE_PATH = Path(cm.get_config('movie_path'))
        self.ANIME_PATH = Path(cm.get_config('anime_path'))
        self.ANIME_MOVIE_PATH = Path(cm.get_config('anime_movie_path'))

        self.ANIME_MOVIE_PATH.mkdir(parents=True, exist_ok=True)
        self.MOVIE_PATH.mkdir(parents=True, exist_ok=True)
        self.ANIME_PATH.mkdir(parents=True, exist_ok=True)
        self.BANGUMI_PATH.mkdir(parents=True, exist_ok=True)
        self.search = Search()
        self.jikan = Jikan(session=metadata_session())
        self.ai_processor = AIProcessor()

        self.R = {}

    def get_subtitle_group(self, path: Path) -> str:
        from .release_group import release_group
        subtitle_group = release_group(path.name)
        if subtitle_group:
            logger.info(f'[处理任务] 识别字幕组：{subtitle_group}')
            return subtitle_group
        groups = set()
        if path.is_dir():
            for item in source_entries(path):
                if item.is_file() and item.suffix.lower() in VIDEO_SUFFIX:
                    if group := release_group(item.name):
                        groups.add(group)
        elif path.is_file():
            if group := release_group(path.parent.name):
                groups.add(group)
        subtitle_group = next(iter(groups)) if len(groups) == 1 else ''
        logger.info(f'[处理任务] 识别字幕组：{subtitle_group or "无"}')
        return subtitle_group

    def get_episode_filename(
        self,
        bangumi_name: str,
        season_id: int,
        episode: int,
        subtitle_group: str,
        suffix: str,
    ) -> str:
        return format_episode_filename(
            bangumi_name=bangumi_name,
            season=season_id,
            episode=episode,
            subtitle_group=subtitle_group,
            suffix=suffix,
        )

    def get_movie_filename(
        self,
        bangumi_name: str,
        subtitle_group: str,
        suffix: str,
    ) -> str:
        filename = sanitize_path_component(bangumi_name)
        if subtitle_group:
            filename = f'{filename} [{sanitize_path_component(subtitle_group)}]'
        return f'{filename}{suffix}'

    def get_season_folder_name(self, season_id: int) -> str:
        return f'Season {int(season_id)}'

    def get_output_directory(
        self,
        work_path: Path,
        is_movie: bool,
        season_id: Optional[int],
    ) -> Path:
        if is_movie:
            return work_path
        try:
            resolved_season_id = int(season_id) if season_id is not None else 1
        except (TypeError, ValueError):
            resolved_season_id = 1
        return work_path / self.get_season_folder_name(resolved_season_id)

    def normalize_search_name(
        self,
        source_name: str,
        remove_season_hint: bool = True,
    ) -> tuple[str, int]:
        year = 0
        rtpath_name = source_name
        path_atri = re.split(r'[\s-]+', rtpath_name)
        if len(path_atri) > 3:
            rtpath_name = ' '.join(path_atri)
        if rtpath_name.count('.') >= 3:
            rtpath_name = ' '.join(rtpath_name.split('.'))
            rtpath_name, year = divide_by_year(rtpath_name)
        if remove_season_hint:
            rtpath_name = remove_season(rtpath_name)
        rtpath_name = remove_episode(rtpath_name)
        rtpath_name = rtpath_name.strip()
        return rtpath_name, year

    def search_folder_context(self, path: Path):
        current = path
        platforms = None
        season = None
        while True:
            name = current.name.strip()
            folder_platforms = FOLDER_PLATFORMS.get(name.casefold())
            content_folder = is_sp_extra_dir_name(name) or is_special_dir_name(name)
            hint = season_hint(name)
            season = season if season is not None else (None if content_folder else hint)
            platforms = platforms or folder_platforms
            if not folder_platforms and not content_folder and not (hint is not None and not title_parts(name)[0]):
                release_name = current.stem if current == path and current.suffix.lower() in VIDEO_SUFFIX else name
                release = bracketed_release(release_name)
                if release:
                    platforms = platforms or release[1]
                return name, platforms, season
            if current.parent == current:
                return '', platforms, season
            current = current.parent

    def build_search_candidates(
        self,
        path: Path,
        custom_name: Optional[str] = None,
    ) -> List[tuple[str, int]]:
        if custom_name:
            return [(custom_name, 0)]

        source_name, _, _ = self.search_folder_context(path)
        if path.is_dir() and re.fullmatch(r'(?:[A-Z]{2,5}|(?i:Film)\s+\d+)', source_name):
            from .source_scan import files_in
            videos = [file for file in files_in(path, recursive=False) if file.suffix.lower() in VIDEO_SUFFIX]
            if videos:
                # Release filenames retain the series name lost in container labels.
                return self.build_search_candidates(sorted(videos)[0])
        if path.is_file() and source_name == path.name:
            source_name = re.sub(r'(?i)\[v\d+\]', '', path.stem).strip()
            fractional_title = re.search(r'([\u3040-\u30ff\u3400-\u9fffー]{4,})\s*(第\d+\.5[話话集])', source_name)
            if fractional_title:
                return [(' '.join(fractional_title.groups()), 0)]
        release = bracketed_release(source_name)
        if release:
            return release[0]
        signer = re.search(r'\]\s*-\s*[^\[\]]+$', source_name)
        if signer:
            source_name = source_name[:signer.start() + 1].rstrip()
        source_name = re.sub(r'(?i)(?:\s+|(?<=\]))v\d{1,2}(?=\s*(?:\[|$))', '', source_name).strip()
        if source_name != path.name:
            # Do not search a season marker or a year/month container as a title.
            if not title_parts(source_name)[0] or re.fullmatch(r'\d{4}(?:[-._]\d{1,2})?', source_name):
                return []
        year_match = re.search(r'[\s._-][(\[]?((?:19|20)\d{2})[)\]]?\s*$', source_name)
        source_year = int(year_match.group(1)) if year_match else 0
        bracket_year = re.search(r'\[((?:19|20)\d{2})\]', source_name)
        if not source_year and bracket_year:
            source_year = int(bracket_year[1])
        if not source_year and not re.search(r'[\[\]【】]', source_name):
            for parent in path.parents:
                match = re.fullmatch(r'((?:19|20)\d{2})-\d{2}', parent.name)
                if match:
                    source_year = int(match[1])
                    break
        if year_match:
            source_name = source_name[:year_match.start()].rstrip()
        # Technical release groups must never leak into a fallback query.
        source_name = re.sub(r'(?i)\[[^\]]*(?:\d{3,4}p|x26[45]|h[ .]?26[45]|ma10p|flac|aac|bluray|bdrip)[^\]]*\]', '', source_name).strip()
        source_name = re.sub(r'(?i)\([^()]*(?:DVD|BD|\d{3,4}p|x[ .]?26[45])[^()]*\)', '', source_name).strip()
        source_name = re.sub(r'(?i)\s+(?:JPBD|BD)\s+Remux\b.*$', '', source_name).strip()
        source_name = re.sub(r'(?i)\s+CUSTOM\s+REMASTER\b.*$', '', source_name).strip()
        # Episode zero before an explicit OVA marker is release numbering.
        source_name = re.sub(r'(?i)\s*-\s*0+\s+(?=OVA\b)', ' ', source_name)
        # Parenthesized words inside an unbracketed title are title evidence.
        def protect_parenthesized_title(match):
            if re.search(r'(?i)(?:BDRip|BD|FLAC|AAC|x26[45]|\d{3,4}p|Ma10)', match[1]):
                return match[0]
            return '｟' + match[1] + '｠'

        protected = re.sub(r'\(([^()]*[A-Za-z][^()]*)\)', protect_parenthesized_title, source_name)
        raw_candidates = [remove_tag(protected).replace('｟', '(').replace('｠', ')'),
                          remove_tag(protected, True).replace('｟', '(').replace('｠', ')')]
        # Native-script alternate titles are often absent from the Latin index.
        native_titles = re.findall(r'\(([^()]*[\u3040-\u30ff\u3400-\u9fff][^()]*)\)', source_name)
        native_titles = [title for title in native_titles if not re.fullmatch(r'(?i)(?:TV)?未放送', title)]
        raw_candidates = native_titles + raw_candidates
        mixed_title = re.fullmatch(r'[A-Za-z][A-Za-z -]*\s+([\u3400-\u9fff]{4,})', raw_candidates[0]) if raw_candidates else None
        if mixed_title:
            raw_candidates.insert(0, mixed_title[1])
        if path.is_file():
            labels = re.findall(r'\[([^\[\]]+)\]', source_name)
            special = any(re.search(r'(?i)\b(?:OAD|OVA)\b', label) or re.fullmatch(r'0+|\d+\.5', label) for label in labels)
            subtitles = [label for label in labels[1:] if re.fullmatch(r'[A-Za-z]+(?:-[A-Za-z]+)+', label)]
            if special and not any(re.search(r'(?i)\b(?:OAD|OVA)\s*\d', label) for label in labels):
                raw_candidates = [name + ' OAD' for name in raw_candidates]
            elif subtitles:
                raw_candidates = [name + ' ' + subtitles[0] for name in raw_candidates]
        directory_source = path.is_dir()
        candidates: List[tuple[str, int]] = []
        seen = set()
        for raw_candidate in raw_candidates:
            raw_candidate = re.sub(r'(?i)\s+-\s+(?:TV|Movie)\s*\+.*$', '', raw_candidate).strip()
            raw_candidate = re.sub(r'(?i)\s+(?:(?:[248]K\s+)?Remaster(?:ed)?\s+Edition|Blu[- ]?ray\s+BOX|BD[- ]BOX|Ver[. ](?:19|20)\d{2}\s+[248]Kリマスター)\b.*$', '', raw_candidate).strip()
            raw_candidate = re.sub(r'(?i)\s+\d{3,4}p\b.*$', '', raw_candidate).strip()
            candidate_year = source_year
            trailing_year = re.search(r'\s+((?:19|20)\d{2})\s*$', raw_candidate)
            if trailing_year:
                candidate_year = int(trailing_year[1])
                raw_candidate = raw_candidate[:trailing_year.start()].rstrip()
            # Batch directories often append the included episodes after the title.
            if directory_source:
                batch = re.search(r'\s+0{0,2}1\s*[-–~～]\s*(\d{1,3})\s*$', raw_candidate)
                if batch and int(batch[1]) > 1:
                    raw_candidate = raw_candidate[:batch.start()].rstrip()
            if source_name != path.name:
                # Collection release annotations are not part of the show title.
                raw_candidate = re.sub(r'(?i)\b\d+(?:st|nd|rd|th)\s+anniversary\b', '', raw_candidate).strip()
            if not raw_candidate:
                continue
            for remove_season_hint in (False, True):
                normalized_name, year = self.normalize_search_name(
                    raw_candidate,
                    remove_season_hint=remove_season_hint,
                )
                if not title_parts(normalized_name)[0]:
                    continue
                key = (normalized_name, year or candidate_year)
                if key in seen:
                    continue
                seen.add(key)
                candidates.append(key)
        return candidates

    def resolve_task_type(
        self,
        _uuid: str,
        path: Path,
        is_anime: Optional[bool],
        is_movie: Optional[bool],
        custom_name: Optional[str] = None,
        custom_year: Optional[str] = None,
        custom_tmdb_id: Optional[str] = None,
        custom_bgm_id: Optional[str] = None,
        skip_search: bool = False,
    ) -> Union[Tuple[str, int, Tuple[str, Dict, bool, bool]], str]:
        if skip_search:
            return self.build_manual_task_type(
                path,
                is_anime,
                is_movie,
                custom_name,
                custom_year,
            )

        self.search.last_bangumi_candidates = []
        self.search.recall_warnings = []
        self.search.network_error = None
        _, folder_platforms, folder_season = self.search_folder_context(path)
        self.search.requested_platforms = folder_platforms
        if not folder_platforms and folder_season is not None and not path.is_file():
            self.search.requested_platforms = ('TV', 'WEB', 'ONA')
        self.search.requested_season = season_hint(custom_name) if custom_name else folder_season
        if path.is_file() and re.search(r'(?i)\b(?:OVA|OAD)\b', path.stem):
            self.search.requested_platforms = ('OVA', 'OAD')
            self.search.requested_season = None
        last_error = ''
        # Explicit IDs identify the subject without a searchable folder title.
        # OVA / Specials / season-only folders must still reach ID validation.
        if str(custom_bgm_id or '').strip() or str(custom_tmdb_id or '').strip():
            candidates = [(custom_name or path.name, 0)]
        else:
            candidates = self.build_search_candidates(path, custom_name)
        for rtpath_name, year in candidates:
            self.search.strict_year = bool(year)
            logger.info(f'[处理任务] 尝试搜索名: {rtpath_name} (year={year})')
            task_type = self.check_task_type(
                _uuid,
                rtpath_name,
                year,
                path,
                is_anime,
                is_movie,
                custom_tmdb_id,
                custom_bgm_id,
            )
            if not isinstance(task_type, str):
                return rtpath_name, year, task_type
            last_error = task_type
            if task_type.startswith('[Bangumi]') and self.search.last_bangumi_candidates:
                # Do not discard sequel/type intent by retrying a weaker query.
                return task_type
            if getattr(self.search, 'network_error', None):
                return self.search.network_error
            logger.info(f'[处理任务] 搜索名失败, 尝试下一候选: {task_type}')
        return last_error or f'[搜索] 未搜索到有效结果, 跳过{path.name}'

    def parse_manual_year(self, custom_year: Optional[str]) -> Union[int, str]:
        normalized = str(custom_year or '').strip()
        if not normalized:
            return '[手动模式] 请填写年份'
        try:
            year = int(normalized)
        except ValueError:
            return f'[手动模式] 非法年份: {custom_year}'
        if year <= 0:
            return f'[手动模式] 非法年份: {custom_year}'
        return year

    def build_manual_task_type(
        self,
        path: Path,
        is_anime: Optional[bool],
        is_movie: Optional[bool],
        custom_name: Optional[str],
        custom_year: Optional[str],
    ) -> Union[Tuple[str, int, Tuple[str, Dict, bool, bool]], str]:
        normalized_name = str(custom_name or '').strip()
        if not normalized_name:
            return '[手动模式] 请填写剧集名称'
        if is_movie is None:
            return '[手动模式] 请明确指定是否为 TV/电影'

        year = self.parse_manual_year(custom_year)
        if isinstance(year, str):
            return year

        resolved_is_anime = bool(is_anime) if is_anime is not None else False
        if is_anime is None:
            logger.info('[处理任务] 手动模式未指定是否动画，按非动画处理')

        genres = [{'name': 'Animation'}] if resolved_is_anime else []
        if is_movie:
            info = {
                'source': 'manual',
                'release_date': f'{year:04d}-01-01',
                'genres': genres,
            }
        else:
            info = {
                'source': 'manual',
                'first_air_date': f'{year:04d}-01-01',
                'genres': genres,
                'seasons': [],
            }

        logger.info('[处理任务] 启用手动模式，跳过 BGM/TMDB 检索')
        return normalized_name, year, (
            normalized_name,
            info,
            resolved_is_anime,
            bool(is_movie),
        )

    def resolve_detected_year(
        self,
        info: Optional[Dict[str, Any]],
        custom_year: Optional[str] = None,
    ) -> str:
        normalized_custom_year = str(custom_year or '').strip()
        if normalized_custom_year:
            return normalized_custom_year
        if not info:
            return ''

        date_text = str(
            info.get('first_air_date') or info.get('release_date') or ''
        ).strip()
        if re.match(r'^\d{4}', date_text):
            return date_text[:4]
        return ''

    def resolve_detected_bgm_id(
        self,
        info: Optional[Dict[str, Any]],
        custom_bgm_id: Optional[str] = None,
    ) -> str:
        normalized_custom_bgm_id = str(custom_bgm_id or '').strip()
        if normalized_custom_bgm_id:
            return normalized_custom_bgm_id
        if not info:
            return ''

        source = str(info.get('source') or '').strip().lower()
        if source != 'bgm':
            return ''

        source_id = info.get('source_id') or info.get('id')
        if source_id is None:
            return ''
        return str(source_id).strip()

    def resolve_subtitle_group(
        self,
        path: Path,
        custom_subtitle_group: Optional[str],
    ) -> str:
        if custom_subtitle_group is not None:
            normalized = str(custom_subtitle_group).strip()
            from .release_group import technical_group
            if normalized and not technical_group(normalized):
                logger.info(f'[处理任务] 使用指定字幕组：{normalized}')
                return normalized
        return self.get_subtitle_group(path)

    def get_episode_offset(self) -> int:
        value = cm.get_config('episode_offset')
        try:
            return int(value)
        except (TypeError, ValueError):
            logger.warning(f'[处理任务] 非法跨季集数偏移配置: {value}, 使用0')
            return 0

    def normalize_episode_mapping(
        self,
        season_id: int,
        episode: int,
        tv_info: Optional[Dict],
    ) -> Tuple[int, int, bool]:
        if not tv_info:
            return season_id, episode, True

        season_counts = get_regular_season_episode_counts(tv_info)
        if not season_counts:
            return season_id, episode, True

        mapped_season_id, mapped_episode, is_regular = (
            remap_episode_by_season_counts(
                season_id,
                episode,
                season_counts,
                self.get_episode_offset(),
            )
        )
        if not is_regular:
            logger.info(
                f'[处理任务] 集号{episode}超过剧集总集数上限，按非正片处理'
            )
            return 0, 0, False
        if (mapped_season_id, mapped_episode) != (season_id, episode):
            logger.info(
                '[处理任务] 根据各季集数重新映射: '
                f'S{season_id:02d}E{episode:02d} -> '
                f'S{mapped_season_id:02d}E{mapped_episode:02d}'
            )
        return mapped_season_id, mapped_episode, True

    def _extract_episode_identity(
        self,
        item_path: Path,
        itme_path_main_name: str,
        default_season_id: int,
    ) -> Tuple[int, int]:
        item_name = item_path.name
        item_name_remove = item_path.stem
        item_name_l = item_name_remove.lower()
        n_item_name_no_ext_l = item_name_remove.replace(
            itme_path_main_name, ''
        ).lower()

        _item_name = remove_code(remove_season(item_name_l))
        epp = extract_base_num(_item_name)
        if epp is None:
            ep = extract_number(_item_name)
            if ep is None:
                ep = extract_trailing_bare_episode(n_item_name_no_ext_l)
        else:
            ep = int(epp)

        if ep is None:
            if _item_name.isdigit():
                ep = int(_item_name)
            else:
                return 0, 0
        else:
            ep = int(ep)

        identity = match_and_extract(item_name)
        if identity:
            return int(identity[0]), int(identity[1])
        return int(default_season_id), int(ep)

    def _get_folder_majority_season(
        self,
        files: List[Path],
        itme_path_main_name: str,
        default_season_id: int,
        tv_info: Optional[Dict],
    ) -> Optional[int]:
        if not tv_info or not files:
            return None

        season_counter: Counter[int] = Counter()
        for item_path in files:
            if item_path.suffix.lower() not in VIDEO_SUFFIX:
                continue
            season_id, episode = self._extract_episode_identity(
                item_path,
                itme_path_main_name,
                default_season_id,
            )
            if season_id != 1 or episode <= 0:
                continue
            mapped_season_id, _, is_regular_episode = self.normalize_episode_mapping(
                season_id,
                episode,
                tv_info,
            )
            if is_regular_episode and mapped_season_id > 0:
                season_counter[mapped_season_id] += 1

        if len(season_counter) <= 1:
            return None

        dominant_season_id, dominant_count = season_counter.most_common(1)[0]
        logger.info(
            '[处理任务] 文件夹跨季映射统计: '
            f'{dict(season_counter)}, 采用最多的 Season {dominant_season_id} '
            f'({dominant_count} 个文件)'
        )
        return dominant_season_id

    def get_season_id(
        self,
        tv_info: Dict,
        work_path: Path,
        path: Path,
        titles: Optional[List[Dict]],
    ):
        season_id = 1
        path_name = path.name
        all_similaritys: List[Dict] = []

        for season in tv_info['seasons']:
            info_season_id = season['season_number']
            sname: str = season['name']
            logger.info(f'[处理任务] Season{info_season_id} 季度名: {sname}')

            '''
            int_season = extract_season(sname)
            logger.info(f'[处理任务] 提取信息季号:{int_season}')
            '''

            int_rtpath_name = extract_season(path_name)
            logger.info(f'[处理任务] 提取标题季号:{int_rtpath_name}')
            if info_season_id == int_rtpath_name:
                season_id = int_rtpath_name
                break

            # 如果不是Season1的情况下，sname处于路径之中，则直接跳过
            if not (sname.strip().startswith('Season') and '1' in sname):
                if sname in path.name:
                    sname_list = sname.split(' ')
                    path_name_list = path.stem.split(' ')
                    if len(sname_list) == len(path_name_list):
                        logger.info(f'[处理任务] 季度名称处于标题中：{sname}')
                        season_id = info_season_id
                        break
                    else:
                        logger.info(f'[处理任务] 季度名称与路径名称长度不同：{sname}')

                if titles:
                    # 或者计算相似度
                    for title in titles:
                        similaritys = {}
                        if title['type'] in [
                            'Default',
                            'Synonym',
                            'English',
                            'French',
                        ]:
                            ename = title['title']
                            path_name = path_name.replace(ename, '')
                            similarity = SequenceMatcher(
                                None,
                                sname,
                                remove_tag(path_name),
                            ).ratio()

                            # logger.debug(f'相似度{tindex}：{similarity}')
                            similaritys[similarity] = season_id
                        all_similaritys.append(similaritys)
        else:
            if all_similaritys:
                logger.info(f'[处理任务] 相似度：{all_similaritys}')
                season_id = to_sim_max(all_similaritys)

        logger.info(f'[处理任务] 识别季号：{season_id}')
        return season_id

    def process_sub(
        self,
        itme_path_main_name: str,
        item_repeat: Optional[List[str]],
        item_path: Path,
        local_files: Optional[List[Path]],
        work_path: Path,
        bangumi_name: str,
        season_id: int,
        subtitle_group: str,
        tv_info: Optional[Dict] = None,
        folder_majority_season_id: Optional[int] = None,
        standalone_ova: bool = False,
    ):
        item_name = item_path.name
        item_full_suffix = item_path.suffix
        # if item_repeat:
        #     item_name_remove = remove_similar_part(item_repeat, item_path.stem)
        # else:
        item_name_remove = item_path.stem

        item_name_l = item_name_remove.lower()
        item_suffix = item_path.suffix.lower()

        n_item_name_l = item_name.replace(itme_path_main_name, '').lower()
        logger.info(f'[处理任务] 移去主要内容后的文件名Lower：{n_item_name_l}')

        if item_suffix not in VIDEO_SUFFIX:
            logger.info(f'[处理任务] 非视频文件不参与主识别：{item_path.name}')
            return

        ova = NUMBERED_OVA.search(item_name_remove) if standalone_ova else None
        if (ova and int(ova.group(1)) > 0
                and not any(tag in item_name for tag in IGNORE_DIR)
                and not any(re.search(rf'(?<![a-zA-Z\u4e00-\u9fa5]){re.escape(tag)}(?![a-zA-Z\u4e00-\u9fa5])',
                                      n_item_name_l, re.IGNORECASE) for tag in EXTRA_TAG)):
            # A release consisting entirely of numbered OVAs is its own series.
            # Preserve release numbering: catalogs may split its OVAs into
            # separate one-episode subjects, so regular season limits do not apply.
            target = work_path / self.get_season_folder_name(season_id)
            self.R[item_path] = target / self.get_episode_filename(
                bangumi_name, season_id, int(ova.group(1)), subtitle_group, item_full_suffix,
            )
            self._map_associated_files(item_path, self.R[item_path], local_files)
            return

        for ignore_dir in IGNORE_DIR:
            if ignore_dir in item_path.name:
                logger.info(f'[处理任务] 忽略文件夹：{item_path.name}')
                break
        else:
            for ignore_tag in IGNORE_SUFFIX:
                if ignore_tag in item_suffix:
                    logger.info(f'[处理任务] 忽略文件：{item_path.name}')
                    break
            else:
                p = r'[a-zA-Z\u4e00-\u9fa5]'
                for ex in EXTRA_TAG:
                    if re.search(
                        rf'(?<!{p}){ex.lower()}(?!{p})',
                        n_item_name_l,
                    ):
                        t = work_path / 'extra'
                        self.R[item_path] = t / item_name
                        self._map_associated_files(
                            item_path,
                            self.R[item_path],
                            local_files,
                        )
                        logger.info(
                            f'[处理任务] 识别{n_item_name_l},'
                            f'移动到extra文件夹：{item_path.name}'
                        )
                        break
                else:
                    for s0 in S0_TAG:
                        if (s0 == r' ver\.' and edition_label(item_path)
                                and self._extract_episode_identity(item_path, itme_path_main_name, season_id)[1] > 0):
                            # A named cut of an explicit episode is still that
                            # episode, rather than an unnumbered special.
                            continue
                        if re.search(s0, item_name_l):
                            t = work_path / self.get_season_folder_name(0)
                            self.R[item_path] = t / item_name
                            self._map_associated_files(
                                item_path,
                                self.R[item_path],
                                local_files,
                            )
                            logger.info(
                                f'[处理任务] 识别{n_item_name_l},'
                                f'移动到Season 0文件夹并保留原名：{item_path.name}'
                            )
                            break
                    else:
                        _item_name = remove_code(remove_season(item_name_l))
                        logger.info(
                            f'[处理任务] 开始对{_item_name}处理, 寻找集数中...")'
                        )
                        original_season_id, original_ep = self._extract_episode_identity(
                            item_path,
                            itme_path_main_name,
                            season_id,
                        )
                        season_id, ep = original_season_id, original_ep

                        season_id, ep, is_regular_episode = (
                            self.normalize_episode_mapping(
                                int(season_id),
                                int(ep),
                                tv_info,
                            )
                        )
                        if (
                            folder_majority_season_id is not None
                            and original_season_id == 1
                            and season_id != folder_majority_season_id
                            and original_ep > 0
                        ):
                            logger.info(
                                '[处理任务] 文件夹主 Season 覆盖跨季映射: '
                                f'S{season_id:02d}E{ep:02d} -> '
                                f'S{folder_majority_season_id:02d}E{original_ep:02d}'
                            )
                            season_id, ep = folder_majority_season_id, original_ep

                        t = work_path / self.get_season_folder_name(season_id)
                        if int(season_id) == 0 or not is_regular_episode:
                            self.R[item_path] = t / item_name
                            self._map_associated_files(
                                item_path,
                                self.R[item_path],
                                local_files,
                            )
                            logger.info(
                                f'[处理任务] 无法识别为正片，移动到Season 0并保留原名：{item_path.name}'
                            )
                        else:
                            self.R[item_path] = t / self.get_episode_filename(
                                bangumi_name,
                                int(season_id),
                                int(ep),
                                subtitle_group,
                                item_full_suffix,
                            )
                            self._map_associated_files(
                                item_path,
                                self.R[item_path],
                                local_files,
                            )
        logger.info(f'[处理任务] 处理完成{item_name}')

    def _map_associated_files(
        self,
        source_video_path: Path,
        target_video_path: Path,
        local_files: Optional[List[Path]],
    ) -> None:
        if not local_files:
            return

        source_video_stem = source_video_path.stem
        target_video_stem = target_video_path.stem
        for other_file in companions(source_video_path, local_files):
            suffix_part = other_file.name[len(source_video_stem):]
            target_associated_path = (
                target_video_path.parent / f'{target_video_stem}{suffix_part}'
            )
            self.R[other_file] = target_associated_path
            logger.info(
                f'[处理任务] 关联文件跟随重命名: '
                f'{other_file.name} -> {target_associated_path.name}'
            )

    def _map_extra_folder_files(self, extra_dir: Path, work_path: Path) -> None:
        target_dir = work_path / 'extra'
        for source_path in sorted(source_entries(extra_dir, recursive=True)):
            if not source_path.is_file():
                continue

            relative_path = source_path.relative_to(extra_dir)
            target_path = target_dir / relative_path
            self.R[source_path] = target_path
            logger.info(
                f'[处理任务] SP子文件夹内容视为extra: '
                f'{source_path.name} -> {target_path}'
            )

    def _map_sp_extra_folders(self, path: Path, work_path: Path) -> None:
        if not path.is_dir():
            return

        if is_sp_extra_dir_name(path.name):
            self._map_extra_folder_files(path, work_path)
            return
        if is_special_dir_name(path.name):
            self._map_special_folder_files(path, work_path)
            return
        for item_path in source_entries(path):
            if item_path.is_dir():
                self._map_sp_extra_folders(item_path, work_path)

    def _map_special_folder_files(self, folder: Path, work_path: Path) -> None:
        for video in sorted(source_entries(folder, recursive=True)):
            if not video.is_file() or video.suffix.lower() not in VIDEO_SUFFIX:
                continue
            if any(tag in video.name for tag in IGNORE_DIR):
                continue
            # Keep names and subdirectories: no reliable catalog episode number
            # can be inferred from the fact that a file is a special.
            target = work_path / self.get_season_folder_name(0) / video.relative_to(folder)
            self.R[video] = target
            self._map_associated_files(video, target, list(source_entries(video.parent)))

    def _contains_video_files(self, path: Path) -> bool:
        try:
            return has_video(path)
        except Exception as e:
            logger.warning(f'[处理任务] 检查视频文件失败 {path}: {e}')
            return False

    def process(
        self,
        path: Path,
        _is_anime: Optional[bool] = None,
        _is_movie: Optional[bool] = None,
        _tuuid: Optional[str] = None,
        cus_name: Optional[str] = None,
        cus_season_id: Optional[int] = None,
        cus_subtitle_group: Optional[str] = None,
        cus_year: Optional[str] = None,
        cus_tmdb_id: Optional[str] = None,
        cus_bgm_id: Optional[str] = None,
        skip_search: bool = False,
    ):
        if _tuuid is None:
            existing = existing_task(path, TASK_PATH)
            if existing:
                return existing
        progress('扫描来源目录')
        if not self._contains_video_files(path):
            return self.error_reply(
                _tuuid or str(uuid.uuid4()),
                '传入路径中未找到视频文件，跳过处理',
                path,
                _is_anime,
                _is_movie,
                cus_name,
                cus_season_id,
                cus_subtitle_group,
                cus_year,
                cus_tmdb_id,
                cus_bgm_id,
                skip_search=skip_search,
            )

        if path.is_dir():
            is_video = False
            for sub_path in source_entries(path):
                if not sub_path.is_dir() and sub_path.suffix.lower() in VIDEO_SUFFIX:
                    is_video = True

            selected = getattr(self, 'selected_subject_ids', [])
            multiple = isinstance(selected, list) and len(selected) > 1
            if selected_paths() is not None or multiple or is_video or is_sp_extra_dir_name(path.name) or is_special_dir_name(path.name):
                return self._process(
                    path,
                    _is_anime,
                    _is_movie,
                    _tuuid,
                    cus_name,
                    cus_season_id,
                    cus_subtitle_group,
                    cus_year,
                    cus_tmdb_id,
                    cus_bgm_id,
                    skip_search,
                )
            else:
                errors = []
                reused = []
                created = 0
                for sub_path in source_entries(path):
                    result = self._process(
                        sub_path,
                        _is_anime,
                        _is_movie,
                        _tuuid,
                        cus_name,
                        cus_season_id,
                        cus_subtitle_group,
                        cus_year,
                        cus_tmdb_id,
                        cus_bgm_id,
                        skip_search,
                    )
                    if isinstance(result, str):
                        errors.append(result)
                    elif isinstance(result, ExistingTasks):
                        reused.extend(result.tasks)
                    elif result is True:
                        created += 1
                if errors:
                    return '\n\n'.join(errors)
                return ExistingTasks(reused, created) if reused else True
        else:
            return self._process(
                path,
                _is_anime,
                _is_movie,
                _tuuid,
                cus_name,
                cus_season_id,
                cus_subtitle_group,
                cus_year,
                cus_tmdb_id,
                cus_bgm_id,
                skip_search,
            )

    def check_task_type(
        self,
        _uuid: str,
        rtpath_name: str,
        year: int,
        path: Path,
        is_anime: Optional[bool] = None,
        is_movie: Optional[bool] = None,
        custom_tmdb_id: Optional[str] = None,
        custom_bgm_id: Optional[str] = None,
    ) -> Union[Tuple[str, Dict, bool, bool], str]:
        season_id = 1
        pos = 0
        logger.info('[处理任务] 未传入任务类型，开始判断该文件是否为电影！')

        tmdb_id = None
        bgm_id = None
        if custom_tmdb_id is not None and str(custom_tmdb_id).strip():
            try:
                tmdb_id = int(str(custom_tmdb_id).strip())
                logger.info(f'[处理任务] 使用指定 TMDB ID: {tmdb_id}')
            except ValueError:
                return f'[TMDB] 非法的 TMDB ID: {custom_tmdb_id}'
        if custom_bgm_id is not None and str(custom_bgm_id).strip():
            try:
                bgm_id = int(str(custom_bgm_id).strip())
                logger.info(f'[处理任务] 使用指定 BGM ID: {bgm_id}')
            except ValueError:
                return f'[Bangumi] 非法的 BGM ID: {custom_bgm_id}'

        use_bangumi = tmdb_id is None and (bgm_id is not None or is_anime is not False)
        if use_bangumi:
            s1_name, s1_info = self.search.get_bangumi_info(
                rtpath_name,
                year,
                bgm_id=bgm_id,
            )
            logger.info(f'[处理任务] Bangumi 搜索到的动画名称: {s1_name}')
            if not s1_name and year != 0 and bgm_id is None and not getattr(self.search, 'strict_year', False) and not getattr(self.search, 'network_error', None):
                s1_name, s1_info = self.search.get_bangumi_info(
                    rtpath_name,
                    0,
                    bgm_id=None,
                )
                logger.info(f'[处理任务] Bangumi 删除year后重试: {s1_name}')

            if not s1_info:
                logger.warning(f'[处理任务] 未搜索到 Bangumi 动画信息, 跳过{rtpath_name}')
                return self.search.last_error or f'[Bangumi] 未搜索到动画信息, 跳过{rtpath_name}'

            resolved_is_movie = (
                is_movie
                if is_movie is not None
                else self.search.is_bangumi_movie_info(s1_info)
            )
            logger.info(
                '[处理任务] Bangumi 平台判定: '
                f'platform={s1_info.get("platform")}, is_movie={resolved_is_movie}'
            )
            return s1_name, s1_info, True, bool(resolved_is_movie)

        if tmdb_id is not None:
            if is_movie is True:
                s2_name, s2_info = self.search.get_movie_info_by_id(tmdb_id)
                s1_name, s1_info = ('', None)
                if not s2_info:
                    s1_name, s1_info = self.search.get_tv_info_by_id(tmdb_id)
            else:
                s1_name, s1_info = self.search.get_tv_info_by_id(tmdb_id)
                s2_name, s2_info = ('', None)
                if not s1_info:
                    s2_name, s2_info = self.search.get_movie_info_by_id(tmdb_id)
        else:
            anime_tv_only = is_anime is True and is_movie is not True
            s1_name, s1_info = self.search.get_tv_info(
                rtpath_name,
                year,
                anime_only=anime_tv_only,
            )
            logger.info(f'[处理任务] 搜索到的电视剧名称: {s1_name}')
            if not s1_name and year != 0:
                s1_name, s1_info = self.search.get_tv_info(
                    rtpath_name,
                    0,
                    anime_only=anime_tv_only,
                )
                logger.info(f'[处理任务] 未搜索到结果, 删除year后重试: {s1_name}')

            if anime_tv_only:
                s2_name, s2_info = ('', None)
                logger.info('[处理任务] 指定为动画，跳过 TMDB 电影搜索')
            else:
                s2_name, s2_info = self.search.get_movie_info(rtpath_name, year)
                logger.info(f'[处理任务] 搜索到的电影名称: {s2_name}')

                if not s2_name and year != 0:
                    s2_name, s2_info = self.search.get_movie_info(
                        rtpath_name,
                        0,
                    )
                    logger.info(f'[处理任务] 未搜索到结果, 删除year后重试: {s2_name}')

        season_id = extract_season(rtpath_name)

        if s1_name:
            pos += 1
        elif s2_name:
            pos -= 1

        if season_id == -1:
            pos -= 0.6
            if path.is_file():
                pos -= 0.5
        else:
            pos += 0.6
            if path.is_file():
                pos += 0.5

        if path.is_dir():
            path_file_num = len([i for i in source_entries(path) if i.is_file()])
            if path_file_num > 6:
                pos += 0.4
            else:
                pos -= 0.4

        if pos > 0 or (is_movie is not None and not is_movie):
            logger.info('[处理任务] 该文件可能为电视剧！')
            is_movie = False
            info = s1_info
            name = s1_name

            if not info:
                logger.warning(f'[处理任务] 未搜索到电视剧信息, 跳过{rtpath_name}')
                return f'[TMDB] 未搜索到电视剧信息, 跳过{rtpath_name}'

            if is_anime is None:
                for g in info['genres']:
                    if g['name'].lower() == 'animation' or g['name'].lower() == 'anime':
                        is_anime = True
                        break
                else:
                    is_anime = False
        else:
            logger.info('[处理任务] 该文件可能为电影！')
            is_movie = True
            info = s2_info
            name = s2_name

            if not info:
                logger.warning(f'[处理任务] 未搜索到电影信息, 跳过{rtpath_name}')
                return self.search.last_error or f'[Bangumi] 未搜索到电影信息, 跳过{rtpath_name}'

            if is_anime is None:
                for g in info['genres']:
                    if g['name'].lower() == 'animation' or g['name'].lower() == 'anime':
                        is_anime = True
                        break
                else:
                    is_anime = False
        return name, info, is_anime, is_movie

    def _process(
        self,
        path: Path,
        _is_anime: Optional[bool] = None,
        _is_movie: Optional[bool] = None,
        _tuuid: Optional[str] = None,
        cus_name: Optional[str] = None,
        cus_season_id: Optional[int] = None,
        cus_subtitle_group: Optional[str] = None,
        cus_year: Optional[str] = None,
        cus_tmdb_id: Optional[str] = None,
        cus_bgm_id: Optional[str] = None,
        skip_search: bool = False,
    ):
        if _tuuid is None:
            existing = existing_task(path, TASK_PATH)
            if existing:
                return existing
        if _tuuid:
            _uuid = _tuuid
        else:
            _uuid = str(uuid.uuid4())

        existing_path = TASK_PATH / f'{_uuid}.json'
        existing_data = normalize_task(json.loads(existing_path.read_text(encoding='utf-8'))) if existing_path.exists() else {}
        self._task_metadata = {key: existing_data[key] for key in
                               ('schema_version', 'layout', 'metadata_source', 'subject_id', 'migration', 'platform')
                               if key in existing_data}
        selected = getattr(self, 'selected_subject_ids', [])
        if isinstance(selected, list):
            self._task_metadata['subject_ids'] = selected
        if not existing_data:
            self._task_metadata.update(
                schema_version=2,
                layout='bangumi' if not skip_search and not cus_tmdb_id and _is_anime is not False
                and not self.ai_processor.ai_client.is_available() else 'legacy',
            )
        self.R = {}

        use_tmdb = (
            not skip_search
            and (
                bool(str(cus_tmdb_id or '').strip())
                or _is_anime is False
            )
        )
        if use_tmdb and not self.search.TMDB_KEY:
            return self.error_reply(
                _uuid,
                '你还没有配置TMDB的Key！任务失败！请先前往配置界面！',
                path,
                _is_anime,
                _is_movie,
                cus_name,
                cus_season_id,
                cus_subtitle_group,
                cus_year,
                tmdb_id=cus_tmdb_id,
                bgm_id=cus_bgm_id,
                skip_search=skip_search,
            )

        # 【Step.0】 开始处理
        logger.info(f'[处理任务] 开始处理{path.name}')

        # 【Step.1】
        # 如果该路径不是一个视频文件或者不是一个文件夹, 则跳过
        if path.is_file() and path.suffix.lower() not in VIDEO_SUFFIX:
            logger.info(f'[处理任务] {path.name} 不是一个视频文件, 跳过')
            return

        subtitle_group = self.resolve_subtitle_group(path, cus_subtitle_group)

        # 【Step.1.5】
        # 判断类型是否为电影，并在必要时回退到 skip 模式搜索名
        if not skip_search:
            self.search.defer_episodes = (self._task_metadata.get('layout') == 'bangumi'
                                         and not self.ai_processor.ai_client.is_available())
        progress('识别作品与搜索条目')
        task_type_result = self.resolve_task_type(
            _uuid,
            path,
            _is_anime,
            _is_movie,
            cus_name,
            cus_year,
            cus_tmdb_id,
            cus_bgm_id,
            skip_search,
        )
        if isinstance(task_type_result, str):
            if (task_type_result.startswith('[Bangumi]') and not cus_bgm_id and not cus_tmdb_id
                    and not cus_name and not skip_search):
                discover_ambiguous(path, self.search)
            return self.error_reply(
                _uuid,
                task_type_result,
                path,
                _is_anime,
                _is_movie,
                cus_name,
                cus_season_id,
                cus_subtitle_group,
                cus_year,
                tmdb_id=cus_tmdb_id,
                bgm_id=cus_bgm_id,
                skip_search=skip_search,
            )

        rtpath_name, _, task_type = task_type_result
        logger.info(f'[处理任务] 去除标签后: {rtpath_name}')

        name, info, is_anime, is_movie = (
            task_type[0],
            task_type[1],
            task_type[2],
            task_type[3],
        )
        resolved_year = self.resolve_detected_year(info, cus_year)
        resolved_bgm_id = self.resolve_detected_bgm_id(info, cus_bgm_id)
        if info.get('source') == 'bgm':
            self._task_metadata.update(metadata_source='bangumi', subject_id=resolved_bgm_id,
                                       platform=info.get('platform') or '')

        output_dir_path: Optional[Path] = None
        manual_mode = bool(skip_search)
        native = (info.get('source') == 'bgm' and existing_data.get('layout') != 'legacy'
                  and not self.ai_processor.ai_client.is_available())
        native_context = {}

        if native:
            self._task_metadata.update(schema_version=2, layout='bangumi', metadata_source='bangumi',
                                       subject_id=str(info['id']))
            progress('获取完整章节')
            catalog = self.search.get_bangumi_all_episodes(info['id'])
            if catalog is None:
                return self.error_reply(
                    _uuid, self.search.last_error or '[Bangumi] 无法获取完整章节列表',
                    path, is_anime, is_movie, name, None, subtitle_group,
                    resolved_year, cus_tmdb_id, resolved_bgm_id,
                )
            info['bangumi_episodes'] = catalog
            progress('获取关联条目')
            relations = self.search.get_bangumi_relations(info['id'])
            # One-episode OVA subjects remain subjects, not inferred movies.
            is_movie = str(info.get('platform') or '').upper() in {'剧场版', 'MOVIE', '电影'}
            base = self.ANIME_MOVIE_PATH if is_movie else self.ANIME_PATH
            work_path = subject_directory(base, {**info, 'first_air_date': resolved_year})
            progress('扫描文件与匹配章节')
            self.R, decisions = plan_subject(path, info, work_path, subtitle_group)
            regular_pending = [row for row in decisions if row.get('category') == 'unresolved'
                               and row.get('episode_type') in (None, 0) and row.get('episode') is not None]
            from .subject_discovery import _regular_numbers, _whole_episode
            main_numbers = _regular_numbers(catalog)
            pending_numbers = [_whole_episode(row.get('episode')) for row in regular_pending]
            overflow = (main_numbers and pending_numbers and
                        all(n is not None and n > max(main_numbers) for n in pending_numbers))
            if (not cus_bgm_id and len(regular_pending) >= 2 and overflow
                    and self.search.requested_season is None
                    and not any(row.get('episode_id') for row in decisions)):
                self._task_metadata.pop('subject_id', None)
                return self.error_reply(
                    _uuid, '[Bangumi] 片名候选的章节目录无法解释本地集号，请确认季别或归属作品',
                    path, is_anime, is_movie, name, None, subtitle_group, resolved_year,
                    cus_tmdb_id, None)

            season_id = None
            output_dir_path = work_path
            self._task_metadata.update(
                schema_version=2, layout='bangumi', metadata_source='bangumi',
                subject_id=str(info['id']), episode_bindings=decisions, relations=relations,
            )
            native_context = {'layout': 'bangumi', 'subject_id': str(info['id']),
                              'platform': info.get('platform'),
                              'first_air_date': info.get('first_air_date') or resolved_year,
                              'anime_path': str(self.ANIME_PATH),
                              'anime_movie_path': str(self.ANIME_MOVIE_PATH),
                              'episodes': catalog, 'bindings': decisions,
                              'task_metadata': dict(self._task_metadata)}
            if not selected or len(selected) == 1:
                suggestions = related_candidates(decisions, relations)
                suggestions.extend(sequel_candidates(decisions, catalog, relations, self.search))
                if suggestions:
                    native_context['suggested_subjects'] = suggestions
                    prioritize(self.search, suggestions)
            if isinstance(selected, list) and len(selected) > 1:
                from .subject_selection import unresolved_bindings
                from .plan_resolution import load_subject_context
                progress('载入已选择的归属作品')
                subjects = {sid: load_subject_context(self.search, sid, native_context)
                            for sid in selected if sid != str(info['id'])}
                decisions = unresolved_bindings(decisions)
                # The first ID only anchors the plan schema, never file ownership.
                self.R = {}
                self._task_metadata.update(subject_ids=selected, episode_bindings=decisions,
                    selected_subjects=[{'id': str(info['id']), 'name': name},
                                       *[{'id': sid, 'name': subject['name']} for sid, subject in subjects.items()]])
                native_context.update(subjects=subjects, bindings=decisions,
                    requires_subject_assignment=True, task_metadata=dict(self._task_metadata))

        # 【Step.2】
        # 如果是电影
        elif is_movie:
            if not name:
                logger.warning(f'[处理任务] 未搜索到电影信息, 跳过{rtpath_name}')
                return self.error_reply(
                    _uuid,
                    f'[TMDB] 未搜索到电影信息, 跳过{rtpath_name}',
                    path,
                    is_anime,
                    is_movie,
                    name,
                    None,
                    subtitle_group,
                    cus_year,
                    tmdb_id=cus_tmdb_id,
                    bgm_id=cus_bgm_id,
                    skip_search=skip_search,
                )

            if is_anime:
                _WORK_PATH = self.ANIME_MOVIE_PATH
            else:
                _WORK_PATH = self.MOVIE_PATH

            first_data = info['release_date']
            first_year = first_data.split('-')[0]
            work_path = _WORK_PATH / sanitize_path_component(
                f'{name} ({first_year})'
            )
            if path.is_file():
                target_path = work_path / self.get_movie_filename(
                    name,
                    subtitle_group,
                    path.suffix,
                )
                self.R[path] = target_path
                local_files = [
                    item for item in source_entries(path.parent) if item.is_file()
                ]
                self._map_associated_files(path, target_path, local_files)
            else:
                local_files = [item for item in source_entries(path) if item.is_file()]
                for item_path in local_files:
                    if item_path.suffix.lower() in VIDEO_SUFFIX:
                        target_path = work_path / self.get_movie_filename(
                            name,
                            subtitle_group,
                            item_path.suffix,
                        )
                        if target_path in self.R.values():
                            target_path = work_path / item_path.name
                        self.R[item_path] = target_path
                        self._map_associated_files(
                            item_path,
                            target_path,
                            local_files,
                        )
                    elif item_path not in self.R:
                        self.R[item_path] = work_path / item_path.name
            season_id = 0
            output_dir_path = self.get_output_directory(work_path, True, season_id)
        # 如果是剧集类型
        else:
            if is_anime:
                if not name:
                    logger.info('[处理任务] TMDB未搜索到!转为MyAnimeList搜索！')
                    search_result = self.jikan.search(
                        'anime',
                        rtpath_name,
                        page=1,
                    )
                    for i in search_result['data']:
                        if i['type'] == 'Anime':
                            data = i
                            break
                    else:
                        for i in search_result['data']:
                            if i['type'] == 'TV':
                                data = i
                                break
                        else:
                            data = search_result['data'][0]
                    titles = data['titles']
                    logger.info((f'[处理任务] MyAnimeList识别结果: {titles}'))
                else:
                    titles = None
                _WORK_PATH = self.ANIME_PATH
            else:
                titles = [{'type': 'Default', 'title': name}]
                _WORK_PATH = self.BANGUMI_PATH

            if not name:
                logger.warning(f'[处理任务] 未搜索到剧集信息, 跳过{rtpath_name}')
                return self.error_reply(
                    _uuid,
                    f'[Bangumi] 未搜索到剧集信息, 跳过{rtpath_name}',
                    path,
                    is_anime,
                    is_movie,
                    name,
                    None,
                    subtitle_group,
                    cus_year,
                    tmdb_id=cus_tmdb_id,
                    bgm_id=cus_bgm_id,
                    skip_search=skip_search,
                )

            first_data: str = info['first_air_date']
            first_year = first_data.split('-')[0]
            work_path = _WORK_PATH / sanitize_path_component(
                f'{name} ({first_year})'
            )

            if manual_mode:
                if cus_season_id is None or str(cus_season_id).strip() == '':
                    return self.error_reply(
                        _uuid,
                        '[手动模式] 请填写季度',
                        path,
                        is_anime,
                        is_movie,
                        name,
                        season_id=None,
                        subtitle_group=subtitle_group,
                        year=resolved_year,
                        tmdb_id=cus_tmdb_id,
                        bgm_id=resolved_bgm_id,
                        skip_search=skip_search,
                    )
                try:
                    season_id = int(cus_season_id)
                except (TypeError, ValueError):
                    return self.error_reply(
                        _uuid,
                        f'[手动模式] 非法季度: {cus_season_id}',
                        path,
                        is_anime,
                        is_movie,
                        name,
                        season_id=None,
                        subtitle_group=subtitle_group,
                        year=resolved_year,
                        tmdb_id=cus_tmdb_id,
                        bgm_id=resolved_bgm_id,
                        skip_search=skip_search,
                    )
                if season_id <= 0:
                    return self.error_reply(
                        _uuid,
                        f'[手动模式] 非法季度: {cus_season_id}',
                        path,
                        is_anime,
                        is_movie,
                        name,
                        season_id=None,
                        subtitle_group=subtitle_group,
                        year=resolved_year,
                        tmdb_id=cus_tmdb_id,
                        bgm_id=resolved_bgm_id,
                        skip_search=skip_search,
                    )
            else:
                season_id = self.get_season_id(
                    info,
                    work_path,
                    path,
                    titles,
                )

                if cus_season_id:
                    season_id = int(cus_season_id)

            output_dir_path = self.get_output_directory(
                work_path,
                False,
                season_id,
            )

            # 【AI增强处理】
            # 如果是动漫且启用了AI，使用AI分析文件映射
            if (
                is_anime
                and not manual_mode
                and self.ai_processor.ai_client.is_available()
            ):
                logger.info("[处理任务] 启用AI分析动漫文件映射")
                if info.get('source') == 'bgm':
                    logger.info("[处理任务] 使用 Bangumi 季集信息")
                    tv_info = info
                else:
                    logger.info("[处理任务] 填充详细季信息")
                    tv_info = self.search.fill_season_info(info)
                ai_result: AIAnalysisResult | None = (
                    self.ai_processor.analyze_anime_files(path, tv_info)
                )

                # 检查AI置信度阈值
                confidence_threshold = cm.get_config("ai_confidence_threshold")
                should_use_ai = False

                if ai_result:
                    if (
                        confidence_threshold == "High"
                        and ai_result.confidence == "High"
                    ):
                        should_use_ai = True
                    elif confidence_threshold == "Medium" and ai_result.confidence in [
                        "High",
                        "Medium",
                    ]:
                        should_use_ai = True
                    elif confidence_threshold == "Low":
                        should_use_ai = True

                if should_use_ai and ai_result:
                    logger.info("[处理任务] 使用AI分析结果进行文件映射")
                    # AI流程独立生成映射，不再需要传统方法预处理
                    self.R = self.ai_processor.apply_ai_mapping(
                        ai_result=ai_result,
                        base_path=path,
                        work_path=work_path,
                    )
                    # 如果AI没有返回任何有效映射，则回退到传统方法
                    if not self.R:
                        logger.warning(
                            "[处理任务] AI未返回有效映射，回退到传统方法处理"
                        )
                        self._process_traditional(
                            path,
                            rtpath_name,
                            work_path,
                            name,
                            season_id,
                            subtitle_group,
                            info,
                        )
                    else:
                        self._map_sp_extra_folders(path, work_path)
                else:
                    logger.info("[处理任务] AI置信度不足或AI结果无效，使用传统方法处理")
                    self._process_traditional(
                        path,
                        rtpath_name,
                        work_path,
                        name,
                        season_id,
                        subtitle_group,
                        info,
                    )
            else:
                # 传统处理方式
                self._process_traditional(
                    path,
                    rtpath_name,
                    work_path,
                    name,
                    season_id,
                    subtitle_group,
                    info,
                )

        video_targets = [target for source, target in self.R.items()
                         if source.suffix.lower() in VIDEO_SUFFIX]
        for category in ('Season 0', 'extra'):
            category_path = work_path / category
            if video_targets and all(target.is_relative_to(category_path) for target in video_targets):
                output_dir_path = category_path
                break

        task_path = TASK_PATH / f"{_uuid}.json"
        task_data = self.build_task_data(
            path=path,
            uuid_value=_uuid,
            is_anime=is_anime,
            is_movie=is_movie,
            name=name,
            season_id=season_id,
            subtitle_group=subtitle_group,
            year=resolved_year,
            tmdb_id=cus_tmdb_id,
            bgm_id=resolved_bgm_id,
            output_dir=output_dir_path,
            error=None,
            use_ai=bool(
                is_anime
                and not manual_mode
                and self.ai_processor.ai_client.is_available()
            ),
            skip_search=skip_search,
        )
        progress('检查并生成整理方案')
        trans_result = Trans(self.R, _uuid, source_root=path, plan_context={
            'name': name, 'work_path': str(work_path), 'is_movie': is_movie,
            'subtitle_group': subtitle_group,
            **native_context,
            **({'source_files': list(map(str, selected_paths()))} if selected_paths() is not None else {}),
        }).trans_file()
        self.R = {}
        if isinstance(trans_result, str):
            return self.error_reply(
                _uuid,
                trans_result,
                path,
                is_anime,
                is_movie,
                name,
                season_id,
                subtitle_group,
                resolved_year,
                cus_tmdb_id,
                resolved_bgm_id,
                skip_search=skip_search,
            )
        with open(task_path, "w", encoding="UTF-8") as file:
            json.dump(task_data, file, indent=4, ensure_ascii=False)
        return True

    def _process_traditional(
        self,
        path: Path,
        rtpath_name: str,
        work_path: Path,
        bangumi_name: str,
        season_id: int,
        subtitle_group: str,
        tv_info: Optional[Dict] = None,
    ):
        """传统处理方式"""
        candidates = source_entries(path.parent) if path.is_file() else source_entries(path, recursive=True)
        videos = [item for item in candidates if item.is_file()
                  and item.suffix.lower() in VIDEO_SUFFIX
                  and not any(tag in item.name for tag in IGNORE_DIR)]
        standalone_ova = bool(videos) and all(
            (match := NUMBERED_OVA.search(item.stem)) and int(match.group(1)) > 0
            for item in videos
        )
        if path.is_file():
            logger.info(f"[处理任务] 开始对 [单文件] {path.name}处理")
            local_files = [item for item in source_entries(path.parent) if item.is_file()]
            self.process_sub(
                rtpath_name,
                None,
                path,
                local_files,
                work_path,
                bangumi_name,
                season_id,
                subtitle_group,
                tv_info,
                None,
                standalone_ova,
            )
        else:
            def process_folder(folder):
                if is_sp_extra_dir_name(folder.name):
                    self._map_extra_folder_files(folder, work_path)
                    return
                if is_special_dir_name(folder.name):
                    self._map_special_folder_files(folder, work_path)
                    return
                local_files = [item for item in source_entries(folder) if item.is_file()]
                repeat = find_unique_parts_in_videos(folder)
                majority = self._get_folder_majority_season(
                    local_files, rtpath_name, season_id, tv_info,
                )
                for item in source_entries(folder):
                    if item.is_dir():
                        process_folder(item)
                    else:
                        self.process_sub(
                            rtpath_name, repeat, item, local_files, work_path,
                            bangumi_name, season_id, subtitle_group, tv_info,
                            majority, standalone_ova,
                        )

            process_folder(path)

    def build_task_data(
        self,
        path: Path,
        uuid_value: str,
        is_anime: Optional[bool],
        is_movie: Optional[bool],
        name: Optional[str],
        season_id: Optional[int],
        subtitle_group: Optional[str] = None,
        year: Optional[str] = None,
        tmdb_id: Optional[str] = None,
        bgm_id: Optional[str] = None,
        output_dir: Optional[Path] = None,
        error: Optional[str] = None,
        use_ai: bool = False,
        skip_search: bool = False,
    ) -> Dict[str, Any]:
        search = getattr(self, 'search', None)
        candidates = getattr(search, 'last_bangumi_candidates', [])
        warnings = getattr(search, 'recall_warnings', [])
        return {
            **getattr(self, '_task_metadata', {}),
            **({'source_files': list(map(str, selected_paths()))} if selected_paths() is not None else {}),
            'path': str(path),
            'is_anime': is_anime,
            'is_movie': is_movie,
            'name': name,
            'season_id': season_id,
            'year': str(year or ''),
            'skip_search': bool(skip_search),
            'output_dir': str(output_dir) if output_dir else '',
            'tmdb_id': tmdb_id or '',
            'bgm_id': bgm_id or '',
            'subtitle_group': subtitle_group or '',
            'uuid': str(uuid_value),
            'error': error,
            'use_ai': bool(use_ai),
            'bangumi_candidates': candidates if isinstance(candidates, list) else [],
            'recall_warnings': warnings if isinstance(warnings, list) else [],
        }

    def error_reply(
        self,
        _uuid: str,
        error: str,
        path: Path,
        is_anime: Optional[bool] = None,
        is_movie: Optional[bool] = None,
        name: Optional[str] = None,
        season_id: Optional[int] = None,
        subtitle_group: Optional[str] = None,
        year: Optional[str] = None,
        tmdb_id: Optional[str] = None,
        bgm_id: Optional[str] = None,
        skip_search: bool = False,
    ):
        task_path = TASK_PATH / f'{_uuid}.json'
        task_data = self.build_task_data(
            path=path,
            uuid_value=_uuid,
            is_anime=is_anime,
            is_movie=is_movie,
            name=name,
            season_id=season_id,
            subtitle_group=subtitle_group,
            year=year,
            tmdb_id=tmdb_id,
            bgm_id=bgm_id,
            output_dir=None,
            error=error,
            use_ai=bool(
                is_anime
                and not skip_search
                and self.ai_processor.ai_client.is_available()
            ),
            skip_search=skip_search,
        )
        if error.startswith('[Bangumi]'):
            task_data['bangumi_candidates'] = getattr(self.search, 'last_bangumi_candidates', [])
        with open(task_path, 'w', encoding='UTF-8') as file:
            json.dump(task_data, file, indent=4, ensure_ascii=False)
        return error
