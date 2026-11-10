"""Persist only controlled status fields; no secret values or provider bodies."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path

def data(name):
    try:
        result=json.loads(os.environ.get(name,'') or '{}')
        return result if isinstance(result,dict) else {}
    except json.JSONDecodeError:
        return {}

provision=data('SUPABASE_REPORT')
safe_fields=('tokenPresent','schemaApplied','manualOrdersReady','customEmailConfigured','authConfigured','publicConfigReady','ownerReady','stage','httpStatus','endpoint','sqlState','error')
result={
    'commit':os.environ['GITHUB_SHA'],
    'runId':os.environ['GITHUB_RUN_ID'],
    'runUrl':'https://github.com/'+os.environ['GITHUB_REPOSITORY']+'/actions/runs/'+os.environ['GITHUB_RUN_ID'],
    'createdAt':datetime.now(timezone.utc).isoformat(),
    'build':os.environ['BUILD_RESULT'], 'deployment':os.environ['DEPLOY_RESULT'],
    'supabase':{key:provision[key] for key in safe_fields if key in provision},
    'pages':data('PAGES_PREFLIGHT'), 'live':data('LIVE_REPORT'),
    'databaseChecks':data('SUPABASE_READINESS'),
    'url':os.environ.get('PAGES_URL','')
}
(Path(os.environ['RUNNER_TEMP'])/'mr1-deployment-status.json').write_text(json.dumps(result,indent=2)+'\n')
print('Relatório de status preparado sem credenciais ou conteúdo privado.')
