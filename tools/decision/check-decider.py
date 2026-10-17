"""Direct Decider Q4 measurements on authored probes; no rule override or App writes."""
from pathlib import Path
import argparse
import hashlib
import json
import resource
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.tools/decider'))
from decider.infer import Decider


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backend', choices=['cpu', 'metal'], default='cpu')
    args = parser.parse_args()
    model = ROOT / '.tools/decider-08b-gguf/decider-0.8b-Q4_K_M.gguf'
    expected_sha = '5cb5d042a236add5cde5459f8e8b8f8f80161ad4a1779a49377b70a64eb7b11a'
    if hashlib.sha256(model.read_bytes()).hexdigest() != expected_sha:
        raise SystemExit('Decider checkpoint checksum mismatch.')
    fixtures = json.loads((ROOT / 'tools/decision/fixtures.json').read_text())
    start = time.perf_counter()
    engine = Decider(str(model), gguf_options={'n_ctx': 2048, 'n_threads': 2, 'n_gpu_layers': -1 if args.backend == 'metal' else 0})
    loaded = time.perf_counter() - start
    variants = {
        'original_chinese_json': (fixtures['chineseQuestion'], fixtures['chineseOptions'], True),
        'short_english_text': ('What is the speaker\'s meal intent right now?', {
            'start_soon': 'Preparing to eat food right now or immediately.',
            'invited': 'An invitation to eat, not yet accepted.',
            'eating_now': 'Currently eating food.',
            'finished': 'Already finished eating.',
            'declined': 'Refusing or cancelling food.',
            'unrelated': 'Unrelated, other people, media, future or hypothetical meals.',
            'uncertain': 'Insufficient evidence of current eating intent.',
        }, False),
    }
    reports = []
    for name, (question, options, as_json) in variants.items():
        keys = list(options)
        for fixture in fixtures['fixtures']:
            state = fixture['state']
            context = json.dumps(state, ensure_ascii=False) if as_json else (
                'Previous: ' + ' | '.join(state['recent_utterances']) + '\n'
                + 'Speaker: ' + state['speaker'] + '\nSource: ' + state['source']
                + '\nMessage: ' + state['transcript'])
            start = time.perf_counter()
            result = engine.decide(context, [{'question': question, 'options': list(options.values())}])[0]
            elapsed_ms = (time.perf_counter() - start) * 1000
            distribution = dict(zip(keys, result['probs_list']))
            prediction = max(distribution, key=distribution.get)
            reports.append({'variant': name, 'id': fixture['id'], 'state': state, 'expected': fixture['expected'],
                            'prediction': prediction, 'distribution': distribution,
                            'correct': prediction == fixture['expected'], 'elapsedMs': round(elapsed_ms, 2)})
            print(json.dumps({'variant': name, 'id': fixture['id'], 'prediction': prediction,
                              'expected': fixture['expected'], 'elapsedMs': round(elapsed_ms, 1)}, ensure_ascii=False), flush=True)
    summary = {name: {'correct': sum(row['correct'] for row in reports if row['variant'] == name),
                      'cases': len(fixtures['fixtures']),
                      'warmMedianMs': round(statistics.median([row['elapsedMs'] for row in reports if row['variant'] == name][1:]), 2)}
               for name in variants}
    report = {'fixtureOnly': True, 'independentAccuracyBenchmark': False, 'domainCalibrated': False,
              'model': 'Mapika/decider-0.8b, third-party Q4_K_M conversion', 'modelBytes': model.stat().st_size,
              'sha256': expected_sha, 'runtime': f'Mac {args.backend}, CPU 2 threads, llama-cpp-python 0.3.36',
              'modelLoadSeconds': round(loaded, 3), 'peakRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              'summary': summary, 'records': reports, 'productionBackendModified': False, 'phoneInference': False}
    target = ROOT / f'output/validation/decider-context{"-metal" if args.backend == "metal" else ""}.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
