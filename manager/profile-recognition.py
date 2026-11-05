"""Profile bgm.res's current Python recognition engine without touching live records.

Run with the engine's Python, e.g. .../Scripts/python.exe manager/profile-recognition.py.
Reports contain timings and source filenames, never config or HTTP credentials.
All writes (including preview plans) are confined to a temporary sandbox.
"""
import argparse
import cProfile
import functools
import json
import os
from pathlib import Path
import pstats
import re
import sys
import tempfile
import time
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=Path(__file__).resolve().parents[1] / 'engine')
    parser.add_argument('--data', type=Path)
    parser.add_argument('--task', action='append', help='Task UUID (repeatable); default: newest available file and directory')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--clean-file-title', action='store_true', help='Experiment only: remove video extension and [vN] from file search titles')
    args = parser.parse_args()
    engine = args.engine.resolve()
    data = args.data or Path(json.loads((engine / '.bgm-storage.json').read_text(encoding='utf-8'))['renameData'])
    tasks = []
    for file in sorted((data / 'task').glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True):
        if args.task and file.stem not in args.task:
            continue
        task = json.loads(file.read_text(encoding='utf-8'))
        source = Path(task.get('path', ''))
        if not source.exists() or not task.get('bgm_id'):
            continue
        if not args.task and any(Path(t['path']).is_dir() == source.is_dir() for t in tasks):
            continue
        tasks.append(task)
        if not args.task and len(tasks) == 2:
            break
    if not tasks:
        raise SystemExit('No available source tasks found')
    report = {'engine': str(engine), 'cases': [], 'ai_enabled': False, 'preview_only': True,
              'clean_file_title_experiment': args.clean_file_title,
              'cold_definition': 'Clears HTTP memory/disk response caches and connection session; OS disk cache is not cleared'}
    with tempfile.TemporaryDirectory(prefix='bgm-recognition-profile-') as sandbox_name:
        sandbox = Path(sandbox_name).resolve()
        config = {key: str(sandbox / key) for key in ('bangumi_path', 'movie_path', 'anime_path', 'anime_movie_path')}
        config.update(ai_enabled=False, log_level='WARNING')
        (sandbox / 'config.json').write_text(json.dumps(config), encoding='utf-8')
        os.environ['BGM_RENAME_DATA'] = str(sandbox)
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(engine))

        # Guard the entire engine run, not just the expected preview code path.
        allowed_output = None

        def check_write(path):
            if isinstance(path, (str, bytes, os.PathLike)):
                resolved = Path(os.fsdecode(path)).resolve()
                if not resolved.is_relative_to(sandbox) and resolved != allowed_output:
                    raise PermissionError('Profiler blocked write outside sandbox: ' + str(resolved))

        def audit(event, values):
            if event == 'open':
                path, mode, flags = values
                if (mode and any(c in mode for c in 'wax+')) or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
                    check_write(path)
            elif event in {'os.mkdir', 'os.remove', 'os.rmdir', 'os.chmod', 'os.truncate', 'os.utime'}:
                check_write(values[0])
            elif event in {'os.rename', 'os.link', 'os.symlink'}:
                for path in values[:2]:
                    check_write(path)

        sys.addaudithook(audit)
        started = time.perf_counter()
        from src.integration_api import recognize, preview_only
        from src.rename.process import Rename
        from src.rename.get_info import Search
        from src.rename.trans import Trans
        from src.rename import metadata_http
        import requests
        report['import_seconds'] = round(time.perf_counter() - started, 4)
        current = None
        if args.clean_file_title:
            original_context = Rename.search_folder_context

            def clean_context(self, path):
                name, platforms, season = original_context(self, path)
                if path.is_file() and name == path.name:
                    name = re.sub(r'(?i)\[v\d+\]', '', path.stem).strip()
                return name, platforms, season
            Rename.search_folder_context = clean_context

        def instrument(owner, name, collection):
            original = getattr(owner, name)

            @functools.wraps(original)
            def wrapped(*a, **kw):
                start = time.perf_counter()
                item = {'name': name}
                if collection in {'http', 'wire'}:
                    url = a[1].url if collection == 'wire' else a[2]
                    parsed = urlsplit(url)
                    item.update(host=parsed.hostname, path=parsed.path)
                try:
                    result = original(*a, **kw)
                    if collection in {'http', 'wire'}:
                        item['status'] = result.status_code
                    return result
                except Exception as exc:
                    item['error'] = type(exc).__name__
                    raise
                finally:
                    item['seconds'] = round(time.perf_counter() - start, 5)
                    if current is not None:
                        current[collection].append(item)
            setattr(owner, name, wrapped)

        for owner, names in (
            (Rename, ['__init__', '_contains_video_files', 'build_search_candidates', 'resolve_task_type', 'process']),
            (Search, ['search_bangumi_subjects', 'get_bangumi_info', 'get_bangumi_subject_by_id',
                      'get_bangumi_episodes', 'get_bangumi_all_episodes', 'get_bangumi_relations']),
            (Trans, ['preflight', 'trans_file']),
        ):
            for name in names:
                instrument(owner, name, 'phases')
        instrument(metadata_http.MetadataSession, 'request', 'http')
        instrument(requests.Session, 'send', 'wire')
        original_trans = Trans.trans_file

        def preview_trans(self):
            assert preview_only(), 'Profiler must never execute media operations'
            return original_trans(self)
        Trans.trans_file = preview_trans

        for task in tasks:
            source = Path(task['path'])
            for mode in ('auto-cold', 'auto-warm', 'id-cold', 'id-warm', 'id-persistent'):
                if mode.endswith(('cold', 'persistent')):
                    metadata_http._CACHE = metadata_http.ResponseCache()
                    if hasattr(metadata_http._local, 'session'):
                        metadata_http._local.session.close()
                        del metadata_http._local.session
                    if mode.endswith('cold') and (sandbox / 'metadata_cache').exists():
                        import shutil
                        shutil.rmtree(sandbox / 'metadata_cache')
                # Empty isolated task store prevents existing-task short circuits.
                for folder in ('task', 'rename_plans', 'recognition_reviews'):
                    target = sandbox / folder
                    if target.exists():
                        import shutil
                        shutil.rmtree(target)
                (sandbox / 'task').mkdir(exist_ok=True)
                current = {'source': source.name, 'mode': mode, 'phases': [], 'http': [], 'wire': []}
                before = source.stat()
                profile = cProfile.Profile()
                start = time.perf_counter()
                profile.enable()
                try:
                    changes = {'bgm_id': task['bgm_id']} if mode.startswith('id') else {}
                    result = recognize({'path': str(source), 'changes': changes})
                    current['result'] = result
                except Exception as exc:
                    current['error'] = type(exc).__name__ + ': ' + str(exc)
                finally:
                    profile.disable()
                    current['seconds'] = round(time.perf_counter() - start, 5)
                records = [json.loads(p.read_text(encoding='utf-8')) for p in (sandbox / 'task').glob('*.json')]
                current['tasks'] = [{'name': t.get('name'), 'bgm_id': t.get('bgm_id'),
                                     'error': t.get('error'), 'layout': t.get('layout'),
                                     'bindings': t.get('episode_bindings')} for t in records]
                current['source_unchanged'] = (before.st_size, before.st_mtime_ns) == (source.stat().st_size, source.stat().st_mtime_ns)
                stats = pstats.Stats(profile)
                current['top_cumulative'] = [
                    {'file': Path(key[0]).name, 'line': key[1], 'function': key[2],
                     'calls': value[1], 'self_seconds': round(value[2], 5), 'cumulative_seconds': round(value[3], 5)}
                    for key, value in sorted(stats.stats.items(), key=lambda pair: pair[1][3], reverse=True)[:25]
                ]
                report['cases'].append(current)
                print(json.dumps({**{k: current[k] for k in ('source', 'mode', 'seconds')},
                                  'tasks': [{k: v for k, v in t.items() if k != 'bindings'} for t in current['tasks']]},
                                 ensure_ascii=False), flush=True)
                current = None
        import logging
        logging.shutdown()  # Windows cannot remove the sandbox while BAR.log is open.
        destination = sandbox / 'report.json'
        destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        output = args.output.resolve()
        allowed_output = output
        output.write_text(destination.read_text(encoding='utf-8'), encoding='utf-8')
        allowed_output = None


if __name__ == '__main__':
    main()
