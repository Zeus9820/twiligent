"""Run one retained caption inspection or render on the paired Mac."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from caption_edit import corrected_words, render_revision, retained_clip, timed_words


def main():
    spec_path = Path(sys.argv[1]).resolve()
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    root = Path(spec['root']).resolve()
    task = spec['task']
    path, job, clip = retained_clip(root, task['jobId'], task['clipId'])
    current = timed_words(path, clip)
    if task['kind'] == 'inspect':
        words = [{'text': word['w'], 'start': word['s'], 'end': word['e']} for word in current]
        Path(spec['result']).write_text(json.dumps({'words': words}), encoding='utf-8')
        return
    desired = task.get('words')
    if not isinstance(desired, list) or len(desired) != len(current):
        raise ValueError('The timed captions changed. Inspect them again before saving.')
    edits = []
    for old, new in zip(current, desired):
        if abs(float(old['s']) - float(new['start'])) > 0.03 or abs(float(old['e']) - float(new['end'])) > 0.03:
            raise ValueError('The timed captions changed. Inspect them again before saving.')
        edits.append(new['text'])
    fixed = corrected_words(current, edits)
    output = Path(spec['output']).resolve()
    output.relative_to(root)
    render_revision(path, job, clip, fixed, output.parent)
    result = {'file': str(output.parent / 'revision.mp4'), 'words': [{'text': word['w'], 'start': word['s'], 'end': word['e']} for word in fixed]}
    Path(spec['result']).write_text(json.dumps(result), encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error)[:400], file=sys.stderr)
        raise
