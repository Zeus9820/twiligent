"""Install a user LaunchAgent. No administrator privileges are required."""
import os
from pathlib import Path
import plistlib
import subprocess
import shutil

root = Path(__file__).resolve().parents[1]
data = Path.home() / 'Library' / 'Application Support' / 'Kratos Studio' / 'PeakCut'
data.mkdir(parents=True, exist_ok=True, mode=0o700)
plist = Path.home() / 'Library' / 'LaunchAgents' / 'dev.gameofkratos.peakcut.plist'
plist.parent.mkdir(parents=True, exist_ok=True)
label = f'gui/{os.getuid()}/dev.gameofkratos.peakcut'
subprocess.run(['launchctl', 'bootout', label], capture_output=True)
data.chmod(0o700)
runtime = data / 'runtime'
(runtime / 'processor').mkdir(parents=True, exist_ok=True)
shutil.copytree(root / 'processor', runtime / 'processor', dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
shutil.copytree(root / 'third_party' / 'peakcut', runtime / 'third_party' / 'peakcut', dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', 'data', '.venv', '*.log'))
python = runtime / '.local' / 'peakcut' / 'venv' / 'bin' / 'python'
uv = shutil.which('uv') or '/opt/homebrew/bin/uv'
if not python.is_file():
    subprocess.run([uv, 'venv', str(python.parents[1]), '--python', '3.12'], check=True)
subprocess.run([uv, 'pip', 'install', '--python', str(python), '-r', str(runtime / 'third_party' / 'peakcut' / 'requirements.txt')], check=True)
for name in ['agent.log', 'agent-error.log']:
    log = data / name
    log.touch(exist_ok=True)
    log.chmod(0o600)
settings = {
    'Label': 'dev.gameofkratos.peakcut',
    'ProgramArguments': [str(python), '-u', str(runtime / 'processor' / 'agent.py')],
    'WorkingDirectory': str(runtime), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30,
    'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
    'StandardOutPath': str(data / 'agent.log'), 'StandardErrorPath': str(data / 'agent-error.log'),
}
plist.write_bytes(plistlib.dumps(settings))
plist.chmod(0o600)
subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True)
print('Studio Mac processor installed. Open Studio → Clipping to pair this Mac.')
