"""Fetch pinned AgentJev code and public v1 weights into ignored .tools/."""
from pathlib import Path
import os
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / '.tools/agent-jev'
VENV = ROOT / '.tools/decision-venv'
COMMIT = '05c0d4ff9bb7aa84448b604f950cde5f8400d471'


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, cwd=ROOT, **kwargs)


def main():
    if not shutil.which('uv'):
        raise SystemExit('Install uv first. This setup uses an isolated Python 3.12 environment.')
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    if not SOURCE.exists():
        run(['git', 'clone', '--no-checkout', '--filter=blob:none',
             'https://github.com/malevrigns/agent-jev.git', SOURCE])
        run(['git', '-C', SOURCE, 'checkout', '--detach', COMMIT])
    actual = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != COMMIT:
        raise SystemExit('Existing AgentJev checkout differs from the pinned revision; preserve it and choose another directory.')
    if not (VENV / 'bin/python').exists():
        run(['uv', 'venv', '--python', '3.12', VENV])
    python = VENV / 'bin/python'
    run(['uv', 'pip', 'install', '--python', python, '-r', ROOT / 'tools/decision/requirements.txt'])
    env = {**os.environ, 'HF_HOME': str(ROOT / '.tools/hf-jev'),
           'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1', 'HF_HUB_DOWNLOAD_TIMEOUT': '60'}
    # The pinned upstream downloader verifies every public release file SHA256.
    run([python, SOURCE / 'fetch_v1_weights.py', '--model-dir', ROOT / '.tools/agent-jev-model'], env=env)


if __name__ == '__main__':
    main()
