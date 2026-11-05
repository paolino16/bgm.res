import json
import os
from pathlib import Path

MAIN_PATH = Path(__file__).parents[1]
PROJECT_PATH = Path(__file__).parents[2]
# The desktop integration writes this pointer only after a verified data copy.
POINTER_PATH = PROJECT_PATH / '.bgm-storage.json'
def resolve_data_path():
    override = os.environ.get('BGM_RENAME_DATA')
    if override:
        return Path(override).expanduser().resolve()
    if POINTER_PATH.exists():
        pointer = json.loads(POINTER_PATH.read_text(encoding='utf-8'))
        target = Path(pointer['renameData'])
        if not target.is_absolute() or not target.is_dir():
            raise RuntimeError('统一整理数据目录不可用，请检查 .bgm-storage.json')
        return target
    return PROJECT_PATH / 'data'

DATA_PATH = resolve_data_path()

CONFIG_PATH = DATA_PATH / 'config.json'
LOG_PATH = DATA_PATH / 'log'
RECORD_PATH = DATA_PATH / 'record'
TASK_PATH = DATA_PATH / 'task'
AI_ANALYSIS_PATH = DATA_PATH / 'ai_analysis'

log_path = LOG_PATH / 'BAR.log'
for i in [DATA_PATH, LOG_PATH, RECORD_PATH, TASK_PATH, AI_ANALYSIS_PATH]:
    if not i.exists():
        i.mkdir(parents=True)
