"""Use the Actions secret without copying it into artifacts, logs or reports."""
import json
import os
from pathlib import Path
import subprocess
import sys

destination = Path(os.environ['RUNNER_TEMP']) / 'mr1-provision-status.json'
environment = dict(os.environ, MR1_PROVISION_REPORT=str(destination))
command = [sys.executable, 'scripts/provision-supabase.py', '--skip-admin',
           '--additional-redirect', 'https://fslrv.github.io/demo-repository/']
canonical = Path('CNAME')
if canonical.exists():
    import re
    domain = canonical.read_text().strip().lower()
    if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', domain):
        raise SystemExit('Domínio inválido no arquivo CNAME.')
    command += ['--site-url', 'https://' + domain + '/',
                '--additional-redirect', 'https://www.' + domain + '/']
# The earlier candidate was unavailable. Only the purchased domain is allowed.
command += ['--exclude-redirect', 'https://mr1streetsp.com.br/',
            '--exclude-redirect', 'http://mr1streetsp.com.br/']
result = subprocess.run(command, env=environment)
report = json.loads(destination.read_text()) if destination.exists() else {'stage':'setup-not-started','error':'Não foi possível iniciar a configuração.'}
if not report.get('tokenPresent'):
    report['error'] = 'SUPABASE_ACCESS_TOKEN não foi encontrado nos repository secrets.'
with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    output.write('report=' + json.dumps(report, separators=(',', ':')) + '\n')
sys.exit(result.returncode)
