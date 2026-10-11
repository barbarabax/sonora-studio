"""audio_lab_dsp.py — Mastering DSP for Sonora Audio Lab.

Adapted from Barichord Audio Lab (E:/audio-lab/barichord-audio-lab,
audio_mastering_tool.py and audio_analyzer.py), MIT License,
Copyright (c) 2025 geeknik. See integrations/audio-lab.json.

Changes from the original: BS.1770 integrated loudness and oversampled true
peak in the analysis (no RMS approximation), causal reverb (the original
'same' convolution played the reverb before the dry sound), stereo-linked
compressor, a limiter that does not fade in the start of the track, a single
processing order for every render and bounded memory for long files.

exports: VERSION | MAX_SECONDS | EQ_BANDS | DEFAULTS | RANGES | COMPRESSORS | REVERBS | HIGH_PASS_HZ | BUTTERWORTH_Q | gain(db_value) | to_db(linear) | rounded(value, digits) | validate(settings) | probe(filename) | read_audio(filename) | write_flac(filename, audio, rate, tags_from) | copy_tags(source, target) | export_mp3(source, target, keep_metadata) | peak_envelope(audio, oversample, block, pad) | true_peak_db(audio) | (+17 more)
used_by: audio_lab_worker.py
         test/audio_lab_dsp_test.py
rules:   none
agent:   codedna-cli (no-llm) | codedna-cli | 2026-10-11 | codedna-cli | initial CodeDNA annotation pass
message: 
"""
# @codedna
# description: Audio Lab measurement and mastering chain adapted from Barichord Audio Lab (MIT).
# rules: Channels-first float32 arrays; one processing order for every render; measure the result, never assume it.
# agent: Claude - 2026-10-04 - Audio Lab integration for Sonora.
"""Mastering DSP for Sonora Audio Lab.

Adapted from Barichord Audio Lab (E:/audio-lab/barichord-audio-lab,
audio_mastering_tool.py and audio_analyzer.py), MIT License,
Copyright (c) 2025 geeknik. See integrations/audio-lab.json.

Changes from the original: BS.1770 integrated loudness and oversampled true
peak in the analysis (no RMS approximation), causal reverb (the original
'same' convolution played the reverb before the dry sound), stereo-linked
compressor, a limiter that does not fade in the start of the track, a single
processing order for every render and bounded memory for long files.
"""
import json
import math
import os
import subprocess
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d

try:
    from numba import njit
except ImportError:  # pragma: no cover - the Sonora runtime ships numba
    njit = None

VERSION = 'sonora-audio-lab/2'
MAX_SECONDS = 600
# Shared with public/audio-lab-dsp.mjs: the browser plays this exact chain in real time.
EQ_BANDS = (31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)
EQ_Q, EQ_RANGE = 1.4, 12
DEFAULTS = {'eq': [0.0] * len(EQ_BANDS), 'compressor': 'off', 'reverb': 'off',
            'width': 1.0, 'targetLufs': -14.0, 'ceiling': -1.0, 'metadata': 'keep'}
RANGES = {'width': (0.5, 1.5), 'targetLufs': (-20, -8), 'ceiling': (-3, -0.1)}
# threshold dB, ratio, attack ms, release ms (Barichord Audio Lab presets)
COMPRESSORS = {'gentle': (-18.0, 2.0, 12.0, 160.0), 'tight': (-22.0, 3.5, 8.0, 140.0), 'punch': (-24.0, 5.0, 4.0, 90.0)}
# decay s, wet mix
REVERBS = {'small': (0.3, 0.12), 'studio': (0.5, 0.18), 'large': (0.8, 0.25)}
HIGH_PASS_HZ = 30
BUTTERWORTH_Q = 1 / math.sqrt(2)
IR_LOWPASS, IR_HIGHPASS, WET_LOWPASS = (2000, 5), (150, 3), (2500, 4)


def gain(db_value):
    return 10 ** (db_value / 20)


def to_db(linear):
    return 20 * math.log10(linear) if linear > 0 else None


def rounded(value, digits=1):
    return None if value is None or not math.isfinite(value) else round(float(value), digits)


def validate(settings):
    """Rules: Reject out-of-range settings before any audio is processed; never clamp silently."""
    result = {}
    eq = settings.get('eq', DEFAULTS['eq'])
    if not isinstance(eq, list) or len(eq) != len(EQ_BANDS) or any(
            isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > EQ_RANGE for v in eq):
        raise ValueError('Impostazione eq non valida.')
    result['eq'] = [float(v) for v in eq]
    if settings.get('metadata', 'keep') not in ('keep', 'strip'):
        raise ValueError('Impostazione metadata non valida.')
    result['metadata'] = settings.get('metadata', 'keep')
    for key, (low, high) in RANGES.items():
        value = settings.get(key, DEFAULTS[key])
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f'Impostazione {key} non valida.')
        result[key] = float(value)
    for key, options in (('compressor', COMPRESSORS), ('reverb', REVERBS)):
        value = settings.get(key, DEFAULTS[key])
        if value != 'off' and value not in options:
            raise ValueError(f'Impostazione {key} non valida.')
        result[key] = value
    return result


# ---------------------------------------------------------------- input/output

def probe(filename):
    result = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                             'stream=sample_rate,channels,codec_name,bits_per_raw_sample,bits_per_sample,sample_fmt:format=duration:format_tags=title,artist,album',
                             '-of', 'json', str(filename)], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise ValueError('Formato audio non riconosciuto.')
    data = json.loads(result.stdout)
    streams = data.get('streams') or []
    if not streams:
        raise ValueError('Il file non contiene una traccia audio.')
    stream = streams[0]
    duration = float(data.get('format', {}).get('duration') or 0)
    if not math.isfinite(duration) or duration <= 0 or duration > MAX_SECONDS:
        raise ValueError('Scegli un audio valido di massimo 10 minuti.')
    bits = int(stream.get('bits_per_raw_sample') or stream.get('bits_per_sample') or 0) or None
    tags = {k.lower(): str(v)[:200] for k, v in (data.get('format', {}).get('tags') or {}).items() if k.lower() in ('title', 'artist', 'album')}
    return {'sampleRate': int(stream['sample_rate']), 'channels': int(stream.get('channels') or 0),
            'codec': stream.get('codec_name'), 'bitDepth': bits, 'sampleFormat': stream.get('sample_fmt'), 'tags': tags}


def read_audio(filename):
    """Decode any FFmpeg-readable file to channels-first float32 stereo at its own rate."""
    info = probe(filename)
    rate = info['sampleRate'] if 22050 <= info['sampleRate'] <= 96000 else 48000
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(filename), '-vn', '-ac', '2', '-ar', str(rate),
                              '-f', 'f32le', 'pipe:1'], capture_output=True, timeout=300)
    if decoded.returncode != 0:
        raise ValueError('Impossibile decodificare l’audio.')
    audio = np.frombuffer(decoded.stdout, dtype='<f4').reshape(-1, 2).T.copy()
    if audio.shape[1] < rate // 2 or not np.isfinite(audio).all():
        raise ValueError('Audio vuoto, troppo breve o non valido.')
    return audio, rate, info


def write_flac(filename, audio, rate, tags_from=None):
    filename = Path(filename)
    filename.parent.mkdir(parents=True, exist_ok=True)
    temp = filename.with_suffix('.tmp.flac')
    sf.write(temp, np.ascontiguousarray(np.clip(audio, -1, 1).T), rate, subtype='PCM_24')
    if tags_from:
        copy_tags(tags_from, temp)
    os.replace(temp, filename)


def copy_tags(source, target):
    """Keep compatible text metadata (title, ComfyUI prompt…); never fail the render for it."""
    try:
        from mutagen import File
        from mutagen.flac import FLAC
        tags = File(source)
        if tags is None or not tags.tags or not str(source).lower().endswith('.flac'):
            return
        out = FLAC(target)
        for key, value in tags.tags.items():
            out[key] = value
        out.save()
    except Exception:
        pass


def export_mp3(source, target, keep_metadata=True):
    target = Path(target)
    temp = target.with_suffix('.tmp.mp3')
    result = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-map_metadata', '0' if keep_metadata else '-1', '-codec:a', 'libmp3lame',
                             '-b:a', '320k', '-id3v2_version', '3', str(temp)], capture_output=True, text=True, timeout=300)
    if result.returncode != 0 or not temp.exists() or temp.stat().st_size < 1024:
        temp.unlink(missing_ok=True)
        raise ValueError('Esportazione MP3 non riuscita: verifica FFmpeg.')
    os.replace(temp, target)


# ---------------------------------------------------------------- measurement

def peak_envelope(audio, oversample=4, block=1 << 18, pad=64):
    """Per-sample true-peak envelope (max over channels and 4x oversampling), in bounded memory."""
    count = audio.shape[1]
    envelope = np.empty(count, dtype=np.float32)
    for start in range(0, count, block):
        stop = min(count, start + block)
        a, b = max(0, start - pad), min(count, stop + pad)
        up = signal.resample_poly(audio[:, a:b], oversample, 1, axis=1)
        peaks = np.abs(up).max(axis=0).reshape(-1, oversample).max(axis=1)
        envelope[start:stop] = peaks[start - a:stop - a]
    return envelope


def true_peak_db(audio):
    return to_db(float(peak_envelope(audio).max()))


def integrated_lufs(audio, rate):
    value = pyln.Meter(rate).integrated_loudness(audio.T.astype(np.float64))
    return float(value) if math.isfinite(value) else None


def frame_rms_db(mono, rate, seconds):
    size = max(1, int(rate * seconds))
    frames = mono[:len(mono) // size * size].reshape(-1, size).astype(np.float64)
    if not len(frames):
        return np.array([])
    return 10 * np.log10(np.mean(frames ** 2, axis=1) + 1e-20)


def analyze(audio, rate, info, musical=True):
    left, right = audio[0].astype(np.float64), audio[1].astype(np.float64)
    mono = (left + right) / 2
    frames = audio.shape[1]
    lufs = integrated_lufs(audio, rate)
    sample_peak = float(np.max(np.abs(audio)))
    true_peak = true_peak_db(audio)
    rms = to_db(math.sqrt(float(np.mean(audio.astype(np.float64) ** 2))))

    try:  # EBU Tech 3342 loudness range
        variation = float(pyln.Meter(rate).loudness_range(audio.T.astype(np.float64)))
    except Exception:
        variation = None

    freqs, power = signal.welch(mono, rate, nperseg=8192)
    audible = (freqs >= 20) & (freqs <= min(20000, rate / 2))
    total = float(np.sum(power[audible])) or 1e-20
    bands = {name: rounded(100 * float(np.sum(power[(freqs >= lo) & (freqs < hi)])) / total)
             for name, (lo, hi) in {'sub': (20, 60), 'bass': (60, 250), 'lowMid': (250, 2000),
                                    'presence': (2000, 6000), 'air': (6000, 20001)}.items()}
    centroid = float(np.sum(freqs[audible] * power[audible]) / total)
    octaves = []
    for centre in (31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000):
        mask = (freqs >= centre / math.sqrt(2)) & (freqs < centre * math.sqrt(2))
        if centre * math.sqrt(2) <= rate / 2 and mask.any():
            octaves.append([centre, 10 * math.log10(float(np.sum(power[mask])) + 1e-20)])
    if octaves:
        mean = sum(level for _, level in octaves) / len(octaves)
        octaves = [{'hz': hz, 'db': rounded(level - mean)} for hz, level in octaves]
    fit = [(math.log2(o['hz']), o['db']) for o in octaves if 100 <= o['hz'] <= 10000]
    tilt = float(np.polyfit(*zip(*fit), 1)[0]) if len(fit) > 2 else None

    energy_l, energy_r = float(np.sum(left ** 2)), float(np.sum(right ** 2))
    side_energy = float(np.sum(((left - right) / 2) ** 2))
    mid_energy = float(np.sum(mono ** 2))
    correlation = float(np.sum(left * right) / math.sqrt(energy_l * energy_r)) if energy_l and energy_r else 1.0
    low = signal.sosfilt(signal.butter(4, 150, 'lp', fs=rate, output='sos'), np.vstack((left, right)), axis=1)
    low_l, low_r = float(np.sum(low[0] ** 2)), float(np.sum(low[1] ** 2))
    low_correlation = float(np.sum(low[0] * low[1]) / math.sqrt(low_l * low_r)) if low_l and low_r else 1.0
    stereo = {'correlation': rounded(correlation, 2), 'lowCorrelation': rounded(low_correlation, 2),
              'width': rounded(100 * side_energy / (mid_energy + side_energy)) if mid_energy + side_energy else 0.0,
              'balance': rounded(10 * math.log10(energy_l / energy_r)) if energy_l and energy_r else 0.0,
              'monoLoss': rounded(10 * math.log10(2 * mid_energy / (energy_l + energy_r))) if mid_energy else None}

    hot = np.abs(audio) >= 0.999
    clipped_runs = 0
    for channel in hot:
        edges = np.diff(np.concatenate(([0], channel.astype(np.int8), [0])))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        clipped_runs += int(np.sum(ends - starts >= 3))
    tens = frame_rms_db(mono, rate, 0.01)
    loud = np.flatnonzero(tens > -60)
    head = len(loud) and loud[0] * 0.01
    tail = len(loud) and (len(tens) - 1 - loud[-1]) * 0.01
    floor_frames = frame_rms_db(mono, rate, 0.05)
    floor_frames = floor_frames[floor_frames > -120]
    integrity = {'dcOffset': rounded(100 * max(abs(float(np.mean(left))), abs(float(np.mean(right)))), 3),
                 'clippedRuns': clipped_runs, 'overs': int(np.sum(np.abs(audio) > 1.0)),
                 'headSilence': rounded(head if len(loud) else frames / rate, 2),
                 'tailSilence': rounded(tail if len(loud) else frames / rate, 2),
                 'noiseFloor': rounded(float(np.percentile(floor_frames, 5))) if len(floor_frames) else None}

    return {'version': VERSION,
            'technical': {**info, 'analysisRate': rate, 'frames': frames, 'duration': rounded(frames / rate, 2)},
            'loudness': {'integrated': rounded(lufs), 'truePeak': rounded(true_peak), 'samplePeak': rounded(to_db(sample_peak)),
                         'rms': rounded(rms), 'crest': rounded(to_db(sample_peak) - rms) if rms is not None and sample_peak else None,
                         'plr': rounded(true_peak - lufs) if true_peak is not None and lufs is not None else None,
                         'lra': rounded(variation)},
            'spectrum': {'centroid': rounded(centroid, 0), 'tilt': rounded(tilt, 2), 'bands': bands, 'octaves': octaves},
            'stereo': stereo, 'integrity': integrity,
            'musical': musical_features(mono, rate) if musical else None}


KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def key_candidates(chroma):
    """All 24 Krumhansl-Schmuckler correlations for a 12-bin chroma vector, best first."""
    return sorted(
        ((float(np.corrcoef(np.roll(chroma, -i), profile)[0, 1]), f'{KEY_NAMES[i]} {mode}')
         for i in range(12) for mode, profile in (('major', MAJOR), ('minor', MINOR))),
        reverse=True)


def musical_features(mono, rate):
    """Tempo and key estimates (Krumhansl-Schmuckler) on up to two minutes.

    The key uses a constant-Q chroma: the old STFT chroma (4096 points at 22.05 kHz) cannot resolve bass notes, so
    I-IV-V rockabilly in C major was reported as E minor. When the runner-up is within 0.1 it is reported as
    'keyAlternative', because related keys (relative minor, mediant) genuinely compete on diatonic music.
    """
    try:
        import librosa
        y = signal.resample_poly(mono, 22050, rate).astype(np.float32) if rate != 22050 else mono.astype(np.float32)
        span = 22050 * 120
        if len(y) > span:
            start = (len(y) - span) // 2
            y = y[start:start + span]
        tempo, _ = librosa.beat.beat_track(y=y, sr=22050)
        chroma = librosa.feature.chroma_cqt(y=y, sr=22050).sum(axis=1)
        ranked = key_candidates(chroma)
        best = ranked[0]
        result = {'bpm': rounded(float(np.atleast_1d(tempo)[0])), 'key': best[1], 'keyConfidence': rounded(best[0], 2)}
        if ranked[1][0] > best[0] - 0.1:
            result['keyAlternative'] = ranked[1][1]
            result['keyAlternativeConfidence'] = rounded(ranked[1][0], 2)
        return result
    except Exception:
        return None


# ---------------------------------------------------------------- processing

def biquad(kind, freq, rate, q=BUTTERWORTH_Q, gain_db=0.0):
    """RBJ cookbook biquad as the Web Audio API computes it; returns one SOS row."""
    w = 2 * math.pi * freq / rate
    c, alpha, a_gain = math.cos(w), math.sin(w) / (2 * q), 10 ** (gain_db / 40)
    if kind == 'peaking':
        b, a = [1 + alpha * a_gain, -2 * c, 1 - alpha * a_gain], [1 + alpha / a_gain, -2 * c, 1 - alpha / a_gain]
    elif kind == 'lowpass':
        b, a = [(1 - c) / 2, 1 - c, (1 - c) / 2], [1 + alpha, -2 * c, 1 - alpha]
    elif kind == 'highpass':
        b, a = [(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + alpha, -2 * c, 1 - alpha]
    else:
        raise ValueError(kind)
    return [b[0] / a[0], b[1] / a[0], b[2] / a[0], 1.0, a[1] / a[0], a[2] / a[0]]


def high_pass(audio, rate):
    return signal.sosfilt([biquad('highpass', HIGH_PASS_HZ, rate)], audio, axis=1).astype(np.float32)


def equalize(audio, rate, bands):
    """Ten peaking filters (Q 1.4) at the graphic-EQ centres; bands at 0 dB or above Nyquist are skipped."""
    sos = [biquad('peaking', f, rate, EQ_Q, g) for f, g in zip(EQ_BANDS, bands) if g != 0 and f < rate * 0.49]
    if not sos:
        return audio
    return signal.sosfilt(sos, audio, axis=1).astype(np.float32)


def _compressor_gain(level, threshold, ratio, attack, release):
    out = np.empty_like(level)
    envelope = 0.0
    for i in range(level.shape[0]):
        x = level[i]
        coeff = attack if x > envelope else release
        envelope = coeff * envelope + (1.0 - coeff) * x
        out[i] = (threshold + (envelope - threshold) / ratio) / envelope if envelope > threshold else 1.0
    return out


if njit:
    _compressor_gain = njit(cache=True)(_compressor_gain)


def compress(audio, rate, mode):
    if mode not in COMPRESSORS:
        return audio
    threshold_db, ratio, attack_ms, release_ms = COMPRESSORS[mode]
    level = np.abs(audio).max(axis=0).astype(np.float64)  # stereo-linked: keeps the image centred
    reduction = _compressor_gain(level, gain(threshold_db), ratio,
                                 math.exp(-1 / (rate * attack_ms / 1000)), math.exp(-1 / (rate * release_ms / 1000)))
    return (audio * reduction.astype(np.float32)).astype(np.float32)


def widen(audio, width):
    if width == 1:
        return audio
    mid, side = (audio[0] + audio[1]) / 2, (audio[0] - audio[1]) / 2 * width
    return np.vstack((mid + side, mid - side)).astype(np.float32)


def _mulberry32(seed, count):
    """Same 32-bit generator as the browser (public/audio-lab-dsp.mjs)."""
    mask, a, out = 0xFFFFFFFF, seed & 0xFFFFFFFF, np.empty(count)
    for i in range(count):
        a = (a + 0x6D2B79F5) & mask
        t = ((a ^ (a >> 15)) * (1 | a)) & mask
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & mask)) & mask) ^ t
        out[i] = ((t ^ (t >> 14)) & mask) / 4294967296
    return out


def impulse(rate, mode):
    """Deterministic filtered-noise impulse, unit energy, reproducible in the browser."""
    decay = REVERBS[mode][0]
    count = max(1, int(math.floor(rate * (decay + 0.15))))
    position = np.arange(count) / (count - 1) if count > 1 else np.zeros(1)
    ir = (_mulberry32(42, count) * 2 - 1) * np.power(1 - position, decay * 2.5)
    ir = signal.sosfilt([biquad('lowpass', IR_LOWPASS[0], rate)] * IR_LOWPASS[1], ir)
    ir = signal.sosfilt([biquad('highpass', IR_HIGHPASS[0], rate)] * IR_HIGHPASS[1], ir)
    return ir / (math.sqrt(float(np.sum(ir ** 2))) or 1)


def reverb(audio, rate, mode):
    """Convolution reverb. Causal; the tail past the last sample is cut to keep the length."""
    if mode not in REVERBS:
        return audio
    mix = REVERBS[mode][1]
    wet = signal.fftconvolve(audio, impulse(rate, mode)[np.newaxis, :].astype(np.float32), mode='full', axes=1)[:, :audio.shape[1]]
    wet = signal.sosfilt([biquad('lowpass', WET_LOWPASS[0], rate)] * WET_LOWPASS[1], wet, axis=1)
    return ((1 - mix) * audio + mix * wet).astype(np.float32)


def limit(audio, rate, ceiling_db, lookahead_ms=3.0, release_ms=60.0):
    """Stereo-linked look-ahead true-peak limiter with a smooth attack and exponential release."""
    target = gain(ceiling_db)
    required = np.minimum(1.0, target / np.maximum(peak_envelope(audio).astype(np.float64), 1e-9))
    window = 2 * max(1, int(rate * lookahead_ms / 1000)) + 1
    # Averaging a window-minimum over the same window stays below every required gain, with a smooth ramp.
    attack = uniform_filter1d(minimum_filter1d(required, size=window, mode='nearest'), size=window, mode='nearest')
    coeff = math.exp(-1 / (rate * release_ms / 1000))
    b, a = [1 - coeff], [1, -coeff]
    # Start from the first gain: the original zero state faded in the first ~100 ms of every master.
    released, _ = signal.lfilter(b, a, attack, zi=signal.lfilter_zi(b, a) * attack[0])
    limited = audio * np.minimum(attack, released).astype(np.float32)
    residual = true_peak_db(limited)
    if residual is not None and residual > ceiling_db + 0.05:
        limited = limited * gain(ceiling_db - residual)
    return limited.astype(np.float32)


def master(audio, rate, settings, progress=lambda phase: None):
    """The single chain used for every render: HP → 10-band EQ → compressor → width → reverb → loudness/true peak.
    Everything before the loudness stage is what the browser plays in real time."""
    settings = validate(settings)
    progress('Filtro, equalizzazione e compressione')
    audio = high_pass(audio, rate)
    audio = equalize(audio, rate, settings['eq'])
    audio = compress(audio, rate, settings['compressor'])
    audio = widen(audio, settings['width'])
    audio = reverb(audio, rate, settings['reverb'])
    progress('Loudness e limitazione true peak')
    target, ceiling = settings['targetLufs'], settings['ceiling']
    current = integrated_lufs(audio, rate)
    if current is None:
        raise ValueError('Audio troppo breve o silenzioso per misurare la loudness.')
    applied = max(-24.0, min(24.0, target - current))
    audio = limit(audio * gain(applied), rate, ceiling)
    passes = 1
    for _ in range(4):
        current = integrated_lufs(audio, rate)
        if current is None or abs(target - current) <= 0.2:
            break
        step = max(-6.0, min(6.0, target - current))
        applied += step
        audio = limit(audio * gain(step), rate, ceiling)
        passes += 1
    if not np.isfinite(audio).all():
        raise ValueError('Il master contiene campioni non validi.')
    reached = integrated_lufs(audio, rate)
    return audio, {'target': target, 'reached': rounded(reached), 'gap': rounded(reached - target) if reached is not None else None,
                   'ceiling': ceiling, 'truePeak': rounded(true_peak_db(audio)), 'gain': rounded(applied), 'passes': passes}
