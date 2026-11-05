"""Cross-catalog title scoring following Bangumi-To Romaji Title 0.4.1."""
import re
import unicodedata
from functools import lru_cache

_PHRASES = re.compile(r'\d+|[a-z]{2,}|[\u3400-\u9fff々]+|[\u3040-\u309fー]+|[\u30a0-\u30ffー]+')
_FILTER = {'映画', 'アニメ', '第', 'st', 'nd', 'rd', 'th', 'season', '章', '編'}
_PREFIX = re.compile(r'^(((劇場版?)?総集|特別|短)編|(映画|劇場|同人)版?)\s*|.?(Official )?Music Video.?', re.I)


def clean_evidence(entries):
    """Only adopted cross-catalog links are user-facing evidence; deduplicate."""
    unique = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get('source') == 'tenrai' and (not entry.get('verified') or entry.get('match_score', 0) < 2.5):
            continue
        key = (entry.get('source'), entry.get('mal_id'), entry.get('title'), entry.get('english'), entry.get('japanese'))
        if key not in unique or entry.get('match_score', 0) > unique[key].get('match_score', 0):
            unique[key] = entry
    return list(unique.values())


def phrases(title):
    text = unicodedata.normalize('NFKC', str(title or '')).lower()
    return set(_PHRASES.findall(_PREFIX.sub('', text))) - _FILTER


def match_entries(subject, entries):
    """Six title points plus script's date/episode bonuses; 2.5 adoption cutoff.

    Equivalent to its broadened (unfiltered) query, including the 0.5 platform
    penalty. Platform is a search hint rather than a mandatory equality check.
    """
    base = phrases(subject.get('name'))
    scored = []
    for entry in entries:
        other = phrases(entry.get('title_japanese'))
        similarity = len(base & other) / len(base | other) if base | other else 0
        if similarity:
            scored.append([entry, 6 * similarity])
    day = str(subject.get('date') or '')
    if not day:
        for row in scored:
            row[1] += 1
    else:
        year = [row for row in scored if str((row[0].get('aired') or {}).get('from') or '')[:4] == day[:4]]
        month = [row for row in year if len(day) >= 7 and str((row[0].get('aired') or {}).get('from') or '')[:7] == day[:7]]
        if not month:
            for row in year:
                row[1] += 2
        elif len(month) == 1:
            month[0][1] += 4
        else:
            episodes = subject.get('eps') or subject.get('total_episodes')
            for row in month:
                row[1] += 2 if episodes else 3
            if episodes:
                closest = min(month, key=lambda row: abs(float(row[0].get('episodes') or 0) - float(episodes)))
                closest[1] += 2
    for row in scored:
        if subject.get('platform'):
            row[1] -= .5
    return sorted(scored, key=lambda row: row[1], reverse=True)


@lru_cache(maxsize=4096)
def reading(title):
    if not re.search(r'[\u3040-\u30ff\u3400-\u9fff]', title):
        return ''
    import pykakasi
    return ' '.join(' '.join(part['hepburn'] for part in pykakasi.kakasi().convert(title)).split())
