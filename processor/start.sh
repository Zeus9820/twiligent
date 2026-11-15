#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$TASK_ROOT/.local/peakcut/venv/bin/python" -u "$TASK_ROOT/processor/agent.py" --open-browser
