"""audio_lab_worker.py — Audio Lab worker. All paths come from Sonora, never from browser input.

exports: report() | main(task)
used_by: none
rules:   none
agent:   codedna-cli (no-llm) | codedna-cli | 2026-10-11 | codedna-cli | initial CodeDNA annotation pass
message: 
"""
# @codedna
# description: Isolated Audio Lab CPU worker: import, analysis, full-length mastering renders and MP3 export.
# rules: Use server-owned paths, never modify the source, write results atomically and report JSON lines.
# agent: Claude - 2026-10-04 - Audio Lab integration for Sonora.
"""Audio Lab worker. All paths come from Sonora, never from browser input."""
import os
os.environ['CUDA_VISIBLE_DEVICES'] = ''
os.environ.setdefault('OMP_NUM_THREADS', '4')
import sys
import json
from pathlib import Path

import audio_lab_dsp as dsp


def report(**values):
    print(json.dumps(values, allow_nan=False), flush=True)


def main(task):
    """Rules: Paths come from the Sonora server; analysis and mastering never overwrite the source file."""
    action = task['action']
    if action == 'analyze':
        report(phase='Lettura audio')
        audio, rate, info = dsp.read_audio(task['source'])
        report(phase='Analysis: loudness, frequencies, stereo, tempo and key')
        report(done=True, analysis=dsp.analyze(audio, rate, info))
    elif action == 'import':
        report(phase='Decodifica del file')
        audio, rate, info = dsp.read_audio(task['source'])
        dsp.write_flac(task['outputFile'], audio, rate)
        report(phase='Analysis: loudness, frequencies, stereo, tempo and key')
        report(done=True, analysis=dsp.analyze(audio, rate, info))
    elif action == 'render':
        report(phase='Lettura della sorgente')
        audio, rate, info = dsp.read_audio(task['source'])
        settings = dsp.validate(task['settings'])
        result, loudness = dsp.master(audio, rate, settings, progress=lambda phase: report(phase=phase))
        report(phase='Scrittura del master FLAC e MP3')
        keep = settings['metadata'] == 'keep'
        dsp.write_flac(task['outputFile'], result, rate, tags_from=task['source'] if keep else None)
        dsp.export_mp3(task['outputFile'], str(Path(task['outputFile']).with_suffix('.mp3')), keep_metadata=keep)
        report(phase='Misura del master')
        analysis = dsp.analyze(result, rate, {**info, 'codec': 'flac', 'bitDepth': 24, 'sampleFormat': 's32',
                                              'tags': info.get('tags', {}) if keep else {}}, musical=False)
        report(done=True, analysis=analysis, loudness=loudness, mp3=True)
    elif action == 'mp3':
        report(phase='Esportazione MP3 320 kbps')
        dsp.export_mp3(task['source'], task['outputFile'])
        report(done=True)
    else:
        raise ValueError('Operazione Audio Lab non valida.')


if __name__ == '__main__':
    try:
        main(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig')))
    except Exception as error:
        report(error=str(error)[:1200])
        sys.exit(1)
