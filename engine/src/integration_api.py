"""Headless desktop API. All writes share the existing rename execution lock."""
import asyncio
import copy
import json
import secrets
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException, Request
from .utils.path import DATA_PATH, TASK_PATH
from .rename.task_schema import atomic_write

_local = threading.local()


def preview_only():
    return getattr(_local, 'preview', False)


@contextmanager
def reviewing():
    before = preview_only()
    _local.preview = True
    try:
        yield
    finally:
        _local.preview = before


def task_path(task_id):
    import re
    if not re.fullmatch(r'[\w-]+', str(task_id)):
        raise ValueError('无效任务编号')
    return TASK_PATH / f'{task_id}.json'


def read_task(task_id):
    from .rename.task_schema import normalize_task
    from .rename.title_evidence import clean_evidence
    task = normalize_task(json.loads(task_path(task_id).read_text(encoding='utf-8')))
    candidates = []
    for candidate in task.get('bangumi_candidates') or []:
        if isinstance(candidate, dict) and candidate.get('recall_evidence'):
            before = candidate['recall_evidence']
            candidate['recall_evidence'] = clean_evidence(before)
            if any(e.get('source') == 'tenrai' for e in before if isinstance(e, dict)) and not any(e.get('source') == 'tenrai' for e in candidate['recall_evidence']):
                continue
        candidates.append(candidate)
    if 'bangumi_candidates' in task:
        task['bangumi_candidates'] = candidates
    return task


def recognize(body):
    from .rename.process import Rename
    from .rename.task_submission import ExistingTasks
    from .config.config_manager import cm
    task_id = body.get('id')
    task = read_task(task_id) if task_id else {}
    allowed = {'name', 'year', 'season_id', 'subtitle_group', 'bgm_id', 'tmdb_id',
               'is_anime', 'is_movie', 'use_ai', 'skip_search', 'subject_ids'}
    task.update({k: v for k, v in body.get('changes', {}).items() if k in allowed})
    from .rename.subject_selection import subject_ids
    selected = subject_ids(task['subject_ids']) if 'subject_ids' in task else []
    if selected:
        task['bgm_id'] = selected[0]
    if len(selected) > 1 and (task.get('tmdb_id') or task.get('skip_search') or task.get('layout') == 'legacy'):
        raise ValueError('多归属需要使用 Bangumi 条目目录；旧目录请先迁移，关闭仅使用给定信息并清空 TMDB ID')
    path = Path(task.get('path') or body.get('path') or '').expanduser()
    if not path.exists():
        raise ValueError('源路径不存在')
    if not task_id and not str(body.get('path') or '').strip():
        raise ValueError('请选择源路径')
    from .rename import review_rollback
    if task_id:
        review_rollback.begin(task_id)
    old_ai = cm.get_config('ai_enabled')
    if task.get('use_ai') is False or len(selected) > 1:
        cm.set_config('ai_enabled', False)
    try:
        from .rename.source_scan import scan_scope
        from .rename.metadata_http import recognition_budget
        from .rename.recognition_progress import progress_scope
        with reviewing(), scan_scope(), recognition_budget(), progress_scope(body.get('_progress')):
            worker = Rename()
            worker.selected_subject_ids = selected
            result = worker.process(path, task.get('is_anime', True), task.get('is_movie'), task_id,
                task.get('name'), task.get('season_id'), task.get('subtitle_group'), task.get('year'),
                task.get('tmdb_id'), task.get('bgm_id'), bool(task.get('skip_search')))
    finally:
        try:
            if task_id:
                review_rollback.seal(task_id)
        finally:
            if cm.get_config('ai_enabled') != old_ai:
                cm.set_config('ai_enabled', old_ai)
    if isinstance(result, ExistingTasks):
        return {'message': result.message, 'reused': True}
    return {'message': result if isinstance(result, str) else '识别完成，请审核文件方案'}


def perform(action, body):
    from .rename import plan_resolution as plans
    from .config.config_manager import cm, CONFIG_DEFAULT
    if action in {'recognize', 'retry'}:
        return recognize(body)
    if action == 'cancel-review':
        from .rename.review_rollback import cancel
        return cancel(body['id'], body.get('revision'))
    if action == 'save-task':
        task = read_task(body['id'])
        allowed = {'name', 'year', 'season_id', 'subtitle_group', 'bgm_id', 'tmdb_id',
                   'is_anime', 'is_movie', 'use_ai', 'skip_search', 'subject_ids'}
        task.update({k: v for k, v in body.get('changes', {}).items() if k in allowed})
        if 'subject_ids' in task:
            from .rename.subject_selection import subject_ids
            task['subject_ids'] = subject_ids(task['subject_ids'])
            task['bgm_id'] = task['subject_ids'][0] if task['subject_ids'] else ''
        from .rename.review_rollback import finish
        atomic_write(task_path(body['id']), task)
        finish(body['id'], 'superseded')
        plans.invalidate_plan(body['id'])
        return {'message': '识别信息已保存，原文件保持原样'}
    if action == 'plan':
        return {**plans.desktop_review_plan(body['id']), 'ai_default_model': cm.get_config('plan_ai_model')}
    if action == 'delete-task-preview':
        from .rename.task_deletion import preview
        return preview(body['id'], body.get('delete_outputs') is True)
    if action == 'delete-task':
        from .rename.task_deletion import execute
        return execute(body['id'], body['token'], body.get('delete_outputs') is True)
    if action == 'deepseek-plan':
        from .ai.bangumi_deepseek import review_plan
        return review_plan(body['id'], body['revision'], body['rows'], body.get('scope', 'unresolved'), progress=body.get('_progress'), model=body.get('model'))
    if action == 'deepseek-history':
        files = sorted((DATA_PATH / 'ai_analysis' / 'native-deepseek').glob('*/*.json'),
                       key=lambda file: file.stat().st_mtime, reverse=True)[:20]
        return [json.loads(file.read_text(encoding='utf-8')) for file in files]
    if action == 'check':
        checked = plans.check_saved_plan(body['id'], body['revision'], body['rows'], collect_errors=True)
        return {key: checked[key] for key in ('issues', 'token', 'preview', 'row_errors')}
    if action == 'execute':
        from .rename.review_rollback import finish, seal
        try:
            result = plans.execute_saved_plan(body['id'], body['revision'], body['rows'], body['token'])
            if result:
                raise ValueError(result)
            finish(body['id'])
            return {'message': '整理完成，媒体库已更新'}
        finally:
            seal(body['id'])
    if action == 'add-subject':
        plans.add_plan_subject(body['id'], body['revision'], body['subject_id'])
        return plans.desktop_review_plan(body['id'])
    if action == 'layout':
        from .rename.layout_migration import prepare_layout_migration
        prepare_layout_migration(body['id'])
        return plans.desktop_review_plan(body['id'])
    if action == 'subtitle-preview':
        from .rename.subtitle_import import preview_records, import_targets, subtitle_target
        from .utils.utils import get_record
        ids = body.get('ids') if 'ids' in body else [body.get('id')]
        if not isinstance(ids, list) or not ids or len(ids) > 200:
            raise ValueError('请选择有效的整理记录')
        for identifier in ids:
            task_path(identifier)
        videos, rows = preview_records([get_record(identifier) for identifier in dict.fromkeys(ids)],
                                      body.get('folder'), body.get('offset', 0), files=body.get('files'))
        validated = set()
        for row in rows:
            if row.get('video'):
                if row['video'] not in validated:
                    import_targets(Path(row['source']), row['video'], videos, row.get('suffix'))
                    validated.add(row['video'])
                output = subtitle_target(Path(row['source']), row['video'], row.get('suffix'))
                row['target'] = str(output)
                row['existing'] = output.exists() or output.is_symlink()
        return {'videos': list(videos), 'rows': rows}
    if action == 'subtitle-execute':
        from .rename.subtitle_import import execute_import
        count = execute_import(body['id'], body['rows'])
        from .rename.review_rollback import finish
        finish(body['id'], 'superseded')
        return {'message': f'已导入 {count} 个字幕',
                'videos': list(dict.fromkeys(row['video'] for row in body['rows'] if row.get('video')))}
    if action == 'config':
        config = copy.deepcopy(cm.config)
        config['deepseek_key_configured'] = bool(config.get('deepseek_api_key'))
        config['deepseek_api_key'] = ''
        config['bigmodel_key_configured'] = bool(config.get('bigmodel_api_key'))
        config['bigmodel_api_key'] = ''
        return config
    if action == 'save-config':
        changes = body.get('changes', {})
        if any(k not in CONFIG_DEFAULT for k in changes):
            raise ValueError('不支持的配置项')
        if changes.get('mode', cm.get_config('mode')) not in {'链接', '复制', '剪切'}:
            raise ValueError('整理模式无效')
        if 'deepseek_api_key' in changes and not isinstance(changes['deepseek_api_key'], str):
            raise ValueError('DeepSeek API Key 必须为文本')
        if 'bigmodel_api_key' in changes and not isinstance(changes['bigmodel_api_key'], str):
            raise ValueError('智谱 API Key 必须为文本')
        if 'plan_ai_model' in changes:
            from .ai.bangumi_deepseek import PROFILES
            if changes['plan_ai_model'] not in PROFILES:
                raise ValueError('不支持的方案辅助模型')
        for key, value in changes.items():
            if key not in {'file_picker_history', 'file_picker_last_dir'}:
                cm.set_config(key, value)
        return {'message': '整理设置已保存'}
    raise ValueError('不支持的操作')


def register(app, lifecycle=None):
    token = secrets.token_urlsafe(32)
    atomic_write(DATA_PATH / 'desktop-api.json', {'token': token})
    jobs = {}

    def authorize(request):
        if not secrets.compare_digest(request.headers.get('x-bgm-token', ''), token):
            raise HTTPException(403, '无效的桌面访问令牌')

    @app.get('/integration/v1/tasks')
    async def tasks(request: Request):
        authorize(request)
        def snapshot():
            result, errors = [], []
            for file in sorted(TASK_PATH.glob('*.json'), key=lambda p: p.stat().st_mtime_ns, reverse=True):
                try:
                    task = read_task(file.stem)
                    plan_file = DATA_PATH / 'rename_plans' / file.name
                    state = None
                    if plan_file.exists():
                        try:
                            state = json.loads(plan_file.read_text(encoding='utf-8')).get('state')
                        except (OSError, ValueError):
                            pass
                    from .rename.review_rollback import available, blocked
                    task['can_cancel_review'] = available(file.stem)
                    task['rollback_blocked'] = blocked(file.stem)
                    task['plan_state'] = state
                    result.append(task)
                except (OSError, ValueError) as exc:
                    errors.append({'file': file.name, 'error': str(exc)})
            return {'tasks': result, 'errors': errors}
        snapshot_jobs = [{key: job.get(key) for key in ('id', 'action', 'task_id', 'state', 'error', 'progress')} for job in jobs.values()]
        result = await asyncio.to_thread(snapshot)
        result['jobs'] = snapshot_jobs
        return result

    @app.get('/integration/v1/jobs/{job_id}')
    async def job(request: Request, job_id: str):
        authorize(request)
        if job_id not in jobs:
            raise HTTPException(404, '任务状态已失效，请刷新记录')
        return jobs[job_id]

    @app.post('/integration/v1/action/{action}')
    async def action(request: Request, action: str):
        authorize(request)
        if lifecycle and lifecycle.draining:
            raise HTTPException(503, '整理后台正在更新，请稍后重试')
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, '参数无效')
        if len([j for j in jobs.values() if j['state'] in {'queued', 'running'}]) >= 30:
            raise HTTPException(429, '队列已满，请等待现有任务完成')
        identifier = uuid.uuid4().hex
        job = {'id': identifier, 'action': action, 'task_id': body.get('id'), 'state': 'queued'}
        jobs[identifier] = job

        async def work():
            from .rename.runner import run_serialized
            try:
                def execute():
                    job['state'] = 'running'
                    def update_progress(stage, timings):
                        job.update(progress=stage, timings=timings)
                    return perform(action, {**body, '_progress': update_progress})
                job['result'] = await run_serialized(execute)
                job['state'] = 'completed'
            except Exception as exc:
                job.update(state='failed', error=str(exc))
            finally:
                finished = [key for key, value in jobs.items() if value['state'] in {'completed', 'failed'}]
                for key in finished[:-200]:
                    jobs.pop(key, None)
        # Keep a reference independent of browser/client lifetime.
        task = asyncio.create_task(work())
        running.add(task)
        task.add_done_callback(running.discard)
        return {'job_id': identifier}
    running = set()
    if lifecycle:
        lifecycle.jobs = jobs

        @app.post('/integration/v1/control/attach')
        async def attach(request: Request):
            authorize(request)
            body = await request.json()
            pid = body.get('pid') if isinstance(body, dict) else None
            if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
                raise HTTPException(400, '无效的桌面进程')
            lifecycle.owners.add(pid)
            return {'attached': True}

        @app.post('/integration/v1/control/shutdown')
        async def shutdown(request: Request):
            authorize(request)
            lifecycle.draining = True
            return {'draining': True, 'active_jobs': lifecycle.active_jobs()}
