"""test_yue2_worker.py — tests of the melody transcription action of the YuE2 worker, with a fake SheetSage2.

exports: ABC | FAKE_INFER | ABC_CHORDS | class Transcribe | class Continuation | class TrainUpload | class Cpp
used_by: test/yue2-worker-python.test.mjs
rules:   No GPU, no model, no network: the "SheetSage2" is a tiny script that writes score.abc the way infer.py does.
agent:   claude-sonnet-5-5 | anthropic | 2026-10-14 | s_20261014_cover | Created with the transcribe action.
"""
import base64
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault('YUE2_VOLUME', tempfile.mkdtemp())
import yue2_worker as worker  # noqa: E402

ABC = 'X:1\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal\nV: Ins\nK:C\n% verse\nV: Vocal\nc4d4e4f4|\nV: Ins\nC,16|\n'
FAKE_INFER = '''
import sys
from pathlib import Path
args = sys.argv[1:]
audio, out = Path(args[0]), Path(args[args.index('--output') + 1])
if audio.read_bytes().startswith(b'FAIL'):
    sys.stderr.write('model exploded')
    sys.exit(3)
out.mkdir(parents=True)
# like SheetSage2: chords in the score unless --melody-only is given
(out / 'score.abc').write_text(%r if '--melody-only' in args else %r, encoding='utf-8')
'''
ABC_CHORDS = ABC.replace('c4d4e4f4|', '"C"c4d4"G"e4f4|')


class Transcribe(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        (self.repo / 'infer.py').write_text(FAKE_INFER % (ABC, ABC_CHORDS), encoding='utf-8')
        os.environ['SHEETSAGE_PYTHON'] = sys.executable
        os.environ['SHEETSAGE_REPO'] = str(self.repo)

    def request(self, audio=b'x' * 4000, **extra):
        return {'localId': str(uuid.uuid4()), 'audio': base64.b64encode(audio).decode(), 'format': 'mp3', **extra}

    def test_returns_the_melody_only_plan(self):
        result = worker.transcribe({}, self.request())
        self.assertEqual(result['abc'], ABC)
        self.assertEqual(result['engine'], 'SheetSage2')
        self.assertIn('seconds', result)

    def test_prefers_sheetsage_even_when_cpp_is_ready(self):
        original = worker.CPP_READY
        worker.CPP_READY = self.repo / '.cpp-ready'
        worker.CPP_READY.write_text('1')
        original_start = worker.start_engine
        worker.start_engine = lambda: self.fail('yue2.cpp should not start when SheetSage2 succeeds')
        try:
            self.assertEqual(worker.transcribe({}, self.request())['engine'], 'SheetSage2')
        finally:
            worker.CPP_READY = original
            worker.start_engine = original_start

    def test_chords_come_back_only_when_asked_for(self):
        plain = worker.transcribe({}, self.request())
        self.assertFalse(plain['chords'])
        self.assertNotIn('"C"', plain['abc'])
        with_chords = worker.transcribe({}, self.request(chords=True))
        self.assertTrue(with_chords['chords'])
        self.assertEqual(with_chords['abc'], ABC_CHORDS)
        with self.assertRaises(ValueError):
            worker.transcribe({}, self.request(chords='yes'))

    def test_reports_the_error_of_the_tool(self):
        with self.assertRaisesRegex(RuntimeError, 'model exploded'):
            worker.transcribe({}, self.request(audio=b'FAIL' + b'x' * 4000))

    def test_refuses_bad_input(self):
        with self.assertRaises(ValueError):
            worker.transcribe({}, self.request(format='exe'))
        with self.assertRaises(ValueError):
            worker.transcribe({}, {**self.request(), 'audio': 'not base64!!'})
        with self.assertRaises(ValueError):
            worker.transcribe({}, self.request(audio=b'tiny'))
        with self.assertRaises(ValueError):
            worker.transcribe({}, {**self.request(), 'localId': 'nope'})

    def test_says_when_the_tool_is_not_installed(self):
        os.environ['SHEETSAGE_REPO'] = str(self.repo / 'missing')
        with self.assertRaisesRegex(RuntimeError, 'not installed'):
            worker.transcribe({}, self.request())

    def test_ffmpeg_is_linked_in_when_the_image_has_none(self):
        folder = Path(tempfile.mkdtemp()) / 'bin'
        fake = Path(tempfile.mkdtemp()) / 'static-ffmpeg'
        fake.write_text('#!/bin/sh\n')
        original = worker.ffmpeg_binary
        worker.ffmpeg_binary = lambda: str(fake)
        try:
            bare = {'PATH': str(Path(tempfile.mkdtemp()))}
            result = worker.with_ffmpeg(bare, folder)
            if hasattr(os, 'symlink') and (folder / 'ffmpeg').exists():
                self.assertTrue(result['PATH'].startswith(str(folder)))
            else:  # symlinks are not allowed here: the environment must come back untouched
                self.assertEqual(result, bare)
            self.assertEqual(worker.with_ffmpeg({'PATH': os.environ.get('PATH', '')}, folder)['PATH'], os.environ.get('PATH', ''))
        finally:
            worker.ffmpeg_binary = original

    def test_the_handler_serves_the_action_and_health_knows_the_tool(self):
        self.assertEqual(worker.handler({'input': {'action': 'transcribe', **self.request()}})['abc'], ABC)
        self.assertTrue(worker.health()['sheetsage'])


class Continuation(unittest.TestCase):
    def test_validated_source_section_reaches_cpp(self):
        tokens = ','.join(str(n % 100) for n in range(500))
        base = {'localId': str(uuid.uuid4()), 'style': 'piano', 'lyrics': '[Verse]\nCiao',
                'sourceTokens': tokens, 'sourceStart': 2, 'sourceEnd': 8, 'duration': 26}
        _, request = worker.validate(base)
        body = worker.cpp_request(request, [])
        self.assertEqual((body['source_tokens'], body['source_start'], body['source_end'], body['duration']),
                         (tokens, 2, 8, 26))
        with self.assertRaises(ValueError):
            worker.validate({**base, 'semanticTokens': tokens})
        with self.assertRaises(ValueError):
            worker.validate({**base, 'sourceEnd': 25})
        with self.assertRaises(ValueError):
            worker.validate({**base, 'duration': 10})


class TrainUpload(unittest.TestCase):
    def setUp(self):
        self.old_train = worker.TRAIN
        self.temp = tempfile.TemporaryDirectory()
        worker.TRAIN = Path(self.temp.name)
        self.project = str(uuid.uuid4())
        self.track = str(uuid.uuid4())
        self.audio = b'a' * 1200
        import hashlib
        self.sha = hashlib.sha256(self.audio).hexdigest()

    def tearDown(self):
        worker.TRAIN = self.old_train
        self.temp.cleanup()

    def upload(self, offset, chunk, sha=None):
        return worker.train_upload({
            'projectId': self.project, 'trackId': self.track, 'ext': '.wav',
            'total': len(self.audio), 'offset': offset,
            'sha256': sha or self.sha, 'base64': base64.b64encode(chunk).decode(),
        })

    def test_checked_chunks_and_offset_recovery(self):
        self.assertEqual(self.upload(0, self.audio[:600]), {'offset': 600})
        self.assertEqual(self.upload(500, self.audio[600:]), {'offset': 600})
        with self.assertRaises(ValueError):
            self.upload(-1, self.audio[:100])
        with self.assertRaises(ValueError):
            self.upload(len(self.audio), self.audio[:100])
        self.assertEqual(self.upload(600, self.audio[600:]), {'offset': 1200})
        self.assertEqual(self.upload(0, self.audio), {'offset': 1200})

    def test_rejects_checksum_mismatch_even_for_existing_file(self):
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.upload(0, self.audio, '0' * 64)
        self.assertEqual(self.upload(0, self.audio), {'offset': 1200})
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.upload(0, self.audio, '0' * 64)


class Cpp(unittest.TestCase):
    """yue2.cpp path, against a fake yue-server on a random port."""

    def setUp(self):
        import http.server
        import threading
        self.seen = []
        test = self

        class Fake(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, code, body, kind='application/json'):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == '/health':
                    return self.reply(200, {'status': 'ok'})
                if self.path.startswith('/job') and 'result=1' not in self.path:
                    return self.reply(200, {'status': 'done'})
                if test.seen[-1].get('transcribe'):
                    return self.reply(200, {'abc': ABC})
                replay = json.dumps({**test.seen[-1], 'abc': test.seen[-1].get('abc') or ABC, 'lm_seed': 42, 'semantic_tokens': '1,2,3,4,5'})
                body = (b'--b\r\nContent-Type: application/json\r\n\r\n' + replay.encode() + b'\r\n'
                        b'--b\r\nContent-Type: audio/wav\r\n\r\n' + b'\x00\r\n\x01' * 10 + b'\r\n--b--\r\n')
                return self.reply(200, body, 'multipart/mixed; boundary=b')

            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                if self.path == '/transcribe':
                    test.seen.append({'transcribe': True, 'melody_only': b'melody_only' in body})
                else:
                    test.seen.append(json.loads(body))
                return self.reply(200, {'id': '1'})

        self.server = http.server.HTTPServer(('127.0.0.1', 0), Fake)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.saved = (worker.CPP_PORT, worker.CPP_READY, worker.ADAPTERS, worker.start_engine, worker.ffmpeg_binary)
        self.saved_sheetsage = (os.environ.get('SHEETSAGE_PYTHON'), os.environ.get('SHEETSAGE_REPO'))
        os.environ['SHEETSAGE_REPO'] = str(Path(tempfile.mkdtemp()) / 'missing')
        root = Path(tempfile.mkdtemp())
        worker.CPP_PORT = self.server.server_address[1]
        worker.CPP_READY = root / '.ready'
        worker.CPP_READY.write_text('1')
        worker.ADAPTERS = root / 'adapters'
        (worker.ADAPTERS / 'yue2-canzone-italiana').mkdir(parents=True)
        worker.start_engine = lambda restart=False: None
        copier = root / 'ffmpeg.py'
        copier.write_text('import shutil, sys\nargs = sys.argv[1:]\nshutil.copy(args[args.index("-i") + 1], args[-1])\n')
        launcher = root / ('ffmpeg.cmd' if os.name == 'nt' else 'ffmpeg')
        launcher.write_text(f'@"{sys.executable}" "{copier}" %*\n' if os.name == 'nt' else f'#!/bin/sh\nexec "{sys.executable}" "{copier}" "$@"\n')
        launcher.chmod(0o755)
        worker.ffmpeg_binary = lambda: str(launcher)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        worker.CPP_PORT, worker.CPP_READY, worker.ADAPTERS, worker.start_engine, worker.ffmpeg_binary = self.saved
        for key, value in zip(('SHEETSAGE_PYTHON', 'SHEETSAGE_REPO'), self.saved_sheetsage):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_multipart_keeps_binary_parts(self):
        parts = worker.parse_multipart('multipart/mixed; boundary=b', b'--b\r\nContent-Type: audio/wav\r\n\r\n\x00\r\n\x01\r\n--b--\r\n')
        self.assertEqual(parts[0][1], b'\x00\r\n\x01')

    def test_plan_song_and_cover_go_through_the_engine(self):
        request = {'localId': str(uuid.uuid4()), 'style': 'ballad', 'lyrics': '[Verse]\nCiao', 'cot': 'full', 'seed': 7}
        plan = worker.plan({}, dict(request))
        self.assertEqual((plan['abc'], plan['seed'], plan['engine']), (ABC, 42, 'yue2.cpp'))
        self.assertEqual((self.seen[-1]['duration'], self.seen[-1]['steps']), (1, 1))
        song = worker.generate({}, {**request, 'abc': ABC, 'adapters': [{'name': 'yue2-canzone-italiana', 'ar': 1, 'nar': 0.5}]})
        self.assertEqual(self.seen[-1]['adapters'], [{'name': 'yue2-canzone-italiana', 'ar_scale': 1.0, 'nar_scale': 0.5}])
        self.assertEqual(song['duration'], 0.2)
        self.assertEqual([a['format'] for a in song['audio']], ['flac', 'mp3'])
        self.assertEqual(worker.recover({'localId': request['localId']})['abc'], ABC)
        self.assertTrue(song['replay']['semanticTokens'].startswith('1,2'))
        replayed = worker.generate({}, {**request, 'localId': str(uuid.uuid4()), 'abc': ABC, 'semanticTokens': '1,2,3', 'steps': 64})
        self.assertEqual((self.seen[-1]['semantic_tokens'], self.seen[-1]['steps']), ('1,2,3', 64))
        self.assertNotIn('lm_seed', self.seen[-1])
        self.assertEqual(replayed['engine'], 'yue2.cpp')
        with self.assertRaises(ValueError):
            worker.generate({}, {**request, 'localId': str(uuid.uuid4()), 'semanticTokens': '1;rm -rf'})
        cover = worker.transcribe({}, {'localId': str(uuid.uuid4()), 'audio': base64.b64encode(b'x' * 4000).decode(), 'format': 'mp3'})
        self.assertEqual(cover['abc'], ABC)
        self.assertEqual(cover['engine'], 'yue2.cpp')
        self.assertTrue(self.seen[-1]['melody_only'])

    def test_cpp_fallback_when_sheetsage_fails(self):
        repo = Path(tempfile.mkdtemp())
        (repo / 'infer.py').write_text(FAKE_INFER % (ABC, ABC_CHORDS), encoding='utf-8')
        os.environ['SHEETSAGE_PYTHON'] = sys.executable
        os.environ['SHEETSAGE_REPO'] = str(repo)
        audio = base64.b64encode(b'FAIL' + b'x' * 4000).decode()
        cover = worker.transcribe({}, {'localId': str(uuid.uuid4()), 'audio': audio, 'format': 'mp3'})
        self.assertEqual(cover['engine'], 'yue2.cpp')
        self.assertEqual(cover['abc'], ABC)
        self.assertTrue(self.seen[-1]['melody_only'])

    def test_adapters_are_checked(self):
        with self.assertRaisesRegex(ValueError, 'not installed'):
            worker.read_adapters({'adapters': [{'name': 'missing', 'ar': 1, 'nar': 1}]})
        with self.assertRaises(ValueError):
            worker.read_adapters({'adapters': [{'name': 'yue2-canzone-italiana', 'ar': 11, 'nar': 1}]})
        bad = {'id': 'x', 'files': [{'url': 'https://evil.example/a.safetensors', 'file': 'a.safetensors', 'bytes': 10}]}
        with self.assertRaises(ValueError):
            worker.install_adapters({'install': [bad]})
        unpinned = {'id': 'x', 'files': [{'url': 'https://huggingface.co/a/b/resolve/main/a.safetensors', 'file': 'a.safetensors', 'bytes': 10}]}
        with self.assertRaises(ValueError):
            worker.install_adapters({'install': [unpinned]})
        self.assertEqual(worker.install_adapters({'remove': ['yue2-canzone-italiana']})['installed'], [])


if __name__ == '__main__':
    unittest.main()
