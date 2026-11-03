"""yue2_worker.py — RunPod serverless handler that writes songs with YuE2-3B, returns their editable ABC plan and transcribes the melody of an existing song for covers.

exports: VOLUME | HOME | OUTPUT | STATE | MODEL | COT_MODES | CHUNK | SHEET | AUDIO_FORMATS | MAX_AUDIO | CPP | CPP_COMMIT | CPP_READY | CPP_PORT | ADAPTERS | TRAIN | COMPANION | TRAINED | TRAIN_COMMIT | ADAPTER_URL | (+39 more)
used_by: integrations/runpod/yue2_boot.sh, runpod-yue2.mjs (embedded in the template), yue2-backend.mjs (calls it over the RunPod HTTP API)
related: integrations/runpod/worker.py — same transfer protocol (generate / asset / recover) for the ComfyUI worker
rules:   Never run a generation twice for the same localId: a restarted job is reported as interrupted, not resubmitted. Audio leaves the worker only in verified 3 MB chunks.
         All inputs are validated here; paths are built from the job's own UUID only.
         The melody transcription (SheetSage2, its own Python environment) only reads the uploaded audio and returns text; the audio is never kept.
         yue2.cpp (when built on the volume, CPP_READY) replaces the Python pipeline for plan and generate, and backs up
         SheetSage2 for transcription. Its yue-server listens on 127.0.0.1 only, inside the worker.
agent:   claude-sonnet-5-5 | anthropic | 2026-10-11 | s_20261011_yue2 | Created from the YuE2-3B model card and the pod tests (pipe(style, lyrics, cot, seed, abc) -> save / save_artifacts).
         message: "plan() relies on plan.save(dir) writing score.abc, as save_artifacts does; confirmed only through save_artifacts so far."
         claude-opus-5-5 | anthropic | 2026-10-15 | s_20261015_cpp | yue2.cpp engine (built on the volume), LoRA installs, replay, training actions.
         Codex | openai | 2026-10-15 | Continuation from source codes; fixed trainer help for argument verification.
         Codex | openai | 2026-10-15 | Restored SheetSage2 as primary transcription engine, with yue2.cpp fallback.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

VOLUME = Path(os.environ.get('YUE2_VOLUME', '/runpod-volume'))
HOME = VOLUME / 'yue2'
OUTPUT = HOME / 'audio'
STATE = HOME / 'jobs'
MODEL = 'm-a-p/YuE2-3B'
COT_MODES = ('full', 'melody', 'off')
CHUNK = 3 * 1024 * 1024
SHEET = HOME / 'sheetsage'
AUDIO_FORMATS = ('mp3', 'wav', 'flac', 'ogg', 'm4a')
MAX_AUDIO = 12 * 1024 * 1024
_pipeline = None
CPP = HOME / 'cpp'
CPP_COMMIT = 'c8516dbf44d660cca40d3f420c67063e37ec8258'
CPP_READY = CPP / ('.ready-' + CPP_COMMIT[:7])
CPP_PORT = 8087
ADAPTERS = CPP / 'adapters'
TRAIN = HOME / 'train'
COMPANION = TRAIN / 'models' / 'nar_lora_joint_v9.safetensors'
TRAINED = re.compile(r'^mine-[a-z0-9-]{1,58}$')
TRAIN_COMMIT = '91e92a8aeeac5e800c8810e7b2e7fafbebaca3fc'
ADAPTER_URL = re.compile(r'^https://huggingface\.co/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/resolve/[0-9a-f]{40}/[A-Za-z0-9_./-]+\.safetensors$')
ADAPTER_ID = re.compile(r'^[a-z0-9-]{1,64}$')
_engine = None


def write_json(file, data):
    """Rules: Persist state atomically so a crash never leaves a half-written receipt."""
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(data), encoding='utf-8')
    temp.replace(file)


def get_pipeline():
    """Rules: Load the model once per worker; weights come from the Hugging Face cache kept on the volume."""
    global _pipeline
    if _pipeline is None:
        from yue2 import YuE2Pipeline
        _pipeline = YuE2Pipeline.from_pretrained(MODEL, device='cuda')
    return _pipeline


def validate(data, need_lyrics=True):
    """Rules: Reject anything outside the documented ranges; the returned values are the only ones the pipeline sees."""
    local_id = str(uuid.UUID(str(data.get('localId', ''))))
    style, lyrics = data.get('style'), data.get('lyrics', '')
    if not isinstance(style, str) or not 1 <= len(style.strip()) <= 3000:
        raise ValueError('Style must be 1-3000 characters.')
    if not isinstance(lyrics, str) or len(lyrics) > 12000 or (need_lyrics and not lyrics.strip()):
        raise ValueError('Lyrics are required (up to 12000 characters).')
    cot = data.get('cot', 'full')
    if cot not in COT_MODES:
        raise ValueError('cot must be full, melody or off.')
    seed = data.get('seed', -1)
    if not isinstance(seed, int) or isinstance(seed, bool) or not -1 <= seed <= 2 ** 31 - 1:
        raise ValueError('Invalid seed.')
    if seed == -1:
        seed = int.from_bytes(os.urandom(4), 'little') & 0x7FFFFFFF
    request = {'style': style.strip(), 'lyrics': lyrics.strip(), 'cot': cot, 'seed': seed}
    abc = data.get('abc')
    if abc is not None:
        if not isinstance(abc, str) or not 20 <= len(abc) <= 60000 or not re.search(r'^K:', abc, re.M):
            raise ValueError('The ABC score must be text with a K: key line (up to 60000 characters).')
        request['abc'] = abc
    tokens = data.get('semanticTokens')
    source_tokens = data.get('sourceTokens')
    if tokens is not None and source_tokens is not None:
        raise ValueError('Exact replay and continuation cannot be combined.')
    if source_tokens is not None:
        if not isinstance(source_tokens, str) or not re.fullmatch(r'[0-9]+(,[0-9]+)*', source_tokens) or len(source_tokens) > 400000:
            raise ValueError('Invalid source tokens.')
        start, end = data.get('sourceStart'), data.get('sourceEnd')
        available = (source_tokens.count(',') + 1) / 25
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= available for value in (start, end)) \
                or end - start < 2:
            raise ValueError('Invalid source section.')
        duration = data.get('duration')
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not end - start + 10 <= duration <= 360:
            raise ValueError('Invalid continuation duration.')
        request.update(source_tokens=source_tokens, source_start=float(start), source_end=float(end), duration=float(duration))
    if tokens is not None:
        # Rules: an exact replay: the saved semantic codes are rendered again, only with yue2.cpp
        if not isinstance(tokens, str) or not re.match(r'^[0-9]+(,[0-9]+)*$', tokens) or len(tokens) > 400000:
            raise ValueError('Invalid semantic tokens.')
        steps = data.get('steps', 32)
        if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= 128:
            raise ValueError('steps must be between 1 and 128.')
        request['semantic_tokens'] = tokens
        request['steps'] = steps
    cfg = data.get('cfgScale')
    if cfg is not None:
        if isinstance(cfg, bool) or not isinstance(cfg, (int, float)) or not 1 <= cfg <= 3:
            raise ValueError('cfgScale must be between 1 and 3.')
        request['cfg_scale'] = float(cfg)
    return local_id, request


def ffmpeg_binary():
    """Rules: Prefer a system ffmpeg; otherwise the static binary shipped by imageio-ffmpeg in the worker environment."""
    found = shutil.which('ffmpeg')
    if found:
        return found
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def describe(file):
    """Rules: Size and SHA-256 of a finished file, the numbers the app verifies after every transfer."""
    digest = hashlib.sha256()
    with file.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return {'format': file.suffix[1:], 'bytes': file.stat().st_size, 'sha256': digest.hexdigest()}


def read_score(folder):
    """Rules: The ABC plan is the file score.abc that the pipeline saves; an empty or missing score is an error."""
    score = Path(folder) / 'score.abc'
    if not score.is_file():
        raise RuntimeError('The pipeline did not produce a score.abc plan.')
    text = score.read_text(encoding='utf-8')
    if not text.strip():
        raise RuntimeError('The ABC plan is empty.')
    return text


def progress(job, message):
    """Rules: Progress is best effort; a failure to report must never fail the song."""
    try:
        import runpod
        runpod.serverless.progress_update(job, message)
    except Exception:
        pass


def generate(job, data):
    """Rules: One generation per localId. A finished job is returned again; an unfinished one is never restarted."""
    local_id, request = validate(data)
    adapters = read_adapters(data)
    receipt = STATE / (local_id + '.json')
    if receipt.exists():
        saved = json.loads(receipt.read_text())
        if saved.get('phase') == 'done':
            return saved['result']
        raise RuntimeError('This job was interrupted earlier and is not resubmitted automatically.')
    write_json(receipt, {'phase': 'running', 'startedAt': time.time()})
    out = OUTPUT / local_id
    out.mkdir(parents=True, exist_ok=True)
    try:
        if ('semantic_tokens' in request or 'source_tokens' in request) and not cpp_ready():
            raise RuntimeError('A replay or continuation needs yue2.cpp on this volume.')
        if cpp_ready():
            result = generate_cpp(job, local_id, request, adapters, out, read_harmony(data))
            write_json(receipt, {'phase': 'done', 'result': result})
            return result
        progress(job, 'Loading YuE2')
        pipe = get_pipeline()
        progress(job, 'Writing the song')
        started = time.time()
        song = pipe(**request)
        seconds = round(time.time() - started, 1)
        flac, mp3 = out / 'track.flac', out / 'track.mp3'
        song.save(str(flac))
        with tempfile.TemporaryDirectory() as scratch:
            song.save_artifacts(scratch)
            abc = read_score(scratch)
        progress(job, 'Encoding MP3')
        subprocess.run([ffmpeg_binary(), '-y', '-v', 'error', '-i', str(flac), '-b:a', '192k', str(mp3)],
                       check=True, timeout=300)
        result = {'localId': local_id, 'audio': [describe(flac), describe(mp3)], 'abc': abc,
                  'seed': request['seed'], 'cot': request['cot'], 'seconds': seconds}
        try:
            import soundfile
            result['duration'] = round(soundfile.info(str(flac)).duration, 2)
        except Exception:
            pass
        write_json(receipt, {'phase': 'done', 'result': result})
        return result
    except BaseException as error:
        write_json(receipt, {'phase': 'failed', 'error': str(error)[:400]})
        shutil.rmtree(out, ignore_errors=True)
        raise


def plan(job, data):
    """Rules: Only the ABC plan (melody and chords) is produced; no audio is rendered and nothing is kept on the volume."""
    local_id, request = validate(data)
    request.pop('abc', None)
    adapters = read_adapters(data)
    if cpp_ready():
        started = time.time()
        start_engine()
        content_type, answer = engine_job('/synth', cpp_request(request, adapters, plan_only=True, harmony=read_harmony(data)),
                                          job=job, label='Writing the melody and chords')
        replay = next(json.loads(p) for h, p in parse_multipart(content_type, answer) if h.get('content-type', '').startswith('application/json'))
        if not (replay.get('abc') or '').strip():
            raise RuntimeError('yue2.cpp wrote no plan.')
        return {'localId': local_id, 'abc': replay['abc'], 'seed': replay.get('lm_seed', request['seed']), 'cot': request['cot'],
                'seconds': round(time.time() - started, 1), 'engine': 'yue2.cpp'}
    progress(job, 'Loading YuE2')
    pipe = get_pipeline()
    progress(job, 'Writing the melody and chords')
    started = time.time()
    drafted = pipe.plan(**request)
    with tempfile.TemporaryDirectory() as scratch:
        drafted.save(scratch)
        abc = read_score(scratch)
    return {'localId': local_id, 'abc': abc, 'seed': request['seed'], 'cot': request['cot'],
            'seconds': round(time.time() - started, 1)}


def train_ready():
    """Rules: The LoRA trainer is used only after its build script finished (marker file)."""
    return (TRAIN / ('.ready-' + TRAIN_COMMIT[:7])).is_file()


def engine_log_tail(lines=40):
    """The last lines of the engine's log (the reason a job failed is printed there, not in the job status)."""
    try:
        text = (CPP / 'engine.log').read_bytes()[-20000:].decode('utf-8', 'replace')
    except OSError:
        return ''
    return ' | '.join(line.strip() for line in text.splitlines()[-lines:] if line.strip())[-1500:]


def disk():
    """Read-only: free space on the volume and the size of its top folders (and of yue2's), to decide what can be cleaned."""
    usage = shutil.disk_usage(str(VOLUME))
    sizes = {}
    for folder in [p for p in VOLUME.iterdir() if p.is_dir()] + [p for p in HOME.iterdir() if p.is_dir()]:
        done = subprocess.run(['du', '-sb', str(folder)], capture_output=True, text=True, timeout=600)
        if done.returncode == 0 and done.stdout.split():
            sizes[str(folder)] = int(done.stdout.split()[0])
    return {'freeGB': round(usage.free / 1e9, 2), 'totalGB': round(usage.total / 1e9, 1),
            'folders': {k: round(v / 1e9, 2) for k, v in sorted(sizes.items(), key=lambda kv: -kv[1])}}


def train_help():
    """Read-only help for the exact five subcommands in the training recipe; no caller-supplied command or arguments."""
    if not train_ready():
        raise RuntimeError('The trainer is not installed on this volume yet.')
    binary = str(TRAIN / 'bin' / 'ace-train')
    environment = {**os.environ, 'LD_LIBRARY_PATH': str(TRAIN / 'bin') + os.pathsep + os.environ.get('LD_LIBRARY_PATH', '')}
    commands = ('yue2-preprocess', 'yue2-tokenize', 'yue2-sheet', 'yue2-prepare-aitk', 'yue2-joint-train')
    help_text = {}
    for command in commands:
        result = subprocess.run([binary, command, '--help'], capture_output=True, text=True,
                                env=environment, timeout=30)
        help_text[command] = {'exit': result.returncode, 'text': (result.stdout + result.stderr)[:12000]}
    return help_text


def cpp_ready():
    """Rules: yue2.cpp is used only when the CPU pod finished building it and downloading its models (marker file)."""
    return CPP_READY.is_file()


def engine_url(route):
    return f'http://127.0.0.1:{CPP_PORT}{route}'


def engine_alive():
    import urllib.request
    try:
        with urllib.request.urlopen(engine_url('/health'), timeout=2) as answer:
            return answer.status == 200
    except Exception:
        return False


def start_engine(restart=False):
    """Rules: One yue-server per worker, models kept loaded between jobs (the worker GPUs have the memory); restarted only to
    read a newly installed LoRA, never while a job is running (the handler serves one job at a time)."""
    global _engine
    if restart and _engine is not None:
        _engine.terminate()
        try:
            _engine.wait(timeout=30)
        except Exception:
            _engine.kill()
        _engine = None
    if _engine is not None and _engine.poll() is None and engine_alive():
        return
    ADAPTERS.mkdir(parents=True, exist_ok=True)
    models = CPP / 'models'
    command = [str(CPP / 'bin' / 'yue-server'), '--model', str(models / 'YuE2-3B-Q8_0.gguf'), '--vae', str(models / 'YuE2-Vae-F32.gguf'),
               '--transcriber', str(models / 'SheetSage2-Q8_0.gguf'), '--adapters', str(ADAPTERS),
               '--host', '127.0.0.1', '--port', str(CPP_PORT), '--keep-loaded']
    if COMPANION.is_file():
        # the decoder companion a trained LoRA was trained over; each request says how much of it to merge (companion_scale)
        command += ['--companion', str(COMPANION)]
    log = open(CPP / 'engine.log', 'ab')
    _engine = subprocess.Popen(command, stdout=log, stderr=log, cwd=str(CPP / 'bin'),
                               env={**os.environ, 'LD_LIBRARY_PATH': str(CPP / 'bin') + os.pathsep + os.environ.get('LD_LIBRARY_PATH', '')})
    for _ in range(240):
        if engine_alive():
            return
        if _engine.poll() is not None:
            break
        time.sleep(0.5)
    tail = (CPP / 'engine.log').read_bytes()[-400:].decode('utf-8', 'replace')
    raise RuntimeError('yue2.cpp did not start: ' + tail)


def engine_json(route, body=None, content_type='application/json', timeout=60):
    import urllib.request
    import urllib.error
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    request = urllib.request.Request(engine_url(route), data=data, method='POST' if data is not None else 'GET',
                                     headers={'Content-Type': content_type} if data is not None else {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return answer.headers.get('Content-Type', ''), answer.read()
    except urllib.error.HTTPError as error:
        raise RuntimeError('yue2.cpp: ' + error.read().decode('utf-8', 'replace')[:300])


def parse_multipart(content_type, body):
    """Rules: The engine answers a song as multipart/mixed: a JSON replay request, the audio and the latents, in this order."""
    found = re.search(r'boundary="?([^";]+)"?', content_type)
    if not found:
        raise RuntimeError('yue2.cpp answered without a multipart boundary.')
    marker = b'--' + found.group(1).encode()
    parts = []
    for chunk in body.split(marker)[1:]:
        if chunk.startswith(b'--'):
            break
        chunk = chunk[2:] if chunk.startswith(b'\r\n') else chunk
        chunk = chunk[:-2] if chunk.endswith(b'\r\n') else chunk
        head, _, payload = chunk.partition(b'\r\n\r\n')
        headers = {}
        for line in head.decode('utf-8', 'replace').split('\r\n'):
            if ':' in line:
                key, value = line.split(':', 1)
                headers[key.strip().lower()] = value.strip()
        parts.append((headers, payload))
    return parts


def engine_job(route, body, content_type='application/json', job=None, label='Working'):
    """Submit to yue-server and wait for the result (content type, bytes)."""
    _, answer = engine_json(route, body, content_type)
    engine_id = json.loads(answer)['id']
    while True:
        _, state = engine_json(f'/job?id={engine_id}')
        status = json.loads(state).get('status')
        if status == 'done':
            return engine_json(f'/job?id={engine_id}&result=1', timeout=300)
        if status in ('failed', 'cancelled'):
            raise RuntimeError('yue2.cpp ' + status + ': ' + (json.loads(state).get('error') or engine_log_tail(6)))
        if job is not None:
            progress(job, label)
        time.sleep(1)


def read_harmony(data):
    """Rules: Chord variety and section order for the plan (yue2.cpp `harmony`), only the documented keys and ranges."""
    harmony = data.get('harmony')
    if harmony is None:
        return None
    if not isinstance(harmony, dict) or set(harmony) - {'identity', 'strength', 'outside_bonus', 'section_strength', 'follow'}:
        raise ValueError('Invalid harmony.')
    for key, top in (('strength', 64), ('outside_bonus', 20), ('section_strength', 64)):
        value = harmony.get(key, 0)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= top:
            raise ValueError('Invalid harmony ' + key + '.')
    if harmony.get('identity') not in (None, 'root', 'spelling'):
        raise ValueError('Invalid harmony identity.')
    follow = harmony.get('follow')
    if follow is not None and (not isinstance(follow, list) or not 1 <= len(follow) <= 64
                               or not all(isinstance(x, str) and re.match(r'^[a-z -]{1,40}$', x) for x in follow)):
        raise ValueError('Invalid harmony sections.')
    return harmony


def cpp_request(request, adapters, plan_only=False, harmony=None):
    if request.get('semantic_tokens') and not plan_only:
        body = {'style': request['style'], 'lyrics': request['lyrics'], 'cot': request['cot'], 'semantic_tokens': request['semantic_tokens'],
                'seed': request['seed'], 'steps': request.get('steps', 32), 'output_format': 'wav24'}
        if 'abc' in request:
            body['abc'] = request['abc']
        if adapters:
            body['adapters'] = [{'name': a['name'], 'ar_scale': a['ar'], 'nar_scale': a['nar']} for a in adapters]
        if COMPANION.is_file():
            body['companion_scale'] = 1.0 if any(TRAINED.match(a['name']) for a in adapters or []) else 0.0
        return body
    body = {'style': request['style'], 'lyrics': request['lyrics'], 'cot': request['cot'],
            'lm_seed': request['seed'], 'seed': request['seed'], 'output_format': 'wav16' if plan_only else 'wav24'}
    if plan_only:
        body.update(duration=1, steps=1)
    else:
        body['duration'] = request.get('duration', 360)
        if 'abc' in request:
            body['abc'] = request['abc']
        if 'source_tokens' in request:
            body.update(source_tokens=request['source_tokens'], source_start=request['source_start'], source_end=request['source_end'])
    if 'cfg_scale' in request:
        body['cfg_scale'] = request['cfg_scale']
    if adapters:
        body['adapters'] = [{'name': a['name'], 'ar_scale': a['ar'], 'nar_scale': a['nar']} for a in adapters]
    if COMPANION.is_file():
        # Rules: the companion is merged only under a LoRA trained here (sounds as trained), never under a catalogue one
        body['companion_scale'] = 1.0 if any(TRAINED.match(a['name']) for a in adapters or []) else 0.0
    if harmony and 'abc' not in body:
        body['harmony'] = harmony
    return body


def read_adapters(data):
    """Rules: LoRA are named by their folder under ADAPTERS, installed beforehand with the `adapters` action; at most 4, strengths -10..10."""
    adapters = data.get('adapters') or []
    if not isinstance(adapters, list) or len(adapters) > 4:
        raise ValueError('At most 4 adapters.')
    checked = []
    for a in adapters:
        name, ar, nar = (a or {}).get('name'), (a or {}).get('ar', 0), (a or {}).get('nar', 0)
        if not isinstance(name, str) or not ADAPTER_ID.match(name) or not (ADAPTERS / name).is_dir():
            raise ValueError('Adapter not installed on this volume: ' + str(name))
        for value in (ar, nar):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not -10 <= value <= 10:
                raise ValueError('Adapter strength must be between -10 and 10.')
        checked.append({'name': name, 'ar': float(ar), 'nar': float(nar)})
    if checked and not cpp_ready():
        raise RuntimeError('LoRA need yue2.cpp, which is not installed on this volume yet.')
    return checked


def generate_cpp(job, local_id, request, adapters, out, harmony=None):
    started = time.time()
    progress(job, 'Starting yue2.cpp')
    start_engine()
    content_type, answer = engine_job('/synth', cpp_request(request, adapters, harmony=harmony), job=job, label='Writing the song')
    parts = parse_multipart(content_type, answer)
    replay = next(json.loads(p) for h, p in parts if h.get('content-type', '').startswith('application/json'))
    audio = next(p for h, p in parts if h.get('content-type', '').startswith('audio/'))
    wav, flac, mp3 = out / 'track.wav', out / 'track.flac', out / 'track.mp3'
    wav.write_bytes(audio)
    progress(job, 'Encoding')
    subprocess.run([ffmpeg_binary(), '-y', '-v', 'error', '-i', str(wav), str(flac)], check=True, timeout=300)
    subprocess.run([ffmpeg_binary(), '-y', '-v', 'error', '-i', str(wav), '-b:a', '192k', str(mp3)], check=True, timeout=300)
    wav.unlink()
    frames = len([t for t in str(replay.get('semantic_tokens', '')).split(',') if t])
    result = {'localId': local_id, 'audio': [describe(flac), describe(mp3)], 'abc': replay.get('abc') or '',
              'seed': replay.get('lm_seed', request['seed']), 'cot': request['cot'], 'seconds': round(time.time() - started, 1),
              'engine': 'yue2.cpp'}
    if frames:
        result['duration'] = round(frames / 25, 2)
    result['replay'] = {'semanticTokens': replay.get('semantic_tokens', ''), 'abc': replay.get('abc', ''), 'cot': replay.get('cot'),
                        'lmSeed': replay.get('lm_seed'), 'seed': replay.get('seed'), 'steps': replay.get('steps')}
    return result


def install_adapters(data):
    """Rules: Only files from a Hugging Face commit-pinned URL, written as <id>/<file>.part, checked by size, then renamed;
    the engine is restarted afterwards so it reads them. `remove` deletes a folder. Returns what is installed."""
    import urllib.request
    changed = False
    ADAPTERS.mkdir(parents=True, exist_ok=True)
    for item in data.get('install') or []:
        adapter_id, files = item.get('id'), item.get('files')
        if not isinstance(adapter_id, str) or not ADAPTER_ID.match(adapter_id) or not isinstance(files, list) or not 1 <= len(files) <= 4:
            raise ValueError('Invalid adapter to install.')
        folder = ADAPTERS / adapter_id
        folder.mkdir(parents=True, exist_ok=True)
        for f in files:
            url, name, size = f.get('url'), f.get('file'), f.get('bytes')
            if not isinstance(url, str) or not ADAPTER_URL.match(url) or not isinstance(name, str) \
                    or not re.match(r'^[A-Za-z0-9_.-]{1,120}\.safetensors$', name) or not isinstance(size, int) or not 0 < size <= 2 * 1024 ** 3:
                raise ValueError('Invalid adapter file.')
            target = folder / name
            if target.is_file() and target.stat().st_size == size:
                continue
            partial = target.with_suffix('.part')
            with urllib.request.urlopen(url, timeout=120) as source, partial.open('wb') as sink:
                shutil.copyfileobj(source, sink, 8 * 1024 * 1024)
            if partial.stat().st_size != size:
                partial.unlink()
                raise RuntimeError('Adapter download has the wrong size: ' + name)
            partial.replace(target)
            changed = True
    for adapter_id in data.get('remove') or []:
        if not isinstance(adapter_id, str) or not ADAPTER_ID.match(adapter_id):
            raise ValueError('Invalid adapter to remove.')
        if (ADAPTERS / adapter_id).is_dir():
            shutil.rmtree(ADAPTERS / adapter_id)
            changed = True
    if changed and cpp_ready() and _engine is not None:
        start_engine(restart=True)
    installed = sorted(d.name for d in ADAPTERS.iterdir() if d.is_dir() and any(d.glob('*.safetensors'))) if ADAPTERS.exists() else []
    return {'installed': installed, 'cpp': cpp_ready()}


def build_cpp(script_name='/yue2_cpp_build.sh', folder=None):
    """Rules: Runs an embedded build script once (pinned sources); the log stays on the volume and its tail comes back."""
    folder = folder or CPP
    script = Path(script_name)
    if not script.is_file() or script.stat().st_size == 0:
        raise RuntimeError('The build script is not part of this worker.')
    folder.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with (folder / 'build.log').open('wb') as log:
        done = subprocess.run(['bash', '-x', str(script)], stdout=log, stderr=subprocess.STDOUT, timeout=3500)
    tail = (folder / 'build.log').read_bytes()[-3000:].decode('utf-8', 'replace')
    return {'exit': done.returncode, 'ready': cpp_ready() if folder == CPP else train_ready(), 'seconds': round(time.time() - started), 'log': tail}


def train_upload(data):
    """Rules: One song of a training set, in chunks of at most 6 MB, written as .part and kept only when size and SHA-256 match."""
    project = str(uuid.UUID(str(data.get('projectId', ''))))
    track = str(uuid.UUID(str(data.get('trackId', ''))))
    ext, total, offset = data.get('ext'), data.get('total'), data.get('offset')
    if ext not in ('.wav', '.mp3', '.flac', '.ogg', '.m4a') or not isinstance(total, int) or not 1000 <= total <= 100 * 1024 ** 2:
        raise ValueError('Invalid training song.')
    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset < total or not re.match(r'^[0-9a-f]{64}$', str(data.get('sha256', ''))):
        raise ValueError('Invalid upload offset.')
    chunk = base64.b64decode(data.get('base64', ''), validate=True)
    if not chunk or len(chunk) > 6 * 1024 * 1024 or offset + len(chunk) > total:
        raise ValueError('Invalid upload chunk.')
    folder = TRAIN / 'datasets' / project
    folder.mkdir(parents=True, exist_ok=True)
    target, partial = folder / (track + ext), folder / (track + ext + '.part')
    if target.is_file() and target.stat().st_size == total:
        if hashlib.sha256(target.read_bytes()).hexdigest() == data['sha256']:
            return {'offset': total}
        raise ValueError('The uploaded song does not match its checksum.')
    size = partial.stat().st_size if partial.exists() else 0
    if offset != size:
        if offset == 0:
            partial.unlink(missing_ok=True)
        else:
            return {'offset': size}
    with partial.open('ab') as sink:
        sink.write(chunk)
    if partial.stat().st_size == total:
        digest = hashlib.sha256(partial.read_bytes()).hexdigest()
        if digest != data['sha256']:
            partial.unlink()
            raise ValueError('The uploaded song does not match its checksum.')
        partial.replace(target)
        return {'offset': total}
    return {'offset': partial.stat().st_size}


TRAIN_PRESETS = {'fast': (100, 4, 10), 'balanced': (200, 4, 20), 'thorough': (300, 8, 30)}


def train(job, data):
    """Rules: HOT-Step's base-matched recipe (as YuE2-Studio runs it): latents, codes, scores, dataset, then the joint LoKr training.
    The engine is stopped first (it holds the GPU); the latest checkpoint becomes the adapter `mine-...` in ADAPTERS. A run is never resumed
    by a retried job: its folder is new each time."""
    global _engine
    project = str(uuid.UUID(str(data.get('projectId', ''))))
    adapter_id, trigger, preset = data.get('adapterId'), data.get('trigger', ''), data.get('preset', 'fast')
    if not isinstance(adapter_id, str) or not TRAINED.match(adapter_id):
        raise ValueError('Invalid adapter name.')
    if not isinstance(trigger, str) or not re.match(r'^[a-z0-9]{0,24}$', trigger) or preset not in TRAIN_PRESETS:
        raise ValueError('Invalid trigger word or preset.')
    tracks = data.get('tracks')
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= 40:
        raise ValueError('Between 1 and 40 songs.')
    if not train_ready() or not cpp_ready():
        raise RuntimeError('The trainer or yue2.cpp is not installed on this volume yet.')
    # Rules: a run writes caches and up to ten checkpoints; never start one that could fill the shared volume
    if shutil.disk_usage(str(VOLUME)).free < 6 * 1024 ** 3:
        raise RuntimeError('Less than 6 GB free on the RunPod volume: free some space before training.')
    models = TRAIN / 'models'
    run = TRAIN / 'runs' / project / str(uuid.uuid4())
    audio = run / 'audio'
    audio.mkdir(parents=True)
    for t in tracks:
        track = str(uuid.UUID(str(t.get('id', ''))))
        ext = t.get('ext')
        caption, lyrics, instrumental = t.get('caption', ''), t.get('lyrics', ''), bool(t.get('instrumental'))
        if ext not in ('.wav', '.mp3', '.flac', '.ogg', '.m4a') or not isinstance(caption, str) or not 3 <= len(caption) <= 3000 \
                or not isinstance(lyrics, str) or len(lyrics) > 12000:
            raise ValueError('Invalid training song.')
        source = TRAIN / 'datasets' / project / (track + ext)
        if not source.is_file():
            raise RuntimeError('A song of the training set was not uploaded.')
        subprocess.run([ffmpeg_binary(), '-y', '-v', 'error', '-i', str(source), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
                        str(audio / (track + '.wav'))], check=True, timeout=600)
        style = ' '.join(caption.split())
        (audio / (track + '.txt')).write_text(f'caption: {style}\nis_instrumental: {str(instrumental).lower()}\nlyrics:\n{lyrics.strip()}\n', encoding='utf-8')
        (audio / (track + '.yue2.txt')).write_text(style + '\n', encoding='utf-8')
    if _engine is not None:
        _engine.terminate()
        try:
            _engine.wait(timeout=30)
        except Exception:
            _engine.kill()
        _engine = None
    steps, accum, every = TRAIN_PRESETS[preset]
    cache, prepared, output = run / 'cache', run / 'prepared', run / 'output'
    manifest = cache / 'yue2_preprocess.json'
    convrot = models / 'yue2_3b_int8_convrot.safetensors'
    prepare = ['yue2-prepare-aitk', '--legacy-manifest', manifest, '--checkpoint', convrot, '--tokenizer', CPP / 'models' / 'YuE2-3B-Q8_0.gguf',
               '--output', prepared, '--model', 'vae=' + str(models / 'yue2-vae-standard-f32.gguf'),
               '--model', 'semantic=' + str(models / 'yue2-tok-f16.gguf'), '--model', 'sheetsage=' + str(models / 'sheetsage2-f16.gguf'),
               '--lyric-timing', '0'] + (['--trigger', trigger] if trigger else [])
    stages = [
        ('latents', ['yue2-preprocess', '--audio', audio, '--out', cache, '--models', models, '--vae', 'standard', '--caption-mode', 'yue2',
                     '--loudness-lufs', '0']),
        ('codes', ['yue2-tokenize', '--manifest', manifest, '--models', models]),
        ('scores', ['yue2-sheet', '--manifest', manifest, '--models', models]),
        ('prepare', prepare),
        ('train', ['yue2-joint-train', '--checkpoint', convrot, '--companion', COMPANION, '--dataset', prepared / 'dataset.json',
                   '--output', output, '--steps', str(steps), '--save-every', str(every), '--seed', '42', '--device', 'CUDA0',
                   '--rank', '64', '--alpha', '256', '--adapter-type', 'lokr', '--lokr-dim', '128', '--lokr-factor', '4',
                   '--optimizer', 'adamw-lm', '--lr', '1e-4', '--weight-decay', '0.1', '--beta1', '0.9', '--beta2', '0.95',
                   '--kl-weight', '0', '--caption-dropout', '0', '--abc-dropout', '0.5', '--planner-lr-scale', '1',
                   '--lr-schedule', 'cosine-floor', '--lr-floor', '0.1', '--ar-loss-weight', '0.25', '--ar-targets', 'base',
                   '--nar-crop-frames', '1500', '--text-dropout', '0.1', '--lyric-dropout', '0.1', '--both-dropout', '0.1',
                   '--cursor-weight', '0', '--warmup', str(max(1, round(steps * 0.03))), '--grad-accum', str(accum)]),
    ]
    started = time.time()
    environment = {**os.environ, 'LD_LIBRARY_PATH': str(TRAIN / 'bin') + os.pathsep + os.environ.get('LD_LIBRARY_PATH', '')}
    losses = []
    for name, args in stages:
        progress(job, f'Training: {name}')
        with (run / f'{name}.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen([str(TRAIN / 'bin' / 'ace-train')] + [str(a) for a in args], stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, env=environment, cwd=str(run))
            for line in process.stdout:
                log.write(line)
                if name == 'train' and line.lstrip().startswith('{'):
                    try:
                        value = json.loads(line)
                    except ValueError:
                        continue
                    if value.get('stage') == 'joint' and isinstance(value.get('step'), int):
                        loss = value.get('ar_ce', 0) + 0.2 * value.get('ar_kl', 0) + value.get('nar_mse', 0)
                        losses.append(round(loss, 4))
                        progress(job, f'Training {value["step"]}/{steps} · loss {loss:.3f}')
            code = process.wait()
        if code != 0:
            tail = (run / f'{name}.log').read_text(encoding='utf-8', errors='replace')[-600:]
            raise RuntimeError(f'Training stage {name} failed: {tail}')
    checkpoints = sorted((int(d.name.removeprefix('checkpoint-step')), d) for d in output.glob('checkpoint-step*')
                         if (d / 'native-ar.safetensors').is_file() and (d / 'native-nar.safetensors').is_file())
    if not checkpoints:
        raise RuntimeError('The training wrote no checkpoint.')
    step, latest = checkpoints[-1]
    target = ADAPTERS / adapter_id
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    for file in ('native-ar.safetensors', 'native-nar.safetensors'):
        shutil.copy2(latest / file, target / file)
    write_json(target / 'adapter.json', {'trigger': trigger, 'trained': True, 'step': step, 'preset': preset, 'run': str(run)})
    return {'adapterId': adapter_id, 'step': step, 'checkpoints': [c for c, _ in checkpoints], 'losses': losses[-200:],
            'seconds': round(time.time() - started), 'trigger': trigger}


def sheetsage_paths():
    """Rules: SheetSage2 lives in its own environment next to the YuE2 one; both paths can be overridden for a PC."""
    python = os.environ.get('SHEETSAGE_PYTHON') or str(SHEET / 'venv' / 'bin' / 'python')
    repo = Path(os.environ.get('SHEETSAGE_REPO') or SHEET / 'repo')
    return python, repo


def with_ffmpeg(environment, folder):
    """Rules: SheetSage2 reads audio through an `ffmpeg` command and the worker image has none: link the static binary the worker
    already uses under that name, only for this subprocess. Without any ffmpeg the environment is returned unchanged."""
    if shutil.which('ffmpeg', path=environment.get('PATH')):
        return environment
    try:
        binary = ffmpeg_binary()
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'ffmpeg').symlink_to(binary)
    except Exception:
        return environment
    return {**environment, 'PATH': str(folder) + os.pathsep + environment.get('PATH', '')}


def transcribe(job, data):
    """Rules: Melody only unless `chords` is true (YuE2 recommends melody-only for covers; with chords the plan can be sung with cot=full).
    The audio is written to a temporary folder that is always removed."""
    local_id = str(uuid.UUID(str(data.get('localId', ''))))
    fmt = data.get('format', 'mp3')
    raw = data.get('audio')
    if fmt not in AUDIO_FORMATS or not isinstance(raw, str) or len(raw) > MAX_AUDIO * 4 // 3 + 16:
        raise ValueError('Send the song as mp3, wav, flac, ogg or m4a, base64-encoded (up to 12 MB).')
    try:
        audio = base64.b64decode(raw, validate=True)
    except Exception:
        raise ValueError('The audio is not valid base64.')
    if not 1024 <= len(audio) <= MAX_AUDIO:
        raise ValueError('The audio must be between 1 KB and 12 MB.')
    chords = data.get('chords', False)
    if not isinstance(chords, bool):
        raise ValueError('chords must be true or false.')
    started = time.time()
    python, repo = sheetsage_paths()
    sheetsage_error = RuntimeError('SheetSage2 is not installed on this worker yet.')
    if (repo / 'infer.py').is_file():
        try:
            progress(job, 'Transcribing the melody with SheetSage2')
            with tempfile.TemporaryDirectory() as scratch:
                source = Path(scratch) / ('cover.' + fmt)
                source.write_bytes(audio)
                out = Path(scratch) / 'score'
                command = [python, '-u', str(repo / 'infer.py'), str(source), '--output', str(out),
                           '--dtype', os.environ.get('SHEETSAGE_DTYPE', 'bf16')]
                if not chords:
                    command.append('--melody-only')
                environment = with_ffmpeg({**os.environ, 'HF_HOME': os.environ.get('HF_HOME') or str(HOME / 'hf')}, Path(scratch) / 'bin')
                done = subprocess.run(command, capture_output=True, text=True, timeout=1500, cwd=str(repo), env=environment)
                if done.returncode != 0:
                    raise RuntimeError('SheetSage2 failed: ' + (done.stderr or done.stdout or 'no message')[-300:].strip())
                abc = read_score(out)
            return {'localId': local_id, 'abc': abc, 'chords': chords,
                    'seconds': round(time.time() - started, 1), 'engine': 'SheetSage2'}
        except Exception as error:
            sheetsage_error = error
    if not cpp_ready():
        raise sheetsage_error
    progress(job, 'SheetSage2 unavailable; transcribing with yue2.cpp')
    start_engine()
    boundary = 'sonora' + uuid.uuid4().hex
    form = (f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="song.{fmt}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n').encode() + audio + b'\r\n'
    if not chords:
        form += f'--{boundary}\r\nContent-Disposition: form-data; name="melody_only"\r\n\r\n1\r\n'.encode()
    form += f'--{boundary}--\r\n'.encode()
    _, answer = engine_job('/transcribe', form, 'multipart/form-data; boundary=' + boundary, job=job, label='Transcribing the melody')
    abc = json.loads(answer).get('abc') or ''
    if not abc.strip():
        raise RuntimeError('yue2.cpp transcribed nothing.')
    return {'localId': local_id, 'abc': abc, 'chords': chords,
            'seconds': round(time.time() - started, 1), 'engine': 'yue2.cpp'}


def asset(data):
    """Rules: Serve a chunk of a finished track only for the job's own folder and only inside the file."""
    local_id = str(uuid.UUID(str(data['localId'])))
    ext, offset = data.get('format'), data.get('offset', 0)
    if ext not in ('mp3', 'flac') or not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError('Invalid asset request.')
    receipt = STATE / (local_id + '.json')
    if not receipt.exists() or json.loads(receipt.read_text()).get('phase') != 'done':
        raise ValueError('Asset not ready.')
    file = (OUTPUT / local_id / f'track.{ext}').resolve()
    if not file.is_relative_to((OUTPUT / local_id).resolve()) or not file.is_file() or offset >= file.stat().st_size:
        raise ValueError('Invalid asset offset or path.')
    with file.open('rb') as source:
        source.seek(offset)
        raw = source.read(CHUNK)
    return {'localId': local_id, 'format': ext, 'offset': offset, 'bytes': len(raw),
            'base64': base64.b64encode(raw).decode('ascii')}


def recover(data):
    """Rules: Read-only: report a finished job, or that it is missing or still pending; never generate."""
    local_id = str(uuid.UUID(str(data['localId'])))
    receipt = STATE / (local_id + '.json')
    if not receipt.exists():
        return {'missing': True}
    saved = json.loads(receipt.read_text())
    if saved.get('phase') == 'done':
        return saved['result']
    return {'pending': True} if saved.get('phase') == 'running' else {'missing': True}


def health():
    """Rules: Report what is needed to judge readiness without loading the model."""
    info = {'worker': 'yue2', 'model': MODEL, 'modelLoaded': _pipeline is not None,
            'sheetsage': (sheetsage_paths()[1] / 'infer.py').is_file(), 'cpp': cpp_ready(),
            'adapters': sorted(d.name for d in ADAPTERS.iterdir() if d.is_dir()) if ADAPTERS.exists() else []}
    try:
        import torch
        info['cuda'] = torch.cuda.is_available()
        if info['cuda']:
            info['gpu'] = torch.cuda.get_device_name(0)
            info['vramGiB'] = round(torch.cuda.get_device_properties(0).total_memory / 2 ** 30, 1)
        from importlib.metadata import version
        info['yue2_infer'] = version('yue2_infer')
    except Exception as error:
        info['error'] = str(error)[:200]
    return info


def sweep(days=3):
    """Rules: Remove finished outputs older than `days`; receipts are tiny and stay."""
    cutoff = time.time() - days * 86400
    removed = 0
    if OUTPUT.exists():
        for folder in OUTPUT.iterdir():
            if folder.is_dir() and folder.stat().st_mtime < cutoff:
                shutil.rmtree(folder, ignore_errors=True)
                removed += 1
    return removed


def handler(job):
    """Rules: Only the fixed actions below are served; anything else is refused."""
    data = job['input']
    action = data.get('action')
    if action == 'health':
        return health()
    if action == 'setup':
        started = time.time()
        get_pipeline()
        return {'ready': True, 'loadSeconds': round(time.time() - started, 1), **health()}
    if action == 'plan':
        return plan(job, data)
    if action == 'generate':
        return generate(job, data)
    if action == 'transcribe':
        return transcribe(job, data)
    if action == 'asset':
        return asset(data)
    if action == 'recover':
        return recover(data)
    if action == 'adapters':
        return install_adapters(data)
    if action == 'build-cpp':
        return build_cpp()
    if action == 'train-upload':
        return train_upload(data)
    if action == 'train':
        return train(job, data)
    if action == 'build-train':
        return build_cpp('/yue2_train_build.sh', TRAIN)
    if action == 'train-help':
        return train_help()
    if action == 'disk':
        return disk()
    if action == 'engine-log':
        return {'log': engine_log_tail(80)}
    raise ValueError('Unsupported action.')


def main():
    """Rules: A real worker needs the persistent volume; YUE2_VOLUME overrides it for local tests only."""
    import runpod
    if 'YUE2_VOLUME' not in os.environ and not VOLUME.is_mount():
        raise RuntimeError('Persistent RunPod volume is required.')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True)
    sweep()
    os.environ.setdefault('HF_HOME', str(HOME / 'hf'))
    runpod.serverless.start({'handler': handler})


if __name__ == '__main__':
    main()
    sys.exit(0)
