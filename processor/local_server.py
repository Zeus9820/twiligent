"""Local clipping UI using the paired Mac's fixed Flash endpoint. Loopback only."""
from __future__ import annotations
import fcntl
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import re
import sys
import threading
import uuid

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
from studio import accounts as account_service, ai, config, creators, jobs, render, server, transcribe
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
_html = _html.replace('c?.min_len ?? 15', 'c?.min_len ?? 30', 1)
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
_hashtag_marker = '<label class="f">Description<textarea data-f="description" rows="2">${esc(c.description)}</textarea></label>'
if _hashtag_marker not in _html:
    raise RuntimeError('Hashtag editor could not be attached to the local clip editor.')
_html = _html.replace(_hashtag_marker, _hashtag_marker + '\n        <label class="f">Hashtags<textarea data-f="hashtags" rows="2">${esc((c.hashtags || []).map(tag => "#" + String(tag).replace(/^#+/, "")).join(" "))}</textarea><small class="sub">Edit the hashtags used in captions and YouTube titles.</small></label>', 1)
_bulk_marker = '${j.clips.some(c => c.status === "done") ? `<button class="btn sm icon ghost" data-act="dlall"'
if _bulk_marker not in _html:
    raise RuntimeError('Bulk upload action could not be attached to the local video card.')
_bulk_button = '${j.status === "done" && j.clips.some(c => c.status === "done") ? `<button class="btn sm" data-act="bulk-upload-job" data-j="${j.id}" ${j.clips.filter(c => c.status === "done" && sel().has(`c:${j.id}:${c.id}`)).length ? "" : "disabled"}>Upload selected (${j.clips.filter(c => c.status === "done" && sel().has(`c:${j.id}:${c.id}`)).length})</button>` : ""}\n        <span class="sub" data-bulk-state="${j.id}" role="status"></span>\n        ${j.clips.some(c => c.status === "done") ? `<button class="btn sm icon ghost" data-act="dlall"'
_html = _html.replace(_bulk_marker, _bulk_button, 1)
_html = _html.replace(_dialog_marker, '  D.sig = sig;\n  if (full && c.status === "done") loadCaptionWords(j.id, c.id);\n  put($("#dposts"), postPills(c));', 1)
_html = _html.replace(_js_marker, (ROOT / 'processor' / 'caption_editor.js').read_text(encoding='utf-8') + '\n' + _js_marker, 1)
_html = _html.replace(_js_marker, (ROOT / 'processor' / 'publish_editor.js').read_text(encoding='utf-8') + '\n' + _js_marker, 1)

# Use 30–60 seconds as the Mac app's default for new jobs and newly created creators.
jobs.DEFAULTS['min_len'] = 30
creators.DEFAULTS['min_len'] = 30

_original_request_render = jobs.request_render
def local_request_render(jid, cid, changes):
    body = dict(changes)
    if 'hashtags' in body:
        raw_tags = body.pop('hashtags')
        values = raw_tags if isinstance(raw_tags, list) else re.split(r'[,;\s]+', str(raw_tags))
        tags = []
        seen = set()
        for value in values:
            tag = re.sub(r'[^A-Za-z0-9_]', '', str(value).lstrip('#'))[:30]
            if tag and tag.lower() not in seen:
                seen.add(tag.lower()); tags.append(tag)
            if len(tags) == 8: break
        job = server._job_or_404(jid)
        clip = next((clip for clip in job['clips'] if clip['id'] == cid), None)
        if not clip: raise HTTPException(404, 'Clip not found.')
        clip['hashtags'] = tags
        jobs.save(job)
    return _original_request_render(jid, cid, body)
jobs.request_render = local_request_render

_original_youtube_upload = account_service.youtube_upload
def local_youtube_upload(acc, path, title, description, tags, privacy):
    clean_tags = []
    seen = set()
    for value in tags if isinstance(tags, list) else []:
        tag = re.sub(r'[^A-Za-z0-9_]', '', str(value).lstrip('#'))[:30]
        if tag and tag.lower() not in seen:
            seen.add(tag.lower()); clean_tags.append(tag)
        if len(clean_tags) == 3: break
    full_title = title.strip()[:100]
    added = 0
    for tag in clean_tags:
        hashtag = '#' + tag
        if hashtag.lower() in full_title.lower(): continue
        suffix = ' ' + hashtag
        if len(full_title) + len(suffix) > 100:
            if added: continue
            full_title = full_title[:100 - len(suffix)].rstrip()
        full_title += suffix
        added += 1
    return _original_youtube_upload(acc, path, full_title[:100], description, tags, privacy)
account_service.youtube_upload = local_youtube_upload

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


_publish_lock = threading.RLock()
_publish_jobs: dict[str, dict] = {}

def _publish_update(publish_id, **values):
    with _publish_lock:
        if publish_id in _publish_jobs:
            _publish_jobs[publish_id].update(values)

def _publish_status(publish_id):
    with _publish_lock:
        state = _publish_jobs.get(publish_id)
        if not state:
            raise HTTPException(404, 'This upload status is no longer available. Start the upload again.')
        return {key: state[key] for key in ('id', 'jobId', 'status', 'stage', 'progress', 'filesDone', 'filesTotal', 'error') if key in state}

def _upload_local_batch(publish_id, job, files, total_bytes):
    try:
        connection = credentials(); api_url = connection['api']; credential = connection['deviceToken']

        def remote(method, path, **kwargs):
            headers = {'Authorization': f'Bearer {credential}'}
            headers.update(kwargs.pop('headers', {}))
            response = httpx.request(method, api_url + path, headers=headers, timeout=120, **kwargs)
            response.raise_for_status()
            return response.json()

        _publish_update(publish_id, stage='Connecting to Studio storage')
        batch = remote('POST', '/clipping/processor/local-batches', json={
            'batchId': publish_id,
            'name': str(job.get('title') or job.get('source', {}).get('name') or 'Local clips')[:150],
            'clips': [clip for clip, _path in files],
        })
        batch_id = batch['batchId']
        _publish_update(publish_id, jobId=batch_id, stage='Uploading clips to Studio')
        uploaded_bytes = 0
        progress_lock = threading.Lock()

        def upload_one(clip, file_path):
            nonlocal uploaded_bytes
            start_path = f"/clipping/processor/local-batches/{batch_id}/clips/{clip['id']}/upload"
            started = remote('POST', start_path, json={})
            parts = []
            with file_path.open('rb') as source:
                while True:
                    chunk = source.read(started['partSize'])
                    if not chunk: break
                    part_number = len(parts) + 1
                    result = remote('PUT', f"{start_path}/{started['uploadId']}/{part_number}", content=chunk,
                                    headers={'Content-Type': 'application/octet-stream'})
                    parts.append({'partNumber': part_number, 'etag': result['etag']})
                    with progress_lock:
                        uploaded_bytes += len(chunk)
                        _publish_update(publish_id, progress=round(uploaded_bytes * 100 / max(total_bytes, 1)))
            remote('POST', f"{start_path}/{started['uploadId']}/complete", json={'parts': parts})
            with progress_lock:
                done = _publish_jobs[publish_id].get('filesDone', 0) + 1
                _publish_update(publish_id, filesDone=done)

        with ThreadPoolExecutor(max_workers=min(3, len(files))) as pool:
            futures = [pool.submit(upload_one, clip, path) for clip, path in files]
            for future in as_completed(futures): future.result()
        result = remote('POST', f'/clipping/processor/local-batches/{batch_id}/complete', json={})
        _publish_update(publish_id, status='completed', stage='Clips are ready in the Studio bulk uploader', progress=100, jobId=result['jobId'])
    except Exception as error:
        message = str(error)
        try:
            response = getattr(error, 'response', None)
            if response is not None:
                message = response.json().get('message') or f'Studio returned HTTP {response.status_code}.'
        except (ValueError, AttributeError):
            pass
        _publish_update(publish_id, status='failed', stage='Upload stopped', error=message[:400])

@server.app.post('/api/local-publish/{jid}')
def start_local_publish(jid: str, body: dict = Body(...)):
    job = server._job_or_404(jid)
    if job.get('status') != 'done':
        raise HTTPException(409, 'Wait for this video’s clipping job to finish first.')
    clip_ids = body.get('clipIds') if isinstance(body, dict) else None
    if not isinstance(clip_ids, list) or not clip_ids or any(not isinstance(cid, str) or not cid for cid in clip_ids):
        raise HTTPException(400, 'Select at least one finished clip to upload.')
    selected = set(clip_ids)
    ready_clips = [clip for clip in job.get('clips', []) if clip.get('status') == 'done']
    ready_ids = {clip.get('id') for clip in ready_clips}
    if selected - ready_ids:
        raise HTTPException(400, 'One or more selected clips are not finished or do not belong to this video.')
    ready = [clip for clip in ready_clips if clip.get('id') in selected]
    if not ready:
        raise HTTPException(409, 'This video has no finished clips to upload.')
    files = []
    total_bytes = 0
    for clip in ready:
        path = (Path(job['dir']) / 'clips' / clip['file']).resolve()
        if not path.is_relative_to(Path(job['dir']).resolve()) or not path.is_file() or path.suffix.lower() != '.mp4':
            raise HTTPException(400, 'A finished clip file is missing or invalid.')
        total_bytes += path.stat().st_size
        tags = clip.get('hashtags') or clip.get('tags') or []
        if isinstance(tags, str): tags = [tag.lstrip('#') for tag in tags.split() if tag.startswith('#')]
        files.append(({'id': clip['id'], 'title': str(clip.get('title') or clip.get('hook') or 'Clip')[:100],
                       'description': str(clip.get('description') or '')[:2200],
                       'hashtags': [str(tag).lstrip('#') for tag in tags if isinstance(tag, str)][:8],
                       'start': clip['start'], 'end': clip['end']}, path))
    publish_id = str(uuid.uuid4())
    state = {'id': publish_id, 'status': 'uploading', 'stage': 'Starting secure upload', 'progress': 0,
             'filesDone': 0, 'filesTotal': len(files), 'error': ''}
    with _publish_lock: _publish_jobs[publish_id] = state
    threading.Thread(target=_upload_local_batch, args=(publish_id, job, files, total_bytes), daemon=True).start()
    return {'publishId': publish_id, **_publish_status(publish_id)}

@server.app.get('/api/local-publish/{publish_id}')
def get_local_publish_status(publish_id: str):
    return _publish_status(publish_id)


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
