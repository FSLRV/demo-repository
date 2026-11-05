"""Use the Actions secret without copying it into artifacts, logs or reports."""
import json
import os
from pathlib import Path
import subprocess
import sys

destination = Path(os.environ['RUNNER_TEMP']) / 'mr1-provision-status.json'
environment = dict(os.environ, MR1_PROVISION_REPORT=str(destination))
result = subprocess.run([sys.executable, 'scripts/provision-supabase.py', '--skip-admin'], env=environment)
report = json.loads(destination.read_text()) if destination.exists() else {'stage':'setup-not-started','error':'Não foi possível iniciar a configuração.'}
if not report.get('tokenPresent'):
    report['error'] = 'SUPABASE_ACCESS_TOKEN não foi encontrado nos repository secrets.'
with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    output.write('report=' + json.dumps(report, separators=(',', ':')) + '\n')
sys.exit(result.returncode)
