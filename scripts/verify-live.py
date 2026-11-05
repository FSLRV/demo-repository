"""Non-destructive checks of the website produced by this deployment."""
import base64
import json
import os
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

site=os.environ['PAGES_URL'].rstrip('/')+'/'
result={'live':False,'catalogRead':False,'settingsRead':False,'privateOrdersBlocked':False}
try:
    for attempt in range(8):
        try:
            with urlopen(site+'?deployment='+os.environ['GITHUB_RUN_ID'],timeout=20) as response:
                html=response.read().decode()
            if 'backend.js' in html and 'account-dialog' in html: break
        except (HTTPError,URLError): pass
        time.sleep(5)
    else: raise RuntimeError('O site ainda não respondeu com a versão publicada.')
    with urlopen(urljoin(site,'config.js')+'?deployment='+os.environ['GITHUB_RUN_ID'],timeout=20) as response:
        source=response.read().decode()
    match=re.search(r'Object\.freeze\((\{.*\})\)',source)
    config=json.loads(match[1]) if match else {}
    if config.get('supabaseUrl')!='https://tsrhrqwwunjyyujepppn.supabase.co': raise RuntimeError('Projeto Supabase inesperado no site.')
    key=config.get('supabasePublishableKey','')
    if not key.startswith('eyJ'): raise RuntimeError('A chave pública ainda não foi aplicada.')
    if json.loads(base64.urlsafe_b64decode(key.split('.')[1]+'===' )).get('role')!='anon': raise RuntimeError('Tipo de chave pública inválido.')
    headers={'apikey':key,'Authorization':'Bearer '+key}
    for table,field in [('mr1_products','catalogRead'),('mr1_site_settings','settingsRead')]:
        with urlopen(Request(config['supabaseUrl']+'/rest/v1/'+table+'?select=*&limit=1',headers=headers),timeout=20) as response:
            if not isinstance(json.load(response),list): raise RuntimeError('Resposta pública do banco inválida.')
        result[field]=True
    try:
        with urlopen(Request(config['supabaseUrl']+'/rest/v1/mr1_orders?select=id&limit=1',headers=headers),timeout=20):
            raise RuntimeError('O acesso anônimo a pedidos não foi bloqueado.')
    except HTTPError as error:
        if error.code not in (401,403): raise
        result['privateOrdersBlocked']=True
    result['live']=True
    print('Site e leitura pública Supabase verificados; pedidos privados bloqueados.')
except Exception as error:
    # Do not persist server bodies or credentials from request objects.
    result['error']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
finally:
    with open(os.environ['GITHUB_OUTPUT'],'a') as output:
        output.write('report='+json.dumps(result,separators=(',', ':'))+'\n')
if not result['live']: raise SystemExit(1)
