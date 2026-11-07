"""Local subtitle matching and exclusive, journalled copy imports."""
import json
import os
import re
import shutil
import unicodedata
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from ..utils.path import DATA_PATH, RECORD_PATH
from ..utils.utils import extract_record_entries, get_record
from .utils import VIDEO_SUFFIX

SUBTITLES = {'.ass', '.ssa', '.srt', '.vtt', '.sub', '.idx', '.sup', '.smi', '.sami', '.ttml'}
LANG = re.compile(r'(\.(?:(?:chs|cht|sc|tc|jpsc|jptc|zh|ja|jpn|en|eng|gb|big5)(?:&(?:chs|cht|jpn|eng))*|forced|sdh))+$', re.I)


def episode_key(filename):
    name = unicodedata.normalize('NFKC', Path(filename).stem)
    if re.search(r'\d\s*[-~+]\s*\d|S\d+E\d+E\d+', name, re.I):
        return None
    n = r'(\d{1,3}(?:\.\d+)?[AB]?)(?:v\d+)?(?![a-z0-9])'
    patterns = [r'(?<![a-z0-9])S(\d+)\s*E' + n,
                r'(?<![a-z0-9])(NCOP|NCED|OVA|OAD|SP|OP|ED|PV|OTHER|MAD)[ ._-]*' + n,
                r'(?<![a-z0-9])(?:EP|E)[ ._-]*' + n,
                r'第\s*' + n + r'\s*[话話集]', r'[\[【(]\s*' + n + r'\s*[\]】)]',
                r'(?:^|[\s_-])' + n + r'(?=\s*(?:[\[.(]|$))']
    for index, pattern in enumerate(patterns):
        matches = list(re.finditer(pattern, name, re.I))
        if not matches:
            continue
        keys = set()
        for match in matches:
            season = int(match[1]) if index == 0 else None
            kind = match[1].upper() if index == 1 else 'EP'
            value = match[2] if index < 2 else match[1]
            part = value[-1].upper() if value[-1].isalpha() else ''
            value = value[:-1] if part else value
            if Decimal(value) >= 240:
                return None
            keys.add((season, kind, Decimal(value), part))
        return keys.pop() if len(keys) == 1 else None
    return None


def library_videos(record):
    result = {}
    for source, entry in extract_record_entries(record).items():
        target = entry if isinstance(entry, str) else entry.get('target')
        if target and Path(target).suffix.lower() in VIDEO_SUFFIX and Path(target).is_file():
            result.setdefault(str(Path(target)), []).append(source)
    return result


def detected_suffix(source):
    match = LANG.search(Path(source).stem)
    return match[0][1:].lower() if match else ''


def normalize_suffix(value):
    value = str(value).strip()
    if value.startswith('.'):
        value = value[1:]
    if value and (any(c in value for c in '<>:"/\\|?*') or
                  any(ord(c) < 32 for c in value) or
                  any(not part or part != part.strip() for part in value.split('.'))):
        raise ValueError('字幕后缀不能包含路径符号、空段或首尾空格，例如 chs、cht、chs.字幕组')
    return value


def subtitle_target(source, video, suffix=None):
    source, video = Path(source), Path(video)
    suffix = detected_suffix(source) if suffix is None else normalize_suffix(suffix)
    return video.with_name(video.stem + ('.' + suffix if suffix else '') + source.suffix.lower())


def import_targets(source, video, videos, suffix=None):
    originals = list(dict.fromkeys(videos.get(video, [])))
    if len(originals) != 1 or not Path(originals[0]).is_file():
        raise ValueError('原视频不存在或对应多个原文件，无法安全写回原目录，请先核对任务记录')
    return subtitle_target(source, originals[0], suffix), subtitle_target(source, video, suffix)


def selected_subtitles(folder=None, files=None):
    if files is not None:
        if not isinstance(files, list) or not files or any(not isinstance(p, str) or not p.strip() for p in files):
            raise ValueError('请选择有效的字幕文件')
        candidates = [Path(p).expanduser() for p in files]
        if any(p.suffix.lower() not in SUBTITLES or not p.is_file() for p in candidates):
            raise ValueError('选择的字幕文件不存在或格式不支持，请重新选择')
    else:
        if not folder or not str(folder).strip():
            raise ValueError('请选择字幕文件或目录')
        root = Path(folder).expanduser()
        if root.is_file():
            return selected_subtitles(files=[str(root)])
        if not root.is_dir():
            raise ValueError('请选择有效的字幕文件或目录')
        from .source_scan import files_in
        candidates = [p for p in files_in(root) if p.suffix.lower() in SUBTITLES]
    return sorted({os.path.normcase(os.path.abspath(p)): p for p in candidates}.values())


def chapter_candidates(chapters, videos, parsed):
    """Use confirmed library membership; filenames only supply season hints."""
    if not isinstance(chapters, list):
        raise ValueError('章节信息无效，请重新预览')
    paths = {os.path.normcase(os.path.abspath(target)): target for target in videos}
    index = defaultdict(list)
    for chapter in chapters:
        number = Decimal(str(chapter['number']))
        if not number.is_finite() or number <= 0:
            raise ValueError('章节集数无效，请重新预览')
        targets = list(dict.fromkeys(paths[key] for file in chapter.get('videos', [])
                                    if (key := os.path.normcase(os.path.abspath(file))) in paths))
        if not targets:
            continue
        seasons = set()
        for target in targets:
            for alias in [target, *videos[target]]:
                key = parsed.get(alias)
                if key and key[0] is not None:
                    seasons.add(key[0])
        index[(chapter.get('kind', 'EP'), number, '')].append((targets, seasons))
    return index


def preview_records(records, folder=None, offset=0, *, files=None, chapters=None):
    sources = selected_subtitles(folder, files)
    merged = {}
    for record in records:
        for source, entry in extract_record_entries(record).items():
            target = entry if isinstance(entry, str) else entry.get('target')
            if target and Path(target).suffix.lower() in VIDEO_SUFFIX:
                merged.setdefault(str(Path(target)), []).append(source)
    # Verify each distinct library video once, even for packs with many records.
    videos = {target: list(dict.fromkeys(originals)) for target, originals in merged.items() if Path(target).is_file()}
    if not videos:
        raise ValueError('此任务没有可用的已整理视频，请先完成视频整理')
    index = defaultdict(list)
    parsed = {}
    for target, originals in videos.items():
        for alias in [target, *originals]:
            if alias not in parsed:
                parsed[alias] = episode_key(alias)
            other = parsed[alias]
            if other:
                index[other[1:]].append((target, other[0]))
    shift = Decimal(str(offset))
    if not shift.is_finite():
        raise ValueError('集数偏移必须是有限数值')
    chapter_index = chapter_candidates(chapters, videos, parsed) if chapters is not None else None
    rows = []
    for source in sources:
        key = episode_key(source.name)
        candidates = []
        if key and key[1] == 'EP' and chapter_index is not None:
            season, kind, number, part = key
            matches = [(targets, seasons) for targets, seasons in chapter_index[(kind, number + shift, part)]
                       if season is None or not seasons or season in seasons]
            candidates = list(dict.fromkeys(target for targets, _ in matches for target in targets))
            # Multiple chapters or conflicting season hints require confirmation.
            selected = candidates if len(matches) == 1 and len(matches[0][1]) <= 1 else []
            reason = (f'按媒体库 EP{number + shift} 匹配，已选择同集 {len(selected)} 个版本' if selected
                      else '章节或季度有歧义，请选择' if candidates else '未找到对应的媒体库 EP，请选择')
            rows.append({'source': str(source), 'video': selected[0] if len(selected) == 1 else '',
                         'videos': selected, 'candidates': candidates, 'suffix': detected_suffix(source),
                         'reason': reason})
            continue
        if key:
            season, kind, number, part = key
            candidates = [target for target, other_season in index[(kind, number + shift, part)]
                          if season is None or other_season is None or season == other_season]
        candidates = list(dict.fromkeys(candidates))
        video = candidates[0] if len(candidates) == 1 else ''
        rows.append({'source': str(source), 'video': video, 'candidates': candidates, 'suffix': detected_suffix(source),
                     'reason': '按集数匹配' if video else '多个候选，请选择' if candidates else '未匹配，请选择'})
    return videos, rows


def preview_import(record, folder=None, offset=0, *, files=None):
    return preview_records([record], folder, offset, files=files)


def execute_import(task_id, rows):
    record = get_record(task_id)
    videos = library_videos(record)
    operations, targets, entries = [], set(), dict(extract_record_entries(record))
    count = 0
    for row in rows:
        if not row.get('video'):
            continue
        source = Path(row['source'])
        if row['video'] not in videos or source.suffix.lower() not in SUBTITLES or not source.is_file():
            raise ValueError('文件或任务已变化，请重新预览')
        original, output = import_targets(source, row['video'], videos, row.get('suffix'))
        for target in dict.fromkeys([original, output]):
            key = str(target.absolute()).casefold()
            if key in targets or (target == original and os.path.lexists(target)):
                raise ValueError(f'目标重复或已存在，请跳过其中一项：{target}')
            if target.is_dir():
                raise ValueError(f'目标是目录，无法写入字幕：{target}')
            targets.add(key)
        operations.append({'source': str(source), 'original': str(original),
                           'target': str(output), 'copied': False})
        entries[str(original)] = {'target': str(output)}
        count += 1
    if not operations:
        raise ValueError('没有已匹配的字幕')
    journal_dir = DATA_PATH / 'subtitle_imports'
    journal_dir.mkdir(exist_ok=True)
    journal = journal_dir / f'{uuid4().hex}.json'
    payload = {'task_id': task_id, 'state': 'running', 'operations': operations}

    def save():
        temporary = journal.with_suffix('.tmp')
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(journal)

    save()
    created, backups, staged = [], [], []
    try:
        for operation in operations:
            original = Path(operation['original'])
            target = Path(operation['target'])
            with original.open('xb') as output:
                created.append(original)
                with open(operation['source'], 'rb') as source:
                    shutil.copyfileobj(source, output)
            if original != target:
                stage = target.with_name(f'.{target.name}.{uuid4().hex}.link')
                staged.append(stage)
                try:
                    os.link(original, stage)
                    operation['link_type'] = 'hardlink'
                except OSError:
                    os.symlink(original.absolute(), stage)
                    operation['link_type'] = 'symlink'
                if os.path.lexists(target):
                    backup = target.with_name(f'.{target.name}.{uuid4().hex}.backup')
                    operation['backup'] = str(backup)
                    save()
                    target.replace(backup)
                    backups.append((target, backup))
                stage.replace(target)
                created.append(target)
            operation['copied'] = True
            save()
        payload['state'] = 'completed'
        save()
        # Track the original-named companion as the source, so retry cleanup
        # owns this output and can recreate it through the normal planner.
        updated = dict(record) if isinstance(record.get('entries'), dict) else {}
        updated['entries'] = entries
        record_path = RECORD_PATH / f'{task_id}.json'
        temporary = record_path.with_suffix('.subtitle-import.tmp')
        try:
            temporary.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding='utf-8')
            temporary.replace(record_path)
        finally:
            temporary.unlink(missing_ok=True)
    except Exception:
        for target in reversed(created):
            target.unlink(missing_ok=True)
        for target, backup in reversed(backups):
            backup.replace(target)
        for stage in staged:
            stage.unlink(missing_ok=True)
        payload['state'] = 'rolled_back'
        save()
        raise
    for _, backup in backups:
        backup.unlink(missing_ok=True)
    return count
