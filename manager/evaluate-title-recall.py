"""Run real search/confirmation against the prior 22 title cases, isolated data."""
import json
import argparse
import logging
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--languages', action='store_true', help='Test Chinese, Japanese and English title forms separately.')
    args = parser.parse_args()
    if args.languages:
        corpus = json.loads((ROOT / '.desktop/vector-eval/corpus.json').read_text(encoding='utf-8'))
        wanted = {283, 889, 890, 1424, 3774, 9912, 26825, 36004, 47685, 115908, 118067, 152091}
        cases = [{'query': subject[field], 'expected': subject['id'], 'language': language}
                 for language, field in [('zh', 'name_cn'), ('ja', 'name')]
                 for subject in corpus if subject['id'] in wanted and subject.get(field)]
        cases.extend({'query': query, 'expected': sid, 'language': 'en'} for query, sid in [
            ('Sound! Euphonium', 115908), ('Sound! Euphonium 2', 152091),
            ('Rokka: Braves of the Six Flowers', 118067),
            ('Nichijou - My Ordinary Life', 9912)])
    else:
        prior = json.loads((ROOT / '.desktop/vector-eval/report.json').read_text(encoding='utf-8'))
        cases = prior['scenarios']['with_aliases']['results']
    with tempfile.TemporaryDirectory(prefix='bgm-title-recall-') as directory:
        os.environ['BGM_RENAME_DATA'] = directory
        Path(directory, 'config.json').write_text(json.dumps({'ai_enabled': False, 'log_level': 'ERROR'}), encoding='utf-8')
        sys.path.insert(0, str(ROOT / 'engine'))
        from src.rename.get_info import Search
        from src.rename.metadata_http import recognition_budget
        rows = []
        for case in cases:
            search = Search()
            search.defer_episodes = True
            started = time.perf_counter()
            with recognition_budget(seconds=20, attempts=2):
                _, info = search.get_bangumi_info(case['query'], 0)
            candidates = search.last_bangumi_candidates
            rank = next((i + 1 for i, c in enumerate(candidates) if c['id'] == case['expected']), None)
            row = {'query': case['query'], 'expected': case['expected'], 'selected': info['id'] if info else None,
                   'language': case.get('language'),
                   'expected_rank': rank, 'seconds': round(time.perf_counter() - started, 3),
                   'error': search.last_error, 'warnings': search.recall_warnings, 'candidates': candidates}
            rows.append(row)
            print(json.dumps({k: v for k, v in row.items() if k != 'candidates'}, ensure_ascii=True), flush=True)
        report = {'cases': len(rows), 'correct_auto': sum(r['selected'] == r['expected'] for r in rows),
                  'wrong_auto': sum(r['selected'] is not None and r['selected'] != r['expected'] for r in rows),
                  'manual': sum(r['selected'] is None for r in rows),
                  'recalled': sum(r['expected_rank'] is not None for r in rows), 'results': rows}
        target = ROOT / ('.desktop/title-recall-languages.json' if args.languages else '.desktop/title-recall-report.json')
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({k: v for k, v in report.items() if k != 'results'}), flush=True)
        print(target, flush=True)
        logging.shutdown()


if __name__ == '__main__':
    main()
