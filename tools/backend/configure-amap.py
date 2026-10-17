#!/usr/bin/env python3
"""Save only the server-side Amap Web Service key; never print it or start a service."""
import getpass
import json
import os
from pathlib import Path
import re
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    target = ROOT / '.env'
    if target.is_symlink():
        raise SystemExit('Refusing to replace a symlinked .env')
    key = os.environ.get('AMAP_WEB_SERVICE_KEY') or getpass.getpass('Amap Web Service API Key (hidden): ').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,256}', key):
        raise SystemExit('Expected a nonempty Amap Web Service key with no whitespace')
    content = target.read_text() if target.exists() else ''
    lines = [line for line in content.splitlines() if not re.match(r'^\s*(?:export\s+)?AMAP_WEB_SERVICE_KEY\s*=', line)]
    lines.append('AMAP_WEB_SERVICE_KEY=' + json.dumps(key))
    descriptor, temporary = tempfile.mkstemp(prefix='.env-amap-', dir=ROOT)
    try:
        with os.fdopen(descriptor, 'w') as output:
            output.write('\n'.join(lines) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps({'configured': 'AMAP_WEB_SERVICE_KEY', 'credentialsPrinted': False,
                      'otherSettingsPreserved': True, 'serviceStarted': False, 'restartRequired': True}))


if __name__ == '__main__':
    main()
