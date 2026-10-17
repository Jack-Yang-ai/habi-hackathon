#!/usr/bin/env python3
"""Build a relocatable Mac mini backend release. Never installs or starts a service."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verified-build', action='store_true', help='Use a build already verified in this session')
    args = parser.parse_args()
    if not args.verified_build:
        subprocess.run(['npm', 'run', 'verify'], cwd=ROOT, check=True)
    entries = [Path(name) for name in ('package.json', 'package-lock.json', '.env.example',
               'services/api/package.json', 'apps/studio/package.json', 'docs/device/MAC_MINI_BACKEND.md', 'docs/dining-api.md')]
    for directory in ('services/api/src', 'apps/studio/dist', 'tools/backend'):
        entries += [p.relative_to(ROOT) for p in (ROOT / directory).rglob('*')
                    if p.is_file() and '__pycache__' not in p.parts and p.suffix not in ('.pyc', '.pyo')]
    entries = sorted(set(entries))
    assert (ROOT / 'apps/studio/dist/index.html').is_file(), 'Build the frontend first'
    # Scan the exact allowlisted bytes; neither local data nor credentials are candidates.
    private_values = []
    if (ROOT / '.env').exists():
        for line in (ROOT / '.env').read_text().splitlines():
            name, sep, value = line.strip().partition('=')
            value = value.strip().strip('"\'')
            if sep and ('KEY' in name or 'TOKEN' in name) and len(value) >= 10:
                private_values.append(value.encode())
    files = []
    for entry in entries:
        source = ROOT / entry
        if source.is_symlink() or not source.is_file(): raise RuntimeError('Release input must be a regular file: ' + str(entry))
        if any(part in ('.data', '.tools', '.git', 'recordings', 'node_modules') for part in entry.parts):
            raise RuntimeError('Private/runtime data cannot enter release: ' + str(entry))
        content = source.read_bytes()
        if any(value in content for value in private_values):
            raise RuntimeError('Configured secret detected in release input: ' + str(entry))
        files.append((entry, content))
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    output = ROOT / 'output/deployment' / ('habi-mac-mini-' + stamp + '.tar.gz')
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {'createdAt': datetime.now(timezone.utc).isoformat(), 'target': 'Mac mini, Node.js 22.16+',
                'serviceInstalled': False, 'credentialsIncluded': False, 'userDataIncluded': False,
                'files': [{'path': str(entry), 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
                          for entry, content in files]}
    with tarfile.open(output, 'w:gz') as archive:
        for entry, content in files + [(Path('release-manifest.json'), (json.dumps(manifest, ensure_ascii=False, indent=2)+'\n').encode())]:
            info = tarfile.TarInfo(str(entry)); info.size = len(content); info.mode = 0o644
            archive.addfile(info, io.BytesIO(content))
    print(json.dumps({'release': str(output), 'bytes': output.stat().st_size,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'files': len(files),
                      'credentialsIncluded': False, 'userDataIncluded': False, 'serviceInstalled': False}))


if __name__ == '__main__': main()
