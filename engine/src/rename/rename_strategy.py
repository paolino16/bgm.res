"""Deterministic version names and same-directory companion handling."""

import re
import unicodedata
from collections import defaultdict
from pathlib import Path

from .preflight import path_key
from .utils import VIDEO_SUFFIX, sanitize_path_component


def companions(source: Path, candidates):
    candidates = list(candidates)
    longer_stems = [p.stem for p in candidates if p.parent == source.parent
                    and p.suffix.lower() in VIDEO_SUFFIX and len(p.stem) > len(source.stem)]
    return [p for p in candidates if p.parent == source.parent and p != source
            and p.suffix.lower() not in VIDEO_SUFFIX and p.name.startswith(source.stem + '.')
            and not any(p.name.startswith(stem + '.') for stem in longer_stems)]


def retarget(mapping, source, target, candidates):
    mapping[source] = target
    for companion in companions(source, candidates):
        mapping[companion] = target.parent / (target.stem + companion.name[len(source.stem):])


def append_version(target, version):
    version = str(version or '').strip()
    if not version:
        return target
    # The label is inside brackets, so a period in "Ver." is not a trailing
    # filename period and should survive Windows path sanitization.
    label = sanitize_path_component(f'[{version}]')
    return target.with_name(f'{target.stem} {label}{target.suffix}')


def custom_filename(source, title, subtitle_group=''):
    """Complete a reviewed title without changing the original media type."""
    source = Path(source)
    title = str(title or '').strip()
    if not title or any(char in title for char in '<>:"/\\|?*') or any(ord(c) < 32 for c in title) or title.rstrip(' .') != title:
        raise ValueError(f'{source.name}：目标文件名不能包含路径或非法字符')
    if re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', title):
        raise ValueError(f'{source.name}：文件名是 Windows 保留名称')
    extension = Path(title).suffix
    if extension.lower() == source.suffix.lower():
        title = title[:-len(extension)].rstrip()
    elif extension.lower() in set(VIDEO_SUFFIX) | {'.exe', '.com', '.bat', '.cmd', '.ps1', '.txt', '.nfo', '.ass', '.srt', '.ssa', '.zip', '.rar', '.7z', '.iso', '.flac', '.aac'}:
        raise ValueError(f'{source.name}：扩展名自动沿用原视频 {source.suffix}，不能改为 {extension}')
    if not title:
        raise ValueError('请填写自定义标题')
    if re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', title):
        raise ValueError(f'{source.name}：文件名是 Windows 保留名称')
    group = str(subtitle_group or '').strip().strip('[]［］').strip()
    if group:
        normalized = unicodedata.normalize('NFKC', title).casefold()
        labels = re.findall(r'\[([^\]]+)\]', normalized)
        wanted = unicodedata.normalize('NFKC', group).casefold().strip()
        if wanted not in {label.strip() for label in labels}:
            title += ' ' + sanitize_path_component(f'[{group}]')
    return title + source.suffix


def edition_label(source):
    """Keep explicit cut/edition labels, without treating encoding tags as cuts."""
    for pattern in (r'\(([^()\[\]]+)\)', r'\[([^()\[\]]+)\]', r'（([^（）]+)）'):
        for label in re.findall(pattern, source.stem):
            label = re.sub(r'\s+', ' ', label).strip()
            if re.search(r'(?i)\b(?:ver(?:sion)?\.?|edition|cut)$', label):
                return label
    return ''


def _episode_hint(source):
    code = re.search(r'(?i)S(\d+)E(\d+)', source.stem)
    if code:
        return int(code.group(1)), int(code.group(2))
    explicit = re.search(r'(?i)\b(?:episode|ep|e)[ ._-]*(\d{1,3})(?:v\d+)?(?![a-z0-9])', source.stem)
    if explicit:
        return None, int(explicit.group(1))
    numbers = re.findall(r'(?i)(?<![a-z0-9])(\d{1,3})(?:v\d+)?(?![a-z0-9])', source.stem)
    return (None, int(numbers[0])) if len(numbers) == 1 else (None, None)


def distinguish_versions(mapping):
    """Preserve named editions, then resolve remaining explicit release collisions."""
    result = dict(mapping)
    versions = {}
    original_groups = defaultdict(list)
    for source, target in mapping.items():
        if source.suffix.lower() in VIDEO_SUFFIX:
            original_groups[path_key(target)].append(source)
    for source, target in mapping.items():
        if source.suffix.lower() not in VIDEO_SUFFIX:
            continue
        edition = edition_label(source)
        if edition and edition_label(target).casefold() != edition.casefold():
            sources = original_groups[path_key(target)]
            if len(sources) > 1 and re.search(r'(?i)S\d+E\d+', target.stem):
                hints = [_episode_hint(item) for item in sources]
                if (any(episode is None for _, episode in hints)
                        or len({episode for _, episode in hints}) != 1
                        or len({season for season, _ in hints if season is not None}) > 1):
                    continue
            retarget(result, source, append_version(target, edition), mapping)
            versions[source] = edition
    groups = defaultdict(list)
    for source, target in result.items():
        if source.suffix.lower() in VIDEO_SUFFIX:
            groups[path_key(target)].append(source)
    for sources in groups.values():
        if len(sources) < 2:
            continue
        if re.search(r'(?i)S\d+E\d+', mapping[sources[0]].stem):
            hints = [_episode_hint(source) for source in sources]
            if (any(episode is None for _, episode in hints)
                    or len({episode for _, episode in hints}) != 1
                    or len({season for season, _ in hints if season is not None}) > 1):
                # Different/unknown episode identities need a human correction,
                # even when quality or group tags happen to differ.
                continue
        signatures = []
        any_version = any(re.search(r'(?i)(?<![a-z0-9])v\d+(?!\d)', p.stem) for p in sources)
        for source in sources:
            group = re.match(r'^\[([^\[\]]+)\]', source.stem)
            group = group.group(1).strip() if group else ''
            if re.search(r'(?i)\d{3,4}[pi]|x26[45]|hevc|flac|bd.?rip', group) or group.isdigit():
                group = ''
            quality = re.search(r'(?i)(?<!\d)(480|576|720|1080|1440|2160|4320)[pi](?![a-z])', source.stem)
            version = re.search(r'(?i)(?<![a-z0-9])(v\d+)(?!\d)', source.stem)
            tokens = [group, quality.group().lower() if quality else '',
                      version.group(1).lower() if version else ('v1' if any_version else '')]
            signatures.append(' '.join(token for token in tokens if token))
        if not all(signatures) or len({s.casefold() for s in signatures}) != len(sources):
            continue
        for source, signature in zip(sources, signatures):
            target = append_version(result[source], signature)
            retarget(result, source, target, mapping)
            versions[source] = ' '.join(part for part in (versions.get(source), signature) if part)
    changes = [{'source': str(source), 'target': str(result[source]), 'version': version}
               for source, version in versions.items()]
    return result, changes
