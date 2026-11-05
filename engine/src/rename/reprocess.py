from pathlib import Path
from typing import Any, Dict, Optional

from ..config.config_manager import cm
from ..utils.utils import (
    prepare_retry_process_inputs,
)
from .process import Rename


def normalize_tri_state(value: Any) -> Optional[bool]:
    if value in (True, False, None):
        return value
    if value == '是':
        return True
    if value == '否':
        return False
    if value == '自动':
        return None
    return value


def reprocess_task(task_data: Dict[str, Any]) -> Optional[str]:
    if not task_data:
        return '任务数据不存在'

    task_uuid = str(task_data.get('uuid') or '').strip()
    path_value = str(task_data.get('path') or '').strip()
    if not task_uuid or not path_value:
        return '任务数据缺少必要字段'

    from .plan_resolution import task_context
    migration = task_data.get('migration') or {}
    if (task_data.get('layout') == 'bangumi' and migration.get('bulk_journal')
            and migration.get('recognition_context') == task_context(task_data)):
        from ..utils.utils import get_record, extract_record_entries
        record = get_record(task_uuid)
        entries = extract_record_entries(record)
        if not entries:
            return '条目迁移的操作记录不可用，请先恢复记录'
        missing = []
        for entry in entries.values():
            values = [entry] if isinstance(entry, str) else [entry.get('target'), entry.get('mirror')]
            for value in values:
                if value and not (Path(value).is_file() or Path(value).is_dir()):
                    missing.append(value)
        # Confirmed split subjects and arc offsets must not be reinterpreted by
        # the old one-subject recognition path on an unchanged retry.
        return '迁移输出不可用，请核对：\n' + '\n'.join(missing) if missing else None

    from .plan_resolution import load_plan
    pending = load_plan(task_uuid)
    if pending and pending['state'] == 'pending' and pending['context'].get('layout_migration'):
        return '此任务已有目录迁移预览，请在文件方案中执行或取消迁移'

    from .plan_resolution import retry_decided_task
    handled, result = retry_decided_task(task_data)
    if handled:
        return result

    retry_inputs = prepare_retry_process_inputs(task_data)
    use_ai = bool(task_data.get('use_ai', True))
    original_ai_enabled = None
    if not use_ai:
        original_ai_enabled = cm.get_config('ai_enabled')
        cm.set_config('ai_enabled', False)

    try:
        result = Rename().process(
            Path(path_value),
            normalize_tri_state(task_data.get('is_anime')),
            normalize_tri_state(task_data.get('is_movie')),
            task_uuid,
            retry_inputs['name'],
            retry_inputs['season_id'],
            retry_inputs['subtitle_group'],
            retry_inputs['year'],
            retry_inputs['tmdb_id'],
            retry_inputs['bgm_id'],
            retry_inputs['skip_search'],
        )
    finally:
        if original_ai_enabled is not None:
            cm.set_config('ai_enabled', original_ai_enabled)

    return result if isinstance(result, str) else None
