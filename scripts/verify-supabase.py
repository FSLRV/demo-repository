"""Read-only checks of public data and anonymous access restrictions."""
import base64
import json
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

result={'ready':False,'catalogRead':False,'settingsRead':False,'privateTablesBlocked':False,'authAvailable':False}
try:
    source=Path('config.js').read_text()
    match=re.search(r'Object\.freeze\((\{.*\})\)',source)
    config=json.loads(match[1]) if match else {}
    url=config.get('supabaseUrl','')
    key=config.get('supabasePublishableKey','')
    if url!='https://tsrhrqwwunjyyujepppn.supabase.co': raise RuntimeError('Projeto Supabase inesperado.')
    if not key.startswith('eyJ') or json.loads(base64.urlsafe_b64decode(key.split('.')[1]+'===' )).get('role')!='anon':
        raise RuntimeError('A chave pública não foi configurada corretamente.')
    headers={'apikey':key,'Authorization':'Bearer '+key}
    def get(path):
        for attempt in range(4):
            try:
                with urlopen(Request(url+path,headers=headers),timeout=20) as response:return json.load(response)
            except HTTPError as error:
                if error.code not in (404,503) or attempt==3:raise
                time.sleep(3)
    for table,field in [('mr1_products','catalogRead'),('mr1_site_settings','settingsRead')]:
        rows=get('/rest/v1/'+table+'?select=*&limit=1')
        if not isinstance(rows,list):raise RuntimeError('Resposta pública do banco inválida.')
        result[field]=True
    for table in ['mr1_orders','mr1_profiles','mr1_favorites','mr1_admins','mr1_owner_bootstrap']:
        try:
            get('/rest/v1/'+table+'?select=*&limit=1')
            raise RuntimeError('A leitura anônima de uma tabela privada não foi bloqueada.')
        except HTTPError as error:
            if error.code not in (401,403):raise
    result['privateTablesBlocked']=True
    if not isinstance(get('/auth/v1/settings'),dict):raise RuntimeError('O serviço de login não está disponível.')
    result['authAvailable']=True
    result['ready']=True
    print('Supabase online verificado: catálogo, aparência, Auth e bloqueio das cinco tabelas privadas.')
except Exception as error:
    result['error']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
finally:
    with open(os.environ['GITHUB_OUTPUT'],'a') as output:
        output.write('report='+json.dumps(result,separators=(',',':'))+'\n')
if not result['ready']:raise SystemExit(1)
