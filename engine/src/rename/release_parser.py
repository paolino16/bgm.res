"""Conservative filename evidence, before subject/episode matching.

Spans refer to the original stem; unknown blocks stay visible. This parser never
assigns a Bangumi episode or changes an explicit user decision.
"""
import re
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from .utils import EXTRA_TAG

BLOCK = re.compile(r'\[([^\[\]]*)\]|【([^【】]*)】|\(([^()]*)\)')
TECH = re.compile(r'(?i)(?:(?<![a-z0-9])(?:BDRIP|BDREMUX|BD|DVD|DVDRIP|WEB[- .]?DL|WEBRIP|'
                  r'HEVC|AVC|[HX][ ._-]?26[45]|XVID|FLAC|AAC|AC3|DTS|OPUS|'
                  r'MA10P|HI10P|8BIT|10BIT|YUV\w*|MKV|MP4)(?![a-z0-9])|'
                  r'(?<!\d)\d{3,4}\s*[x×]\s*\d{3,4}(?!\d)|(?<![a-z0-9])\d{3,4}[pi](?![a-z0-9]))')
EXPLICIT = re.compile(r'(?i)(?<![a-z0-9])(?:(s\d+)e|(extra[ ._-]+episode|special|sp|ncop|nced|op|ed|pv|ep|e|ova|oad)[ ._-]*)(\d{1,3}(?:\.\d+)?)(?:v\d+)?(?![a-z0-9])')

INTERVIEW = re.compile(r'(?i)(?<![a-z0-9])(?:IV[ ._-]*\d{1,3}|interviews?(?:[ ._-]*\d{1,3})?)(?![a-z0-9])')
EXTRA_CONTENT = re.compile(
    r'(?i)(?<![a-z0-9])(?:menu(?:[ ._-]*\d{1,3})?|'
    r'making(?:[ ._-]+of)?(?:[ ._-]*\d{1,3})?|behind[ ._-]+the[ ._-]+scenes|'
    r'music[ ._-]+(?:video|clip)|lyric[ ._-]+video|voice[ ._-]+sample|'
    r'game[ ._-]+scene|eye[ ._-]*catch(?:[ ._-]*\d{1,3})?|'
    r'talk[ ._-]+show|BOCCHI[ ._-]+THE[ ._-]+TALK!?|special[ ._-]+studio[ ._-]+live)(?![a-z0-9])|'
    r'(?<![a-z0-9])MV(?:[ ._-]*\d{1,3}|(?=[_ .-]))(?![a-z0-9])|'
    r'[\[【]\s*(?:IV|MV)\s*[\]】]|'
    r'次回予告|番宣|発売告知|特報')
CREDITLESS = re.compile(r'(?i)(?<![a-z0-9])(?:creditless|textless)[ ._-]+(opening|ending|op|ed)'
                        r'(?:[ ._-]*(\d{1,3}))?(?![a-z0-9])')


def content_marker(text):
    return EXTRA_CONTENT.search(text) or INTERVIEW.search(text)


def normalized_number(value):
    return format(Decimal(value).normalize(), 'f')


@dataclass
class Release:
    stem: str
    suffix: str
    fields: list = field(default_factory=list)
    evidence: list = field(default_factory=list)
    conflicts: list = field(default_factory=list)
    kind: object = None
    ordinal: str | None = None
    clean_stem: str = ''


def parse_release(path, *, group='', titles=()):
    path = Path(path)
    result = Release(path.stem, path.suffix)
    masked = list(result.stem)

    def mask(start, end, role):
        result.fields.append({'role': role, 'text': result.stem[start:end], 'start': start, 'end': end})
        masked[start:end] = ' ' * (end - start)

    # Known metadata is stronger than guesses about bracket position.
    for value, role in [(group, 'group'), *((title, 'title') for title in titles)]:
        if not value:
            continue
        pattern = r'[\s._-]+'.join(re.escape(part) for part in re.split(r'[\s._-]+', value))
        for match in re.finditer(r'(?<![a-zA-Z0-9])' + pattern + r'(?![a-zA-Z0-9])', result.stem, re.I):
            mask(*match.span(), role)

    blocks = list(BLOCK.finditer(result.stem))
    for block in blocks:
        text = next(v for v in block.groups() if v is not None).strip()
        if re.fullmatch(r'(?i)[0-9a-f]{8}', text):
            mask(*block.span(), 'checksum')
        elif re.fullmatch(r'(?:19|20)\d{2}', text):
            mask(*block.span(), 'year')
        elif TECH.search(text) and not EXPLICIT.search(text) and not content_marker('[' + text + ']') and not CREDITLESS.search(text) and not any(
                re.search(rf'(?i)(?<![a-z]){re.escape(tag)}(?![a-z])', text) for tag in EXTRA_TAG):
            mask(*block.span(), 'technical')
    # A leading free-text bracket is a release-group candidate only when there
    # are subsequent blocks; never consume a leading [SP01], [01] or [NCOP].
    if len(blocks) >= 2 and not result.stem[:blocks[0].start()].strip():
        first = blocks[0]
        text = ''.join(masked[first.start()+1:first.end()-1]).strip()
        if text and not EXPLICIT.search(text) and not content_marker('[' + text + ']') and not CREDITLESS.search(text) and not re.fullmatch(r'\d+(?:\.\d+)?(?:v\d+)?', text, re.I) and not re.fullmatch(r'(?i)SP|Special|NCOP|NCED|OP|ED|PV', text):
            mask(*first.span(), 'group_candidate')
    # Remove inline technical values individually, leaving adjacent EP markers.
    for match in TECH.finditer(''.join(masked)):
        mask(*match.span(), 'technical')
    clean = ''.join(masked)
    result.clean_stem = clean
    # Explicit non-story content takes precedence over package/usage numbering.
    if marker := content_marker(clean):
        result.kind = 'extra'
        result.evidence = [{'kind': 'extra', 'number': None, 'text': marker.group()}]
        return result
    candidates = []
    explicit_spans = []
    for match in CREDITLESS.finditer(clean):
        kind = 2 if match.group(1).lower() in ('opening', 'op') else 3
        candidates.append((kind, normalized_number(match.group(2)) if match.group(2) else None, match.group()))
        explicit_spans.append(match.span())
    for match in EXPLICIT.finditer(clean):
        season, marker, number = match.groups()
        marker = (marker or '').lower()
        kind = (1 if int(season[1:]) == 0 else 0) if season else {
            'sp': 1, 'special': 1, 'ncop': 2, 'op': 2, 'nced': 3, 'ed': 3, 'pv': 4,
        }.get(marker, 1 if marker.startswith('extra') else None if marker in ('ova', 'oad') else 0)
        candidates.append((kind, normalized_number(number), match.group()))
        explicit_spans.append(match.span())
    extra_marker = re.search(r'(?i)(?<![a-z0-9])(ncop|nced|op|ed|pv)(?![a-z])', clean)
    if extra_marker or CREDITLESS.search(clean):
        # NCED02_EP45 means ending #2 used in episode 45, not main episode 45.
        # SP08_NCED similarly describes a package index rather than ending #8.
        candidates = [c for c in candidates if c[0] in (2, 3, 4)]
    bracket_number = bool(re.search(r'[\[【]\s*\d{1,3}(?:\.\d+)?(?:v\d+)?(?:\s*END)?\s*[\]】]', clean, re.I))
    for pattern in (r'(?:^|\s)-\s*(\d{1,3}(?:\.\d+)?)(?:v\d+)?(?=\s*(?:[\[(]|$|END\b|OVA\b|OAD\b|DC\b|Ver\b))',
                    r'#\s*(\d{1,3}(?:\.\d+)?)(?![\d.])',
                    r'[\[【]\s*(\d{1,3}(?:\.\d+)?)(?:[vV]\d+)?(?:\s*END)?\s*[\]】]',
                    r'第\s*(\d{1,3}(?:\.\d+)?)\s*[话話集]',
                    r'(?:^|[\s_-])(\d{1,3}(?:\.\d+)?)(?:v\d+)?(?=\s*(?:[\[(]|$|END\b))'):
        for match in re.finditer(pattern, clean, re.I):
            if any(match.start(1) >= a and match.end(1) <= b for a, b in explicit_spans):
                continue
            # Bare title sequel numbers are weaker than explicit episode codes.
            if (explicit_spans or extra_marker) and pattern.startswith('(?:^|[\\s_-]'):
                continue
            if bracket_number and pattern.startswith('(?:^|[\\s_-]'):
                continue
            candidates.append((None, normalized_number(match.group(1)), match.group()))
    result.evidence = [{'kind': k, 'number': n, 'text': t} for k, n, t in candidates]
    numbers = {n for _, n, _ in candidates if n is not None}
    kinds = {k for k, _, _ in candidates if k is not None}
    if len(numbers) > 1:
        result.conflicts.append('文件名中有不同集号：' + '、'.join(sorted(numbers)))
    if len(kinds) > 1:
        result.conflicts.append('文件名中有不同章节类型标记')
    if not result.conflicts:
        result.ordinal = next(iter(numbers), None)
        result.kind = next(iter(kinds), None)
        if result.kind is None and re.search(r'(?i)(?<![a-z0-9])(?:special|sp)(?![a-z0-9])', clean):
            result.kind = 1
        for tag in EXTRA_TAG:
            if re.search(rf'(?i)(?<![a-zA-Z\u4e00-\u9fa5]){re.escape(tag)}(?![a-zA-Z\u4e00-\u9fa5])', clean):
                tagged = re.search(r'(?i)(?<![a-z0-9])(ncop|op|nced|ed|pv)(?![a-z])', clean)
                if tagged:
                    result.kind = {'ncop': 2, 'op': 2, 'nced': 3, 'ed': 3, 'pv': 4}[tagged.group(1).lower()]
                else:
                    result.kind, result.ordinal = 'extra', None
                break
    return result
