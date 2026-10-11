"""audio_worker.py — Local audio processing. All paths come from Sonora, never from browser input.

exports: report() | read_audio(filename, rate) | write_flac(filename, audio, rate) | write_stem_float(filename, samples, rate) | mix_arrays(base, voice, base_gain, voice_gain, offset_ms, rate) | main(task)
used_by: none
rules:   none
agent:   codedna-cli (no-llm) | codedna-cli | 2026-10-11 | codedna-cli | initial CodeDNA annotation pass
message: 
"""
# @codedna
# description: Local stereo float stem writing, CPU separation and aligned lossless mixing.
# rules: Use server-owned paths, preserve source audio and keep stereo floating samples intact.
# agent: Codex - 2026-10-04 - Audio editor worker and stereo writer regression fix.
"""Local audio processing. All paths come from Sonora, never from browser input."""
import os
os.environ['CUDA_VISIBLE_DEVICES'] = ''
os.environ['OMP_NUM_THREADS'] = '4'
import sys
import json
import math
import logging
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


def report(**values):
    """Rules: One JSON object per line on stdout; the server reads these lines as progress, results and errors."""
    print(json.dumps(values), flush=True)


def read_audio(filename, rate=44100):
    """Rules: Always decode to stereo float at `rate`; refuse empty, non-finite or longer than 10 minutes."""
    import subprocess
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(filename)], capture_output=True, text=True, check=True, timeout=30)
    duration = float(json.loads(probe.stdout)['format']['duration'])
    if not math.isfinite(duration) or duration <= 0 or duration > 600:
        raise ValueError('Choose a valid audio file of up to 10 minutes.')
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(filename), '-vn', '-ac', '2', '-ar', str(rate), '-f', 'f32le', 'pipe:1'], capture_output=True, check=True, timeout=120)
    audio = np.frombuffer(decoded.stdout, dtype='<f4').reshape(-1, 2).copy()
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError('Empty or invalid audio.')
    return audio


def write_flac(filename, audio, rate=44100):
    """Rules: Write through a temporary file and an atomic replace so a half-written FLAC is never read."""
    filename = Path(filename)
    temp = filename.with_suffix('.tmp.flac')
    sf.write(temp, audio, rate, subtype='PCM_24')
    os.replace(temp, filename)


def write_stem_float(filename, samples, rate=44100):
    """Rules: Keep stereo float samples intact; never route through 16-bit conversion."""
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim != 2 or samples.shape[1] != 2 or not np.isfinite(samples).all():
        raise ValueError('Invalid stereo format from the separator.')
    sf.write(filename, np.ascontiguousarray(samples), rate, subtype='FLOAT')


def mix_arrays(base, voice, base_gain=1, voice_gain=1, offset_ms=0, rate=44100):
    """Rules: Keep the base timeline; shift/pad/trim the voice, reduce only clipping mixes."""
    result = base.astype(np.float64) * base_gain
    shift = round(offset_ms * rate / 1000)
    start, source_start = max(shift, 0), max(-shift, 0)
    count = min(len(base) - start, len(voice) - source_start)
    if count > 0:
        result[start:start + count] += voice[source_start:source_start + count] * voice_gain
    peak = float(np.max(np.abs(result))) if len(result) else 0
    attenuation = min(1, .98 / peak) if peak > 1 else 1
    return result * attenuation, attenuation


def main(task):
    """Rules: Every path in `task` comes from the Sonora server, never from browser input; source audio is never modified in place."""
    action = task['action']
    target = Path(task['outputDir'])
    target.mkdir(parents=True, exist_ok=True)
    if action == 'probe':
        from importlib.metadata import version
        import onnxruntime
        report(done=True, version=version('audio-separator'))
    elif action == 'separate':
        import torch
        torch.set_num_threads(4)
        from audio_separator.separator import Separator
        report(phase='Loading the vocal/instrumental separator')
        separator = Separator(model_file_dir=task['modelDir'], output_dir=str(target), output_format='WAV', sample_rate=44100, normalization_threshold=1, amplification_threshold=0, use_soundfile=True, log_level=logging.WARNING, mdx_params={'hop_length':1024, 'segment_size':256, 'overlap':.25, 'batch_size':1, 'enable_denoise':False})
        separator.load_model('UVR-MDX-NET-Voc_FT.onnx')
        # v0.36.1's soundfile writer casts C-contiguous stereo floats directly to
        # int16, producing silence. Write the model arrays as stereo float WAVs
        # here; never patch the package or route through lossy 16-bit conversion.
        def write_stem(stem_path, samples):
            write_stem_float(target / Path(stem_path).name, samples)
        separator.model_instance.write_audio = write_stem
        report(phase='Separating vocals and instrumental · CPU')
        files = separator.separate(task['source'], custom_output_names={'Vocals':'vocals', 'Instrumental':'instrumental'})
        vocals = next((target / f for f in files if Path(f).stem == 'vocals'), None)
        if vocals is None or not vocals.exists():
            raise ValueError('Il separatore non ha restituito la traccia vocale.')
        original = read_audio(task['source'])
        voice, rate = sf.read(vocals, dtype='float32', always_2d=True)
        if rate != 44100:
            div = math.gcd(rate, 44100)
            voice = resample_poly(voice, 44100 // div, rate // div)
        aligned = np.zeros_like(original)
        aligned[:min(len(voice), len(original))] = voice[:len(original), :2]
        if not np.isfinite(aligned).all():
            raise ValueError('La separazione contiene campioni non validi.')
        # Derive the complementary base from the untouched source: summing the two
        # stems at unity reconstructs it instead of normalizing each independently.
        base = original - aligned
        peak = max(float(np.max(np.abs(base))), float(np.max(np.abs(aligned))))
        stem_attenuation = min(1, .98 / peak) if peak > 1 else 1
        base *= stem_attenuation
        aligned *= stem_attenuation
        write_flac(target / 'vocals.flac', aligned)
        write_flac(target / 'instrumental.flac', base)
        for f in files:
            candidate = target / f
            if candidate.parent == target and candidate.suffix.lower() == '.wav':
                candidate.unlink(missing_ok=True)
        report(done=True, duration=len(original) / 44100, rate=44100, frames=len(original), stemAttenuation=stem_attenuation, vocalsRms=float(np.sqrt(np.mean(aligned ** 2))))
    elif action == 'instrumental':
        # Rules: a track that is already instrumental needs no separation: the base is the song itself and the original voice is silence.
        original = read_audio(task['source'])
        write_flac(target / 'instrumental.flac', original)
        write_flac(target / 'vocals.flac', np.zeros_like(original))
        report(done=True, duration=len(original) / 44100, rate=44100, frames=len(original), stemAttenuation=1, vocalsRms=0.0)
    elif action == 'import':
        audio = read_audio(task['source'])
        target_name = task.get('outputName', 'voice.flac')
        write_flac(target / target_name, audio)
        report(done=True, duration=len(audio) / 44100)
    elif action == 'mix':
        base, rate = sf.read(task['base'], dtype='float32', always_2d=True)
        voice, voice_rate = sf.read(task['voice'], dtype='float32', always_2d=True)
        if voice_rate != rate:
            div = math.gcd(rate, voice_rate)
            voice = resample_poly(voice, rate // div, voice_rate // div)
        audio, attenuation = mix_arrays(base, voice, task['baseGain'], task['voiceGain'], task['offsetMs'], rate)
        write_flac(target / 'mix.flac', audio, rate)
        report(done=True, duration=len(audio) / rate, attenuation=attenuation)
    else:
        raise ValueError('Operazione audio non valida.')


if __name__ == '__main__':
    try:
        main(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig')))
    except Exception as error:
        report(error=str(error)[:1200])
        sys.exit(1)
