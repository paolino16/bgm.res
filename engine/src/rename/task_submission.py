"""Reuse an existing source-path task instead of creating another UUID."""

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from ..utils.path import TASK_PATH
from ..utils.task_identity import task_path_key
from ..utils.task_index import TaskIndex


@dataclass
class ExistingTasks:
    tasks: list[dict]
    new_tasks: int = 0

    @property
    def message(self):
        lines = ['已跳过重复提交，沿用已有任务；重复路径未执行识别或文件操作。']
        for task in self.tasks:
            state = '已有任务需要处理，请到原记录查看问题或重试' if task['has_error'] else '已有任务已完成'
            lines.append(f'{task["path"]}\n任务 {task["uuid"]}：{state}')
        if self.new_tasks:
            lines.append(f'另有 {self.new_tasks} 个新任务已完成。')
        return '\n'.join(lines)


@lru_cache(maxsize=8)
def _index(directory):
    return TaskIndex(Path(directory))


def existing_task(path, directory=None):
    directory = TASK_PATH if directory is None else directory
    rows = _index(str(directory)).refresh().rows
    key = task_path_key(path)
    matches = [row for row in rows if key and not row.get('manifest_scoped') and task_path_key(row['path']) == key]
    # A single source pack may already have been split into one task per Bangumi
    # subject. Return the whole set so resubmission does not hide those records.
    if matches:
        matches.sort(key=lambda row: row['has_error'])
        return ExistingTasks(matches)
    return None
