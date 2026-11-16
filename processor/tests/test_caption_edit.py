import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import caption_edit


class CaptionEditTests(unittest.TestCase):
    def test_preserves_timing_and_original_words(self):
        original = [{'w': 'old', 's': 2.0, 'e': 2.5}]
        edited = caption_edit.corrected_words(original, ['new'])
        self.assertEqual(edited, [{'w': 'new', 's': 2.0, 'e': 2.5}])
        self.assertEqual(original[0]['w'], 'old')
        for invalid in ([], ['two words'], ['']):
            with self.assertRaises(ValueError):
                caption_edit.corrected_words(original, invalid)

    def test_retained_clip_and_timing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); jid = str(uuid.uuid4())
            folder = root / 'jobs' / jid / str(uuid.uuid4()) / 'data/users/u_local/jobs/one'
            folder.mkdir(parents=True)
            clip = {'id': 'clip01', 'status': 'done', 'start': 1., 'end': 4.}
            (folder / 'job.json').write_text(json.dumps({'clips': [clip]}))
            (folder / 'words.json').write_text(json.dumps([{'w': 'one', 's': 2., 'e': 2.4}, {'w': 'outside', 's': 8., 'e': 8.5}]))
            path, _, result = caption_edit.retained_clip(root, jid, 'clip01')
            self.assertEqual([w['w'] for w in caption_edit.timed_words(path, result)], ['one'])
            with self.assertRaises(ValueError): caption_edit.retained_clip(root, jid, '../clip01')
            with self.assertRaises(FileNotFoundError): caption_edit.retained_clip(root, str(uuid.uuid4()), 'clip01')

    def test_revision_never_overwrites_original(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); source = folder / 'source.mp4'; source.write_bytes(b'original')
            output = folder / 'revision'
            job = {'source_path': str(source), 'width': 1080, 'height': 1920}
            clip = {'start': 1., 'end': 5., 'hook': '', 'layout': 'blur', 'style': 'clean'}
            def fake_render(src, dest, name, local, words, width, height):
                self.assertEqual(src.read_bytes(), b'original')
                self.assertNotEqual(dest, src.parent)
                return {'file': name + '.mp4'}
            with patch('studio.render.render_clip', side_effect=fake_render), patch('apple_acceleration.install'):
                result = caption_edit.render_revision(folder / 'job.json', job, clip, [{'w':'word','s':2.,'e':2.3}], output)
            self.assertEqual(result['file'], 'revision.mp4')
            self.assertEqual(source.read_bytes(), b'original')

if __name__ == '__main__': unittest.main()
