"""Read and re-render retained web clips without overwriting their existing files."""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path


def retained_clip(root: Path, job_id: str, clip_id: str):
    jid = str(uuid.UUID(job_id))
    if not re.fullmatch(r'clip\d{2}', clip_id):
        raise ValueError('Invalid clip ID.')
    base = (root / 'jobs' / jid).resolve()
    if not base.is_relative_to((root / 'jobs').resolve()) or not base.is_dir():
        raise FileNotFoundError('The source files for this job are not available on this Mac.')
    candidates = sorted(base.glob('*/data/users/*/jobs/*/job.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in candidates:
        job = json.loads(path.read_text(encoding='utf-8'))
        clip = next((item for item in job.get('clips', []) if item.get('id') == clip_id and item.get('status') == 'done'), None)
        if clip:
            return path, job, clip
    raise FileNotFoundError('The finished clip is not available on this Mac.')


def timed_words(path: Path, clip: dict):
    span = [round(clip['start'], 2), round(clip['end'], 2), 'en2']
    if clip.get('fixed_for') == span and clip.get('fixed_words'):
        words = clip['fixed_words']
    else:
        transcript = path.parent / 'words.json'
        if not transcript.is_file():
            raise FileNotFoundError('Timed captions are not available for this clip.')
        words = json.loads(transcript.read_text(encoding='utf-8'))
    result = [dict(word) for word in words if clip['start'] <= word.get('s', -1) < clip['end'] and word.get('w')]
    if not result:
        raise ValueError('No timed captions were found for this clip.')
    return result


def corrected_words(words: list, edits: list):
    if not isinstance(edits, list) or len(edits) != len(words):
        raise ValueError('Captions changed. Reload before saving.')
    result = []
    for word, value in zip(words, edits):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 80 or any(ch.isspace() for ch in value.strip()):
            raise ValueError('Each caption field must contain one word, up to 80 characters.')
        result.append({**word, 'w': value.strip()})
    return result


def render_revision(path: Path, job: dict, clip: dict, words: list, output: Path):
    from studio import render, roman
    from apple_acceleration import install
    source = Path(clip['src']) if clip.get('src') else Path(job['source_path'])
    if not source.is_file():
        raise FileNotFoundError('The original video needed to re-render this clip is unavailable.')
    off = float(clip.get('src_offset', 0.0))
    local = {**clip, 'start': clip['start'] - off, 'end': clip['end'] - off, 'hook': roman.to_roman(clip.get('hook') or '')}
    near = [dict(word, s=word['s'] - off, e=word['e'] - off) for word in roman.words(words)]
    install(render)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    return render.render_clip(source, output, 'revision', local, near, job['width'], job['height'])
