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
from fastapi import Body, HTTPException
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
_job_progress_line = '${busy ? `<div class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></div><p class="sub">${esc(j.stage)} · ${Math.round(j.progress * 100)}%</p>` : ""}'
_diagnostics = r'''<div class="local-diagnostics" style="margin:12px 0;padding:14px;border:1px solid var(--line);border-radius:12px" aria-label="Processing details">
      <b>Processing details</b>
      <p class="sub" style="margin:7px 0">Step: ${esc(j.stage || "Waiting")} · Overall: ${Math.round((j.progress || 0) * 100)}%</p>
      <p class="sub" style="margin:7px 0">Clips: ${j.clips.filter(c => c.status === "done").length} ready · ${j.clips.filter(c => c.status === "rendering").length} rendering · ${j.clips.filter(c => c.status === "queued").length} waiting${j.clips.some(c => c.status === "error") ? ` · ${j.clips.filter(c => c.status === "error").length} failed` : ""}</p>
      <p class="sub" style="margin:7px 0">${busy ? `Elapsed since queued: ${fmt(Math.max(0, Date.now()/1000 - j.created))}` : j.took ? `Processing time: ${fmt(j.took)}` : ""}${j.local_updated ? ` · Last saved: ${fmt(Math.max(0, Date.now()/1000 - j.local_updated))} ago` : ""}</p>
      <p class="sub" style="margin:7px 0">${j.status === "queued" ? "Waiting for the Mac processing slot; another job may be using it." : j.status === "error" ? "Review the error below and try again after resolving it." : /finish|render/i.test(j.stage) ? "Up to three clips can render at once. Preparing speech and captions may still take time." : /transcri|writing|reading/i.test(j.stage) ? "Preparing the transcript and word timings." : /finding/i.test(j.stage) ? "AI is selecting moments from the transcript." : j.status === "done" ? "Processing finished. Ready clips can be opened below." : "Keep your Mac awake while processing."}</p>
      ${j.ai?.note ? `<p class="sub" style="margin:7px 0">AI: ${esc(j.ai.note)}</p>` : ""}
      ${j.clips.filter(c => c.status === "error").map(c => `<p class="err">${esc(c.title || c.id)}: ${esc(c.error || "Rendering failed")}</p>`).join("")}
    </div>'''
if _job_progress_line not in _html:
    raise RuntimeError('Local processing details could not be attached to the app page.')
_html = _html.replace(_job_progress_line, _job_progress_line + '\n    ' + _diagnostics, 1)
_caption_marker = '<h3>Post text</h3>'
_dialog_marker = '  D.sig = sig;\n  put($("#dposts"), postPills(c));'
_js_marker = '$("#clipdlg").addEventListener("close",'
if _caption_marker not in _html or _dialog_marker not in _html or _js_marker not in _html:
    raise RuntimeError('Local caption editor could not be attached to the app page.')
_html = _html.replace(_caption_marker, '<h3>Spoken captions</h3><p class="help">Correct each word; its timing stays the same.</p><div id="caption-words" class="help">Loading captions…</div><button class="btn" id="save-caption-words" type="button" disabled>Save captions and re-render</button>' + _caption_marker, 1)
_html = _html.replace(_dialog_marker, '  D.sig = sig;\n  if (full && c.status === "done") loadCaptionWords(j.id, c.id);\n  put($("#dposts"), postPills(c));', 1)
_html = _html.replace(_js_marker, (ROOT / 'processor' / 'caption_editor.js').read_text(encoding='utf-8') + '\n' + _js_marker, 1)

_original_public = jobs.public
def local_public(job):
    result = _original_public(job)
    try:
        result['local_updated'] = (Path(job['dir']) / 'job.json').stat().st_mtime
    except (KeyError, OSError):
        pass
    return result
jobs.public = local_public

def caption_clip(jid, cid):
    job = server._job_or_404(jid)
    clip = next((c for c in job['clips'] if c['id'] == cid), None)
    if not clip:
        raise HTTPException(404, 'Clip not found.')
    return job, clip

def caption_words(job, clip):
    span = [round(clip['start'], 2), round(clip['end'], 2), 'en2']
    if clip.get('fixed_for') == span and clip.get('fixed_words'):
        words = clip['fixed_words']
    else:
        try:
            words = json.loads((Path(job['dir']) / 'words.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return []
    return [dict(w) for w in words if clip['start'] <= w.get('s', -1) < clip['end'] and w.get('w')]

@server.app.get('/api/local-captions/{jid}/{cid}')
def get_local_captions(jid: str, cid: str):
    job, clip = caption_clip(jid, cid)
    return {'words': [{'text': w['w'], 'start': w['s'], 'end': w['e']} for w in caption_words(job, clip)]}

@server.app.post('/api/local-captions/{jid}/{cid}')
def save_local_captions(jid: str, cid: str, body: dict = Body(...)):
    job, clip = caption_clip(jid, cid)
    if job['status'] in ('queued', 'running') or clip.get('status') != 'done':
        raise HTTPException(409, 'Wait until this clip has finished rendering.')
    words = caption_words(job, clip)
    edits = body.get('words')
    if not words or not isinstance(edits, list) or len(edits) != len(words):
        raise HTTPException(400, 'The caption changed. Reload the clip and try again.')
    if any(not isinstance(value, str) or not value.strip() or len(value.strip()) > 80 or any(ch.isspace() for ch in value.strip()) for value in edits):
        raise HTTPException(400, 'Each field must contain one non-empty word, up to 80 characters.')
    for word, value in zip(words, edits):
        word['w'] = value.strip()
    clip['fixed_words'] = words
    clip['fixed_for'] = [round(clip['start'], 2), round(clip['end'], 2), 'en2']
    jobs.request_render(jid, cid, {})
    return {'ok': True}


def local_page(name, shared=False):
    if name == 'index.html':
        return HTMLResponse(_html, headers={'Cache-Control': 'private, no-cache'})
    return _original_page(name, shared)


server._page = local_page
_render_slot = threading.BoundedSemaphore(3)
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
