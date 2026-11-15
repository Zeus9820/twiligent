"""WhisperKit transcription with timed words and a safe Parakeet fallback."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import wave

import numpy as np

BIN = Path.home() / 'Library/Application Support/Kratos Studio/PeakCut/bin/whisperkit-cli'
MODEL_DIR = Path.home() / 'Library/Application Support/Kratos Studio/PeakCut/whisperkit-models'
_lock = threading.Lock()


def install(transcribe):
    original = transcribe.transcribe
    def run(audio, on_progress=None):
        if not BIN.is_file():
            return original(audio, on_progress)
        try:
            with _lock, tempfile.TemporaryDirectory(prefix='kratos-asr-') as tmp:
                folder = Path(tmp)
                wav = folder / 'audio.wav'
                pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2')
                with wave.open(str(wav), 'wb') as f:
                    f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000); f.writeframes(pcm.tobytes())
                result = subprocess.run([str(BIN), 'transcribe', '--audio-path', str(wav), '--model', 'small',
                    '--download-model-path', str(MODEL_DIR), '--word-timestamps', '--report', '--report-path', tmp],
                    capture_output=True, text=True, timeout=max(600, int(len(audio) / 16000 * 3)))
                report = folder / 'audio.json'
                if result.returncode or not report.is_file():
                    raise RuntimeError('WhisperKit transcription unavailable')
                data = json.loads(report.read_text())
                words = [{'w': str(w['word']).strip(), 's': float(w['start']), 'e': float(w['end'])}
                         for segment in data.get('segments', []) for w in segment.get('words') or []
                         if str(w.get('word', '')).strip()]
                if not words:
                    raise RuntimeError('WhisperKit returned no timed words')
                if on_progress: on_progress(1.0)
                return words
        except Exception as error:
            print('WhisperKit failed; using local speech fallback:', type(error).__name__, flush=True)
            return original(audio, on_progress)
    transcribe.transcribe = run
