#!/usr/bin/env python3
"""Compile and test only synthetic PCM file boundaries, without microphone access."""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[2]

def main():
    jdk=next((ROOT/'.tools/jdk').glob('*/Contents/Home'))
    classes=ROOT/'.tools/wave-writer-test/classes'
    classes.mkdir(parents=True,exist_ok=True)
    files=[ROOT/'android/app/src/main/java/com/withecho/companion/WaveChunkWriter.java',ROOT/'android/tests/WaveChunkWriterTest.java']
    subprocess.run([str(jdk/'bin/javac'),'--release','8','-d',str(classes),*map(str,files)],check=True)
    subprocess.run([str(jdk/'bin/java'),'-cp',str(classes),'com.withecho.companion.WaveChunkWriterTest'],check=True)

if __name__=='__main__':main()
