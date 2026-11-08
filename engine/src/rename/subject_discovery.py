"""Suggest additional Bangumi subjects without binding files or overriding a match."""
import copy
import re
from collections import defaultdict
from itertools import groupby
from pathlib import Path

from ..utils.title_matching import normalize_title
from .source_scan import files_in
from .utils import VIDEO_SUFFIX

SPECIAL = re.compile(r'(?i)(?<![a-z])(?:oad|ova|sp)(?=[^a-z]|$)')
ZERO = re.compile(r'(?i)\[0{1,3}\]|(?:oad|ova|ep)\s*\(?0{1,3}(?!\d)')
TITLED_OAD = re.compile(r'^\s*\[[^\]]+\]\s*([^\[\]]+?)\s*\[(?:OAD|OVA)\s*\d+', re.I)


def candidate(item, reason):
    return {key: item[key] for key in ('id', 'name', 'name_cn', 'date', 'season', 'recall_evidence')
            if key in item} | {'suggestion_reason': reason}


def related_candidates(decisions, relations):
    suggestions = {}
    for row in decisions:
        if row.get('category') != 'unresolved':
            continue
        name = Path(row['source']).name
        special, zero = SPECIAL.search(name), ZERO.search(name)
        if not (special or zero):
            continue
        for item in relations or []:
            if item.get('type') != 2 or not item.get('id'):
                continue
            relation = item.get('relation')
            title = ' '.join(str(item.get(key) or '') for key in ('name', 'name_cn'))
            if (relation == '番外篇' and (special or SPECIAL.search(title))
                    or relation == '前传' and zero and re.search(r'第\s*0+\s*[话話集]', title)):
                suggestions.setdefault(item['id'], candidate(item, f'{name} · 本篇的{relation}'))
    return list(suggestions.values())


def prioritize(search, suggestions):
    if suggestions:
        ordered = {str(c['id']): c for c in suggestions}
        for c in search.last_bangumi_candidates:
            ordered.setdefault(str(c['id']), c)
        search.last_bangumi_candidates = list(ordered.values())


def discover_ambiguous(path, search):
    if not path.is_dir() or search.network_error or not search.last_bangumi_candidates:
        return
    names = [p.name for p in files_in(path, recursive=False) if p.suffix.lower() in VIDEO_SUFFIX]
    queries = {}
    for name in sorted(names):
        match = TITLED_OAD.match(name)
        if match:
            queries.setdefault(match[1].strip(), name)
    worker = copy.copy(search)
    if 1 < len(queries) <= 6:
        suggestions = []
        known = {c['id']: {**c, **search._bangumi_search_details.get(c['id'], {})}
                 for c in search.last_bangumi_candidates}
        for query, name in queries.items():
            exact = []
            for item in known.values():
                aliases = worker._bangumi_titles(item)
                for evidence in item.get('recall_evidence', []):
                    if evidence.get('verified'):
                        aliases.extend((evidence.get('title'), evidence.get('english')))
                if any(normalize_title(alias) == normalize_title(query) for alias in aliases):
                    exact.append(item)
            if len(exact) == 1:
                suggestions.append(candidate(exact[0], name))
                continue
            results = worker.search_bangumi_subjects(query)
            known.update((r['id'], r) for r in results if r.get('id'))
            compatible = [item for item in results if worker._bangumi_compatible(item, query, 0)]
            if compatible:
                suggestions.append(candidate(compatible[0], name))
            if worker.network_error:
                break
        prioritize(search, suggestions)


def _regular_numbers(catalog):
    regular = [e for e in catalog or [] if e.get('type') == 0]
    field = 'sort' if any(e.get('sort') is not None for e in regular) else 'ep'
    return {n for e in regular if (n := _whole_episode(e.get(field))) is not None}


def _whole_episode(value):
    from .bangumi_native import number
    normalized = number(value)
    return int(normalized) if normalized and normalized.isdigit() else None


def sequel_candidates(decisions, catalog, relations, search):
    main = _regular_numbers(catalog)
    if not main:
        return []
    # A package may also contain an earlier season. Its lower episode numbers
    # do not justify fetching a sequel (e.g. Mushoku Tensei's split cour).
    last_main = max(main)
    missing = defaultdict(set)
    for row in decisions:
        if row.get('category') != 'unresolved' or row.get('episode_type') not in (None, 0):
            continue
        ordinal = _whole_episode(row.get('episode'))
        if ordinal is not None and ordinal > last_main:
            missing[Path(row['source']).parent].add(ordinal)
    runs = []
    for numbers in missing.values():
        for _, group in groupby(enumerate(sorted(numbers)), key=lambda pair: pair[1] - pair[0]):
            run = [n for _, n in group]
            if len(run) >= 2:
                runs.append(run)
    if not runs:
        return []
    suggestions = []
    worker = copy.copy(search)
    for item in relations or []:
        if item.get('type') != 2 or item.get('relation') != '续集' or not item.get('id'):
            continue
        episodes = _regular_numbers(worker.get_bangumi_all_episodes(item['id']))
        for run in sorted(runs, key=len, reverse=True):
            label = f'{run[0]:02}–{run[-1]:02}'
            if episodes.issuperset(run):
                reason = f'本篇目录未收录 {label}，续集目录有对应集号'
            elif episodes == set(range(1, len(run) + 1)):
                reason = f'本篇目录未收录 {label}，续集从 01 重新编号，集数相符，请核对'
            else:
                continue
            suggestions.append(candidate(item, reason))
            break
    return suggestions
