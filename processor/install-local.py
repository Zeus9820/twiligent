"""Install the loopback-only local UI and a Mac application shortcut."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time

root = Path(__file__).resolve().parents[1]
data = Path.home() / 'Library' / 'Application Support' / 'Kratos Studio' / 'PeakCut'
runtime = data / 'runtime'
python = runtime / '.local' / 'peakcut' / 'venv' / 'bin' / 'python'
if not python.is_file():
    raise SystemExit('Install the Mac processor first using processor/setup.sh and processor/install-service.py.')
# Updating the local UI does not restart or interrupt the hosted job processor.
(runtime / 'processor').mkdir(parents=True, exist_ok=True)
shutil.copyfile(root / 'processor' / 'local_server.py', runtime / 'processor' / 'local_server.py')
for module in ('apple_acceleration.py', 'whisperkit_adapter.py', 'caption_editor.js'):
    shutil.copyfile(root / 'processor' / module, runtime / 'processor' / module)
label = f'gui/{os.getuid()}/dev.gameofkratos.localstudio'
subprocess.run(['launchctl', 'bootout', label], capture_output=True)
plist = Path.home() / 'Library' / 'LaunchAgents' / 'dev.gameofkratos.localstudio.plist'
for name in ['local-studio.log', 'local-studio-error.log']:
    log = data / name
    log.touch(exist_ok=True); log.chmod(0o600)
settings = {'Label': 'dev.gameofkratos.localstudio',
            'ProgramArguments': [str(python), '-u', str(runtime / 'processor' / 'local_server.py')],
            'WorkingDirectory': str(runtime), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30,
            'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
            'StandardOutPath': str(data / 'local-studio.log'), 'StandardErrorPath': str(data / 'local-studio-error.log')}
plist.write_bytes(plistlib.dumps(settings)); plist.chmod(0o600)
for attempt in range(10):
    started = subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], capture_output=True, text=True)
    if started.returncode == 0:
        break
    time.sleep(0.5)
else:
    raise SystemExit('The local service could not restart: ' + started.stderr.strip())
app = Path.home() / 'Applications' / 'Kratos Studio Local.app'
(app / 'Contents' / 'MacOS').mkdir(parents=True, exist_ok=True)
(app / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({
    'CFBundleIdentifier': 'dev.gameofkratos.studio.local', 'CFBundleName': 'Kratos Studio Local',
    'CFBundleDisplayName': 'Kratos Studio Local', 'CFBundleExecutable': 'launch',
    'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1.0', 'LSUIElement': False,
    'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
}))
launch = app / 'Contents' / 'MacOS' / 'launch'
swift = shutil.which('xcrun')
if swift:
    subprocess.run([swift, 'swiftc', str(root / 'processor' / 'LocalApp.swift'), '-o', str(launch), '-framework', 'Cocoa', '-framework', 'WebKit'], check=True)
    codesign = shutil.which('codesign')
    if codesign:
        subprocess.run([codesign, '--force', '--deep', '--sign', '-', str(app)], check=True, capture_output=True)
else:
    launch.write_text('#!/bin/sh\n/usr/bin/open "http://127.0.0.1:8765/app"\n')
    launch.chmod(0o755)
# A Desktop link makes the installed app easy to find; retain an existing different shortcut.
desktop = Path.home() / 'Desktop' / 'Kratos Studio Local.app'
if not desktop.exists() and not desktop.is_symlink():
    desktop.symlink_to(app, target_is_directory=True)
print(f'Installed local clipping app: {app}')
print('Local address: http://127.0.0.1:8765/app')
