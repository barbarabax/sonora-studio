"""yue2_local.py — runs ONE YuE2 job on this computer's GPU and writes the result next to the request.

exports: main(argv) -> int
used_by: yue2-local.mjs (spawns it once per job: `python yue2_local.py request.json job-folder`)
related: integrations/runpod/yue2_worker.py — the same generate / plan / validate code, reused here without RunPod
rules:   One process per job, so the GPU memory is released when the job ends. result.json or error.json is always written (atomically); the caller never parses stdout.
         PyTorch builds without FlashAttention (Windows) and cards older than Ampere (RTX 20xx) cannot run the library's default attention: it is forced to PyTorch's standard SDPA there.
agent:   claude-sonnet-5-5 | anthropic | 2026-10-12 | s_20261012_yue2 | Created after a 72 s song took 447 s on an RTX 2060 12 GB (peak 8.6 GiB) once attention was forced to sdpa.
         message: "On Linux with an Ampere+ card the default flash path is left alone; only checked on the Windows RTX 2060."
"""
import json
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'runpod'))


def force_standard_attention():
    """Rules: Only where FlashAttention cannot work (Windows build or compute capability below 8)."""
    import torch
    old_card = torch.cuda.is_available() and torch.cuda.get_device_capability(0)[0] < 8
    if sys.platform != 'win32' and not old_card:
        return
    import yue2.cuda_graph as graphs
    original = graphs.GraphAR
    graphs.GraphAR = lambda *args, **kwargs: original(*args, **{**kwargs, 'attention_backend': 'sdpa'})
    chunk_attention_queries()


def chunk_attention_queries(size=512):
    """Rules: Where the standard attention is the only choice, compute the audio stage in blocks of `size` queries.
    Whole-song attention allocated 4.25 GiB at once and ran a 12 GiB card out of memory on a long song."""
    import yue2.nar as nar
    original = nar.CachedNAR.__init__

    def init(self, model, chunk, attention='sdpa', query_chunk_size=None):
        original(self, model, chunk, attention, query_chunk_size or size)

    nar.CachedNAR.__init__ = init


def write_json(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(data), encoding='utf-8')
    temp.replace(file)


def main(argv):
    request_file, folder = Path(argv[1]), Path(argv[2])
    try:
        import yue2_worker as worker
        worker.OUTPUT.mkdir(parents=True, exist_ok=True)
        worker.STATE.mkdir(parents=True, exist_ok=True)
        data = json.loads(request_file.read_text(encoding='utf-8'))
        if data.get('action') not in ('plan', 'generate', 'transcribe'):
            raise ValueError('Unsupported action.')
        if data['action'] != 'transcribe':
            force_standard_attention()
        result = worker.handler({'input': data})
        write_json(folder / 'result.json', result)
        return 0
    except BaseException as error:
        traceback.print_exc()
        write_json(folder / 'error.json', {'error': str(error)[:400] or error.__class__.__name__})
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
