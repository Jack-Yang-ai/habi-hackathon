#!/usr/bin/env python3
"""Create a private configuration on the target Mac. Never installs a service."""
import argparse
import getpass
import json
import os
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lan', action='store_true', help='Explicitly allow authenticated LAN access')
    parser.add_argument('--port', type=int, default=8787)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535: parser.error('Port must be between 1024 and 65535')
    target = ROOT / '.env'
    if target.exists(): parser.error('A private .env already exists; preserve it and edit it locally if needed')
    key = os.environ.get('STEPFUN_API_KEY') or getpass.getpass('StepFun API Key (hidden): ').strip()
    if not key or '\n' in key or '\r' in key: parser.error('A nonempty single-line Step key is required')
    values = {'HOST': '0.0.0.0' if args.lan else '127.0.0.1', 'PORT': str(args.port), 'DATA_DIR': '.data',
              'APP_ACCESS_TOKEN': secrets.token_urlsafe(32), 'DEVICE_ACCESS_TOKEN': secrets.token_urlsafe(32),
              'STEPFUN_API_KEY': key, 'FOOD_MODEL_PROVIDER': 'stepfun',
              'FOOD_MODEL_NAME': 'step-1o-turbo-vision', 'CHAT_MODEL_NAME': 'step-1o-turbo-vision'}
    with os.fdopen(os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as output:
        output.write('\n'.join(name + '=' + json.dumps(value) for name, value in values.items()) + '\n')
    print(json.dumps({'configuration': str(target), 'lanEnabled': args.lan, 'port': args.port,
                      'mode': '0600', 'credentialsPrinted': False, 'serviceInstalled': False}))


if __name__ == '__main__': main()
