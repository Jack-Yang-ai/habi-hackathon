#!/usr/bin/env python3
"""Run the synthetic WAV writer fixture on ART. No microphone, root or user data."""
from pathlib import Path
import subprocess
import uuid

ROOT=Path(__file__).resolve().parents[2]

def main():
    subprocess.run(['python3',str(ROOT/'tools/device/test-wave-writer.py')],check=True)
    jdk=next((ROOT/'.tools/jdk').glob('*/Contents/Home'))
    work=ROOT/'.tools/wave-writer-test';sdk=ROOT/'.tools/android-sdk'
    jar=work/'fixture.jar';classes=list((work/'classes').rglob('*.class'))
    subprocess.run([str(jdk/'bin/java'),'-cp',str(sdk/'build-tools/35.0.0/lib/d8.jar'),'com.android.tools.r8.D8','--min-api','26','--lib',str(sdk/'platforms/android-35/android.jar'),'--output',str(jar),*map(str,classes)],check=True)
    adb=str(ROOT/'.tools/platform-tools/adb')
    remote='/data/local/tmp/echo-wave-fixture-'+uuid.uuid4().hex[:12]
    subprocess.run([adb,'shell','mkdir '+remote],check=True,timeout=8)
    try:
        subprocess.run([adb,'shell','mkdir '+remote+'/data'],check=True,timeout=8)
        subprocess.run([adb,'push',str(jar),remote+'/fixture.jar'],check=True,timeout=15)
        result=subprocess.run([adb,'shell','CLASSPATH='+remote+'/fixture.jar app_process /system/bin com.withecho.companion.WaveChunkWriterTest '+remote+'/data'],capture_output=True,text=True,timeout=15)
        (work/'android-receipt.txt').write_text(result.stdout+result.stderr)
        print(result.stdout,result.stderr)
        result.check_returncode()
    finally:
        # Only the random directory created immediately above; never app storage.
        subprocess.run([adb,'shell','rm -rf '+remote],timeout=8,check=False)

if __name__=='__main__':main()
