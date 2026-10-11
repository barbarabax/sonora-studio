"""stems_worker.py — Local six-stem separation. All paths come from Sonora, never from browser input.

exports: STEMS | report() | fit_grid(stem_dir) | reverb(task) | main(task)
used_by: none
rules:   none
agent:   codedna-cli (no-llm) | codedna-cli | 2026-10-11 | codedna-cli | initial CodeDNA annotation pass
message: 
"""
# @codedna
# description: CPU separation of a song into six stems (vocals, drums, bass, guitar, piano, other).
# exports: main
# used_by: stems.mjs
# rules: CPU only; stems are written as FLAC under task['outputDir'] with fixed names; never touch the source file.
# agent: claude-sonnet-5-5 - 2026-10-09 - htdemucs_6s through audio-separator with its default FLAC writer (use_soundfile=True silences stereo floats in 0.36.1).
"""Local six-stem separation. All paths come from Sonora, never from browser input."""
import json
import logging
import re
import sys
from pathlib import Path

STEMS = ('vocals', 'drums', 'bass', 'guitar', 'piano', 'other')


def report(**values):
    print(json.dumps(values), flush=True)


def fit_grid(stem_dir):
    """Constant-tempo beat grid fitted on drums + bass: {'bpm', 'period', 't0'} (t0 = time of a beat, in seconds)."""
    import numpy as np
    import librosa
    mix = None
    for name in ('drums', 'bass'):
        y, _ = librosa.load(str(Path(stem_dir) / (name + '.flac')), sr=22050, mono=True)
        mix = y if mix is None else mix[:len(y)] + y[:len(mix)]
    _, beats = librosa.beat.beat_track(y=mix, sr=22050, units='time', tightness=100)
    beats = np.asarray(beats, dtype=float)
    if len(beats) < 8:
        raise ValueError('Non riesco a trovare il tempo del brano.')
    rough = float(np.median(np.diff(beats)))
    index = np.round((beats - beats[0]) / rough)
    period, t0 = np.polyfit(index, beats, 1)
    if not 0.2 < period < 2.0:
        raise ValueError('Tempo del brano non plausibile.')
    return {'bpm': round(60.0 / float(period), 2), 'period': float(period), 't0': float(t0)}


def reverb(task):
    """True convolution of a stereo float WAV with the impulse response: out = cos(mix*pi/2) * dry + sin(mix*pi/2) * wet, tail kept."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import fftconvolve
    dry, rate = sf.read(task['input'], dtype='float32', always_2d=True)
    ir, ir_rate = sf.read(task['ir'], dtype='float32', always_2d=True)
    if rate != ir_rate or dry.shape[1] != 2 or ir.shape[1] != 2:
        raise ValueError('Formato audio del riverbero non valido.')
    mix = float(task['mix'])
    if not 0 <= mix <= 1:
        raise ValueError('Quantita di riverbero non valida.')
    wet = np.stack([fftconvolve(dry[:, c], ir[:, c]) for c in range(2)], axis=1)
    # Equal-power crossfade, the same law as verbMix() in public/fx.mjs.
    out = wet * np.sin(mix * np.pi / 2)
    out[:len(dry)] += dry * np.cos(mix * np.pi / 2)
    sf.write(task['output'], out.astype('float32'), rate, subtype='FLOAT')
    report(done=True)


def main(task):
    """Rules: Paths come from the Sonora server; write stems next to the job and leave the source file untouched."""
    if task.get('action') == 'reverb':
        reverb(task)
        return
    if task.get('action') == 'grid':
        report(done=True, grid=fit_grid(task['stemDir']))
        return
    if task.get('action') != 'separate6':
        raise ValueError('Operazione audio non valida.')
    import torch
    torch.set_num_threads(6)
    from audio_separator.separator import Separator
    target = Path(task['outputDir'])
    target.mkdir(parents=True, exist_ok=True)
    report(phase='Caricamento separatore a sei strumenti')
    separator = Separator(model_file_dir=task['modelDir'], output_dir=str(target), output_format='FLAC',
                          sample_rate=44100, log_level=logging.WARNING)
    separator.load_model('htdemucs_6s.yaml')
    report(phase='Separazione in sei strumenti · CPU')
    files = separator.separate(task['source'])
    found = []
    for name in files:
        path = target / Path(name).name
        match = re.search(r'\((\w+)\)', path.name)
        stem = match.group(1).lower() if match else ''
        if stem not in STEMS or not path.exists():
            continue
        path.replace(target / (stem + '.flac'))
        found.append(stem)
    if sorted(found) != sorted(STEMS):
        raise ValueError('Il separatore non ha restituito tutti gli strumenti.')
    report(done=True, stems=[s for s in STEMS])


if __name__ == '__main__':
    try:
        main(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
    except Exception as exc:
        report(error=str(exc)[:500])
        sys.exit(1)
