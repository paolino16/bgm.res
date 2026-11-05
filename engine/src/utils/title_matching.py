"""Shared Unicode title relevance and explicit season intent, without network I/O."""

import re
import unicodedata
from difflib import SequenceMatcher

_CN = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
       '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
_WORDS = {'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5,
          'sixth': 6, 'seventh': 7, 'eighth': 8, 'ninth': 9, 'tenth': 10}
_ROMAN = {'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10}
_SEASON = re.compile(
    r'(?:第\s*(?P<cn>[0-9零〇一二两三四五六七八九十]{1,3})\s*[季期]'
    r'|(?P<bare_cn>[0-9零〇一二两三四五六七八九十]{1,3})\s*[季期](?=$|[\s:：._\-]))'
    r'|(?<![a-z0-9])season[\s._-]*(?P<after>\d{1,2})(?!\d)'
    r'|(?<![a-z0-9])(?P<ordinal>\d{1,2})(?:st|nd|rd|th)[\s._-]+season\b'
    r'|(?<![a-z0-9])(?P<word>first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b'
    r'|(?<![a-z0-9])s(?P<short>\d{1,2})(?=$|[\s._\-\[\]\(\)]|e\d)'
    r'|\s+(?P<roman>VIII|VII|III|VI|IV|IX|II|V|X)\s*$', re.IGNORECASE)
_SPECIAL = re.compile(r'(?i)剧场版|劇場版|特别篇|特別篇|总集篇|総集編|\b(?:movie|ova|oad|specials?)\b')


def normalize_title(text):
    text = unicodedata.normalize('NFKC', str(text or '')).casefold()
    return ''.join(char for char in text if char.isalnum())


def _number(text):
    if text.isdigit():
        return int(text)
    if '十' in text:
        tens, _, ones = text.partition('十')
        return (_CN.get(tens, 1) if tens else 1) * 10 + _CN.get(ones, 0)
    return _CN.get(text, 0)


def title_parts(title):
    text = unicodedata.normalize('NFKC', str(title or '')).casefold()
    matches = list(_SEASON.finditer(text))
    season = None
    if matches:
        match = matches[0]
        for key in ('cn', 'bare_cn', 'after', 'ordinal', 'short'):
            if match.group(key):
                season = _number(match.group(key))
                break
        if match.group('word'):
            season = _WORDS[match.group('word')]
        if match.group('roman'):
            season = _ROMAN[match.group('roman').lower()]
    base = normalize_title(_SPECIAL.sub('', _SEASON.sub('', text)))
    # A marker-only title must not become a universal empty-string match.
    return base, season, bool(_SPECIAL.search(text))


def season_hint(title):
    return title_parts(title)[1]


def candidate_season(titles, fallback=None):
    seasons = [season_hint(title) for title in titles]
    try:
        fallback = int(fallback) if fallback is not None else None
    except (TypeError, ValueError):
        fallback = None
    return max((season for season in seasons if season is not None), default=fallback)


def _romanized_words(text):
    """Keep word boundaries for Latin titles; separators may vary by release."""
    text = unicodedata.normalize('NFKC', str(text or '')).casefold()
    text = _SPECIAL.sub('', _SEASON.sub('', text))
    # Apostrophes inside a word are commonly omitted in romanized releases.
    text = re.sub(r"(?<=[a-z])['’](?=[a-z])", '', text)
    if any(char.isalpha() and not ('a' <= char <= 'z') for char in text):
        return None
    return re.findall(r'[a-z0-9]+', text)


def _romanized_grade(query_words, title_words, base_query, base_title):
    # Joined spelling is safe only for a complete title, never a substring.
    if base_query == base_title or query_words == title_words:
        return 5
    if not title_words:
        return 0
    size = len(query_words)
    for offset in range(len(title_words) - size + 1):
        if title_words[offset:offset + size] == query_words:
            return 4 if offset == 0 else 3
    return 0


def title_score(titles, query, *, year=0, date='', fallback_season=None, requested_season=None):
    titles = [str(title) for title in titles if title]
    query = str(query or '').strip()
    if not titles or not normalize_title(query):
        return (0,) * 8
    _, query_season, query_special = title_parts(query)
    query_season = query_season if query_season is not None else requested_season
    season = candidate_season(titles, fallback_season)
    if query_season is not None:
        season_fit = 3 if season == query_season or (season is None and query_season == 1) else 1 if season is None else 0
    else:
        season_fit = 3 if season is None else 2 if season == 1 else -season
    year_match = bool(year and str(date).startswith(str(year)))
    intent = (season_fit, int(year_match)) if query_season is not None else (int(year_match), season_fit)
    best = (0, 0, 0, 0, 0, 0)
    for variant in re.split(r'[/／|]', query):
        full_query = normalize_title(variant)
        base_query, _, _ = title_parts(variant)
        query_words = _romanized_words(variant)
        if not full_query or not base_query:
            continue
        for title in titles:
            full_title = normalize_title(title)
            base_title, _, special = title_parts(title)
            if not base_title:
                continue
            ratio = SequenceMatcher(None, base_query, base_title).ratio()
            title_words = _romanized_words(title)
            if query_words:
                grade = _romanized_grade(query_words, title_words or [], base_query, base_title)
                # Fuzzy spelling can rank suggestions but cannot authorize selection.
                if not grade and len(base_query) >= 5 and ratio >= .8:
                    grade = 1
            elif base_title == base_query:
                grade = 5
            elif base_title.startswith(base_query):
                grade = 4
            elif base_query in base_title or (base_title in base_query and len(base_title) >= .6 * len(base_query)):
                grade = 3
            else:
                tokens = re.findall(r'[^\W_]+', variant.casefold())
                grade = 2 if len(tokens) > 1 and all(normalize_title(t) in full_title for t in tokens) else 1 if len(base_query) >= 5 and ratio >= .8 else 0
            lexical = (grade, int(full_title == full_query),
                       int(unicodedata.normalize('NFKC', title).casefold().strip() == variant.casefold().strip()),
                       int(special == query_special), ratio, -abs(len(base_title) - len(base_query)))
            best = max(best, lexical)
    return (best[0], *intent, *best[1:])


def relevant(titles, query, *, fallback_season=None):
    # Local list search accepts normalized containment/token matches, not fuzzy guesses.
    requested = season_hint(query)
    season = candidate_season(titles, fallback_season)
    if requested is not None and (season if season is not None else 1) != requested:
        return False
    return title_score(titles, query)[0] >= 2
