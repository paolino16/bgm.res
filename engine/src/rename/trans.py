import os
import json
import re
import shutil
from typing import Any, Dict, Optional, Set
from pathlib import Path

from ..logger import logger
from ..utils.path import RECORD_PATH
from ..config.config_manager import cm
from ..utils.utils import extract_record_entries, extract_record_targets
from .preflight import expected_videos, inspect_plan, format_report
from .rename_strategy import distinguish_versions


class Trans:
    def __init__(self, R: Dict[Path, Path], uuid: str, source_root: Optional[Path] = None,
                 *, plan_context=None, skipped_sources=(), resolve_versions=True, save_plan=True) -> None:
        self.mode = cm.get_config('mode')
        self.R, self.automatic_versions = distinguish_versions(R) if resolve_versions else (dict(R), [])
        self.uuid = uuid
        self.source_root = source_root
        self.plan_context = plan_context or {}
        self.skipped_sources = set(skipped_sources)
        self.save_plan = save_plan
        self.record_path = RECORD_PATH / f'{uuid}.json'

    def preflight(self, previous_targets):
        mirrors = [(source, self._build_mirror_target_path(source, target))
                   for source, target in self.R.items()
                   if self.mode == '链接' and self._should_use_mirror_link(source, target)]
        try:
            selected = None
            if 'source_files' in self.plan_context:
                selected = set(map(Path, self.plan_context['source_files']))
                if not selected.issuperset(self.R):
                    raise ValueError('方案包含种子勾选范围外的文件')
            videos = ()
            if self.source_root is not None:
                videos = [p for p in expected_videos(self.source_root, selected) if p not in self.skipped_sources]
            return inspect_plan(self.R, previous_targets, self.mode, videos=videos,
                                mirrors=mirrors, reusable=self._is_reusable_existing_target,
                                allow_empty=bool(self.skipped_sources))
        except OSError as exc:
            return [{'reason': f'无法完整扫描源目录：{exc}',
                     'sources': [str(self.source_root)], 'target': ''}]

    def _load_record(self, path: Path) -> Dict[str, Any]:
        if not path.exists():
            return {}

        try:
            with open(path, 'r', encoding='utf-8') as f:
                record = json.load(f)
        except Exception as e:
            logger.warning(f'[处理迁移] 读取旧记录失败，跳过旧文件清理: {e}')
            return {}

        if not isinstance(record, dict):
            return {}
        return record

    def _load_previous_targets(self, path: Path) -> Set[Path]:
        record = self._load_record(path)
        return extract_record_targets(record)

    def _build_record_payload(
        self,
        entries: Dict[str, Any],
        status: str,
    ) -> Dict[str, Any]:
        payload = {
            'status': status,
            'entries': entries,
        }
        if self.plan_context.get('layout') == 'bangumi':
            payload.update(schema_version=2, metadata_source='bangumi',
                           subject_id=self.plan_context.get('subject_id'),
                           episode_bindings=self.plan_context.get('bindings', []))
        return payload

    def _write_record(
        self,
        path: Path,
        entries: Dict[str, Any],
        status: str,
    ) -> None:
        payload = self._build_record_payload(entries, status)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=4)

    def _cleanup_previous_targets(self, previous_targets: Set[Path]) -> None:
        for target_path in previous_targets:
            try:
                if target_path.is_file() or target_path.is_symlink():
                    target_path.unlink()
            except FileNotFoundError:
                continue
            except Exception as e:
                logger.warning(f'[处理迁移] 清理旧文件失败 {target_path}: {e}')

        self._remove_empty_season_dirs(previous_targets)

    def _remove_empty_season_dirs(self, previous_targets: Set[Path]) -> None:
        checked_dirs = sorted(
            {target_path.parent for target_path in previous_targets},
            key=lambda path: len(path.parts),
            reverse=True,
        )
        for directory in checked_dirs:
            current = directory
            while self._is_empty_season_dir(current):
                try:
                    current.rmdir()
                    logger.info(f'[处理迁移] 删除空Season目录 {current}')
                except OSError:
                    break
                current = current.parent

    def _is_empty_season_dir(self, path: Path) -> bool:
        return (
            path.is_dir()
            and re.fullmatch(r'Season ?\d+', path.name) is not None
            and not any(path.iterdir())
        )

    def _is_empty_cleanup_dir(self, path: Path) -> bool:
        return path.is_dir() and not any(path.iterdir())

    def _remove_empty_parent_dirs(self, previous_targets: Set[Path]) -> None:
        checked_dirs = sorted(
            {target_path.parent for target_path in previous_targets},
            key=lambda path: len(path.parts),
            reverse=True,
        )
        for directory in checked_dirs:
            current = directory
            while self._is_empty_cleanup_dir(current):
                try:
                    current.rmdir()
                    logger.info(f'[处理迁移] 删除空目录 {current}')
                except OSError:
                    break
                parent = current.parent
                if parent == current:
                    break
                current = parent

    def _ensure_target_available(
        self,
        target_path: Path,
        previous_targets: Set[Path],
        source_path: Optional[Path] = None,
    ) -> Optional[str]:
        if not target_path.parent.exists():
            target_path.parent.mkdir(parents=True)
        if target_path.exists() or target_path.is_symlink():
            if target_path not in previous_targets:
                if self._is_reusable_existing_target(source_path, target_path):
                    logger.info(
                        '[处理迁移] 已存在目标与当前源文件一致，按可复用历史处理: '
                        f'{target_path}'
                    )
                    target_path.unlink()
                    return None
                message = (
                    f'[处理迁移] 目标文件已存在且不属于当前任务历史记录: '
                    f'{target_path}'
                )
                logger.error(message)
                return message
            target_path.unlink()
        return None

    def _is_reusable_existing_target(
        self,
        source_path: Optional[Path],
        target_path: Path,
    ) -> bool:
        if source_path is None or self.mode != '链接':
            return False
        if not source_path.exists():
            return False

        try:
            return os.path.samefile(source_path, target_path)
        except FileNotFoundError:
            return False
        except OSError as e:
            logger.warning(
                f'[处理迁移] 复用目标同源校验失败 {target_path}: {e}'
            )
            return False

    def _should_use_mirror_link(self, source_path: Path, target_path: Path) -> bool:
        return (
            os.name == 'nt'
            and
            bool(source_path.drive)
            and bool(target_path.drive)
            and source_path.drive.lower() != target_path.drive.lower()
        )

    def _build_mirror_target_path(
        self,
        source_path: Path,
        target_path: Path,
    ) -> Path:
        relative_parts = target_path.parts[1:]
        return Path(source_path.anchor).joinpath(*relative_parts)

    def _create_link_with_mirror(
        self,
        source_path: Path,
        target_path: Path,
        previous_targets: Set[Path],
    ) -> Dict[str, str]:
        try:
            os.link(source_path, target_path)
            logger.info(f'[处理迁移] 已创建硬链接 {target_path}')
            return {'target': str(target_path)}
        except Exception as hardlink_error:
            logger.warning(
                f'[处理迁移] 无法直接创建硬链接 {target_path}: '
                f'{hardlink_error}'
            )

        if not self._should_use_mirror_link(source_path, target_path):
            logger.warning('[处理迁移] 非跨盘场景，回退为软链接')
            os.symlink(source_path, target_path)
            return {'target': str(target_path)}

        mirror_path = self._build_mirror_target_path(source_path, target_path)
        if not self._is_reusable_existing_target(source_path, mirror_path):
            message = self._ensure_target_available(
                mirror_path, previous_targets, source_path=source_path,
            )
            if message:
                raise FileExistsError(message)
            os.link(source_path, mirror_path)
        logger.info(f'[处理迁移] 已创建镜像硬链接 {mirror_path}')
        os.symlink(mirror_path, target_path)
        logger.info(f'[处理迁移] 已创建目标软链接 {target_path} -> {mirror_path}')
        return {
            'target': str(target_path),
            'mirror': str(mirror_path),
        }

    def trans_file(self):
        path = self.record_path
        previous_record = self._load_record(path)
        previous_targets = extract_record_targets(previous_record)
        issues = self.preflight(previous_targets)
        from ..integration_api import preview_only
        if preview_only():
            from .plan_resolution import save_failed_plan
            save_failed_plan(self, issues)
            return '[待审核] 识别完成，请在资源整理中核对方案后执行'
        if issues:
            if self.save_plan:
                from .plan_resolution import save_failed_plan
                save_failed_plan(self, issues)
            message = format_report(issues)
            logger.error(message)
            return message
        if self.save_plan:
            from .plan_resolution import invalidate_plan
            invalidate_plan(self.uuid)
        old_entries = extract_record_entries(previous_record)
        record_data = {s: entry for s, entry in old_entries.items() if Path(s) in self.skipped_sources}
        reused = set()
        for source, target in self.R.items():
            if self._is_reusable_existing_target(source, target):
                reused.add(source)
                entry = old_entries.get(str(source))
                if not isinstance(entry, dict) or entry.get('target') != str(target):
                    entry = {'target': str(target)}
                    if self._should_use_mirror_link(source, target) and target.is_symlink():
                        mirror = self._build_mirror_target_path(source, target)
                        if target.resolve() == mirror.resolve() and mirror.exists():
                            entry['mirror'] = str(mirror)
                record_data[str(source)] = entry
        retained = extract_record_targets({'entries': record_data})
        self._cleanup_previous_targets(previous_targets - retained)
        self._write_record(path, record_data, 'running')

        for source_path, target_path in self.R.items():
            try:
                if source_path in reused:
                    logger.info(f'[处理迁移] 同源目标已存在，直接跳过：{target_path}')
                    continue
                if target_path.is_dir() or source_path.is_dir():
                    raise IsADirectoryError('源文件或目标在检查后变成了文件夹')
                message = self._ensure_target_available(
                    target_path,
                    previous_targets,
                    source_path=source_path,
                )
                if message:
                    self._write_record(path, record_data, 'failed')
                    return f'{message}\n源文件：{source_path}\n目标：{target_path}'
                if self.mode == '剪切':
                    shutil.move(source_path, target_path)
                    record_entry = {'target': str(target_path)}
                elif self.mode == '复制':
                    shutil.copy(source_path, target_path)
                    record_entry = {'target': str(target_path)}
                elif self.mode == '链接':
                    record_entry = self._create_link_with_mirror(
                        source_path,
                        target_path,
                        previous_targets,
                    )
                else:
                    message = '[处理迁移] 模式错误！仅支持剪切, 复制, 链接'
                    logger.error(message)
                    self._write_record(path, record_data, 'failed')
                    return message
                record_data[str(source_path)] = record_entry
                self._write_record(path, record_data, 'running')
            except Exception as e:
                logger.error(str(e))
                self._write_record(path, record_data, 'failed')
                return f'文件操作失败：{e}\n源文件：{source_path}\n目标：{target_path}'

        self._write_record(path, record_data, 'completed')
        self._remove_empty_parent_dirs(previous_targets)
