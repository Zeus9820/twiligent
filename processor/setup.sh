#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_DATA="$HOME/Library/Application Support/Kratos Studio/PeakCut"
command -v ffmpeg >/dev/null || { echo 'Install FFmpeg first: brew install ffmpeg'; exit 1; }
command -v uv >/dev/null || { echo 'Install uv first: brew install uv'; exit 1; }
if [ ! -x "$TASK_ROOT/.local/peakcut/venv/bin/python" ]; then uv venv "$TASK_ROOT/.local/peakcut/venv" --python 3.12; fi
uv pip install --python "$TASK_ROOT/.local/peakcut/venv/bin/python" -r "$TASK_ROOT/third_party/peakcut/requirements.txt"
(cd "$TASK_ROOT/third_party/peakcut"; PEAKCUT_DATA="$TASK_DATA" "$TASK_ROOT/.local/peakcut/venv/bin/python" -m studio.fetch_model)
printf '\nReady. Start the Mac processor with:\n  "%s"\n' "$TASK_ROOT/processor/start.sh"
