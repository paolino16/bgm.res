"""Offline, journaled migration of all recorded Bangumi outputs."""

import collections
import concurrent.futures
import copy
import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path

from .bangumi_native import file_hint, number, episode_target, subject_directory
from .get_info import Search
from .task_schema import atomic_write
from .utils import VIDEO_SUFFIX, is_special_dir_name, is_sp_extra_dir_name, sanitize_path_component
from ..utils.path import DATA_PATH
from ..utils.utils import extract_record_entries


def read(path):
    return json.loads(Path(path).read_bytes())


def catalog(subject_id, run_dir):
    path = Path(run_dir) / 'catalogs' / f'{int(subject_id)}.json'
    if path.exists():
        return read(path)
    search = Search()
    subject = search.get_bangumi_subject_by_id(int(subject_id))
    if not subject:
        raise ValueError(search.last_error or f'条目 {subject_id} 不可用')
    episodes = search.get_bangumi_all_episodes(int(subject_id))
    if episodes is None:
        raise ValueError(search.last_error or f'章节 {subject_id} 不完整')
    model = {'id': str(subject_id), 'name': subject.get('name_cn') or subject.get('name'),
             'first_air_date': subject.get('date') or '', 'platform': search._extract_bangumi_platform(subject),
             'episodes': episodes, 'subject': subject,
             'relations': search.get_bangumi_relations(int(subject_id))}
    atomic_write(path, model)
    return model


def prefetch(run_dir):
    tasks = [read(path) for path in (DATA_PATH / 'task').glob('*.json')]
    ids = {str(t.get('subject_id') or t.get('bgm_id')) for t in tasks if t.get('bgm_id')}
    ids.update(sid for t in tasks for sid in t.get('subject_ids', []))
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(catalog, sid, run_dir): sid for sid in ids}
        for count, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                future.result()
            except Exception as exc:
                errors.append({'subject_id': futures[future], 'error': str(exc)})
            if count % 20 == 0 or count == len(futures):
                print(json.dumps({'catalogs': count, 'total': len(futures), 'errors': len(errors)}), flush=True)
    atomic_write(Path(run_dir) / 'catalog_errors.json', errors)


def old_root(entries):
    candidates = []
    for entry in entries.values():
        target = Path(entry if isinstance(entry, str) else entry['target'])
        for parent in target.parents:
            if re.search(r'\((?:19|20)\d{2}\)(?:\s*\[bgm-\d+\])?$', parent.name):
                candidates.append(parent)
                break
    if not candidates:
        candidates = [Path(e if isinstance(e, str) else e['target']).parent for e in entries.values()]
    root = Path(os.path.commonpath([str(p) for p in candidates]))
    while re.fullmatch(r'(?i)Season\s*\d+', root.name) or is_special_dir_name(root.name) or is_sp_extra_dir_name(root.name):
        root = root.parent
    if root.parent == root or len(root.parts) < 3:
        raise ValueError('无法推断独立条目目录')
    return root


def raw_hint(source):
    # Parse the actual release filename rather than a previous SxxExx rename.
    cleaned = re.sub(r'\[(?:\d{4,}|[A-Fa-f0-9]{8})\]', '', source.stem)
    cleaned = re.sub(r'(?i)Extra Episode\s*', 'SP', cleaned)
    fake = Path('release') / (cleaned + source.suffix)
    return file_hint(fake, Path('release'))


def choose_episode(source, models, video_count, task, scopes=None):
    from .release_parser import parse_release
    parsed = parse_release(source, group=task.get('subtitle_group', ''), titles=tuple(m.get('name', '') for m in models))
    if parsed.conflicts:
        return None, 'unresolved', None
    kind, ordinal = parsed.kind, parsed.ordinal
    stem = parsed.clean_stem
    if re.search(r'(?i)creditless|\b(?:opening|ending|recap|MV|DVDSpot\d*|VOICES)\b|(?:^|[_\[\s])MV[_\]]|(?:Song|TV)Spot\d*|TV-SPOT|Yokoku|Making\d|Unused Materials|April Fool|CV_Interview|Transforming_Scene|\[EX\]|映像特典|特典|番宣|告知|予告|トレーラー|スボット|Work_World_File|Another Epilogue|クイズ|テスト映像|ピクチャードラマ|お勉強|前夜祭|コンサート|祭|ラッシュビデオ|TVスポット|Genesis 0', stem):
        return None, 'extra', ordinal
    numbers = []
    for match in re.finditer(r'\[\s*(\d{1,3}(?:\.\d+)?)(?:\((\d{1,3}(?:\.\d+)?)\))?\s*\]|(?: - |#)(\d{1,3}(?:\.\d+)?)(?=$|[\s\[(（])', stem):
        numbers.extend(number(part) for part in match.groups() if part is not None)
    # Explicit release numbers outrank years, checksums and title numbers.
    if numbers:
        ordinal = numbers[-1]
    elif kind not in (2, 3, 4, 5, 6) and not re.search(r'(?i)S\d+E\d+|(?:EP(?:ISODE)?|OVA|OAD|SP|Special)[\s._-]*\d|\[\s*\d{1,3}[ (\]]|第\d+[话話集]|(?<!\d)\d{1,3}(?:\s+END)?\s*\[+|\d{1,3}\s*\((?:BD|CR)|\d{1,3}\s*$', stem):
        ordinal = None
    special_folder = any(is_special_dir_name(p.name) or re.fullmatch(r'(?i)SPs?', p.name) for p in source.parents[:3])
    if kind is None and special_folder:
        kind = 1
    if re.search(r'ぷち|(?i:Info\d)', stem):
        kind = 1
    if str(models[0]['platform']).upper() not in {'OVA', 'OAD'} and re.search(r'(?i)(?<![a-z0-9])(?:OVA|OAD)', stem):
        kind = 1
    if ordinal is None:
        bracket = re.search(r'(?i)(?:\b(?:OVA|OAD)\s*\(|#|\[)(\d+(?:\.\d+)?)(?:\)|\])?', stem)
        if bracket:
            ordinal = number(bracket.group(1))
    if kind == 'extra' or kind in (2, 3, 4, 5, 6):
        pool = [(m, ep) for m in models for ep in m['episodes']
                if ep['type'] == kind and (ordinal is None or number(ep['sort']) == ordinal)]
        return (pool[0] if len(pool) == 1 else None), 'extra', ordinal
    pools = [(m, ep) for m in models for ep in m['episodes']]
    regular = [(m, ep) for m, ep in pools if ep['type'] == 0]
    if len(regular) == 1 and re.search(r'(?i)Main[_ ]Movie', stem):
        return regular[0], 'episode', ordinal
    if re.search(r'(?i)Tachikoma[_ ]NA[_ ]Hibi', stem):
        return None, 'special', ordinal
    if (len(regular) == 1 and video_count == 1 and not numbers
            and not re.search(r'(?i)\b(?:OVA|OAD|EP)\s*\d', stem)):
        return regular[0], 'episode', ordinal
    if not regular and video_count == 1 and len(models) == 1:
        return None, 'unindexed_main', ordinal
    # A verified arc scope maps restarted release numbers into catalog numbers.
    if scopes:
        scoped = [(m, ep) for m, ep in pools if ep['id'] in scopes]
        scoped.sort(key=lambda pair: float(pair[1]['sort']))
        if ordinal and ordinal.isdigit() and 1 <= int(ordinal) <= len(scoped):
            return scoped[int(ordinal) - 1], 'episode', ordinal
    kinds = [kind] if kind is not None else [0]
    matches = [(m, ep) for m, ep in pools if ep['type'] in kinds and ordinal is not None
               and number(ep['sort']) == ordinal]
    if len(matches) == 1:
        return matches[0], 'episode', ordinal
    if not matches and kind in (None, 0) and task.get('_catalog_offset') is not None and ordinal is not None:
        shifted = number(float(ordinal) + task['_catalog_offset'])
        offset_matches = [(m, ep) for m, ep in pools if ep['type'] == 0 and number(ep['sort']) == shifted]
        if len(offset_matches) == 1:
            return offset_matches[0], 'episode', shifted
    if not matches and kind == 1 and ordinal and ordinal.isdigit():
        specials = sorted([(m, ep) for m, ep in pools if ep['type'] == 1], key=lambda pair: float(pair[1]['sort']))
        if 1 <= int(ordinal) <= len(specials):
            return specials[int(ordinal) - 1], 'episode', ordinal
    if not matches and len(numbers) > 1:
        local = [(m, ep) for m, ep in pools if ep['type'] in kinds and number(ep['sort']) == numbers[0]]
        if len(local) == 1:
            return local[0], 'episode', numbers[0]
    # Releases may number catalogued specials after the main episodes.
    if not matches and ordinal is not None:
        specials = [(m, ep) for m, ep in pools if ep['type'] == 1 and number(ep['sort']) == ordinal]
        if len(specials) == 1:
            return specials[0], 'episode', ordinal
    if ordinal is None:
        from ..utils.title_matching import normalize_title
        titled = [(m, ep) for m, ep in pools if len(normalize_title(ep.get('name'))) >= 3
                  and normalize_title(ep['name']) in normalize_title(stem)]
        if len(titled) == 1:
            return titled[0], 'episode', ordinal
        regular = [(m, ep) for m, ep in pools if ep['type'] == 0]
        if len(regular) == 1 and (video_count == 1 or str(regular[0][0]['platform']).upper() in {'剧场版', 'MOVIE', '电影'}):
            return regular[0], 'episode', ordinal
    if kind == 1 or ordinal and '.' in ordinal or re.search(r'(?i)\b(?:SP|Special|OVA|OAD)\b|Info\d|ぷち|特別編|告知編', stem):
        return None, 'special', ordinal
    return None, 'unresolved', ordinal


def build_task(task, run_dir, overrides):
    task_id = task['uuid']
    record_path = DATA_PATH / 'record' / f'{task_id}.json'
    record = read(record_path)
    entries = extract_record_entries(record)
    primary = str(overrides.get('task_subjects', {}).get(task_id) or task.get('subject_id') or task.get('bgm_id') or '')
    if not primary:
        return {'uuid': task_id, 'name': task.get('name'), 'state': 'needs_subject', 'task': task, 'record': record}
    root = old_root(entries)
    ids = [primary, *task.get('subject_ids', []), *overrides.get('additional_subjects', {}).get(task_id, [])]
    models = [catalog(sid, run_dir) for sid in dict.fromkeys(ids)]
    analysis_models = list(models)
    paths = {m['id']: subject_directory(root.parent, m) for m in models}
    video_entries = [(s, e) for s, e in entries.items() if Path(s).suffix.lower() in VIDEO_SUFFIX]
    analysis_task = dict(task)
    catalog_numbers = sorted(float(ep['sort']) for ep in models[0]['episodes'] if ep['type'] == 0)
    source_numbers = sorted({float(raw_hint(Path(s))[1]) for s, _ in video_entries
                             if raw_hint(Path(s))[0] in (None, 0) and raw_hint(Path(s))[1] is not None})
    count = len(catalog_numbers)
    if (len(models) == 1 and count and len(source_numbers) == count
            and source_numbers == list(range(1, count + 1))
            and catalog_numbers == [catalog_numbers[0] + i for i in range(count)]):
        analysis_task['_catalog_offset'] = catalog_numbers[0] - 1
    mapping, bindings, problems, recoveries = {}, [], [], []
    video_destinations = {}
    for original_value, entry in video_entries:
        original = Path(original_value)
        current = Path(entry if isinstance(entry, str) else entry['target'])
        selected, category, ordinal = choose_episode(original, analysis_models, len(video_entries), analysis_task,
                                                     overrides.get('arc_scopes', {}).get(task_id))
        override = overrides.get('files', {}).get(original_value)
        if override:
            sid = str(override.get('subject_id') or primary)
            model = next((m for m in models if m['id'] == sid), None) or catalog(sid, run_dir)
            if model not in models:
                models.append(model)
                paths[sid] = subject_directory(root.parent, model)
            ep = next((ep for ep in model['episodes'] if ep['id'] == override.get('episode_id')), None)
            selected, category = (model, ep) if ep else None, override.get('category', 'episode')
        if selected:
            model, episode = selected
            group = task.get('subtitle_group') or ''
            if not group:
                bracket = re.match(r'^\[([^\[\]]+)\]', original.name)
                group = bracket.group(1) if bracket else ''
            target = episode_target(paths[model['id']], model['name'], episode, group, current.suffix)
            binding = {'source': original_value, 'subject_id': model['id'], 'episode_id': episode['id'],
                       'episode_type': episode['type'], 'episode': episode['sort'], 'category': 'episode'}
        elif category in ('extra', 'special', 'unindexed_main'):
            sid = str(override.get('subject_id') or primary) if override else primary
            parent = paths[sid] if category == 'unindexed_main' else paths[sid] / ('Extras' if category == 'extra' else 'Specials')
            target = parent / original.name
            binding = {'source': original_value, 'subject_id': sid, 'episode_id': None,
                       'episode': ordinal, 'category': category}
            if category == 'unindexed_main':
                binding['episode_ids'] = [ep['id'] for ep in next(m for m in models if m['id'] == sid)['episodes'] if ep['type'] == 0]
        else:
            problems.append({'source': original_value, 'current': str(current), 'reason': '无法确定章节'})
            continue
        mapping[str(current)] = str(target)
        video_destinations[original_value] = (current, target)
        bindings.append(binding)
    # Associate each subtitle/audio with the longest matching original video stem.
    for original_value, entry in entries.items():
        if Path(original_value).suffix.lower() in VIDEO_SUFFIX:
            continue
        original = Path(original_value)
        current = Path(entry if isinstance(entry, str) else entry['target'])
        related = [v for v in video_destinations if Path(v).parent == original.parent
                   and original.name.startswith(Path(v).stem + '.')]
        if related:
            owner = max(related, key=lambda v: len(Path(v).stem))
            target_video = video_destinations[owner][1]
            target = target_video.with_name(target_video.stem + original.name[len(Path(owner).stem):])
        else:
            # Directory entries in very old records are retained as historical
            # annotations, not fabricated into files or recursively moved.
            relative = current.relative_to(root) if current.is_relative_to(root) else Path(original.name)
            parts = list(relative.parts)
            while len(parts) > 1 and (re.fullmatch(r'(?i)Season\s*\d+', parts[0]) or parts[0].casefold() in {'extra', 'extras'}):
                parts.pop(0)
            namespace = [sanitize_path_component(task['name'])] if task_id in overrides.get('arc_scopes', {}) else []
            target = paths[primary] / 'Extras' / Path(*namespace, *parts)
        mapping[str(current)] = str(target)
    for source_value in mapping:
        source = Path(source_value)
        if source.is_file() or source.is_dir():
            continue
        original_value, entry = next(((s, e) for s, e in entries.items()
                                      if (e if isinstance(e, str) else e.get('target')) == source_value), (None, None))
        mirror = entry.get('mirror') if isinstance(entry, dict) else None
        fallback = Path(mirror) if mirror and Path(mirror).is_file() else Path(original_value) if original_value else None
        if fallback is not None and fallback.is_file():
            recoveries.append({'current': source_value, 'fallback': str(fallback),
                               'kind': 'symlink' if fallback.drive != source.drive else 'hardlink'})
        else:
            # Missing non-video historical artifacts cannot block available media.
            if source.suffix.lower() not in VIDEO_SUFFIX:
                recoveries.append({'current': source_value, 'kind': 'unavailable', 'original': original_value})
            else:
                problems.append({'source': original_value, 'current': source_value, 'reason': '历史输出和原文件均不可用'})
    metadata = copy.deepcopy(task)
    metadata.update(schema_version=2, layout='bangumi', metadata_source='bangumi',
                    subject_id=primary, subject_ids=sorted({b['subject_id'] for b in bindings}),
                    bgm_id=primary, tmdb_id='', name=models[0]['name'], bangumi_name=models[0]['name'],
                    is_anime=True, platform=models[0].get('platform') or '', season_id=None, output_dir=str(paths[primary]),
                    episode_bindings=bindings, use_ai=False, error=None,
                    migration={'state': 'native', 'legacy_output_dir': task.get('output_dir'),
                               'legacy_season_id': task.get('season_id'), 'legacy_tmdb_id': task.get('tmdb_id')})
    return {'uuid': task_id, 'name': task.get('name'), 'state': 'review' if problems else 'ready',
            'task': task, 'record': record, 'new_task': metadata, 'mapping': mapping,
            'bindings': bindings, 'problems': problems, 'recoveries': recoveries,
            'subjects': [{'id': m['id'], 'name': m['name']} for m in models]}


def prepare(run_dir):
    run_dir = Path(run_dir)
    overrides = read(run_dir / 'overrides.json') if (run_dir / 'overrides.json').exists() else {}
    tasks = [read(p) for p in (DATA_PATH / 'task').glob('*.json')]
    results = []
    for task in tasks:
        try:
            result = build_task(task, run_dir, overrides)
        except Exception as exc:
            result = {'uuid': task['uuid'], 'name': task.get('name'), 'state': 'error', 'error': str(exc)}
        results.append(result)
        if len(results) % 20 == 0:
            print(json.dumps({'planned': len(results), 'status': dict(collections.Counter(r['state'] for r in results))}), flush=True)
    atomic_write(run_dir / 'plan.json', {'tasks': results})
    print(json.dumps({'planned': len(results), 'status': dict(collections.Counter(r['state'] for r in results))}), flush=True)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--prefetch', action='store_true')
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    if args.prefetch:
        prefetch(args.run)
    if args.prepare:
        prepare(args.run)
