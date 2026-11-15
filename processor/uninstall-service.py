"""Stop and remove the Mac processor's login service; retain videos and configuration."""
import os
from pathlib import Path
import subprocess
subprocess.run(['launchctl', 'bootout', f'gui/{os.getuid()}/dev.gameofkratos.peakcut'], capture_output=True)
(Path.home() / 'Library' / 'LaunchAgents' / 'dev.gameofkratos.peakcut.plist').unlink(missing_ok=True)
print('Studio Mac processor stopped and removed from login services.')
