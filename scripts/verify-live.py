"""Non-destructive checks of the website produced by this deployment."""
import base64
import json
import os
import re
import time
from urllib.error import HTTPError, URLError
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

site=os.environ['PAGES_URL'].rstrip('/')+'/'
result={'live':False,'catalogRead':False,'settingsRead':False,'privateOrdersBlocked':False,'manualStorefront':False,'cepLookup':False,'customDomainReady':False}
try:
    for attempt in range(8):
        try:
            with urlopen(site+'?deployment='+os.environ['GITHUB_RUN_ID'],timeout=20) as response:
                html=response.read().decode()
                actual_url=response.geturl()
            if 'manual-commerce.js' in html and 'account-dialog' in html: break
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
    with urlopen(urljoin(site,'manual-commerce.js')+'?deployment='+os.environ['GITHUB_RUN_ID'],timeout=20) as response:
        manual_source=response.read().decode()
    if 'mr1:order-updated' not in manual_source or 'Pix copia e cola' not in manual_source:
        raise RuntimeError('A versão de pedidos manuais ainda não foi publicada.')
    result['manualStorefront']=True
    for cep,municipality in [('05879450','3550308'),('06010000','3534401')]:
        with urlopen('https://viacep.com.br/ws/'+cep+'/json/',timeout=20) as response:
            address=json.load(response)
        if address.get('ibge')!=municipality:
            raise RuntimeError('A consulta de CEP não confirmou os municípios esperados.')
    result['cepLookup']=True
    result['live']=True
    result['activeOrigin']=urlparse(actual_url).scheme+'://'+str(urlparse(actual_url).hostname)
    canonical=Path('CNAME')
    if canonical.exists():
        domain=canonical.read_text().strip()
        result['desiredDomain']=domain
        try:
            with urlopen('https://'+domain+'/',timeout=15) as response:
                secure_html=response.read(262144).decode('utf-8',errors='replace')
                secure_origin=urlparse(response.geturl())
            result['customDomainReady']='account-dialog' in secure_html and 'backend.js' in secure_html and secure_origin.scheme=='https' and secure_origin.hostname==domain
        except (HTTPError,URLError,TimeoutError,OSError) as error:
            result['customDomainPending']=type(error).__name__
    print('Site e leitura pública Supabase verificados; pedidos privados bloqueados.')
except Exception as error:
    # Do not persist server bodies or credentials from request objects.
    result['error']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
finally:
    with open(os.environ['GITHUB_OUTPUT'],'a') as output:
        output.write('report='+json.dumps(result,separators=(',', ':'))+'\n')
if not result['live']: raise SystemExit(1)
