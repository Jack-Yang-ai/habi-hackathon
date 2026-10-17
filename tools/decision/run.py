"""Run the verified public AgentJev checkpoint on local CPU, without cloud calls."""
from pathlib import Path
import hashlib
import os
import subprocess

ROOT = Path(__file__).resolve().parents[2]
WEIGHTS_SHA256 = '8166e46dc6019ae13f0d8fc97d603cdbcc2d20eb1882c7350c8deb9fc6bae215'


def main():
    source = ROOT / '.tools/agent-jev'
    model = ROOT / '.tools/agent-jev-model'
    python = ROOT / '.tools/decision-venv/bin/python'
    checkpoint = model / 'model.safetensors'
    if not python.is_file() or not checkpoint.is_file():
        raise SystemExit('Run python3 tools/decision/install.py first.')
    digest = hashlib.sha256()
    with checkpoint.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != WEIGHTS_SHA256:
        raise SystemExit('AgentJev checkpoint SHA256 differs from the pinned public release.')
    env = {**os.environ, 'PYTHONPATH': str(source), 'HF_HUB_OFFLINE': '1',
           'TRANSFORMERS_OFFLINE': '1', 'OMP_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2'}
    args = [str(python), '-m', 'jev_service.server', '--checkpoint', str(checkpoint),
            '--model-path', str(model), '--temperatures', str(model / 'temperatures.json'),
            '--device', 'cpu', '--port', '8149']
    os.chdir(ROOT)
    os.execve(python, args, env)


if __name__ == '__main__':
    main()
