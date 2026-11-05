"""Bangumi subject/episode planning, independent of TMDB seasons and AI."""

from decimal import Decimal, InvalidOperation
from pathlib import Path

from .rename_strategy import companions
from .utils import VIDEO_SUFFIX, is_special_dir_name, is_sp_extra_dir_name, sanitize_path_component

LAYOUT = 'bangumi'
EPISODE_TYPES = {0: '本篇', 1: '特别篇', 2: 'OP', 3: 'ED', 4: '预告/宣传', 5: 'MAD', 6: '其他'}


def number(value):
    """Use decimal strings throughout; 12.5 must never become episode 12."""
    try:
        result = Decimal(str(value))
        if result.is_finite() and result >= 0:
            return format(result.normalize(), 'f')
    except (InvalidOperation, ValueError):
        pass
    return None


def episode_filename(name, episode, group, suffix):
    label = number(episode['sort'])
    if label is None:
        raise ValueError('章节编号无效')
    whole, dot, fraction = label.partition('.')
    label = whole.zfill(2) + (dot + fraction if dot else '')
    prefix = {0: 'EP', 1: 'SP', 2: 'OP', 3: 'ED', 4: 'PV', 5: 'MAD', 6: 'OTHER'}[int(episode['type'])]
    title = f'{sanitize_path_component(name)} {prefix}{label}'
    if group:
        title += f' [{sanitize_path_component(group)}]'
    return title + suffix


def subject_directory(base, info):
    title = info['name']
    year = str(info.get('first_air_date') or '')[:4]
    date = f' ({year})' if year else ''
    return Path(base) / sanitize_path_component(f'{title}{date}')


def episode_target(work_path, name, episode, group, suffix):
    category = int(episode['type'])
    parent = Path(work_path) if category == 0 else Path(work_path) / ('Specials' if category == 1 else 'Extras')
    return parent / episode_filename(name, episode, group, suffix)


def release_hint(path, root, *, group='', titles=()):
    from .release_parser import parse_release
    parsed = parse_release(path, group=group, titles=titles)
    parents = list(path.relative_to(root).parents) if path.is_relative_to(root) else []
    names = [root.name, *(parent.name for parent in parents if parent.name)]
    if any(is_sp_extra_dir_name(name) for name in names):
        return 'extra', None, parsed
    if parsed.conflicts:
        return 'conflict', None, parsed
    kind = parsed.kind
    if kind is None and any(is_special_dir_name(name) for name in names):
        kind = 1
    return kind, parsed.ordinal, parsed


def file_hint(path, root):
    kind, ordinal, _ = release_hint(path, root)
    return kind, ordinal


def plan_subject(path, info, work_path, group):
    """Return mapping plus explicit decisions; unmatched videos stay unmapped."""
    from .preflight import expected_videos
    root = path if path.is_dir() else path.parent
    from .source_scan import files_in
    files = files_in(root, recursive=path.is_dir())
    videos = expected_videos(path)
    episodes = info.get('bangumi_episodes', [])
    mapping, decisions = {}, []
    for video in videos:
        kind, ordinal, parsed = release_hint(video, root, group=group, titles=(info.get('name', ''), info.get('original_name', '')))
        chosen = None
        if kind not in ('extra', 'conflict'):
            candidates = [ep for ep in episodes if ep['type'] == (kind if kind is not None else 0)]
            matches = [ep for ep in candidates if ordinal is not None and ordinal == number(ep.get('sort'))]
            if not matches and not any(number(ep.get('sort')) is not None for ep in candidates):
                matches = [ep for ep in candidates if ordinal is not None and ordinal == number(ep.get('ep'))]
            if len(matches) == 1:
                chosen = matches[0]
            elif ordinal is None and (len(videos) == 1 or kind in (2, 3, 4)) and len(candidates) == 1:
                chosen = candidates[0]
            if chosen is None and ordinal is None:
                from ..utils.title_matching import normalize_title
                title_matches = [ep for ep in candidates if len(normalize_title(ep.get('name'))) >= 3
                                 and normalize_title(ep['name']) in normalize_title(video.stem)]
                if len(title_matches) == 1:
                    chosen = title_matches[0]
        extra = kind == 'extra' or kind in (2, 3, 4, 5, 6)
        decision = {'source': str(video), 'subject_id': str(info['id']),
                    'episode_id': chosen.get('id') if chosen else None,
                    'episode_type': chosen['type'] if chosen else kind,
                    'episode': chosen.get('sort') if chosen else ordinal,
                    'category': 'episode' if chosen else 'extra' if extra else 'unresolved',
                    'recognition': {'fields': parsed.fields, 'evidence': parsed.evidence, 'conflicts': parsed.conflicts}}
        if chosen:
            target = episode_target(work_path, info['name'], chosen, group, video.suffix)
        elif extra:
            relative = video.relative_to(root)
            # Avoid Extras/extra when the source already contains that container.
            parts = relative.parts
            offset = next((i + 1 for i, part in enumerate(parts[:-1]) if is_sp_extra_dir_name(part)), 0)
            target = Path(work_path) / 'Extras' / Path(*parts[offset:])
        else:
            decisions.append(decision)
            continue
        mapping[video] = target
        for related in companions(video, files):
            mapping[related] = target.with_name(target.stem + related.name[len(video.stem):])
        decisions.append(decision)
    if path.is_dir():
        for resource in files:
            if resource in mapping or resource.suffix.lower() in VIDEO_SUFFIX:
                continue
            relative = resource.relative_to(root)
            parts = relative.parts
            offset = next((i + 1 for i, part in enumerate(parts[:-1]) if is_sp_extra_dir_name(part)), None)
            if is_sp_extra_dir_name(root.name) or offset is not None:
                mapping[resource] = Path(work_path) / 'Extras' / Path(*parts[offset or 0:])
    return mapping, decisions


def collection_episodes(subject, row):
    """Validate an explicit multi-chapter binding without inventing chapters."""
    ids = row.get('episode_ids') or []
    if not isinstance(ids, list) or len(ids) < 2 or len({str(i) for i in ids}) != len(ids):
        raise ValueError('合集请选择至少两个不同的 Bangumi 章节')
    catalog = {str(ep['id']): ep for ep in subject.get('episodes', [])}
    if any(str(i) not in catalog for i in ids):
        raise ValueError('合集包含当前条目中不存在的章节')
    return sorted((catalog[str(i)] for i in ids), key=lambda ep: (int(ep['type']), Decimal(str(ep['sort'])), str(ep['id'])))


def collection_target(work_path, name, episodes, group, suffix):
    title = sanitize_path_component(name)
    if group:
        title += f' [{sanitize_path_component(group)}]'
    return Path(work_path) / '合集' / (title + suffix)
