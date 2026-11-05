"""Reviewable migration of recorded outputs, including tasks whose sources are gone."""

import copy
import json
import os
import uuid
from pathlib import Path

from ..utils.path import DATA_PATH, TASK_PATH, RECORD_PATH
from ..utils.utils import extract_record_entries
from .bangumi_native import plan_subject, subject_directory
from .get_info import Search
from .plan_resolution import save_failed_plan, load_plan
from .preflight import inspect_plan, format_report
from .task_schema import normalize_task, atomic_write
from .trans import Trans
from .utils import VIDEO_SUFFIX


def prepare_layout_migration(task_id):
    existing_plan = load_plan(task_id)  # Also validates the task identifier.
    task_path = TASK_PATH / f'{task_id}.json'
    record_path = RECORD_PATH / f'{task_id}.json'
    task = json.loads(task_path.read_text(encoding='utf-8'))
    normalized = normalize_task(task)
    if normalized.get('layout') == 'bangumi':
        raise ValueError('此任务已经使用 Bangumi 条目目录')
    bgm_id = normalized.get('subject_id') or normalized.get('bgm_id')
    if not bgm_id or normalized.get('tmdb_id'):
        raise ValueError('请先在编辑任务中确认 Bangumi ID；TMDB 任务不自动转换')
    if existing_plan and existing_plan['state'] == 'pending':
        raise ValueError('此任务已有待处理方案，请先处理或重新识别后再生成迁移预览')
    record = json.loads(record_path.read_text(encoding='utf-8'))
    entries = extract_record_entries(record)
    owned = {Path(entry if isinstance(entry, str) else entry['target']) for entry in entries.values()
             if isinstance(entry, str) or isinstance(entry, dict) and entry.get('target')}
    videos = sorted(p for p in owned if p.suffix.lower() in VIDEO_SUFFIX)
    if not videos:
        raise ValueError('操作记录中没有可迁移的视频输出')
    search = Search()
    name, info = search.get_bangumi_info(task.get('name') or '', 0, bgm_id=int(bgm_id))
    if not info:
        raise ValueError(search.last_error or '无法取得 Bangumi 条目')
    episodes = search.get_bangumi_all_episodes(int(bgm_id))
    if episodes is None:
        raise ValueError(search.last_error or '无法取得完整章节列表')
    info['bangumi_episodes'] = episodes
    # Derive the existing library root from the record, not the current config.
    old_root = Path(os.path.commonpath([str(p.parent) for p in videos]))
    from .utils import is_special_dir_name, is_sp_extra_dir_name
    import re
    while re.fullmatch(r'(?i)Season\s*\d+', old_root.name) or is_special_dir_name(old_root.name) or is_sp_extra_dir_name(old_root.name):
        old_root = old_root.parent
    if old_root.parent == old_root:
        raise ValueError('输出跨越多个媒体库，请分开处理，无法推断条目目录')
    work_path = subject_directory(old_root.parent, info)
    mapping, bindings = {}, []
    for video in videos:
        if not video.is_file():
            # Keep the missing entry as an unresolved review row; never discard history.
            bindings.append({'source': str(video), 'category': 'unresolved', 'episode_id': None})
            continue
        planned, decisions = plan_subject(video, info, work_path, task.get('subtitle_group') or '')
        if task.get('identification', {}).get('review_required'):
            planned = {}
            for decision in decisions:
                decision.update(episode_id=None, category='unresolved')
        mapping.update({source: target for source, target in planned.items() if source in owned})
        bindings.extend(decisions)
    for path in owned - set(mapping) - set(videos):
        # Unpaired recorded resources retain names and relative directories.
        if path.is_relative_to(old_root):
            mapping[path] = work_path / 'Extras' / path.relative_to(old_root)
    metadata = dict(normalized)
    metadata.update(schema_version=2, layout='bangumi', metadata_source='bangumi', subject_id=str(bgm_id),
                    season_id=None, name=name, platform=info.get('platform') or '', use_ai=False, output_dir=str(work_path), error=None,
                    relations=search.get_bangumi_relations(int(bgm_id)), episode_bindings=bindings,
                    migration={'state': 'native', 'legacy_output_dir': task.get('output_dir', ''),
                               'legacy_season_id': task.get('season_id')})
    context = {'layout': 'bangumi', 'subject_id': str(bgm_id), 'name': name,
               'work_path': str(work_path), 'subtitle_group': task.get('subtitle_group') or '',
               'episodes': episodes, 'bindings': bindings, 'task_metadata': metadata,
               'layout_migration': {'task': task, 'record': record}}
    worker = Trans(mapping, task_id, source_root=old_root, plan_context=context)
    worker.mode = '剪切'
    worker.review_sources = videos
    save_failed_plan(worker, [{'reason': '将已记录的输出切换为 Bangumi 条目目录；请核对章节后重新检查',
                               'sources': [str(p) for p in videos], 'target': str(work_path)}])
    return load_plan(task_id)


class LayoutMigrationWorker(Trans):
    """Move only owned output entries, preserving mirrors and original source keys."""

    def __init__(self, plan, mapping, skipped):
        super().__init__(mapping, plan['uuid'], plan_context=plan['context'],
                         skipped_sources=skipped, resolve_versions=False, save_plan=False)
        self.mode = '剪切'

    def _load_previous_targets(self, path):
        return set()

    def _is_reusable_existing_target(self, source, target):
        return source == target and source.is_file()

    def preflight(self, previous_targets):
        snapshot = self.plan_context['layout_migration']
        issues = []
        for path, expected in ((TASK_PATH / f'{self.uuid}.json', snapshot['task']),
                               (self.record_path, snapshot['record'])):
            if not path.exists() or json.loads(path.read_text(encoding='utf-8')) != expected:
                issues.append({'reason': '任务或操作记录已改变，请重新生成迁移方案', 'sources': [str(path)], 'target': ''})
        operations = {s: t for s, t in self.R.items() if s != t}
        issues.extend(inspect_plan(operations, set(), '剪切', allow_empty=True))
        return issues

    def trans_file(self):
        issues = self.preflight(set())
        if issues:
            return format_report(issues)
        snapshot = self.plan_context['layout_migration']
        journal_dir = DATA_PATH / 'migrations' / f'layout-{self.uuid}-{uuid.uuid4().hex}'
        journal = {'state': 'prepared', 'task': snapshot['task'], 'record': snapshot['record'],
                   'operations': {str(s): str(t) for s, t in self.R.items()}, 'completed': [],
                   'task_id': self.uuid,
                   'identities': {str(s): [s.lstat().st_dev, s.lstat().st_ino] for s in self.R}}
        journal_path = journal_dir / 'journal.json'
        atomic_write(journal_path, journal)
        moved = []
        task_path = TASK_PATH / f'{self.uuid}.json'
        try:
            for source, target in self.R.items():
                if source == target:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    raise FileExistsError(str(target))
                os.replace(source, target)
                moved.append((source, target))
                journal['completed'] = [[str(s), str(t)] for s, t in moved]
                atomic_write(journal_path, journal)
            new_record = copy.deepcopy(snapshot['record'])
            entries = copy.deepcopy(extract_record_entries(new_record))
            for original, entry in entries.items():
                old = Path(entry if isinstance(entry, str) else entry.get('target', ''))
                if old not in self.R:
                    continue
                if isinstance(entry, str):
                    entries[original] = str(self.R[old])
                else:
                    entry['target'] = str(self.R[old])
            originals = {str(entry if isinstance(entry, str) else entry.get('target', '')): source
                         for source, entry in extract_record_entries(snapshot['record']).items()}
            bindings = [{**binding, 'source': originals.get(binding['source'], binding['source'])}
                        for binding in self.plan_context['bindings']]
            self.plan_context['task_metadata']['episode_bindings'] = bindings
            self.plan_context['task_metadata']['migration']['journal'] = str(journal_path)
            if self.skipped_sources:
                self.plan_context['task_metadata']['migration']['state'] = 'native_with_skips'
            record = {'schema_version': 2, 'status': new_record.get('status', 'completed'),
                      'entries': entries, 'metadata_source': 'bangumi',
                      'subject_id': self.plan_context['subject_id'],
                      'episode_bindings': bindings, 'migration_journal': str(journal_path)}
            task = {**snapshot['task'], **self.plan_context['task_metadata'], 'error': None}
            journal.update(state='committing', committed_task=task, committed_record=record)
            atomic_write(journal_path, journal)
            atomic_write(self.record_path, record)
            atomic_write(task_path, task)
            journal['state'] = 'completed'
            atomic_write(journal_path, journal)
        except Exception as exc:
            try:
                recover_layout_migration(journal_path)
            except Exception as rollback_exc:
                journal.update(state='rollback_failed', error=str(exc), rollback_error=str(rollback_exc))
                atomic_write(journal_path, journal)
                return f'迁移中断，需按日志恢复：{journal_path}；{rollback_exc}'
            return f'迁移失败，已回退：{exc}'
        return None


def recover_layout_migration(journal_path):
    """Roll back an interrupted migration using file identities, including a
    crash between a successful rename and the following journal update.
    """
    journal_path = Path(journal_path)
    journal = json.loads(journal_path.read_text(encoding='utf-8'))
    task_id = journal['task_id']
    # Validate before using the ID as a metadata filename.
    import re
    if not re.fullmatch(r'[\w-]+', task_id):
        raise ValueError('迁移日志任务编号无效')
    task_path, record_path = TASK_PATH / f'{task_id}.json', RECORD_PATH / f'{task_id}.json'
    for path, old, committed in ((task_path, journal['task'], journal.get('committed_task')),
                                 (record_path, journal['record'], journal.get('committed_record'))):
        current = json.loads(path.read_text(encoding='utf-8'))
        # execute_saved_plan adds file decisions after the worker commits.
        compare = {k: v for k, v in current.items() if k not in {'file_decisions', 'file_plan_context', 'skipped_files'}}
        committed_compare = {k: v for k, v in (committed or {}).items()
                             if k not in {'file_decisions', 'file_plan_context', 'skipped_files'}}
        if current != old and (committed is None or compare != committed_compare):
            raise ValueError(f'迁移后记录已修改，拒绝覆盖：{path}')
    reverse = []
    for source_value, target_value in journal['operations'].items():
        source, target = Path(source_value), Path(target_value)
        expected = journal['identities'][source_value]
        if source.exists() or source.is_symlink():
            stat = source.lstat()
            if [stat.st_dev, stat.st_ino] != expected:
                raise ValueError(f'原路径已被其他文件占用：{source}')
            continue
        if not target.exists() and not target.is_symlink():
            raise ValueError(f'迁移文件已无法找到：{source} → {target}')
        stat = target.lstat()
        if [stat.st_dev, stat.st_ino] != expected:
            raise ValueError(f'目标已被替换，拒绝回退：{target}')
        reverse.append((source, target))
    for source, target in reversed(reverse):
        source.parent.mkdir(parents=True, exist_ok=True)
        os.replace(target, source)
    atomic_write(record_path, journal['record'])
    atomic_write(task_path, journal['task'])
    journal['state'] = 'rolled_back'
    atomic_write(journal_path, journal)
    from .plan_resolution import invalidate_plan
    invalidate_plan(task_id)
    return {'restored_files': len(reverse), 'state': 'rolled_back'}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='回退已完成或中断的目录迁移；校验记录与文件身份')
    parser.add_argument('--rollback', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(recover_layout_migration(args.rollback), ensure_ascii=False, indent=2))
