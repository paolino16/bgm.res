"""Exploratory title retrieval benchmark, isolated from live organizer data.

Run in a separate Python environment with numpy, onnxruntime, tokenizers,
huggingface_hub, requests and pykakasi. Downloads the official E5 ONNX model and caches
public Bangumi metadata under .desktop/vector-eval. No production writes.
"""
import hashlib
import argparse
import shutil
import json
from pathlib import Path
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import onnxruntime as ort
import requests
import pykakasi
from huggingface_hub import hf_hub_download, model_info
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'engine'))
from src.utils.title_matching import title_score

CACHE = ROOT / '.desktop/vector-eval'
CACHE.mkdir(parents=True, exist_ok=True)
MODEL = 'intfloat/multilingual-e5-small'
CASES = [
    ('Minami-ke', 283), ('Minamike', 283), ('Minami ke', 283),
    ('Minami-ke Okawari', 890), ('Minami-ke Okaeri', 889),
    ('Minami-ke Tadaima', 47685), ('Minami-ke Betsubara', 3016),
    ('Minami-ke Omatase', 47684),
    ('南家三姐妹', 283), ('南家三姐妹 欢迎回来', 889),
    ('Natsuiro Kiseki', 26825), ('Natsuiro Kisekki', 26825),
    ('Rokka no Yuusha', 118067), ('Rokka no Yusha', 118067),
    ('Hibike! Euphonium', 115908), ('Hibike! Euphonium 2nd Season', 152091),
    ('K-On!', 1424), ('K-On! Second Season', 3774),
    ('Nichijou', 9912), ('Nichijou OAD', 36004),
    ('みなみけ おかえり', 889), ('轻音少女', 1424),
]
SEEDS = ['南家三姐妹', '夏色奇迹', '六花的勇者', '吹响吧 上低音号',
         '轻音少女', '日常', 'Minami-ke', 'Natsuiro Kiseki', 'Rokka no Yuusha']


def api(endpoint, payload=None):
    key = hashlib.sha256(json.dumps([endpoint, payload], ensure_ascii=False).encode()).hexdigest()
    target = CACHE / (key + '.json')
    if target.exists():
        return json.loads(target.read_text(encoding='utf-8'))
    response = requests.request('POST' if payload else 'GET', 'https://api.bgm.tv' + endpoint,
                                json=payload, headers={'User-Agent': 'bgm-res-title-eval/1.0'}, timeout=30)
    response.raise_for_status()
    value = response.json()
    target.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    return value


def titles(subject, aliases=True):
    result = [subject.get('name'), subject.get('name_cn')]
    if aliases:
        for item in subject.get('infobox', []):
            if item.get('key') == '别名':
                values = item.get('value') or []
                if not isinstance(values, list):
                    values = [values]
                result.extend(v.get('v') if isinstance(v, dict) else v for v in values)
    return list(dict.fromkeys(t for t in result if isinstance(t, str) and t.strip()))


def main():
    global MODEL
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['e5', 'bge-m3'], default='e5')
    parser.add_argument('--sparse', action='store_true', help='Evaluate the official BGE-M3 learned sparse head too (requires torch).')
    args = parser.parse_args()
    is_bge = args.model == 'bge-m3'
    if args.sparse and not is_bge:
        parser.error('--sparse requires --model bge-m3')
    MODEL = 'BAAI/bge-m3' if is_bge else 'intfloat/multilingual-e5-small'
    prefix = '' if is_bge else 'query: '
    started = time.perf_counter()
    ids = {expected for _, expected in CASES} | {314426, 316543, 23613, 189918}
    for query in SEEDS:
        result = api('/v0/search/subjects?limit=10', {'keyword': query, 'sort': 'match', 'filter': {'type': [2]}})
        ids.update(item['id'] for item in result.get('data', []))
    with ThreadPoolExecutor(max_workers=3) as pool:
        subjects = list(pool.map(lambda sid: api(f'/v0/subjects/{sid}'), sorted(ids)))
    (CACHE / 'corpus.json').write_text(json.dumps(subjects, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Corpus: {len(subjects)} public Bangumi subjects', flush=True)

    revision_file = CACHE / ('bge-m3-revision.txt' if is_bge else 'model-revision.txt')
    if not revision_file.exists():
        revision_file.write_text(model_info(MODEL).sha, encoding='utf-8')
    revision = revision_file.read_text().strip()
    print(f'Downloading/loading {MODEL}@{revision}', flush=True)
    model_path = hf_hub_download(MODEL, 'onnx/model.onnx', revision=revision)
    if is_bge:
        # ORT validates real paths of external weights; HF cache symlinks point
        # into separate blob directories. Materialize siblings for safe loading.
        model_dir = CACHE / ('bge-m3-' + revision)
        model_dir.mkdir(exist_ok=True)
        for filename in ('model.onnx', 'model.onnx_data', 'Constant_7_attr__value'):
            source = Path(hf_hub_download(MODEL, 'onnx/' + filename, revision=revision))
            destination = model_dir / filename
            if not destination.exists() or destination.stat().st_size != source.stat().st_size:
                shutil.copyfile(source, destination)
        model_path = str(model_dir / 'model.onnx')
    tokenizer_path = hf_hub_download(MODEL, 'tokenizer.json' if is_bge else 'onnx/tokenizer.json', revision=revision)
    tokenizer = Tokenizer.from_file(tokenizer_path)
    tokenizer.enable_padding(pad_id=1, pad_token='<pad>')
    tokenizer.enable_truncation(max_length=128)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    load_start = time.perf_counter()
    session = ort.InferenceSession(model_path, sess_options=options, providers=['CPUExecutionProvider'])
    load_seconds = time.perf_counter() - load_start
    input_names = {item.name for item in session.get_inputs()}
    sparse_weight = sparse_bias = None
    if args.sparse:
        import torch
        head_path = hf_hub_download(MODEL, 'sparse_linear.pt', revision=revision)
        head = torch.load(head_path, map_location='cpu', weights_only=True)
        head = {name: value.float() for name, value in head.items()}
        sparse_weight = head['weight'].numpy()
        sparse_bias = head['bias'].numpy()
        assert sparse_weight.shape == (1, 1024) and sparse_bias.shape == (1,)
    ignored_ids = {tokenizer.token_to_id(token) for token in ('<s>', '</s>', '<pad>', '<unk>')}
    sparse_head_verified = False

    def encode(texts):
        nonlocal sparse_head_verified
        batches = []
        sparse_rows = []
        for offset in range(0, len(texts), 16):
            tokens = tokenizer.encode_batch(texts[offset:offset + 16])
            mask = np.array([t.attention_mask for t in tokens], dtype=np.int64)
            inputs = {'input_ids': np.array([t.ids for t in tokens], dtype=np.int64),
                      'attention_mask': mask,
                      'token_type_ids': np.array([t.type_ids for t in tokens], dtype=np.int64)}
            output = session.run(None, {k: v for k, v in inputs.items() if k in input_names})[0]
            if args.sparse:
                # Official M3: ReLU(linear(last_hidden_state)), maximum weight
                # per repeated token ID, excluding CLS/EOS/PAD/UNK; no L2 norm.
                weights = np.maximum(output @ sparse_weight.T + sparse_bias, 0).squeeze(-1)
                if not sparse_head_verified:
                    reference = torch.relu(torch.nn.functional.linear(
                        torch.from_numpy(output), head['weight'], head['bias'])).numpy().squeeze(-1)
                    np.testing.assert_allclose(weights, reference, rtol=1e-4, atol=1e-6)
                    assert np.isfinite(weights).all()
                    sparse_head_verified = True
                for token_row, weight_row in zip(tokens, weights):
                    row = {}
                    for token_id, weight, active in zip(token_row.ids, weight_row, token_row.attention_mask):
                        if active and token_id not in ignored_ids and weight > 0:
                            row[token_id] = max(row.get(token_id, 0), float(weight))
                    sparse_rows.append(row)
            pooled = output[:, 0] if is_bge else (output * mask[..., None]).sum(axis=1) / mask.sum(axis=1)[:, None]
            batches.append(pooled / np.linalg.norm(pooled, axis=1, keepdims=True))
        return np.concatenate(batches), sparse_rows

    # Symmetric title similarity: official E5 card recommends query: on both sides.
    encode_start = time.perf_counter()
    query_vectors, query_sparse = encode([prefix + query for query, _ in CASES])
    query_seconds = time.perf_counter() - encode_start
    report = {'model': MODEL, 'revision': revision, 'provider': 'CPUExecutionProvider',
              'prefix': prefix, 'pooling': 'CLS' if is_bge else 'mean',
              'subjects': len(subjects), 'cases': len(CASES), 'model_load_seconds': load_seconds,
              'query_batch_seconds': query_seconds, 'versions': {'onnxruntime': ort.__version__, 'numpy': np.__version__},
              'warning': 'Small hand-picked exploratory corpus, targets deliberately included. '
                         'Measures ranking within a local index, not Bangumi API recall; '
                         'no held-out evaluation, absent-target cases or calibrated auto-selection threshold.',
              'scenarios': {}}
    if args.sparse:
        report['sparse'] = {'head': 'official sparse_linear.pt at same model revision',
                            'numpy_head_matches_torch_on_real_query_batch': sparse_head_verified,
                            'torch_version': torch.__version__,
                            'fusion': '0.5*dense_cosine + 0.5*sparse_dot, before max over aliases; fixed, not tuned',
                            'implementation': 'ReLU linear; max per token ID; remove CLS/EOS/PAD/UNK; unnormalized dot product'}
        report['sparse']['query_tokens'] = [
            {'query': query, 'tokens': {tokenizer.id_to_token(token): round(weight, 6)
                                       for token, weight in sparse.items()}}
            for (query, _), sparse in zip(CASES, query_sparse)]
    transliterator = pykakasi.kakasi()
    for label, aliases, transliterate in [('with_aliases', True, False),
                                         ('names_only', False, False),
                                         ('with_generated_readings', True, True)]:
        names = [titles(subject, aliases) for subject in subjects]
        if transliterate:
            for variants, subject in zip(names, subjects):
                reading = ' '.join(part['hepburn'] for part in transliterator.convert(subject['name']))
                if reading and reading not in variants:
                    variants.append(reading)
        flat = [(index, name) for index, variants in enumerate(names) for name in variants]
        encoding_started = time.perf_counter()
        vectors, corpus_sparse = encode([prefix + name for _, name in flat])
        encoding_seconds = time.perf_counter() - encoding_started
        matrix = query_vectors @ vectors.T
        methods = ['rules', 'vector', 'hybrid']
        if args.sparse:
            sparse_matrix = np.array([[sum(weight * passage.get(token, 0) for token, weight in query.items())
                                       for passage in corpus_sparse] for query in query_sparse])
            fused_matrix = .5 * matrix + .5 * sparse_matrix
            methods += ['sparse', 'dense_sparse', 'rules_dense_sparse']
        metrics = {method: {'top1': 0, 'top5': 0, 'mrr': 0} for method in methods}
        rows = []
        for qi, (query, expected) in enumerate(CASES):
            similarities = [float(max(matrix[qi, j] for j, (owner, _) in enumerate(flat) if owner == index))
                            for index in range(len(subjects))]
            scores = [title_score(variants, query, date=subject.get('date', ''))
                      for variants, subject in zip(names, subjects)]
            # Experimental hybrid: lexical match/intent first; vector breaks ties
            # or supplies candidates when all lexical grades are below 2.
            orders = {
                'rules': sorted(range(len(subjects)), key=lambda i: scores[i], reverse=True),
                'vector': sorted(range(len(subjects)), key=lambda i: similarities[i], reverse=True),
                'hybrid': sorted(range(len(subjects)), key=lambda i: (scores[i][:3] if scores[i][0] >= 2 else (0, 0, 0), similarities[i]), reverse=True),
            }
            if args.sparse:
                sparse_scores = [float(max(sparse_matrix[qi, j] for j, (owner, _) in enumerate(flat) if owner == i))
                                 for i in range(len(subjects))]
                fused_scores = [float(max(fused_matrix[qi, j] for j, (owner, _) in enumerate(flat) if owner == i))
                                for i in range(len(subjects))]
                orders.update({
                    'sparse': sorted((i for i in range(len(subjects)) if sparse_scores[i] > 0), key=lambda i: sparse_scores[i], reverse=True),
                    'dense_sparse': sorted(range(len(subjects)), key=lambda i: fused_scores[i], reverse=True),
                    'rules_dense_sparse': sorted(range(len(subjects)), key=lambda i: (scores[i][:3] if scores[i][0] >= 2 else (0, 0, 0), fused_scores[i]), reverse=True),
                })
            row = {'query': query, 'expected': expected, 'methods': {}}
            for method, order in orders.items():
                # Rules have no recall for unrelated or fuzzy-only titles.
                if method == 'rules':
                    order = [i for i in order if scores[i][0] >= 2]
                rank = next((r + 1 for r, i in enumerate(order) if subjects[i]['id'] == expected), None)
                metrics[method]['top1'] += int(rank == 1)
                metrics[method]['top5'] += int(rank is not None and rank <= 5)
                metrics[method]['mrr'] += 1 / rank if rank else 0
                row['methods'][method] = {'rank': rank, 'top5': [
                    {'id': subjects[i]['id'], 'title': subjects[i].get('name_cn') or subjects[i]['name'],
                     'cosine': round(similarities[i], 5), 'lexical_grade': scores[i][0]}
                    for i in order[:5]]}
                if args.sparse:
                    for item, index in zip(row['methods'][method]['top5'], order[:5]):
                        item.update(sparse_dot=round(sparse_scores[index], 5), fused_score=round(fused_scores[index], 5))
            rows.append(row)
        for values in metrics.values():
            values['mrr'] = round(values['mrr'] / len(CASES), 4)
        report['scenarios'][label] = {'titles': len(flat), 'index_encode_seconds': encoding_seconds,
                                     'indexed_titles': {str(s['id']): variants for s, variants in zip(subjects, names)},
                                     'metrics': metrics, 'results': rows}
        print(label, json.dumps(metrics), flush=True)
    report['total_seconds'] = time.perf_counter() - started
    target = CACHE / ('report-bge-m3-sparse.json' if args.sparse else 'report-bge-m3.json' if is_bge else 'report.json')
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Report: {target}', flush=True)


if __name__ == '__main__':
    main()
