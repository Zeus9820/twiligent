"""Prefer Apple's hardware encoder while retaining PeakCut's software fallback."""
import subprocess
import sys


class _FFmpegAdapter:
    def __getattr__(self, name):
        return getattr(subprocess, name)

    def run(self, args, *pos, **kwargs):
        if isinstance(args, list) and 'h264_qsv' in args:
            command = list(args)
            command[command.index('h264_qsv')] = 'h264_videotoolbox'
            command[command.index('nv12')] = 'yuv420p'
            index = command.index('-global_quality')
            command[index:index + 4] = ['-b:v', '8M', '-allow_sw', '0']
            return subprocess.run(command, *pos, **kwargs)
        return subprocess.run(args, *pos, **kwargs)


def install(render):
    if sys.platform == 'darwin':
        render.subprocess = _FFmpegAdapter()
        render._qsv_ok = None
