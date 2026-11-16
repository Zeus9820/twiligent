"""One isolated PeakCut job. No listener, account credentials, or automatic posting."""
from __future__ import annotations
import fcntl
import json
import os
from pathlib import Path
import sys
import traceback
import threading
import uuid

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'third_party' / 'peakcut'


def atomic_json(path: Path, value: dict):
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


def main():
    request_file = Path(sys.argv[1]).resolve()
    spec = json.loads(request_file.read_text())
    work = request_file.parent
    lock = (work / 'engine.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('This clip is already processing locally.')
    os.environ.update({
        'PEAKCUT_DATA': str(work / 'data'), 'PEAKCUT_MODELS': spec['models'],
        'PEAKCUT_AI_PROVIDER': 'gemini', 'PEAKCUT_AI_MODELS': 'gemini-3-flash-preview,gemini-3.1-flash-lite',
        'PEAKCUT_AI_BASE_URL': 'https://generativelanguage.googleapis.com/v1beta/models',
        'PEAKCUT_AI_KEY_FILE': str(Path.home() / '.config' / 'kratos-studio' / 'gemini-api-key'), 'PEAKCUT_ACCOUNTS': '0',
        'PEAKCUT_ASR_THREADS': '4', 'PEAKCUT_ASR_COPIES': '1', 'PEAKCUT_JOB_WORKERS': '1',
        'PEAKCUT_RENDER_WORKERS': '1', 'PEAKCUT_MAX_VIDEO_HOURS': '2',
    })
    sys.path.insert(0, str(VENDOR))
    import httpx
    from studio import ai, auth, ctx, db, jobs, render, transcribe
    from apple_acceleration import install as install_apple_acceleration
    install_apple_acceleration(render)
    from whisperkit_adapter import install as install_whisperkit
    install_whisperkit(transcribe)
    if not transcribe.model_ready():
        raise RuntimeError('The speech model is not downloaded yet. Run processor/setup.sh first.')
    db.init()
    owner = auth.local_user()
    ctx.set_uid(owner.id)
    render.install_fonts()
    render_slot = threading.BoundedSemaphore(3)
    original_render = render.render_clip
    def one_render(*args, **kwargs):
        with render_slot:
            return original_render(*args, **kwargs)
    render.render_clip = one_render
    cloud_job = spec['job']
    original_save = jobs.save

    def save(job):
        original_save(job)
        snapshot = jobs.public(job)
        snapshot['artifacts'] = [
            {'id': clip['id'], 'file': str(Path(job['dir']) / 'clips' / clip['file']),
             'title': clip.get('title') or clip.get('hook') or 'Clip', 'description': clip.get('description', ''), 'hashtags': clip.get('hashtags', []),
             'start': clip['start'], 'end': clip['end'],
             'captionWords': [{'text': word['w'], 'start': word['s'], 'end': word['e']} for word in clip.get('fixed_words', [])
                              if clip['start'] <= word.get('s', -1) < clip['end']]}
            for clip in job.get('clips', []) if clip.get('status') == 'done' and clip.get('file')
        ]
        atomic_json(work / 'progress.json', snapshot)

    jobs.save = save
    opts = cloud_job['options']
    options = {'max_clips': opts['maxClips'], 'min_len': opts['minSeconds'], 'max_len': opts['maxSeconds'],
               'style': opts['style'], 'layout': opts['layout'], 'quality': 1080}
    source = ({'type': 'file', 'path': spec['localPath'], 'name': cloud_job['name']} if spec.get('localPath')
              else {'type': 'url', 'url': cloud_job['source']['url'], 'name': cloud_job['name']})
    job = jobs.create(source, options, enqueue=False)
    try:
        with (Path(spec['models']).parent / 'processing.lock').open('a') as processing_lock:
            fcntl.flock(processing_lock, fcntl.LOCK_EX)
            jobs._run_job(job)
        save(job)
    except Exception as error:
        (work / 'engine-error.log').write_text(traceback.format_exc())
        job.update(status='error', stage='Processing stopped', error=str(error)[:500])
        save(job)
        return 1
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        try:
            atomic_json(Path(sys.argv[1]).resolve().parent / 'progress.json', {'status': 'error', 'stage': 'Setup required', 'progress': 0, 'error': str(error)[:500]})
        finally:
            print(str(error), file=sys.stderr)
        raise SystemExit(1)
