"""Laya multilingual MLX development probes. Mac only; never writes to App data."""
from pathlib import Path
import hashlib
import json
import statistics
import time
import laya_mlx
import mlx.core as mx

ROOT = Path(__file__).resolve().parents[2]
model = ROOT / '.tools/laya-multilingual-mlx'
assert hashlib.sha256((model / 'model.safetensors').read_bytes()).hexdigest() == '7fc5834af4d8fdfb268d272a9d1a66e5819a0daac98241651c4c888cc43adff1'
fixtures = json.loads((ROOT / 'tools/decision/fixtures.json').read_text())
start = time.perf_counter()
agent = laya_mlx.load(str(model), dtype='float16', device='gpu')
load_seconds = time.perf_counter() - start
records = []
for fixture in fixtures['fixtures']:
    start = time.perf_counter()
    result = agent.predict(fixture['state'], {'meal_stage': {'type': 'choice',
        'instructions': fixtures['chineseQuestion'], 'criteria': fixtures['chineseOptions']}})
    answer = result['answers']['meal_stage']
    records.append({'id': fixture['id'], 'state': fixture['state'], 'expected': fixture['expected'],
        'prediction': answer['choice'], 'probabilities': answer['probabilities'],
        'elapsedMs': round((time.perf_counter() - start) * 1000, 2), 'usage': result['usage']})
report = {'fixtureOnly': True, 'independentAccuracyBenchmark': False, 'domainCalibrated': False,
    'model': 'aac6fef/laya-multilingual-mlx', 'revision': 'f2b4faf51023039425946074e2cf1361d2db11d5',
    'runtime': 'laya-mlx 0.4.0 / MLX 0.32.4 / Mac GPU FP16', 'modelBytes': 643835426,
    'modelLoadSeconds': round(load_seconds, 3), 'peakMlxBytes': mx.get_peak_memory(),
    'correct': sum(row['prediction'] == row['expected'] for row in records), 'cases': len(records),
    'warmMedianMs': statistics.median(row['elapsedMs'] for row in records[1:]), 'records': records,
    'productionBackendModified': False, 'androidDeployment': False}
target = ROOT / 'output/validation/laya-context.json'
target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'records'}, ensure_ascii=False))
