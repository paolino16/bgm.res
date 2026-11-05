import re
from typing import Dict, List, Tuple


IGNORE_DIR = ['cd', 'scan']
IGNORE_SUFFIX = [
    '.rar',
    '.zip',
    '.7z',
    '.webp',
    '.jpg',
    '.png',
    '.txt',
    '.nfo',
]
EXTRA_TAG = [
    'NCOP',
    'NCED',
    'Menu',
    'Teaser',
    'CM',
    'NC',
    'OP',
    'PV',
    'ED',
    'Advice',
    'Trailer',
    'Event',
    '访谈',
    'Preview',
    'Picture Drama',
    '预告',
    '特典',
    '映像',
]
S0_TAG = [
    r'(?<![a-z0-9])ova(?:[\s._-]?\d{0,3})?(?![a-z0-9])',
    r'(?<![a-z0-9])oad(?:[\s._-]?\d{0,3})?(?![a-z0-9])',
    r'(?<![a-z0-9])special(?:[\s._-]?\d{0,3})?(?![a-z0-9])',
    r'(?<![a-z0-9])sp(?:[\s._-]?\d{0,3})?(?![a-z0-9])',
    r'(?<!\d)\d+\.5(?!\d)',
    r'chaos no kakera',
    r' ver\.'
]
SP_EXTRA_DIR_EXACT_NAMES = [
    'bonus',
    'extra',
    'extras',
]
SP_EXTRA_DIR_PATTERN_PARTS = [
    r'sp(?:[\s._-]?\d{0,3})?',
]
SP_EXTRA_DIR_PATTERN = re.compile(
    '|'.join(
        [
            *(re.escape(name.strip()) for name in SP_EXTRA_DIR_EXACT_NAMES),
            *SP_EXTRA_DIR_PATTERN_PARTS,
        ]
    ),
    re.IGNORECASE,
)
VIDEO_SUFFIX = [
    '.mp4',
    # '.mka',   # 一般来说无需单独分析外挂音轨
    '.mkv',
    '.avi',
    '.wmv',
    '.flv',
    '.mov',
    '.mpg',
    '.mpeg',
    '.m4v',
    '.rm',
    '.rmvb',
]


def is_sp_extra_dir_name(name: str) -> bool:
    normalized = name.strip()
    if not normalized:
        return False
    return SP_EXTRA_DIR_PATTERN.fullmatch(normalized) is not None


def is_special_dir_name(name: str) -> bool:
    return re.fullmatch(
        r'(?:season[\s._-]*0+|s0+|specials?|特别篇|特別篇)',
        name.strip(), re.IGNORECASE,
    ) is not None

keywords = [
    '01',
    '1080P',
    'FLAC',
    '简繁',
    '外挂',
    'MKV',
    'MP4',
    'TV',
    '全集',
    'HEVC',
    '8bit',
    '10bit',
    '720P',
    '2160P',
    '4K',
    'BD',
    'RIP',
    'DBD-raws',
]

bracket_patterns = [
    r'\[.*?\]',
    r'【.*?】',
    r'《.*?》',
    r'<.*?>',
    r'\(.*?\)',
    r'（.*?）',
]
cn_num = {
    '零': 0,
    '一': 1,
    '二': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
    '十': 10,
    '百': 100,
    '千': 1000,
    '万': 10000,
}
season_partten = [
    r' (I{2,3})',
    r' (I{1,3}V)',
    r' (VI{2,3})',
    r'S([\d]{1,2})',
    r'第([\d一二三四五六七八九零]{1,2})(季|部分|部)',
    r'([\d]{1,2})nd Season',
    r'Season ([\d]{1,2})',
    r'(First|Second|Third|Fourth|Fifth) Season',
]
episode_partten = [
    r'[Ee#]([\d]{1,2})',
    r'第([\d一二三四五六七八九零]{1,2})话',
    r'([\d]{1,2})[Ee]pisode',
    r'([\d]{1,2})[Ee]ps',
    r'\[(\d{1,2})\]',
    r'\[(\d{1,2})\]',
]
NUM_MAP = {
    'First': 1,
    'Second': 2,
    'Third': 3,
    'Fourth': 4,
    'Fifth': 5,
}
ROMA_MAP = {
    'II': 2,
    'III': 3,
    'IV': 4,
    'V': 5,
    'VI': 6,
    'VII': 7,
}
code_partten = [
    r'Ma[\d]{1,2}[pP]',
    r'[\d]{3,4}[pP]',
    r'x264|x265',
    r'_flac',
    r'x265',
    r'h264',
    r'h265',
    r'10bit',
    r'8bit',
]


def extract_first_square_bracket_content(text: str) -> str:
    match = re.search(r'\[([^\[\]]+)\]', text)
    if match:
        return match.group(1).strip()
    return ''


def sanitize_path_component(text: str) -> str:
    sanitized = str(text or '').translate(
        str.maketrans(
            {
                '/': '／',
                '\\': '＼',
                ':': '：',
                '*': '＊',
                '?': '？',
                '"': '＂',
                '<': '＜',
                '>': '＞',
                '|': '｜',
            }
        )
    )
    sanitized = sanitized.rstrip(' .')
    return sanitized or '_'


def format_episode_filename(
    bangumi_name: str,
    season: int,
    episode: int,
    subtitle_group: str = '',
    suffix: str = '',
) -> str:
    episode_code = f'S{int(season):02d}E{int(episode):02d}'
    filename = f'{sanitize_path_component(bangumi_name)} {episode_code}'
    if subtitle_group:
        filename = f'{filename} [{sanitize_path_component(subtitle_group)}]'
    return f'{filename}{suffix}'


def get_regular_season_episode_counts(tv_info: Dict) -> List[Tuple[int, int]]:
    season_counts: List[Tuple[int, int]] = []
    for season in tv_info.get('seasons', []):
        season_number = int(season.get('season_number', 0) or 0)
        episode_count = int(season.get('episode_count', 0) or 0)
        if season_number <= 0 or episode_count <= 0:
            continue
        season_counts.append((season_number, episode_count))
    return sorted(season_counts, key=lambda item: item[0])


def remap_episode_by_season_counts(
    season_id: int,
    episode: int,
    season_counts: List[Tuple[int, int]],
    offset: int = 0,
) -> Tuple[int, int, bool]:
    if season_id <= 0 or episode <= 0 or not season_counts:
        return season_id, episode, True

    total_episode_count = sum(count for _, count in season_counts)
    if episode > total_episode_count:
        if episode < 128:
            return season_id, episode, True
        return 0, 0, False

    if season_id != 1:
        return season_id, episode, True

    effective_episode = episode - offset
    if effective_episode <= 0:
        return season_id, episode, True

    remaining_episode = effective_episode
    for mapped_season_id, mapped_count in season_counts:
        if remaining_episode <= mapped_count:
            return mapped_season_id, remaining_episode, True
        remaining_episode -= mapped_count

    return 0, 0, False
