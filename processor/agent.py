"""Outbound-only Mac processor for Studio. Pair once; video processing stays local."""
from __future__ import annotations
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser

import httpx

ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home() / 'Library' / 'Application Support' / 'Kratos Studio' / 'PeakCut'
API = 'https://twiligent.gameofkratos.workers.dev/api'
STUDIO = 'https://studio.gameofkratos.workers.dev/clipping'
STOP = threading.Event()
CHILD: subprocess.Popen | None = None


def write_private(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle)
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def request(api, method, route, token=None, lease=None, **kwargs):
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    if lease:
        headers['X-Clipping-Lease'] = lease
    response = httpx.request(method, f'{api}{route}', headers=headers, timeout=60, **kwargs)
    response.raise_for_status()
    return response.json()


def pair(config, root, open_browser):
    api = config.get('api', API)
    pending = read_json(root / 'pairing.json')
    if not pending or pending.get('expiresAt', 0) < time.time() + 10:
        registered = request(api, 'POST', '/clipping/processor/register', json={'name': socket.gethostname().split('.')[0] + ' — PeakCut'})
        pending = {**registered, 'expiresAt': time.time() + registered['expiresIn']}
        write_private(root / 'pairing.json', pending)
    code = pending['code']
    print(f'Pair this Mac in Studio → Clipping. Code: {code}', flush=True)
    write_private(root / 'status.json', {'phase': 'pairing', 'code': code, 'expiresAt': pending['expiresAt']})
    if open_browser:
        webbrowser.open(f'{STUDIO}?pair={code}')
    while not STOP.is_set() and time.time() < pending['expiresAt']:
        result = request(api, 'POST', '/clipping/processor/pair-status', json={'code': code, 'secret': pending['secret']})
        if result.get('paired'):
            config.update(api=api, deviceToken=result['deviceToken'], deviceId=result['deviceId'])
            write_private(root / 'config.json', config)
            (root / 'pairing.json').unlink(missing_ok=True)
            print('Mac paired. Waiting for Studio clipping jobs.', flush=True)
            return config
        STOP.wait(5)
    return None


def terminate_child():
    global CHILD
    if CHILD and CHILD.poll() is None:
        try:
            os.killpg(CHILD.pid, signal.SIGTERM)
            CHILD.wait(timeout=8)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(CHILD.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def process(config, root, job):
    global CHILD
    api, credential, lease = config['api'], config['deviceToken'], job['leaseId']
    jid = str(uuid.UUID(job['id']))
    work = root / 'jobs' / jid / str(uuid.UUID(lease))
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    cloud_path = f'/clipping/processor/jobs/{jid}'
    status = {'progress': 0.01, 'stage': 'Preparing on your Mac'}
    failed_heartbeat = threading.Event()
    cancelled = threading.Event()
    done = threading.Event()

    def heartbeat():
        while not done.is_set() and not STOP.is_set():
            try:
                request(api, 'POST', cloud_path + '/progress', credential, json={'leaseId': lease, **status})
            except httpx.HTTPStatusError as error:
                if error.response.status_code in (401, 403, 404, 409):
                    cancelled.set()
                    return
                failed_heartbeat.set()
            except httpx.HTTPError:
                failed_heartbeat.set()
            done.wait(15)

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        local_path = None
        if job['source']['kind'] == 'upload':
            status.update(stage='Downloading the source to your Mac')
            source = work / 'source.mp4'
            if not source.exists():
                with httpx.stream('GET', job['source']['url'], timeout=120, follow_redirects=False) as response:
                    response.raise_for_status()
                    total = int(response.headers.get('content-length') or 0)
                    if total > 2 * 1024 ** 3:
                        raise ValueError('The video exceeds the 2 GB processing limit.')
                    received = 0
                    with source.with_suffix('.part').open('wb') as output:
                        for chunk in response.iter_bytes(1024 * 1024):
                            if STOP.is_set() or cancelled.is_set():
                                raise InterruptedError('Job cancelled or processor stopped.')
                            received += len(chunk)
                            if received > 2 * 1024 ** 3:
                                raise ValueError('The video exceeds the 2 GB processing limit.')
                            output.write(chunk)
                            status['progress'] = 0.05 * received / max(total, received)
                source.with_suffix('.part').replace(source)
            local_path = str(source)
        spec = {'job': job, 'api': api, 'deviceToken': credential, 'models': str(root / 'models'), 'localPath': local_path}
        write_private(work / 'request.json', spec)
        status.update(stage='Starting PeakCut', progress=0.05)
        with (work / 'process.log').open('ab') as log:
            CHILD = subprocess.Popen([sys.executable, str(ROOT / 'processor' / 'engine.py'), str(work / 'request.json')], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            while CHILD.poll() is None:
                if STOP.is_set() or cancelled.is_set():
                    terminate_child()
                    raise InterruptedError('Job cancelled or processor stopped.')
                snapshot = read_json(work / 'progress.json', {})
                stage = str(snapshot.get('stage') or 'Processing on your Mac')
                rendered = snapshot.get('clips') or []
                if stage == 'Finishing the clips' and rendered:
                    ready = sum(clip.get('status') == 'done' for clip in rendered)
                    failed = sum(clip.get('status') == 'error' for clip in rendered)
                    active = sum(clip.get('status') == 'rendering' for clip in rendered)
                    stage = f'Rendering: {ready}/{len(rendered)} complete, {active} active' + (f', {failed} failed' if failed else '')
                status.update(stage=stage[:180], progress=min(0.94, 0.05 + 0.89 * float(snapshot.get('progress') or 0)))
                done.wait(2)
        snapshot = read_json(work / 'progress.json', {})
        if CHILD.returncode or snapshot.get('status') != 'done':
            raise RuntimeError(snapshot.get('error') or 'PeakCut stopped. Check the local process log.')
        clips = []
        artifacts = snapshot.get('artifacts', [])
        for index, artifact in enumerate(artifacts):
            if STOP.is_set() or cancelled.is_set():
                raise InterruptedError('Job cancelled or processor stopped.')
            file = Path(artifact['file']).resolve()
            if not file.is_relative_to(work.resolve()) or not file.is_file() or file.suffix != '.mp4':
                raise RuntimeError('PeakCut returned an invalid clip path.')
            status.update(stage=f'Uploading clip {index + 1} of {len(artifacts)}', progress=0.94 + 0.05 * index / max(1, len(artifacts)))
            base = f"{cloud_path}/clips/{artifact['id']}/upload"
            started = request(api, 'POST', base, credential, lease, json={})
            upload = started['uploadId']
            parts = []
            with file.open('rb') as handle:
                while chunk := handle.read(started['partSize']):
                    if STOP.is_set() or cancelled.is_set():
                        raise InterruptedError('Job cancelled or processor stopped.')
                    number = len(parts) + 1
                    result = request(api, 'PUT', f'{base}/{upload}/{number}', credential, lease, content=chunk)
                    parts.append({'partNumber': number, 'etag': result['etag']})
            request(api, 'POST', f'{base}/{upload}/complete', credential, lease, json={'leaseId': lease, 'parts': parts})
            clips.append({**{key: artifact[key] for key in ('id', 'title', 'description', 'start', 'end')}, 'hashtags': artifact.get('hashtags', []), 'captionWords': artifact.get('captionWords', [])})
        warning = (snapshot.get('ai') or {}).get('note') or ''
        if not (snapshot.get('ai') or {}).get('used'):
            warning = 'No AI-selected highlights were produced. The source may have too little speech, or the AI service was unavailable.'
        done.set()
        thread.join(timeout=65)
        request(api, 'POST', cloud_path + '/progress', credential, json={'leaseId': lease, 'status': 'completed', 'progress': 1, 'stage': f'{len(clips)} clips ready' if clips else 'No highlights found', 'clips': clips, 'warning': warning})
        print(f'Clipping job finished: {len(clips)} clips ready.', flush=True)
    except Exception as error:
        terminate_child()
        done.set()
        thread.join(timeout=65)
        if not cancelled.is_set() and not STOP.is_set():
            try:
                request(api, 'POST', cloud_path + '/progress', credential, json={'leaseId': lease, 'status': 'failed', 'progress': status['progress'], 'stage': 'Processing stopped', 'error': str(error)[:500]})
            except httpx.HTTPError:
                pass
        print(f'Clipping stopped: {str(error)[:300]}', flush=True)
    finally:
        done.set()
        (work / 'request.json').unlink(missing_ok=True)
        CHILD = None


def process_caption(config, root, task):
    global CHILD
    api, credential, lease = config['api'], config['deviceToken'], task['leaseId']
    tid = str(uuid.UUID(task['id']))
    work = root / 'caption-tasks' / tid
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    route = f'/clipping/processor/caption-tasks/{tid}'
    spec_file, result_file = work / 'request.json', work / 'result.json'
    spec = {'root': str(root), 'task': task, 'result': str(result_file), 'output': str(work / 'revision.mp4')}
    write_private(spec_file, spec)
    done = threading.Event()
    cancelled = threading.Event()
    stage = {'value': task.get('stage', 'Working on your Mac')}

    def heartbeat():
        while not done.is_set() and not STOP.is_set():
            try:
                request(api, 'POST', route + '/progress', credential, lease, json={'status': 'processing', 'stage': stage['value']})
            except httpx.HTTPStatusError as error:
                if error.response.status_code in (401, 403, 404, 409):
                    cancelled.set()
                    return
            except httpx.HTTPError:
                pass
            done.wait(15)

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        # This is also the lock used by the local PeakCut worker. Editing never
        # competes with source processing for CPU, memory, or the accelerator.
        lock = (root / 'processing.lock').open('a')
        fcntl.flock(lock, fcntl.LOCK_EX)
        if STOP.is_set() or cancelled.is_set():
            raise InterruptedError('The caption task was interrupted.')
        stage['value'] = 'Reading the original timed captions' if task['kind'] == 'inspect' else 'Rendering the corrected captions'
        with (work / 'process.log').open('ab') as log:
            CHILD = subprocess.Popen([sys.executable, str(ROOT / 'processor' / 'caption_task_worker.py'), str(spec_file)], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            while CHILD.poll() is None:
                if STOP.is_set() or cancelled.is_set():
                    terminate_child()
                    raise InterruptedError('The caption task was interrupted.')
                time.sleep(1)
        if CHILD.returncode:
            log_text = (work / 'process.log').read_text(errors='replace')[-1000:]
            raise RuntimeError(log_text.strip() or 'Caption processing failed.')
        result = read_json(result_file, {})
        if task['kind'] == 'inspect':
            request(api, 'POST', route + '/progress', credential, lease, json={'status': 'completed', 'words': result.get('words', [])})
            print(f"Caption timing loaded for {task['jobId']} {task['clipId']}.", flush=True)
        else:
            file = Path(result['file']).resolve()
            if not file.is_relative_to(work.resolve()) or not file.is_file() or file.suffix != '.mp4':
                raise RuntimeError('Caption renderer returned an invalid video file.')
            stage['value'] = 'Uploading the revised clip'
            base = route + '/upload'
            started = request(api, 'POST', base, credential, lease, json={})
            upload = started['uploadId']
            parts = []
            with file.open('rb') as handle:
                while chunk := handle.read(started['partSize']):
                    if STOP.is_set() or cancelled.is_set():
                        raise InterruptedError('The caption task was interrupted.')
                    number = len(parts) + 1
                    result = request(api, 'PUT', f'{base}/{upload}/{number}', credential, lease, content=chunk)
                    parts.append({'partNumber': number, 'etag': result['etag']})
            request(api, 'POST', f'{base}/{upload}/complete', credential, lease, json={'parts': parts})
            print(f"Revised clip {task['clipId']} uploaded for {task['jobId']}.", flush=True)
        done.set()
        thread.join(timeout=20)
    except Exception as error:
        terminate_child()
        done.set()
        thread.join(timeout=20)
        if not cancelled.is_set() and not STOP.is_set():
            try:
                request(api, 'POST', route + '/progress', credential, lease, json={'status': 'failed', 'error': str(error)[:400]})
            except httpx.HTTPError:
                pass
        print(f'Caption edit stopped: {str(error)[:300]}', flush=True)
    finally:
        done.set()
        CHILD = None
        spec_file.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, default=HOME)
    parser.add_argument('--open-browser', action='store_true')
    args = parser.parse_args()
    root = args.data.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    handle = (root / 'agent.lock').open('w')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('The Studio processor is already running.', flush=True)
        return
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: (STOP.set(), terminate_child()))
    config = read_json(root / 'config.json', {'api': API})
    browser = args.open_browser
    while not STOP.is_set():
        try:
            if not config.get('deviceToken'):
                config = pair(config, root, browser) or {'api': config.get('api', API)}
                browser = False
                continue
            write_private(root / 'status.json', {'phase': 'online', 'deviceId': config['deviceId'], 'at': time.time()})
            caption = request(config['api'], 'POST', '/clipping/processor/caption-tasks/claim', config['deviceToken'], json={}).get('task')
            if caption:
                write_private(root / 'status.json', {'phase': 'caption-edit', 'taskId': caption['id'], 'at': time.time()})
                process_caption(config, root, caption)
                continue
            response = request(config['api'], 'POST', '/clipping/processor/claim', config['deviceToken'], json={})
            if response.get('job'):
                write_private(root / 'status.json', {'phase': 'processing', 'jobId': response['job']['id'], 'at': time.time()})
                process(config, root, response['job'])
            else:
                STOP.wait(60)
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 401:
                config.pop('deviceToken', None)
                (root / 'config.json').unlink(missing_ok=True)
                (root / 'pairing.json').unlink(missing_ok=True)
            print(f'Studio connection returned HTTP {error.response.status_code}. Retrying shortly.', flush=True)
            STOP.wait(15)
        except (httpx.HTTPError, OSError, ValueError) as error:
            print(f'Studio connection paused: {str(error)[:200]}', flush=True)
            STOP.wait(15)
    write_private(root / 'status.json', {'phase': 'offline', 'at': time.time()})


if __name__ == '__main__':
    main()
