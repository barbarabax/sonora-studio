"""integrations/runpod/worker.py — Sonora RunPod pilot: persistent models, scoped Comfy jobs and audio outputs.

This worker intentionally limits inline audio to short pilot results. Full-track
downloads need a separate object-storage transport before UI integration.

exports: VOLUME | OUTPUT | STATE | BASE | MODEL_REPO | MODEL_FILES | api(route, body) | write_json(file, data) | official_models() | file_sha256(file) | setup_models(job) | validate_pilot(data) | collect(entry, local_id, inline) | handler(job)
used_by: none
rules:   none
agent:   codedna-cli (no-llm) | codedna-cli | 2026-10-11 | codedna-cli | initial CodeDNA annotation pass
message: 
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import urllib.request

VOLUME = Path('/runpod-volume')
OUTPUT = VOLUME / 'sonora' / 'audio'
STATE = VOLUME / 'sonora' / 'jobs'
BASE = 'http://127.0.0.1:8188'
MODEL_REPO = 'Comfy-Org/ace_step_1.5_ComfyUI_files'
MODEL_FILES = (
    ('split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors', 'unet'),
    ('split_files/text_encoders/qwen_0.6b_ace15.safetensors', 'clip'),
    ('split_files/text_encoders/qwen_4b_ace15.safetensors', 'clip'),
    ('split_files/vae/ace_1.5_vae.safetensors', 'vae'),
)


def api(route, body=None):
    payload = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + route, data=payload, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def write_json(file, data):
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(data), encoding='utf-8')
    temp.replace(file)


def official_models():
    url = f'https://huggingface.co/api/models/{MODEL_REPO}/tree/main?recursive=true&expand=true'
    with urllib.request.urlopen(url, timeout=60) as response:
        entries = json.load(response)
    if not isinstance(entries, list):
        raise RuntimeError('The official ACE-Step model manifest is invalid.')
    models = []
    for relative, directory in MODEL_FILES:
        entry = next((item for item in entries if item.get('path') == relative), None)
        lfs = entry.get('lfs', {}) if entry else {}
        sha256 = lfs.get('oid') or (entry or {}).get('oid', '')
        sha256 = sha256.removeprefix('sha256:')
        if not entry or not isinstance(entry.get('size'), int) or entry['size'] <= 0 or len(sha256) != 64:
            raise RuntimeError('The official model manifest is missing verified details for ' + Path(relative).name)
        models.append({
            'path': relative,
            'directory': directory,
            'name': Path(relative).name,
            'size': entry['size'],
            'sha256': sha256.lower(),
            'url': f'https://huggingface.co/{MODEL_REPO}/resolve/main/{relative}?download=true',
        })
    return models


def file_sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def setup_models(job):
    import runpod
    import shutil

    models = official_models()
    result = []
    missing = []
    for item in models:
        target = VOLUME / 'models' / item['directory'] / item['name']
        marker = target.with_suffix('.verified.json')
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() or marker.is_symlink():
            raise RuntimeError('Unsafe model path: ' + target.name)
        if target.exists():
            if not target.is_file() or target.stat().st_size != item['size']:
                raise RuntimeError('An existing file conflicts with the official model; it was left untouched: ' + target.name)
            if marker.exists() and json.loads(marker.read_text()).get('sha256') == item['sha256']:
                result.append({'name': target.name, 'bytes': target.stat().st_size, 'cached': True})
                continue
            if file_sha256(target) == item['sha256']:
                write_json(marker, {'sha256': item['sha256'], 'bytes': item['size']})
                result.append({'name': target.name, 'bytes': target.stat().st_size, 'cached': True})
                continue
            raise RuntimeError('An existing file failed the official checksum; it was left untouched: ' + target.name)
        missing.append((item, target, marker))

    required = sum(item['size'] for item, _, _ in missing) + 2 * 1024 ** 3
    if shutil.disk_usage(VOLUME).free < required:
        raise RuntimeError('Not enough free space on the persistent volume. Keep at least the missing model size plus 2 GB free.')

    for item, target, marker in missing:
        temp = target.with_suffix('.part')
        if temp.is_symlink() or (temp.exists() and not temp.is_file()):
            raise RuntimeError('Unsafe partial model path: ' + temp.name)
        offset = temp.stat().st_size if temp.exists() else 0
        if offset > item['size']:
            temp.unlink()
            offset = 0
        digest = hashlib.sha256()
        if offset:
            with temp.open('rb') as source:
                while chunk := source.read(8 * 1024 * 1024):
                    digest.update(chunk)
        headers = {'Range': f'bytes={offset}-'} if offset else {}
        request = urllib.request.Request(item['url'], headers=headers)
        runpod.serverless.progress_update(job, 'Downloading and verifying: ' + target.name)
        with urllib.request.urlopen(request, timeout=60) as response:
            if offset and response.status == 200:
                temp.unlink(missing_ok=True)
                offset = 0
                digest = hashlib.sha256()
            elif offset and (response.status != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-')):
                raise RuntimeError('The model server returned an invalid resume range for ' + target.name)
            mode = 'ab' if offset else 'wb'
            with temp.open(mode) as output:
                received = offset
                last_report = offset
                while chunk := response.read(8 * 1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
                    if received - last_report >= 128 * 1024 ** 2 or received == item['size']:
                        runpod.serverless.progress_update(job, f'Downloading {target.name}: {received} / {item["size"]} bytes')
                        last_report = received
        if temp.stat().st_size != item['size'] or digest.hexdigest() != item['sha256']:
            temp.unlink(missing_ok=True)
            raise RuntimeError('Official checksum verification failed: ' + target.name)
        os.link(temp, target)
        temp.unlink()
        write_json(marker, {'sha256': item['sha256'], 'bytes': item['size']})
        result.append({'name': target.name, 'bytes': item['size'], 'cached': False})
    return {'models': result}


def validate_pilot(data):
    local_id = str(uuid.UUID(data['localId']))
    graph = data['workflow']
    duration = graph['4']['inputs']['duration']
    if not isinstance(duration, (int, float)) or not 10 <= duration <= 300 or graph['6']['inputs']['seconds'] != duration:
        raise ValueError('Duration must be synchronized and between 10 and 300 seconds.')
    if graph['6']['inputs']['batch_size'] != 1:
        raise ValueError('This pilot accepts one variant.')
    allowed = {'UNETLoader', 'DualCLIPLoader', 'VAELoader', 'TextEncodeAceStepAudio1.5',
               'ConditioningZeroOut', 'EmptyAceStep1.5LatentAudio', 'ModelSamplingAuraFlow',
               'KSampler', 'VAEDecodeAudio', 'SaveAudioMP3', 'SaveAudio', 'LoraLoaderModelOnly',
               'LoadAudio', 'VAEEncodeAudio', 'ReferenceTimbreAudio'}
    if not 11 <= len(graph) <= 16 or any(n['class_type'] not in allowed for n in graph.values()):
        raise ValueError('Unsupported pilot workflow.')
    for n in graph.values():
        if n['class_type'] == 'LoraLoaderModelOnly':
            name = n['inputs'].get('lora_name', '')
            import re
            if not re.fullmatch(r'sonora-[a-f0-9-]{36}\.safetensors', name):
                raise ValueError('Invalid LoRA name.')
            from safetensors import safe_open
            from safetensors.torch import load_file
            weights = load_file(str(VOLUME / 'models' / 'loras' / name), device='cpu')
            model_file = VOLUME / 'models' / 'unet' / graph['1']['inputs']['unet_name']
            pairs, learned = 0, False
            with safe_open(str(model_file), framework='pt', device='cpu') as base:
                for key, a in weights.items():
                    if not key.endswith('.lora_A.weight'): continue
                    stem = key[:-len('.lora_A.weight')]
                    b = weights.get(stem + '.lora_B.weight')
                    base_key = stem.removeprefix('diffusion_model.') + '.weight'
                    if b is None or base_key not in base.keys(): raise ValueError('LoRA does not match this model.')
                    shape = base.get_slice(base_key).get_shape()
                    if len(shape) != 2 or list(a.shape) != [b.shape[1], shape[1]] or b.shape[0] != shape[0]:
                        raise ValueError('LoRA tensor shape does not match this model.')
                    pairs += 1
                    learned = learned or bool(b.count_nonzero().item())
            if not pairs or not learned: raise ValueError('LoRA contains no learned adapters.')
        if n['class_type'] == 'LoadAudio' and n['inputs'].get('audio') != 'Sonora/' + local_id + '.mp3':
            raise ValueError('Source audio must be the one sent with this job.')
        if n['class_type'] in ('SaveAudioMP3', 'SaveAudio'):
            n['inputs']['filename_prefix'] = local_id + '/track'
    return local_id, graph


def collect(entry, local_id, inline=False):
    audio = []
    total = 0
    for node in entry.get('outputs', {}).values():
        for item in node.get('audio', []):
            file = (OUTPUT / item.get('subfolder', '') / item['filename']).resolve()
            expected = (OUTPUT / local_id).resolve()
            if not file.is_relative_to(expected) or file.suffix not in ('.mp3', '.flac'):
                raise ValueError('Unexpected audio path.')
            total += file.stat().st_size
            if inline and total > 6 * 1024 * 1024:
                raise ValueError('Pilot result too large; files preserved on volume.')
            raw = file.read_bytes()
            asset = {'format': file.suffix[1:], 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            if inline:
                asset['base64'] = base64.b64encode(raw).decode('ascii')
            audio.append(asset)
    if {a['format'] for a in audio} != {'mp3', 'flac'}:
        raise ValueError('Missing MP3 or FLAC output.')
    return {'localId': local_id, 'audio': audio}


def handler(job):
    """Rules: Only the fixed actions below are served; never run arbitrary workflows or paths sent by the caller."""
    data = job['input']
    if data.get('action') == 'training-upload':
        if not os.environ.get('SONORA_TRAINER'):
            raise ValueError('This endpoint does not accept training datasets.')
        from trainer_worker import upload
        return upload(data)
    if data.get('action') == 'train':
        if not os.environ.get('SONORA_TRAINER'):
            raise ValueError('This endpoint does not train models.')
        from trainer_worker import train
        return train(data, api, write_json, job)
    if data.get('action') == 'setup':
        return setup_models(job)
    if data.get('action') in ('asset', 'recover'):
        local_id = str(uuid.UUID(data['localId']))
        record = STATE / (local_id + '.json')
        if not record.exists():
            return {'missing': True}
        saved = json.loads(record.read_text())
        if not saved.get('entry'):
            return {'pending': True, 'promptId': saved['promptId']}
        if data['action'] == 'recover':
            return collect(saved['entry'], local_id)
        ext = data.get('format')
        offset = data.get('offset', 0)
        if ext not in ('mp3', 'flac') or not isinstance(offset, int) or offset < 0:
            raise ValueError('Invalid asset request.')
        files = [i for n in saved['entry'].get('outputs', {}).values() for i in n.get('audio', [])
                 if Path(i['filename']).suffix == '.' + ext]
        if len(files) != 1:
            raise ValueError('Asset not found.')
        file = (OUTPUT / files[0].get('subfolder', '') / files[0]['filename']).resolve()
        if not file.is_relative_to((OUTPUT / local_id).resolve()) or offset >= file.stat().st_size:
            raise ValueError('Invalid asset offset or path.')
        with file.open('rb') as source:
            source.seek(offset)
            raw = source.read(3 * 1024 * 1024)
        return {'localId': local_id, 'format': ext, 'offset': offset, 'bytes': len(raw),
                'base64': base64.b64encode(raw).decode('ascii')}
    if data.get('action') != 'generate':
        raise ValueError('Unsupported action.')
    local_id, graph = validate_pilot(data)
    STATE.mkdir(parents=True, exist_ok=True)
    record = STATE / (local_id + '.json')
    # A recovered request never submits a second Comfy prompt.
    if record.exists():
        saved = json.loads(record.read_text())
        if saved.get('entry'):
            return collect(saved['entry'], local_id, data.get('inline', False))
        prompt_id = saved['promptId']
    else:
        # Remix input: a compressed copy of the source song, only under this job's own name.
        source = data.get('inputAudio')
        if source:
            raw = base64.b64decode(source, validate=True)
            if not 1024 <= len(raw) <= 8 * 1024 * 1024:
                raise ValueError('Source audio size is not valid.')
            target = Path('/comfyui/input/Sonora') / (local_id + '.mp3')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        prompt_id = str(uuid.uuid4())
        write_json(record, {'promptId': prompt_id, 'submittedAt': time.time(), 'workflow': graph})
        api('/prompt', {'prompt': graph, 'prompt_id': prompt_id, 'client_id': local_id})
    deadline = time.monotonic() + 840
    while time.monotonic() < deadline:
        entry = api('/history/' + prompt_id).get(prompt_id)
        if entry and entry.get('status', {}).get('status_str') == 'error':
            raise RuntimeError('ComfyUI generation failed; inspect worker log.')
        if entry and entry.get('status', {}).get('completed'):
            write_json(record, {'promptId': prompt_id, 'entry': entry})
            return collect(entry, local_id, data.get('inline', False))
        time.sleep(2)
    # Never interrupt an unrelated job or clear the global queue.
    api('/queue', {'delete': [prompt_id]})
    api('/interrupt', {'prompt_id': prompt_id})
    raise RuntimeError('Pilot timed out; no automatic resubmission.')


if __name__ == '__main__':
    import runpod
    if not VOLUME.is_mount():
        raise RuntimeError('Persistent RunPod volume is required.')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if os.environ.get('SONORA_TRAINER'):
        from trainer_worker import bootstrap
        bootstrap()
    Path('/comfyui/extra_model_paths.yaml').write_text('sonora:\n  base_path: /runpod-volume/models/\n  diffusion_models: unet\n  text_encoders: clip\n  vae: vae\n  loras: loras\n')
    process = subprocess.Popen(['python', '-u', '/comfyui/main.py', '--listen', '127.0.0.1',
                                '--port', '8188', '--disable-auto-launch', '--output-directory', str(OUTPUT)], cwd='/comfyui')
    for _ in range(120):
        if process.poll() is not None:
            raise RuntimeError('ComfyUI exited during startup.')
        try:
            api('/system_stats')
            break
        except Exception:
            time.sleep(1)
    else:
        raise RuntimeError('ComfyUI startup timeout.')
    runpod.serverless.start({'handler': handler})
