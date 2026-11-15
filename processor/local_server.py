"""Local clipping UI using the paired Mac's fixed Flash endpoint. Loopback only."""
from __future__ import annotations
import fcntl
import json
import os
from pathlib import Path
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
DATA = Path.home() / 'Library' / 'Application Support' / 'Kratos Studio' / 'PeakCut'
LOCAL = DATA / 'local-studio'
PORT = int(os.environ.get('KRATOS_LOCAL_PORT', '8765'))
LOCAL.mkdir(parents=True, exist_ok=True, mode=0o700)
os.environ.update({
    'PEAKCUT_DATA': str(LOCAL), 'PEAKCUT_MODELS': str(DATA / 'models'),
    'PEAKCUT_HOST': '127.0.0.1', 'PEAKCUT_PORT': str(PORT), 'PEAKCUT_PUBLIC_URL': f'http://127.0.0.1:{PORT}',
    'PEAKCUT_ACCOUNTS': '0', 'PEAKCUT_UPDATE_CHECK': '0',
    'PEAKCUT_AI_PROVIDER': 'gemini', 'PEAKCUT_AI_MODELS': 'gemini-3-flash-preview,gemini-3.1-flash-lite',
    'PEAKCUT_AI_BASE_URL': 'https://generativelanguage.googleapis.com/v1beta/models',
    'PEAKCUT_AI_KEY_FILE': str(Path.home() / '.config' / 'kratos-studio' / 'gemini-api-key'),
    'PEAKCUT_ASR_THREADS': '4', 'PEAKCUT_ASR_COPIES': '1', 'PEAKCUT_JOB_WORKERS': '1',
    'PEAKCUT_MAX_VIDEO_HOURS': '4', 'PEAKCUT_MAX_UPLOAD_MB': '2048', 'PEAKCUT_MAX_JOBS_PER_USER': '5',
})
sys.path.insert(0, str(ROOT / 'third_party' / 'peakcut'))
import httpx
import uvicorn
from fastapi.responses import HTMLResponse
from studio import ai, config, jobs, render, server, transcribe
from apple_acceleration import install as install_apple_acceleration
install_apple_acceleration(render)
from whisperkit_adapter import install as install_whisperkit
install_whisperkit(transcribe)


def credentials():
    try:
        connection = json.loads((DATA / 'config.json').read_text())
        if not connection.get('deviceToken'):
            raise ValueError()
        return connection
    except (OSError, ValueError):
        raise ai.AIError('Connect your Mac in Studio once before using Flash locally.')


def local_flash(model, prompt, schema):
    connection = credentials()
    response = httpx.post(connection['api'] + '/clipping/processor/local-ai/chat/completions',
                          headers={'Authorization': f"Bearer {connection['deviceToken']}"},
                          json={'task': 'peakcut-local', 'model': '@cf/zai-org/glm-4.7-flash',
                                'messages': [{'role': 'user', 'content': ai._wrapped(prompt, schema)}]}, timeout=180)
    if response.status_code != 200:
        try:
            message = response.json().get('message') or 'Flash analysis is unavailable. Check your connection and allowance.'
        except ValueError:
            message = 'Flash analysis is unavailable. Check your connection and allowance.'
        raise ai.AIError(str(message)[:350])
    data = response.json()
    usage = data.get('usage') or {}
    return ai._parse(data['choices'][0]['message']['content']), usage.get('prompt_tokens', 0), usage.get('completion_tokens', 0)


# This UI uses the existing paired credential on the server, never a key in browser settings.
_original_page = server._page
_html = (config.ROOT / 'web' / 'index.html').read_text(encoding='utf-8')
_html = _html.replace('<title>PeakCut</title>', '<title>Kratos Studio — Local Clipping</title>')
_html = _html.replace('<img class="logo" src="/brand/logo-light.svg" alt="PeakCut">', '<strong style="font-size:18px;color:var(--frame-text)">Kratos Studio</strong>')
_html = _html.replace('Welcome to PeakCut', 'Welcome to Kratos Studio Local')
_html = _html.replace('Long videos and live streams go in, captioned vertical clips come out.', 'Your videos stay on this Mac. Flash analysis uses your existing Cloudflare connection.')


def local_page(name, shared=False):
    if name == 'index.html':
        return HTMLResponse(_html, headers={'Cache-Control': 'private, no-cache'})
    return _original_page(name, shared)


server._page = local_page
_render_slot = threading.BoundedSemaphore(1)
_original_render = render.render_clip


def one_render(*args, **kwargs):
    with _render_slot:
        return _original_render(*args, **kwargs)


render.render_clip = one_render
_original_run = jobs._run_job


def serial_job(job):
    # Avoid fighting the hosted Studio's Mac processor for resources.
    jobs._set(job, stage='Waiting for the Mac processing slot')
    with (DATA / 'processing.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _original_run(job)


jobs._run_job = serial_job


@server.app.get('/api/kratos-local-status')
def local_status():
    try:
        credentials()
        paired = True
    except ai.AIError:
        paired = False
    return {'local': True, 'paired': paired, 'model': 'Gemini 3 Flash', 'videoStorage': 'This Mac',
            'speechModelReady': (config.ASR_MODEL_DIR / 'tokens.txt').exists()}


if __name__ == '__main__':
    print(f'Kratos Studio Local: http://127.0.0.1:{PORT}/app', flush=True)
    uvicorn.run(server.app, host='127.0.0.1', port=PORT, log_level='warning', proxy_headers=False)
