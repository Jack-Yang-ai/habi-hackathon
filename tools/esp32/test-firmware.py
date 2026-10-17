#!/usr/bin/env python3
"""Build/run host tests against the exact firmware lease and ArduinoJson ACK parser."""
from pathlib import Path
import os
import subprocess

ROOT=Path(__file__).resolve().parents[2]
PROJECT=ROOT/'firmware/xiao-sense'
OUTPUT=ROOT/'.tools/esp32-host-tests'

def main():
    OUTPUT.mkdir(parents=True,exist_ok=True)
    dependency=PROJECT/'.pio/libdeps/xiao_esp32s3_sense/ArduinoJson/src'
    if not (dependency/'ArduinoJson.h').exists():
        raise SystemExit('Run PlatformIO firmware build first to install pinned ArduinoJson 6.21.5.')
    for name in ('window_policy','capture_ack'):
        binary=OUTPUT/name
        subprocess.run([os.environ.get('CXX','clang++'),'-std=c++11','-Wall','-Wextra','-Werror',
                        '-I'+str(PROJECT/'include'),'-I'+str(dependency),str(PROJECT/'test'/f'{name}.cpp'),'-o',str(binary)],check=True)
        subprocess.run([str(binary)],check=True)
        print(name+': PASS')

if __name__=='__main__':main()
