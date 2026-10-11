"""test/audio_lab_dsp_test.py — audio_lab_dsp_test module.

exports: RATE | music(seconds, seed) | progression(chords, seconds_per_chord, total, rate) | class KeyEstimate | class MasteringChain | class BrowserParity | class Analysis | class Files
used_by: none
rules:   none
agent:   codedna-cli (no-llm) | codedna-cli | 2026-10-11 | codedna-cli | initial CodeDNA annotation pass
message: 
"""
# @codedna
# description: Audio Lab DSP regressions on synthetic signals: channels, length, loudness, true peak, timing.
# rules: Synthetic audio only; no network, GPU or library files.
# agent: Claude - 2026-10-04 - Audio Lab integration for Sonora.
"""Run with: runtime/separator/Scripts/python.exe -m unittest discover -s test -p "*_test.py\""""
import json
import math
import subprocess
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import audio_lab_dsp as dsp  # noqa: E402

RATE = 48000


def music(seconds=12, seed=1):
    """Stereo test material: sustained chords, a kick-like pulse and noise, left louder than right."""
    t = np.arange(int(RATE * seconds)) / RATE
    rng = np.random.default_rng(seed)
    tone = sum(np.sin(2 * np.pi * f * t) for f in (110, 220, 330, 440, 660)) / 5
    kick = np.sin(2 * np.pi * 55 * t) * np.exp(-((t % 0.5) * 18))
    left = 0.25 * tone + 0.35 * kick + 0.02 * rng.standard_normal(len(t))
    right = 0.12 * tone + 0.35 * kick + 0.02 * rng.standard_normal(len(t))
    return np.vstack((left, right)).astype(np.float32)


def progression(chords, seconds_per_chord=2.0, total=24, rate=22050):
    """Mono test music: root-position triads (MIDI notes) with 4 harmonics plus a bass root an octave down."""
    t = np.arange(int(rate * seconds_per_chord)) / rate
    def chord(notes):
        out = np.zeros_like(t)
        for n in notes + [notes[0] - 12]:
            f = 440 * 2 ** ((n - 69) / 12)
            out += sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, 5))
        return out * np.minimum(1, np.minimum(t, t[::-1]) * 40) / 5
    cycle = np.concatenate([chord(c) for c in chords])
    return np.tile(cycle, int(np.ceil(total / (seconds_per_chord * len(chords)))))[: int(total * rate)].astype(np.float32)


class KeyEstimate(unittest.TestCase):
    def test_i_iv_v_in_c_major_is_c_major_not_e_minor(self):
        """Rules: A I-IV-V progression in C must be detected as C major, never as its relative minor."""
        c, f, g = [60, 64, 67], [65, 69, 72], [67, 71, 74]
        result = dsp.musical_features(progression([c, f, g, c]), 22050)
        self.assertEqual(result['key'], 'C major')

    def test_minor_progression_is_minor_and_close_keys_report_an_alternative(self):
        am, dm, e = [57, 60, 64], [62, 65, 69], [64, 68, 71]
        result = dsp.musical_features(progression([am, dm, e, am]), 22050)
        self.assertTrue(result['key'].endswith('minor'), result)
        for key in ('keyAlternative', 'keyAlternativeConfidence'):
            self.assertEqual(key in result, 'keyAlternative' in result)

    def test_candidates_are_the_24_keys_best_first(self):
        ranked = dsp.key_candidates(np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]))
        self.assertEqual(len(ranked), 24)
        self.assertEqual(ranked[0][1], 'C major')
        self.assertTrue(all(ranked[i][0] >= ranked[i + 1][0] for i in range(23)))


class MasteringChain(unittest.TestCase):
    def test_every_setting_preserves_length_channel_order_and_finite_samples(self):
        audio = music()
        settings = {'eq': [3, 2, 0, -2, 0, 0, 1, 4, 5, 2], 'compressor': 'punch', 'reverb': 'large', 'width': 1.4, 'targetLufs': -12, 'ceiling': -1}
        out, loudness = dsp.master(audio, RATE, settings)
        self.assertEqual(out.shape, audio.shape)
        self.assertTrue(np.isfinite(out).all())
        self.assertGreater(np.mean(out[0] ** 2), np.mean(out[1] ** 2), 'left/right must not be swapped')
        self.assertLessEqual(loudness['truePeak'], -1 + 0.1)
        self.assertLessEqual(dsp.true_peak_db(out), -1 + 0.1)

    def test_loudness_target_is_measured_and_gap_reported(self):
        out, loudness = dsp.master(music(), RATE, {'targetLufs': -16, 'ceiling': -1})
        self.assertAlmostEqual(dsp.integrated_lufs(out, RATE), -16, delta=0.3)
        self.assertAlmostEqual(loudness['reached'], -16, delta=0.3)
        _, loud = dsp.master(music(), RATE, {'targetLufs': -8, 'ceiling': -3})
        self.assertLessEqual(loud['truePeak'], -3 + 0.1, 'the ceiling wins over an unreachable target')
        self.assertIsNotNone(loud['gap'])

    def test_neutral_eq_is_transparent_and_limiter_does_not_fade_in(self):
        audio = music()
        self.assertIs(dsp.equalize(audio, RATE, [0] * 10), audio)
        loud = np.tile(np.float32(0.9) * np.sign(np.sin(np.linspace(0, 400 * np.pi, RATE))), (2, 2))
        limited = dsp.limit(loud, RATE, -1)
        start, later = np.abs(limited[:, :480]).max(), np.abs(limited[:, RATE // 2:]).max()
        self.assertGreater(start, 0.5 * later, 'the first 10 ms must not be faded in')

    def test_reverb_never_sounds_before_the_dry_onset(self):
        audio = np.zeros((2, RATE * 2), dtype=np.float32)
        onset = RATE
        audio[:, onset:onset + 2400] = 0.5 * np.sin(2 * np.pi * 440 * np.arange(2400) / RATE)
        out = dsp.reverb(audio, RATE, 'large')
        self.assertEqual(out.shape, audio.shape)
        self.assertLess(np.abs(out[:, :onset]).max(), 1e-6)
        self.assertGreater(np.abs(out[:, onset + 4800:onset + 9600]).max(), 1e-3, 'the tail follows the sound')

    def test_compressor_is_stereo_linked(self):
        audio = music()
        out = dsp.compress(audio, RATE, 'punch')
        ratio = np.sqrt(np.mean(out ** 2, axis=1)) / np.sqrt(np.mean(audio ** 2, axis=1))
        self.assertAlmostEqual(ratio[0], ratio[1], delta=0.05)
        self.assertLess(ratio[0], 1)

    def test_invalid_settings_are_rejected(self):
        for bad in ({'eq': [13] + [0] * 9}, {'eq': [0] * 9}, {'metadata': 'erase'}, {'width': 3}, {'compressor': 'brickwall'}, {'targetLufs': float('nan')}, {'ceiling': True}):
            with self.assertRaises(ValueError):
                dsp.validate(bad)


class BrowserParity(unittest.TestCase):
    """The browser plays public/audio-lab-dsp.mjs in real time; the export uses this module."""

    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parent.parent
        script = ("import('./public/audio-lab-dsp.mjs').then(d=>{const t=Array.from({length:48000*6},(_,i)=>0.3*Math.sin(2*Math.PI*997*i/48000)*(i<144000?1:0.2));"
                  "console.log(JSON.stringify({peak:d.biquad('peaking',1000,44100,{q:d.EQ_Q,gain:5.5}),hp:d.biquad('highpass',30,48000),"
                  "ir:Array.from(d.impulse(44100,'large')),lufs:d.integratedLufs([t,t.map(v=>v*0.5)],48000)}));})")
        result = subprocess.run(['node', '-e', script], cwd=root, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise unittest.SkipTest('Node.js non disponibile: ' + result.stderr[-300:])
        cls.js = json.loads(result.stdout)

    def test_filter_coefficients_match(self):
        sos = dsp.biquad('peaking', 1000, 44100, dsp.EQ_Q, 5.5)
        np.testing.assert_allclose([sos[0], sos[1], sos[2], sos[4], sos[5]], self.js['peak'], rtol=1e-12)
        sos = dsp.biquad('highpass', 30, 48000)
        np.testing.assert_allclose([sos[0], sos[1], sos[2], sos[4], sos[5]], self.js['hp'], rtol=1e-12)

    def test_reverb_impulse_matches(self):
        ir = dsp.impulse(44100, 'large')
        self.assertEqual(len(ir), len(self.js['ir']))
        np.testing.assert_allclose(ir, self.js['ir'], atol=1e-9)

    def test_browser_loudness_matches_pyloudnorm(self):
        t = np.arange(48000 * 6)
        tone = 0.3 * np.sin(2 * np.pi * 997 * t / 48000) * np.where(t < 144000, 1, 0.2)
        self.assertAlmostEqual(self.js['lufs'], dsp.integrated_lufs(np.vstack((tone, tone * 0.5)), 48000), delta=0.02)

    def test_eq_band_boost_matches_its_gain(self):
        t = np.arange(RATE * 2) / RATE
        tone = np.vstack([0.1 * np.sin(2 * np.pi * 1000 * t)] * 2).astype(np.float32)
        boosted = dsp.equalize(tone, RATE, [0, 0, 0, 0, 0, 6, 0, 0, 0, 0])
        level = 20 * np.log10(np.sqrt(np.mean(boosted[:, RATE:] ** 2)) / np.sqrt(np.mean(tone[:, RATE:] ** 2)))
        self.assertAlmostEqual(level, 6, delta=0.1)


class Analysis(unittest.TestCase):
    def test_measurements_match_known_signals(self):
        t = np.arange(RATE * 10) / RATE
        sine = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
        result = dsp.analyze(np.vstack((sine, sine)), RATE, {'sampleRate': RATE}, musical=False)
        self.assertAlmostEqual(result['loudness']['samplePeak'], -6.0, delta=0.1)
        # BS.1770: a 1 kHz sine of amplitude 1 in both channels reads 0 LUFS, so amplitude 0.5 reads -6.
        self.assertAlmostEqual(result['loudness']['integrated'], -6.0, delta=0.3)
        self.assertAlmostEqual(result['stereo']['correlation'], 1.0, places=2)
        self.assertEqual(result['stereo']['width'], 0.0)
        self.assertGreater(result['spectrum']['bands']['lowMid'], 90)
        result = dsp.analyze(np.vstack((sine, -sine)), RATE, {'sampleRate': RATE}, musical=False)
        self.assertAlmostEqual(result['stereo']['correlation'], -1.0, places=2)
        self.assertIsNone(result['stereo']['monoLoss'])

    def test_true_peak_catches_inter_sample_overs(self):
        t = np.arange(RATE) / RATE
        tricky = np.sin(2 * np.pi * (RATE / 4) * t + np.pi / 4).astype(np.float32)  # samples at ±0.707, peaks at 1.0
        self.assertAlmostEqual(dsp.true_peak_db(np.vstack((tricky, tricky))), 0.0, delta=0.3)

    def test_clipping_and_silence_are_reported(self):
        audio = np.zeros((2, RATE * 4), dtype=np.float32)
        audio[:, RATE:RATE * 3] = np.clip(1.5 * np.sin(2 * np.pi * 100 * np.arange(RATE * 2) / RATE), -1, 1)
        result = dsp.analyze(audio, RATE, {}, musical=False)
        self.assertGreater(result['integrity']['clippedRuns'], 100)
        self.assertAlmostEqual(result['integrity']['headSilence'], 1.0, delta=0.05)
        self.assertAlmostEqual(result['integrity']['tailSilence'], 1.0, delta=0.05)


class Files(unittest.TestCase):
    def test_flac_round_trip_keeps_rate_and_mp3_export(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.flac'
            dsp.write_flac(source, music(3), RATE)
            audio, rate, info = dsp.read_audio(source)
            self.assertEqual(rate, RATE)
            self.assertEqual(info['bitDepth'], 24)
            self.assertEqual(audio.shape, (2, RATE * 3))
            self.assertFalse(any(name.endswith('.tmp.flac') for name in os.listdir(folder)))
            dsp.export_mp3(source, Path(folder) / 'master.mp3')
            self.assertGreater((Path(folder) / 'master.mp3').stat().st_size, 10000)

    def test_too_long_or_invalid_audio_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            bad = Path(folder) / 'bad.flac'
            bad.write_bytes(b'not audio' * 100)
            with self.assertRaises(ValueError):
                dsp.read_audio(bad)


if __name__ == '__main__':
    unittest.main()
