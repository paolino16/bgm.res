"""Recover missing Bangumi IDs without running recognition/file-transfer tasks."""

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import unicodedata
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .get_info import Search
from .task_schema import atomic_write
from ..utils.title_matching import normalize_title
from ..utils.path import DATA_PATH


def exact_title(left, right):
    # Exclamation counts can distinguish sequels such as NEW GAME! / NEW GAME!!.
    def signature(text):
        text = unicodedata.normalize('NFKC', str(text or '')).casefold()
        text = text.replace('`', "'").replace('’', "'").replace('′', "'")
        meaningful = ''.join(char for char in text if char in "♭☆★×'′")
        punctuation = (text.count('!'), text.count('?')) if re.search(r'[a-z]', text) else (0, 0)
        return normalize_title(text), meaningful, punctuation
    return bool(normalize_title(left)) and signature(left) == signature(right)


def source_query(task):
    path = Path(task.get('path') or '')
    leaf = path.stem if path.suffix.lower() in {'.mkv', '.mp4', '.avi'} else path.name
    if re.fullmatch(r'(?i)(?:mkv|mp4|tv|tva|ova|oad|sp|specials?|extras?|season\s*\d+|s\d+)', leaf):
        leaf = path.parent.name
    cleaned = re.sub(r'\[[^\]]*\]|【[^】]*】', '', leaf).strip()
    cleaned = re.sub(r'(?i)\b(?:BDRip|WebRip|HEVC|x26[45]|\d{3,4}p)\b.*$', '', cleaned).strip()
    return cleaned


def verified_equivalent(left, right):
    if exact_title(left, right):
        return True
    # A movie marker may appear before or after the same exact title.
    movie = r'剧场版|劇場版|\b(?:movie|gekijouban)\b'
    if re.search(movie, left, re.I) and re.search(movie, right, re.I):
        return exact_title(re.sub(movie, '', left, flags=re.I), re.sub(movie, '', right, flags=re.I))
    return False


def verify_source(result):
    """Cross-check the source title independently of the old recognized name."""
    secondary, query = result.get('source_query') or '', result.get('old_name') or ''
    if len(normalize_title(secondary)) < 5:
        return result
    known = result.get('selected')
    if known and any(verified_equivalent(secondary, alias) for alias in known['aliases']):
        result['source_verified'] = True
        return result
    search = Search()
    term = re.sub(r'[/／]', ' ', secondary)
    term = re.sub(r'(?i)\s+v\d+$|\s+Blu-ray\s+BOX$', '', term).strip()
    if re.search(r'(?i)\b(?:ova|oad)s?\b', term):
        # Reuse the known Chinese base title when the release uses romaji.
        term = query + ' OAD'
    pool = search.search_bangumi_subjects(term, 0)
    candidates = {item['id']: item for item in result.get('candidates', [])}
    for item in pool[:5]:
        detail = search.get_bangumi_subject_by_id(int(item['id']))
        if detail:
            candidates[int(item['id'])] = summarize(search, detail)
    selected = [item for item in candidates.values() if
                any(verified_equivalent(secondary, alias) or verified_equivalent(term, alias)
                    for alias in item['aliases'])]
    if not selected and result['status'] != 'matched':
        selected = [item for item in candidates.values() if any(verified_equivalent(query, alias)
                                                                for alias in item['aliases'])]
    if len(selected) == 1:
        result.update(status='matched', selected=selected[0], source_verified=True,
                      name_changed=selected[0]['name'] != query)
    elif len(selected) > 1 and result['status'] != 'matched':
        result['status'] = 'ambiguous'
    result['candidates'] = list(candidates.values())
    return result


def refine_report(report_path, workers=3):
    report_path = Path(report_path)
    report = json.loads(report_path.read_bytes())
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        jobs = {executor.submit(verify_source, result): i for i, result in enumerate(report['results'])}
        for completed, future in enumerate(concurrent.futures.as_completed(jobs), 1):
            index = jobs[future]
            try:
                report['results'][index] = future.result()
            except Exception as exc:
                report['results'][index].setdefault('errors', []).append(str(exc))
            atomic_write(report_path, report)
            if completed % 20 == 0 or completed == len(jobs):
                print(json.dumps({'verified': completed, 'total': len(jobs),
                                  'status': dict(Counter(r['status'] for r in report['results']))}), flush=True)
    return report_path


def task_year(task):
    value = str(task.get('year') or '')
    if re.fullmatch(r'(?:19|20)\d{2}', value):
        return value
    match = re.search(r'\(((?:19|20)\d{2})\)', str(task.get('output_dir') or ''))
    return match.group(1) if match else ''


def summarize(search, subject):
    return {'id': int(subject['id']), 'name': subject.get('name_cn') or subject.get('name') or '',
            'original_name': subject.get('name') or '', 'date': subject.get('date') or subject.get('air_date') or '',
            'platform': search._extract_bangumi_platform(subject), 'aliases': search._bangumi_titles(subject)}


def identify(task):
    query = str(task.get('name') or '').strip()
    secondary = source_query(task)
    year = task_year(task)
    search = Search()
    candidates = {}
    errors = []
    for term in dict.fromkeys([query, secondary]):
        if not term or (term != query and exact_title(term, query)):
            continue
        results = search.search_bangumi_subjects(term, 0)
        if search.last_error:
            errors.append(search.last_error)
        for item in results[:8]:
            if not item.get('id'):
                continue
            candidates[int(item['id'])] = item
        # Exact display/original names do not require alias requests for every hit.
        exact = [item for item in candidates.values()
                 if any(exact_title(term, title) for title in search._bangumi_titles(item))]
        # A differing source name is additional evidence, especially for OAD packs.
        if term == query and exact and not re.search(r'(?i)\b(?:ova|oad)s?\b', secondary):
            break
    # Verify details and aliases for the strongest few candidates only.
    pool = sorted(candidates.values(), key=lambda item: search._score_bangumi_subject(item, query or secondary, int(year or 0)), reverse=True)
    detailed = []
    for item in pool[:5]:
        detail = search.get_bangumi_subject_by_id(int(item['id']))
        if detail:
            detailed.append(summarize(search, detail))
        elif search.last_error:
            errors.append(search.last_error)
    matches = [item for item in detailed if any(exact_title(query, alias) or exact_title(secondary, alias)
                                              for alias in item['aliases'])]
    if year:
        dated = [item for item in matches if item['date'].startswith(year)]
        if dated:
            matches = dated
        elif any(item['date'] and not item['date'].startswith(year) for item in matches):
            matches = []
    ova_source = bool(re.search(r'(?i)\b(?:ova|oad)s?\b', secondary))
    if ova_source:
        matches = [item for item in matches if item['platform'].upper() in {'OVA', 'OAD'}]
    status = 'matched' if len(matches) == 1 else 'ambiguous' if matches or detailed else 'not_found'
    selected = matches[0] if len(matches) == 1 else None
    return {'uuid': task['uuid'], 'old_name': query, 'query': query, 'source_query': secondary,
            'year_hint': year, 'status': status, 'selected': selected,
            'name_changed': bool(selected and selected['name'] != query),
            'candidates': detailed[:5], 'errors': list(dict.fromkeys(errors))}


def run(data_path, workers=3):
    data_path = Path(data_path)
    run_dir = data_path / 'identification' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    run_dir.mkdir(parents=True)
    tasks = []
    for path in sorted((data_path / 'task').glob('*.json')):
        task = json.loads(path.read_bytes())
        if not task.get('bgm_id') and not task.get('tmdb_id'):
            tasks.append(task)
    report = {'tasks': len(tasks), 'results': [], 'applied': 0, 'run_dir': str(run_dir)}
    atomic_write(run_dir / 'report.json', report)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        jobs = {executor.submit(identify, task): task for task in tasks}
        for future in concurrent.futures.as_completed(jobs):
            task = jobs[future]
            try:
                result = future.result()
            except Exception as exc:
                result = {'uuid': task['uuid'], 'old_name': task.get('name'), 'status': 'error',
                          'selected': None, 'errors': [str(exc)], 'candidates': []}
            report['results'].append(result)
            atomic_write(run_dir / 'report.json', report)
            if len(report['results']) % 10 == 0 or len(report['results']) == len(tasks):
                print(json.dumps({'done': len(report['results']), 'total': len(tasks),
                                  'status': dict(Counter(r['status'] for r in report['results'])),
                                  'report': str(run_dir / 'report.json')}, ensure_ascii=True), flush=True)
    return run_dir / 'report.json'


def apply_report(data_path, report_path):
    data_path, report_path = Path(data_path), Path(report_path)
    report = json.loads(report_path.read_bytes())
    backup = report_path.parent / 'before'
    changed, conflicts = 0, []
    for result in report['results']:
        if result['status'] != 'matched' or not result.get('selected'):
            continue
        path = data_path / 'task' / f'{result["uuid"]}.json'
        raw, stat = path.read_bytes(), path.stat()
        task = json.loads(raw)
        selected = result['selected']
        if task.get('bgm_id') or task.get('tmdb_id'):
            continue
        if (task.get('name') != result['old_name']
                or 'source_query' in result and source_query(task) != result['source_query']
                or 'year_hint' in result and task_year(task) != result['year_hint']):
            conflicts.append(task['uuid'])
            continue
        archived = backup / path.name
        archived.parent.mkdir(parents=True, exist_ok=True)
        if not archived.exists():
            archived.write_bytes(raw)
        # Keep the historical display name, filename decisions, layout and errors.
        task.update(bgm_id=str(selected['id']), subject_id=str(selected['id']),
                    metadata_source='bangumi', bangumi_name=selected['name'])
        task['identification'] = {'report': str(report_path), 'original_name': result['old_name'],
                                  'bangumi_name': selected['name'], 'name_changed': result['name_changed']}
        for key in ('scope_note', 'review_required', 'evidence', 'subject_ids'):
            if key in result:
                task['identification'][key] = result[key]
        if result.get('subject_ids'):
            task['subject_ids'] = result['subject_ids']
        # Adding an ID is not a change to the previously confirmed file plan.
        if isinstance(task.get('file_plan_context'), dict):
            task['file_plan_context'].update(bgm_id=str(selected['id']), subject_id=str(selected['id']))
        if path.read_bytes() != raw:
            conflicts.append(task['uuid'])
            continue
        atomic_write(path, task)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        result['applied'] = True
        result['before_sha256'] = hashlib.sha256(raw).hexdigest()
        changed += 1
    report['applied'] = sum(bool(r.get('applied')) for r in report['results'])
    report['conflicts'] = conflicts
    atomic_write(report_path, report)
    return {'updated': changed, 'applied_total': report['applied'], 'conflicts': conflicts}


def export_name_changes(report_path):
    report_path = Path(report_path)
    report = json.loads(report_path.read_bytes())
    changed = [r for r in report['results'] if r.get('name_changed')]
    formatting = sum(normalize_title(r['old_name']) == normalize_title(r['selected']['name']) for r in changed)
    lines = ['# 缺失 Bangumi ID 的重新识别结果', '',
             f'共检索 {report["tasks"]} 条记录，已补充 ID {report["applied"]} 条。', '',
             f'名称不同 {len(changed)} 条，其中 {formatting} 条仅空格、括号、标点等书写差异。', '',
             '原显示名和现有文件名均保留；Bangumi 标准名另存为 bangumi_name。没有移动媒体文件或改写历史操作记录。', '',
             '## 名称差异（全部）', '', '| 原记录名称 | Bangumi 名称 | 条目 | 差异 |',
             '|---|---|---|---|']
    def cell(text):
        return str(text).replace('|', '\\|').replace('\n', ' ')
    for result in sorted(changed, key=lambda r: r['old_name']):
        selected = result['selected']
        label = '书写格式' if normalize_title(result['old_name']) == normalize_title(selected['name']) else '译名、词序或条目范围'
        lines.append(f'| {cell(result["old_name"])} | {cell(selected["name"])} | [{selected["id"]}](https://bgm.tv/subject/{selected["id"]}) | {label} |')
    lines.extend(['', '## 条目范围需要特别注意', '',
                  '- 倾物语、囮物语、猫物语（白）、鬼物语、恋物语：分别是本地的篇章目录，Bangumi 归入 [物语系列 第二季](https://bgm.tv/subject/68812)。已经补充条目 ID，但不把这些篇章的本地第 1 集当成整个条目的第 1 集；迁移时要求核对章节。',
                  '- Fate UBW：操作记录中包含 00—25 集和 Sunny Day，实际跨 [2014 年 TV 条目](https://bgm.tv/subject/95225) 与 [2015 年 TV 第二期](https://bgm.tv/subject/109386)。已记录两个条目 ID，主 ID 为 95225；旧输出目录标注的 2010 年对应电影版本，不用于此次判断。迁移时核对章节。', '',
                  '## 纠正了原条目范围的记录', '',
                  '- “进击的巨人”：源目录是 OADs，绑定 [进击的巨人 OAD](https://bgm.tv/subject/80993)，不是 TV 本篇。',
                  '- “驭星者 闪亮的拓人”：该记录的源目录和文件明确是电影，绑定 [剧场版](https://bgm.tv/subject/48702)。另一条 TV 记录保持 TV 条目。', '',
                  '## 完整结果与备份', '',
                  '- `report.json`：全部 211 条记录、候选、最终 ID、名称差异与查证说明。',
                  '- `before/`：本次写入前的 211 条任务记录原始字节备份。', ''])
    output = report_path.parent / 'name_changes.md'
    output.write_text('\n'.join(lines), encoding='utf-8')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, default=DATA_PATH)
    parser.add_argument('--apply-report', type=Path)
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--refine-report', type=Path)
    parser.add_argument('--export-report', type=Path)
    args = parser.parse_args()
    print(export_name_changes(args.export_report) if args.export_report else
          apply_report(args.data, args.apply_report) if args.apply_report else
          refine_report(args.refine_report, args.workers) if args.refine_report else run(args.data, args.workers))
