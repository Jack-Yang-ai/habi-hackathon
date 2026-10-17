#!/usr/bin/env python3
"""Prepare pinned KWS models/JNI Kotlin bindings; optionally copy 5 verified files to Habi."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import tarfile
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / 'contracts/voice-kws/kws-lock.json'
BUNDLE = ROOT / '.tools/local-inference-android'

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def fetch(path, spec):
    if path.is_file() and path.stat().st_size == spec['bytes'] and sha(path) == spec['sha256']: return
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name + '.pending')
    with urllib.request.urlopen(spec['url'], timeout=90) as src, pending.open('wb') as dst: shutil.copyfileobj(src, dst)
    if pending.stat().st_size != spec['bytes'] or sha(pending) != spec['sha256']: raise ValueError('Asset verification failed: ' + path.name)
    pending.replace(path)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deploy', action='store_true')
    parser.add_argument('--serial')
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text())
    archive = ROOT / '.tools/kws-prepare' / lock['archive']['url'].rsplit('/',1)[1]
    fetch(archive, lock['archive'])
    with tarfile.open(archive, 'r:bz2') as package:
        for name, spec in lock['files'].items():
            target = BUNDLE / 'models/kws' / name; target.parent.mkdir(parents=True, exist_ok=True)
            content = spec.get('content')
            data = content.encode() if content is not None else package.extractfile(spec['archive_path']).read()
            if len(data) != spec['bytes'] or hashlib.sha256(data).hexdigest() != spec['sha256']: raise ValueError('KWS model mismatch: ' + name)
            if not target.exists() or target.read_bytes() != data: target.write_bytes(data)
    for name, spec in lock['sources'].items(): fetch(BUNDLE / 'sherpa-source' / name, spec)
    receipt = {'prepared':True, 'modelBytes':sum(s['bytes'] for s in lock['files'].values()),'deployed':False,'microphoneStarted':False}
    if args.deploy:
        if not args.serial: parser.error('--deploy requires --serial')
        adb = ROOT / '.tools/platform-tools/adb'; prefix = [str(adb),'-s',args.serial]
        def run(*command): return subprocess.check_output([*prefix,*command], text=True, timeout=60)
        services = run('shell','dumpsys','activity','services','com.withecho.companion.dev')
        if 'com.withecho.companion.RecordingService' in services: parser.error('Stop recording before replacing live model files')
        temporary = '/data/local/tmp/habi-kws-' + uuid.uuid4().hex[:12]
        try:
            run('shell','mkdir','-p',temporary); run('push',str(BUNDLE/'models/kws'),temporary+'/')
            commands = ['mkdir -p files/local-models/kws']
            for name in lock['files']:
                src=shlex.quote(temporary+'/kws/'+name);dst=shlex.quote('files/local-models/kws/'+name)
                pending=shlex.quote('files/local-models/kws/'+name+'.pending')
                commands.extend([f'cp {src} {pending}',f'mv {pending} {dst}'])
            run('shell','run-as com.withecho.companion.dev sh -c '+shlex.quote(' && '.join(commands)))
            observed=run('shell','run-as com.withecho.companion.dev sha256sum '+' '.join(shlex.quote('files/local-models/kws/'+n) for n in lock['files']))
            hashes={l.split()[1]:l.split()[0] for l in observed.splitlines()}
            for name,spec in lock['files'].items():
                if hashes.get('files/local-models/kws/'+name)!=spec['sha256']:raise ValueError('Phone model mismatch: '+name)
            receipt['deployed']=True;receipt['appPrivateHashesVerified']=True
        finally: run('shell','rm','-rf',temporary) # only this script's random staging directory
    print(json.dumps(receipt))

if __name__=='__main__':main()
