"""Read-only validation of the complete file operation plan."""

import os
import re
from collections import defaultdict
from pathlib import Path

from .utils import VIDEO_SUFFIX, IGNORE_DIR


def path_key(path: Path) -> str:
    # Do not resolve symlinks: existing links can be reusable output entries.
    return os.path.normcase(os.path.abspath(path))


def expected_videos(root: Path, files=None):
    from .source_scan import files_in
    candidates = files if files is not None else files_in(root) if root.is_dir() else [root]
    return sorted(path for path in candidates if path.suffix.lower() in VIDEO_SUFFIX
                  and path.is_file()
                  and not any(tag in path.name for tag in IGNORE_DIR))


def format_report(issues: list[dict]) -> str:
    lines = [f'执行前检查未通过：发现 {len(issues)} 个问题，本次未执行文件操作。']
    for number, issue in enumerate(issues, 1):
        lines.append(f'\n{number}. {issue["reason"]}')
        lines.extend(f'源文件：{source}' for source in issue['sources'])
        if issue.get('target'):
            lines.append(f'目标：{issue["target"]}')
    return '\n'.join(lines)


def inspect_plan(mapping, previous_targets, mode, *, videos=(), mirrors=(), reusable=None, allow_empty=False):
    issues = []

    def issue(reason, sources=(), target=None):
        issues.append({'reason': reason, 'sources': [str(p) for p in sources],
                       'target': str(target) if target is not None else ''})

    if mode not in {'剪切', '复制', '链接'}:
        issue('模式错误，仅支持剪切、复制、链接')
    if not mapping and not allow_empty:
        issue('没有生成任何文件映射')
    source_keys = {path_key(source): source for source in mapping}
    previous_keys = {path_key(target) for target in previous_targets}
    for source in videos:
        if path_key(source) not in source_keys:
            issue('视频未生成目标映射，可能漏处理', [source])
    for source in mapping:
        if not source.is_file():
            issue('源文件不存在或不是普通文件', [source], mapping[source])
        if path_key(source) in previous_keys:
            issue('源文件属于将被清理的历史输出', [source], mapping[source])

    destinations = defaultdict(list)
    operations = list(mapping.items()) + list(mirrors)
    for source, target in operations:
        destinations[path_key(target)].append((source, target))
    for key, entries in destinations.items():
        target = entries[0][1]
        sources = [entry[0] for entry in entries]
        if os.name == 'nt' and any(len(part.encode('utf-16-le')) // 2 > 255 for part in target.parts):
            issue('目标文件名或目录名过长，请缩短名称或版本标识', sources, target)
        if os.name == 'nt':
            parts = target.parts[1:] if target.anchor else target.parts
            if any(re.search(r'[<>:"|?*\x00-\x1f]', part) or part.rstrip(' .') != part
                   or re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part)
                   for part in parts):
                issue('目标包含 Windows 不支持的名称或字符', sources, target)
        if len(entries) > 1:
            issue('多个文件映射到同一目标', sources, target)
        if key in source_keys:
            issue('目标路径与本批次源文件重叠', sources, target)
        try:
            if target.is_dir():
                issue('目标路径已被文件夹占用', sources, target)
            elif (target.exists() or target.is_symlink()) and key not in previous_keys:
                if not (len(sources) == 1 and reusable and reusable(sources[0], target)):
                    issue('目标文件已存在且不属于当前任务历史记录', sources, target)
            parent = target.parent
            while parent != parent.parent:
                if path_key(parent) in destinations:
                    issue('目标父目录同时被规划为文件', sources, target)
                    break
                parent = parent.parent
            parent = target.parent
            while not parent.exists() and not parent.is_symlink() and parent != parent.parent:
                parent = parent.parent
            if not parent.is_dir():
                issue('目标父路径不是可用文件夹', sources, target)
        except OSError as exc:
            issue(f'无法检查目标路径：{exc}', sources, target)
    return issues
