"""Benchmark matching against the previous nested loop using generated files only."""
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import time
from decimal import Decimal


def main():
    repo = Path(__file__).resolve().parents[1]
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(repo / 'engine'))
    with tempfile.TemporaryDirectory(prefix='bgm-subtitle-profile-') as temp:
        root = Path(temp)
        os.environ['BGM_RENAME_DATA'] = temp
        (root / 'config.json').write_text(json.dumps({'ai_enabled': False, 'log_level': 'ERROR'}))
        from src.rename import subtitle_import as sub
        folder = root / 'subtitles'; folder.mkdir()
        library = root / 'library'; library.mkdir()
        downloads = root / 'downloads'; downloads.mkdir()
        record = {'entries': {}}
        for number in range(1, 121):
            video = library / f'Show EP{number:03}.mkv'; video.write_bytes(b'video')
            original = downloads / f'Original [{number:03}].mkv'; original.write_bytes(b'video')
            record['entries'][str(original)] = {'target': str(video)}
            for language in ('chs', 'cht'):
                (folder / f'Show EP{number:03}.{language}.ass').write_bytes(b'subtitle')
        original_key = sub.episode_key
        parsed = 0

        def counted_key(name):
            nonlocal parsed
            parsed += 1
            return original_key(name)

        sub.episode_key = counted_key

        def baseline():
            videos = sub.library_videos(record)
            rows = []
            for source in sorted(folder.rglob('*')):
                if not source.is_file() or source.suffix.lower() not in sub.SUBTITLES:
                    continue
                key = sub.episode_key(source.name)
                candidates = []
                if key:
                    season, kind, number, part = key
                    for target, originals in videos.items():
                        for alias in [target, *originals]:
                            other = sub.episode_key(alias)
                            if other and other[1:] == (kind, number + Decimal('0'), part) and (
                                    season is None or other[0] is None or season == other[0]):
                                candidates.append(target)
                                break
                candidates = list(dict.fromkeys(candidates))
                rows.append((str(source), candidates[0] if len(candidates) == 1 else '', sub.detected_suffix(source)))
            return rows

        runs, expected = [], None
        for version in ('baseline', 'optimized', 'baseline', 'optimized'):
            parsed = 0
            start = time.perf_counter()
            if version == 'baseline':
                rows = baseline()
            else:
                _, result = sub.preview_import(record, folder)
                rows = [(row['source'], row['video'], row['suffix']) for row in result]
            elapsed = time.perf_counter() - start
            expected = expected or rows
            assert rows == expected
            runs.append({'version': version, 'milliseconds': round(elapsed * 1000, 2), 'episode_key_calls': parsed})
        logging.shutdown()
    report = {'videos': 120, 'subtitles': 240, 'matchingResultsEqual': True, 'generatedFixturesOnly': True, 'runs': runs}
    output = repo / '.desktop/subtitle-import-profile.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
