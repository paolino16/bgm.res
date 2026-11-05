"""Run bundled engine tests against isolated configuration and output paths."""
import argparse
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import unittest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pattern', default='test_*.py')
    args = parser.parse_args()
    engine = Path(__file__).resolve().parents[1] / 'engine'
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(engine))
    with tempfile.TemporaryDirectory(prefix='bgm-engine-tests-') as folder:
        os.environ['BGM_RENAME_DATA'] = folder
        config = {key: str(Path(folder) / key) for key in ('bangumi_path', 'movie_path', 'anime_path', 'anime_movie_path')}
        config.update(ai_enabled=False, log_level='ERROR')
        Path(folder, 'config.json').write_text(json.dumps(config), encoding='utf-8')
        try:
            suite = unittest.defaultTestLoader.discover(str(engine / 'tests'), pattern=args.pattern, top_level_dir=str(engine))
            result = unittest.TextTestRunner(verbosity=1).run(suite)
        finally:
            logging.shutdown()
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
