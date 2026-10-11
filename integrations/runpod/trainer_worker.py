"""integrations/runpod/trainer_worker.py — Bounded ComfyUI XL LoRA training using the existing persistent model files.

exports: ROOT | REV | SHA | upload(data) | bootstrap() | PUBLISH_SOURCE | train(data, api, write_json, job)
used_by: none
rules:   none
agent:   codedna-cli (no-llm) | codedna-cli | 2026-10-11 | codedna-cli | initial CodeDNA annotation pass
message: 
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import urllib.request
import urllib.parse
import uuid
import zipfile
import base64
import csv
import subprocess

ROOT = Path('/runpod-volume/sonora/training')
REV = 'cfd644ead212419cd30c99a83d06093cce3d7df2'
SHA = '06f2b4c03b9e02669ca988b6c16df9591b06dba130cbd2bb3b902994d3d9e170'

def upload(data):
    """Rules: Upload only the finished LoRA file produced by this worker; never read other paths from the request."""
    project = str(uuid.UUID(data['projectId']))
    track = str(uuid.UUID(data['trackId']))
    ext, total, offset = data['ext'], data['total'], data['offset']
    if ext not in ('.wav', '.mp3', '.flac', '.ogg', '.m4a') or not isinstance(total, int) or not 1000 <= total <= 100 * 1024 ** 2:
        raise ValueError('Invalid training asset.')
    if not isinstance(offset, int) or not 0 <= offset < total:
        raise ValueError('Invalid upload offset.')
    chunk = base64.b64decode(data['base64'], validate=True)
    if not chunk or len(chunk) > 512 * 1024 or offset + len(chunk) > total:
        raise ValueError('Invalid upload chunk.')
    folder = ROOT / project / 'dataset'
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / (track + ext)
    if target.exists() and target.stat().st_size == total and hashlib.sha256(target.read_bytes()).hexdigest() == data['sha256']:
        return {'offset':total}
    partial = target.with_suffix('.part')
    size = partial.stat().st_size if partial.exists() else 0
    if offset == 0 and size:
        partial.unlink()
        size = 0
    if size != offset:
        raise ValueError('Upload offset mismatch.')
    with partial.open('ab') as out:
        out.write(chunk)
    size += len(chunk)
    if size == total:
        if hashlib.sha256(partial.read_bytes()).hexdigest() != data['sha256']:
            partial.unlink()
            raise ValueError('Training audio checksum mismatch.')
        partial.replace(target)
    return {'offset':size}


def bootstrap():
    import subprocess
    subprocess.run(['python', '-m', 'pip', 'install', '--disable-pip-version-check',
                    'peft==0.18.0', 'diffusers==0.36.0', 'loguru==0.7.3', 'soundfile==0.13.1'], check=True, timeout=300)
    target = Path('/comfyui/custom_nodes/sonora_fl_training')
    archive = Path('/tmp/trainer.zip')
    req = urllib.request.Request('https://api.github.com/repos/filliptm/ComfyUI-FL-AceStep-Training/zipball/' + REV,
                                 headers={'User-Agent': 'Sonora'})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = response.read(4 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != SHA:
        raise RuntimeError('Trainer source checksum mismatch.')
    archive.write_bytes(data)
    with zipfile.ZipFile(archive) as z:
        prefix = z.namelist()[0].split('/')[0] + '/'
        for item in z.infolist():
            relative = Path(item.filename[len(prefix):])
            if not item.filename.startswith(prefix) or relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('Invalid trainer source archive.')
            if item.is_dir():
                continue
            dest = target / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(item))
    publish = Path('/comfyui/custom_nodes/sonora_publish')
    publish.mkdir(parents=True, exist_ok=True)
    publish.joinpath('__init__.py').write_text(PUBLISH_SOURCE)
    # Permit a one-epoch smoke test; the upstream configure method supports it.
    config_file = target / 'nodes' / 'training_config.py'
    config_file.write_text(config_file.read_text().replace('"min": 10,', '"min": 1,', 1))
    preprocess_file = target / 'nodes' / 'dataset_preprocess.py'
    preprocess_file.write_text(preprocess_file.read_text().replace('logger.warning(error_msg)\n                    errors.append(error_msg)', 'raise RuntimeError(error_msg) from e'))


PUBLISH_SOURCE = '''
import json
from pathlib import Path
import hashlib
import uuid
import torch
from safetensors.torch import load_file, save_file
class SonoraPublishLoRA:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"checkpoint": ("STRING",), "model": ("MODEL",), "project_id": ("STRING",), "training_status": ("STRING",)}}
    RETURN_TYPES = ()
    FUNCTION = "publish"
    OUTPUT_NODE = True
    def publish(self, checkpoint, model, project_id, training_status):
        if not training_status.startswith('Training complete!'):
            raise RuntimeError(training_status)
        project_id = str(uuid.UUID(project_id))
        root = Path('/runpod-volume/sonora/training') / project_id
        source = (Path(checkpoint) / 'adapter' / 'adapter_model.safetensors').resolve()
        if not source.is_relative_to(root.resolve()): raise ValueError('Invalid checkpoint path')
        config = json.loads(source.with_name('adapter_config.json').read_text())
        weights = load_file(str(source))
        converted = {}
        for key, value in weights.items():
            while key.startswith('base_model.model.'): key = key[len('base_model.model.'):]
            if not key.startswith('decoder.'): key = 'decoder.' + key
            key = 'diffusion_model.' + key
            converted[key] = value
            if key.endswith('.lora_A.weight'):
                converted[key[:-len('.lora_A.weight')] + '.alpha'] = torch.tensor(float(config['lora_alpha']))
        if not converted: raise ValueError('Empty adapter')
        name = 'sonora-' + project_id + '.safetensors'
        target = Path('/runpod-volume/models/loras') / name
        target.parent.mkdir(parents=True, exist_ok=True)
        save_file(converted, str(target) + '.part', metadata={"sonora_model": "acestep_v1.5_xl_turbo_bf16"})
        Path(str(target) + '.part').replace(target)
        return {"ui": {"sonora_lora": [{"loraName":name,"bytes":target.stat().st_size,"sha256":hashlib.sha256(target.read_bytes()).hexdigest()}]}}
NODE_CLASS_MAPPINGS = {"SonoraPublishLoRA": SonoraPublishLoRA}
'''


def train(data, api, write_json, job):
    import runpod
    project_id = str(uuid.UUID(data['projectId']))
    local_id = str(uuid.UUID(data['localId']))
    epochs = data['epochs']
    if not isinstance(epochs, int) or not 1 <= epochs <= 100:
        raise ValueError('Invalid epoch limit.')
    tracks = data['tracks']
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= 20:
        raise ValueError('Invalid dataset.')
    folder = ROOT / project_id
    record = folder / (local_id + '.json')
    folder.mkdir(parents=True, exist_ok=True)
    if record.exists():
        saved = json.loads(record.read_text())
        if saved.get('result'):
            return saved['result']
        # Never re-submit a recovered training graph.
        prompt_id = saved['promptId']
    else:
        if shutil.disk_usage('/runpod-volume').free < 2 * 1024 ** 3:
            raise RuntimeError('At least 2 GB free persistent storage is required.')
        dataset = folder / 'dataset'
        dataset.mkdir(exist_ok=True)
        prepared = folder / 'prepared'
        prepared.mkdir(exist_ok=True)
        total = 0
        runpod.serverless.progress_update(job, 'Copia dataset e annotazioni')
        for track in tracks:
            track_id = str(uuid.UUID(track['id']))
            ext = track['ext']
            if ext not in ('.wav', '.mp3', '.flac', '.ogg', '.m4a'):
                raise ValueError('Invalid audio format.')
            target = dataset / (track_id + ext)
            if not target.exists() or target.stat().st_size != track['bytes'] or hashlib.sha256(target.read_bytes()).hexdigest() != track['sha256']:
                raise ValueError('Training audio not uploaded or corrupted.')
            wav = prepared / (track_id + '.wav')
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(target), '-t', '30',
                            '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', str(wav)], check=True, timeout=90)
            wav.with_suffix('.txt').write_text('' if track['instrumental'] else track['lyrics'], encoding='utf-8')
        with (prepared / 'metadata.csv').open('w', encoding='utf-8', newline='') as out:
            writer = csv.DictWriter(out, fieldnames=['filename', 'caption'])
            writer.writeheader()
            writer.writerows({'filename':t['id'] + '.wav', 'caption':t['caption']} for t in tracks)
        node = lambda kind, inputs: {'class_type':kind,'inputs':inputs}
        graph = {
            '1':node('UNETLoader', {'unet_name':'acestep_v1.5_xl_turbo_bf16.safetensors','weight_dtype':'default'}),
            '2':node('CLIPLoader', {'clip_name':'qwen_0.6b_ace15.safetensors','type':'ace','device':'default'}),
            '3':node('VAELoader', {'vae_name':'ace_1.5_vae.safetensors'}),
            '4':node('FL_AceStep_ScanDirectory', {'directory':str(prepared),'all_instrumental':all(t['instrumental'] for t in tracks),'custom_tag':'','tag_position':'prepend'}),
            '5':node('FL_AceStep_PreprocessDataset', {'dataset':['4',0],'model':['1',0],'vae':['3',0],'clip':['2',0],
                      'output_dir':str(folder/'tensors'),'max_duration':30.0,'genre_ratio':0}),
            '6':node('FL_AceStep_TrainingConfig', {'lora_rank':8,'lora_alpha':16,'lora_dropout':0.1,'learning_rate':0.0001,
                      'max_epochs':epochs,'batch_size':1,'gradient_accumulation':1,'save_every_n_epochs':5,
                      'output_dir':str(folder/'checkpoints'),'seed':42,'warmup_steps':0,'weight_decay':0.01,'max_grad_norm':1.0,'target_modules':'q_proj,k_proj,v_proj,o_proj'}),
            '7':node('FL_AceStep_Train', {'model':['1',0],'config':['6',0],'tensor_dir':['5',0],'lora_name':'adapter','resume_from':''}),
            '8':node('SonoraPublishLoRA', {'checkpoint':['7',1],'model':['7',0],'project_id':project_id,'training_status':['7',2]})
        }
        prompt_id = str(uuid.uuid4())
        write_json(record, {'promptId':prompt_id})
        runpod.serverless.progress_update(job, 'Preprocessing e training XL Turbo')
        result = api('/prompt', {'prompt':graph,'prompt_id':prompt_id,'client_id':local_id})
        if result.get('node_errors'):
            raise RuntimeError('Training graph rejected by ComfyUI.')
    deadline = time.monotonic() + 1740
    while time.monotonic() < deadline:
        entry = api('/history/' + prompt_id).get(prompt_id)
        if entry and entry.get('status', {}).get('status_str') == 'error':
            write_json(record, {'promptId':prompt_id, 'failure':entry.get('status')})
            failures = [m[1] for m in entry.get('status', {}).get('messages', []) if m[0] == 'execution_error']
            failure = failures[-1] if failures else {}
            raise RuntimeError('Training node ' + str(failure.get('node_id', '?')) + ': ' + str(failure.get('exception_type', 'unknown')) + ': ' + str(failure.get('exception_message', 'inspect scoped log'))[:600])
        if entry and entry.get('status', {}).get('completed'):
            result = entry['outputs'].get('8', {}).get('sonora_lora', [])
            if not result or result[0]['loraName'] != f'sonora-{project_id}.safetensors':
                raise RuntimeError('Training completed without an adapter.')
            write_json(record, {'promptId':prompt_id,'result':result[0]})
            return result[0]
        time.sleep(3)
    api('/queue', {'delete':[prompt_id]})
    api('/interrupt', {'prompt_id':prompt_id})
    raise RuntimeError('Training time limit reached. Checkpoints remain on storage.')
