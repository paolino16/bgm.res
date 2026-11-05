"""Metadata-only rollback for a desktop recognition review; never touches media."""
import hashlib
import json
from pathlib import Path
from .task_schema import atomic_write
from ..utils.path import DATA_PATH, TASK_PATH, RECORD_PATH


def paths(task_id):
    import re
    if not re.fullmatch(r'[\w-]+', str(task_id)):
        raise ValueError('无效任务编号')
    return (TASK_PATH / f'{task_id}.json', DATA_PATH / 'rename_plans' / f'{task_id}.json',
            RECORD_PATH / f'{task_id}.json', DATA_PATH / 'recognition_reviews' / f'{task_id}.json')


def read(file):
    return json.loads(file.read_text(encoding='utf-8')) if file.exists() else None


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest() if file.exists() else None


def begin(task_id):
    task, plan, record, snapshot = paths(task_id)
    before = read(snapshot)
    if before and before.get('state') in {'active', 'restoring'}:
        if before['record_hash'] != digest(record):
            raise ValueError('上次识别后操作记录已变化，请先核对，不能覆盖回退快照')
        if read(task) != before.get('expected_task'):
            raise ValueError('任务已被另外编辑，请先核对，不能覆盖回退快照')
        if before.get('state') == 'restoring':
            raise ValueError('上次取消尚未完成，请先继续取消恢复')
        if (read(plan) or {}).get('revision') != before.get('expected_revision'):
            raise ValueError('方案已被替换，不能覆盖回退快照')
        return
    original = read(task)
    if original is None:
        raise ValueError('原任务不存在')
    atomic_write(snapshot, {'state': 'active', 'task': original, 'plan': read(plan),
                           'record_hash': digest(record), 'expected_task': original,
                           'expected_revision': (read(plan) or {}).get('revision')})


def seal(task_id):
    task, plan, record, snapshot = paths(task_id)
    saved = read(snapshot)
    if saved and saved.get('state') == 'active':
        saved.update(expected_task=read(task), expected_revision=(read(plan) or {}).get('revision'))
        atomic_write(snapshot, saved)


def finish(task_id, state='committed'):
    *_, snapshot = paths(task_id)
    saved = read(snapshot)
    if saved and saved.get('state') == 'active':
        saved['state'] = state
        atomic_write(snapshot, saved)


def available(task_id):
    try:
        task, plan, record, snapshot = paths(task_id)
        saved = read(snapshot)
        return bool(saved and saved.get('state') in {'active', 'restoring'} and saved['record_hash'] == digest(record))
    except (OSError, ValueError, KeyError):
        return False


def blocked(task_id):
    try:
        *_, snapshot = paths(task_id)
        saved = read(snapshot)
        return bool(saved and saved.get('state') in {'active', 'restoring'} and not available(task_id))
    except (OSError, ValueError):
        return True


def cancel(task_id, revision=None):
    task, plan, record, snapshot = paths(task_id)
    saved, current, current_plan = read(snapshot), read(task), read(plan)
    if current is None:
        raise ValueError('任务不存在')
    if revision is not None and (current_plan or {}).get('revision') != revision:
        raise ValueError('方案已变化，请重新打开后取消')
    if saved and saved.get('state') in {'active', 'restoring'}:
        if digest(record) != saved['record_hash']:
            raise ValueError('本次识别后已发生文件操作或记录变更，不能用取消识别回退')
        if current != saved.get('expected_task') and not (saved['state'] == 'restoring' and current == saved['task']):
            raise ValueError('任务被另外编辑过，拒绝覆盖新信息')
        allowed_revisions = {saved.get('expected_revision'), (saved.get('plan') or {}).get('revision')}
        if (current_plan or {}).get('revision') not in allowed_revisions:
            raise ValueError('文件方案已被替换，拒绝覆盖')
        saved.update(state='restoring', cancelled_task=current, cancelled_plan=current_plan)
        atomic_write(snapshot, saved)
        atomic_write(task, saved['task'])
        if saved['plan'] is None:
            plan.unlink(missing_ok=True)
        else:
            atomic_write(plan, saved['plan'])
        saved['state'] = 'cancelled'
        atomic_write(snapshot, saved)
        return {'message': '已取消本次重新识别，恢复原任务信息和方案；原有输出文件保持原样', 'restored': True}
    # Old plans predate review snapshots. Retain their metadata as an archive,
    # but do not claim to reconstruct a former successful task.
    if not current_plan or current_plan.get('state') != 'pending':
        raise ValueError('没有可放弃的待审核方案')
    current_plan['state'] = 'cancelled'
    atomic_write(plan, current_plan)
    current['review_state'] = 'cancelled'
    atomic_write(task, current)
    return {'message': '已放弃此方案，原有输出文件保持原样。此旧方案没有回退快照，未恢复先前的识别信息', 'restored': False}
