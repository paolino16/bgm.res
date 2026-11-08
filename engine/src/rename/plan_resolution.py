"""Persist editable failed plans; recheck and execute without another recognition call."""

import hashlib
import json
import os
import re
import uuid
from pathlib import Path

from ..utils.path import DATA_PATH, TASK_PATH
from .preflight import expected_videos, format_report
from .rename_strategy import append_version, companions, retarget, custom_filename
from .utils import VIDEO_SUFFIX, format_episode_filename

PLAN_PATH = DATA_PATH / 'rename_plans'
TASK_CONTEXT = ('path', 'name', 'season_id', 'subtitle_group', 'year', 'tmdb_id', 'bgm_id', 'subject_ids',
                'skip_search', 'is_anime', 'is_movie', 'use_ai', 'layout', 'subject_id')


def task_context(task):
    return {key: task.get(key) for key in TASK_CONTEXT}


def _path(task_id):
    if not re.fullmatch(r'[\w-]+', str(task_id)):
        raise ValueError('任务编号无效')
    return PLAN_PATH / f'{task_id}.json'


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f'{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def load_plan(task_id):
    path = _path(task_id)
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else None


def load_review_plan(task_id):
    plan = load_plan(task_id)
    if plan:
        plan['target_info'] = {}
        for row in plan['rows']:
            if row['original_target']:
                target = Path(row['original_target'])
                try:
                    if target.exists():
                        plan['target_info'][row['source']] = f'已有目标：{target.stat().st_size:,} 字节；重新检查时会验证是否同源'
                except OSError:
                    plan['target_info'][row['source']] = '已有目标暂时无法读取'
    return plan


def invalidate_plan(task_id):
    plan = load_plan(task_id)
    if plan and plan['state'] == 'pending':
        plan['state'] = 'superseded'
        _write(_path(task_id), plan)


def add_plan_subject(task_id, revision, subject_id):
    """Load an explicitly selected related subject without assigning any files."""
    from .get_info import Search
    from .bangumi_native import subject_directory
    plan = load_plan(task_id)
    if not plan or plan['revision'] != revision or plan['state'] != 'pending' or plan['context'].get('layout') != 'bangumi':
        raise ValueError('方案已失效，请重新打开')
    subject_id = str(int(subject_id))
    context = plan['context']
    if subject_id == context['subject_id'] or subject_id in context.get('subjects', {}):
        return context
    context.setdefault('subjects', {})[subject_id] = load_subject_context(Search(), subject_id, context)
    _write(_path(task_id), plan)
    return context


def load_subject_context(search, subject_id, context):
    from .bangumi_native import subject_directory
    name, info = search.get_bangumi_info('', 0, bgm_id=int(subject_id))
    if not info:
        raise ValueError(search.last_error or '无法获取关联条目')
    episodes = search.get_bangumi_all_episodes(int(subject_id))
    if episodes is None:
        raise ValueError(search.last_error or '无法获取关联条目的完整章节')
    is_movie = str(info.get('platform') or '').upper() in {'剧场版', 'MOVIE', '电影'}
    base_key = 'anime_movie_path' if is_movie else 'anime_path'
    base = Path(context.get(base_key) or Path(context['work_path']).parent)
    relations = search.get_bangumi_relations(int(subject_id))
    return {
        'subject_id': subject_id, 'name': name, 'episodes': episodes,
        'platform': info.get('platform'),
        'first_air_date': info.get('first_air_date') or info.get('release_date') or '',
        'relations': relations if isinstance(relations, list) else [],
        'work_path': str(subject_directory(base, {
            **info, 'first_air_date': info.get('first_air_date') or info.get('release_date') or ''
        })),
    }


def save_failed_plan(worker, issues):
    if worker.source_root is None:
        return
    try:
        videos = worker.review_sources if hasattr(worker, 'review_sources') else expected_videos(worker.source_root)
    except OSError:
        videos = [p for p in worker.R if p.suffix.lower() in VIDEO_SUFFIX]
    rows = []
    for source in sorted(set(videos) | {p for p in worker.R if p.suffix.lower() in VIDEO_SUFFIX}):
        target = worker.R.get(source)
        code = re.search(r'(?i)S(\d+)E(\d+)', target.stem) if target else None
        row = {'source': str(source), 'original_target': str(target) if target else '',
                     'season': int(code.group(1)) if code else None,
                     'episode': int(code.group(2)) if code else None,
                     'version': '', 'filename': '', 'skip': source in worker.skipped_sources}
        if worker.plan_context.get('layout') == 'bangumi':
            binding = next((b for b in worker.plan_context.get('bindings', []) if b['source'] == str(source)), {})
            row.update(episode_ids=binding.get('episode_ids', []), episode_id=binding.get('episode_id'), category=binding.get('category', 'unresolved'),
                       episode=binding.get('episode'), season=None,
                       subject_id=str(binding.get('subject_id') or ('' if worker.plan_context.get('requires_subject_assignment') else worker.plan_context['subject_id'])),
                       recognition=binding.get('recognition', {}))
        rows.append(row)
    plan = {'revision': uuid.uuid4().hex, 'state': 'pending', 'uuid': worker.uuid,
            'root': str(worker.source_root), 'mode': worker.mode,
            'root_is_file': worker.source_root.is_file(),
            'context': worker.plan_context, 'mapping': {str(s): str(t) for s, t in worker.R.items()},
            'issues': issues, 'rows': rows, 'automatic_versions': worker.automatic_versions}
    # Never overwrite a user's pending adjustments when rechecking that plan.
    _write(_path(worker.uuid), plan)


def _integer(value, name, minimum):
    if value is None or str(value).strip() == '':
        return None
    number = float(value)
    if not number.is_integer() or number < minimum:
        raise ValueError(f'{name}必须是大于等于 {minimum} 的整数')
    return int(number)


def build_adjusted_mapping(plan, edited_rows, *, row_errors=None):
    allowed = {row['source']: row for row in plan['rows']}
    if len(edited_rows) != len(allowed) or {r['source'] for r in edited_rows} != set(allowed):
        raise ValueError('方案文件列表已变化，请重新打开')
    mapping = {Path(s): Path(t) for s, t in plan['mapping'].items()}
    context = plan['context']
    work_path = Path(context['work_path']) if context.get('work_path') else None
    skipped = set()
    for row in edited_rows:
        try:
            source = Path(row['source'])
            original = allowed[row['source']]
            # Discover companions in the same directory, including previously unmapped subtitles.
            candidates = set(mapping)
            if 'source_files' in context:
                candidates.update(map(Path, context['source_files']))
            elif source.parent.is_dir():
                candidates.update(p for p in source.parent.iterdir() if p.is_file())
            if context.get('layout_migration'):
                from ..utils.utils import extract_record_targets
                candidates.intersection_update(extract_record_targets(context['layout_migration']['record']))
            related = companions(source, candidates)
            if row.get('skip'):
                skipped.update([source, *related])
                for path in [source, *related]:
                    mapping.pop(path, None)
                continue
            target = Path(original['original_target']) if original['original_target'] else None
            old_group = context.get('original_subtitle_group', context.get('subtitle_group', '')) or ''
            new_group = context.get('subtitle_group', '') or ''
            if target and old_group != new_group and original.get('category') != 'extra':
                from .utils import sanitize_path_component
                stem = target.stem
                old_label = f' [{sanitize_path_component(old_group)}]' if old_group else ''
                if old_label and old_label in stem:
                    before, _, after = stem.rpartition(old_label)
                    stem = before + (f' [{new_group}]' if new_group else '') + after
                elif new_group:
                    stem += f' [{new_group}]'
                target = target.with_name(stem + target.suffix)
            if context.get('layout') == 'bangumi':
                from .bangumi_native import episode_target
                if context.get('requires_subject_assignment') and not row.get('subject_id'):
                    raise ValueError(f'{source.name}：请选择归属作品')
                subject_id = str(row.get('subject_id') or context['subject_id'])
                subject = context.get('subjects', {}).get(subject_id)
                if subject_id != context['subject_id'] and subject is None:
                    raise ValueError(f'{source.name}：请先载入对应 Bangumi 条目')
                subject = subject or context
                subject_work_path = Path(subject['work_path'])
                if row.get('category') == 'collection':
                    from .bangumi_native import collection_episodes, collection_target
                    episodes = collection_episodes(subject, row)
                    target = collection_target(subject_work_path, subject['name'], episodes,
                                               context.get('subtitle_group', ''), source.suffix)
                elif row.get('category') == 'extra':
                    target = (target if original.get('category') == 'extra' and target
                              and str(original.get('subject_id') or context['subject_id']) == subject_id
                              else subject_work_path / 'Extras' / source.name)
                else:
                    episode = next((ep for ep in subject.get('episodes', [])
                                    if str(ep['id']) == str(row.get('episode_id'))), None)
                    if episode is None:
                        conflicts = original.get('recognition', {}).get('conflicts', [])
                        if conflicts:
                            raise ValueError(f'{source.name}：' + '；'.join(conflicts) + '，请手动选择章节、归为附加资源或跳过')
                        raise ValueError(f'{source.name}：请选择 Bangumi 章节、归为附加资源或跳过')
                    if (target is None or str(row.get('episode_id')) != str(original.get('episode_id'))
                            or str(original.get('subject_id') or context['subject_id']) != subject_id
                            or original.get('category') in ('extra', 'collection')):
                        target = episode_target(subject_work_path, subject['name'], episode,
                                                context.get('subtitle_group', ''), source.suffix)
            else:
                season = _integer(row.get('season'), '季号', 0)
                episode = _integer(row.get('episode'), '集号', 1)
                if target is None and context.get('is_movie') and work_path is not None:
                    target = work_path / source.name
                if (season, episode) != (original['season'], original['episode']) or target is None:
                    if work_path is None or season is None or episode is None:
                        raise ValueError(f'{source.name}：请同时填写季号和集号')
                    target = work_path / f'Season {season}' / format_episode_filename(
                        context.get('name') or Path(plan['root']).stem, season, episode,
                        context.get('subtitle_group') or '', source.suffix)
            filename = str(row.get('filename') or '').strip()
            if filename:
                target = target.with_name(custom_filename(source, filename, context.get('subtitle_group', '')))
            target = append_version(target, row.get('version'))
            retarget(mapping, source, target, candidates)
        except (ValueError, TypeError, OverflowError) as exc:
            if row_errors is None:
                raise
            source = Path(row['source'])
            row_errors[str(source)] = str(exc)
            for item in [source, *companions(source, mapping)]:
                mapping.pop(item, None)
    return mapping, skipped


def check_saved_plan(task_id, revision, rows, *, collect_errors=False, subtitle_group=None):
    from .trans import Trans
    plan = load_plan(task_id)
    if not plan or plan['revision'] != revision or plan['state'] != 'pending':
        raise ValueError('方案已失效或已执行，请重新打开')
    if subtitle_group is not None:
        if not isinstance(subtitle_group, str):
            raise ValueError('字幕组必须是文字')
        group = subtitle_group.strip()
        if len(group) > 120 or any(c in group for c in '<>:"/\\|?*[]') or any(ord(c) < 32 for c in group) or group.endswith('.'):
            raise ValueError('字幕组不能包含路径符号、方括号或非法字符，且不能超过 120 字')
        context = plan['context']
        if group != (context.get('subtitle_group') or ''):
            if context.get('layout_migration'):
                raise ValueError('目录迁移方案不能修改字幕组')
            context.setdefault('original_subtitle_group', context.get('subtitle_group') or '')
            context['subtitle_group'] = group
            context.setdefault('task_metadata', {})['subtitle_group'] = group
    row_errors = {}
    mapping, skipped = build_adjusted_mapping(plan, rows, row_errors=row_errors if collect_errors else None)
    if plan['context'].get('layout') == 'bangumi' and not row_errors:
        context = plan['context']
        bindings = []
        for row in rows:
            subject_id = str(row.get('subject_id') or context['subject_id'])
            subject = context.get('subjects', {}).get(subject_id) or context
            episode = next((ep for ep in subject['episodes']
                            if str(ep['id']) == str(row.get('episode_id'))), None)
            if row.get('category') == 'collection' and not row.get('skip'):
                from .bangumi_native import collection_episodes
                episodes = collection_episodes(subject, row)
                bindings.append({'source': row['source'], 'subject_id': subject_id,
                                 'episode_id': None, 'episode_ids': [ep['id'] for ep in episodes],
                                 'episode': None, 'episode_type': 0, 'category': 'collection'})
                continue
            bindings.append({'source': row['source'], 'subject_id': subject_id,
                             'episode_id': episode['id'] if episode and row.get('category') != 'extra' else None,
                             'episode': episode['sort'] if episode else None,
                             'episode_type': episode['type'] if episode else None,
                             'category': 'skipped' if row.get('skip') else 'extra' if row.get('category') == 'extra' else 'episode'})
        context['bindings'] = bindings
        context['task_metadata']['episode_bindings'] = bindings
        context['task_metadata']['subject_ids'] = sorted({b['subject_id'] for b in bindings if b['category'] != 'skipped'})
    if plan['context'].get('layout_migration'):
        from .layout_migration import LayoutMigrationWorker
        worker = LayoutMigrationWorker(plan, mapping, skipped)
    else:
        worker = Trans(mapping, task_id, Path(plan['root']), plan_context=plan['context'],
                       skipped_sources=skipped, resolve_versions=False, save_plan=False)
    worker.mode = plan['mode']
    previous = worker._load_previous_targets(worker.record_path)
    issues = [{'reason': message, 'sources': [source], 'target': ''} for source, message in row_errors.items()] + worker.preflight(previous)
    plan['draft_rows'] = rows
    _write(_path(task_id), plan)
    # Fingerprint the reviewed decisions. Execution always checks the disk again.
    token = hashlib.sha256(json.dumps({'rows': rows, 'subtitle_group': plan['context'].get('subtitle_group') or ''}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    preview = []
    root = Path(plan['root'])
    source_base = root.parent if plan.get('root_is_file') else root
    output_base = Path(plan['context']['work_path']) if plan['context'].get('work_path') else None
    for source, target in mapping.items():
        exists = target.exists() or target.is_symlink()
        try:
            size = target.stat().st_size if exists and target.is_file() else None
        except OSError:
            size = None
        preview.append({'source': str(source), 'target': str(target),
                        'source_label': str(source.relative_to(source_base)) if source.is_relative_to(source_base) else source.name,
                        'target_label': str(target.relative_to(output_base)) if output_base and target.is_relative_to(output_base) else str(target),
                        'existing': f'已有文件 · {size:,} 字节' if size is not None else ('已占用' if exists else '空闲'),
                        'action': '同源跳过' if worker._is_reusable_existing_target(source, target) else '执行'})
    for source in sorted(skipped):
        target = plan['mapping'].get(str(source), '')
        preview.append({'source': str(source), 'target': target,
                        'source_label': str(source.relative_to(source_base)) if source.is_relative_to(source_base) else source.name,
                        'target_label': '保持原样', 'existing': '不改动已有输出', 'action': '跳过'})
    return {'issues': issues, 'token': token, 'row_errors': row_errors, 'mapping': mapping, 'skipped': skipped, 'preview': preview,
            'worker': worker, 'plan': plan}


def desktop_review_plan(task_id):
    """Return final mappings immediately, retaining valid rows around bad edits."""
    plan = load_review_plan(task_id)
    if not plan or plan.get('state') != 'pending':
        return plan
    rows = plan.get('draft_rows') or plan['rows']
    checked = check_saved_plan(task_id, plan['revision'], rows, collect_errors=True)
    plan['review'] = {key: checked[key] for key in ('issues', 'token', 'preview', 'row_errors')}
    from .review_rollback import available, blocked
    plan['can_rollback'] = available(task_id)
    plan['rollback_blocked'] = blocked(task_id)
    return plan


def execute_saved_plan(task_id, revision, rows, token):
    checked = check_saved_plan(task_id, revision, rows)
    if checked['token'] != token:
        raise ValueError('调整已改变，请先重新检查')
    task_path = TASK_PATH / f'{task_id}.json'
    task = json.loads(task_path.read_text(encoding='utf-8'))
    result = format_report(checked['issues']) if checked['issues'] else checked['worker'].trans_file()
    if isinstance(result, str) and checked['plan']['context'].get('layout_migration'):
        return result
    if isinstance(result, str):
        task['error'] = result
    else:
        task['error'] = None
        task.update(checked['plan']['context'].get('task_metadata', {}))
        task['file_decisions'] = rows
        task['file_plan_context'] = task_context(task)
        task['skipped_files'] = [str(p) for p in checked['skipped']]
        plan = checked['plan']
        plan.update(state='completed', decisions=rows)
        _write(_path(task_id), plan)
    _write(task_path, task)
    if not isinstance(result, str) and task.get('layout') == 'bangumi':
        from .subject_tasks import split_completed_native_task
        split_completed_native_task(task_path, checked['worker'].record_path, checked['plan']['context'])
    return result


def retry_decided_task(task):
    """Reuse explicit file decisions only while the task's recognition inputs match."""
    if not task.get('file_decisions') or task.get('file_plan_context') != task_context(task):
        return False, None
    plan = load_plan(task['uuid'])
    if plan and plan['context'].get('layout_migration'):
        return False, None
    if not plan or plan['state'] not in {'completed', 'pending'}:
        return False, None
    plan.update(state='pending', revision=uuid.uuid4().hex)
    _write(_path(task['uuid']), plan)
    rows = task['file_decisions']
    checked = check_saved_plan(task['uuid'], plan['revision'], rows)
    return True, execute_saved_plan(task['uuid'], plan['revision'], rows, checked['token'])
