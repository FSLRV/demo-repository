"""Read Pages configuration inside the authorized deployment job."""
import json
import os
import ipaddress
import socket
from urllib.parse import urlparse
from urllib.error import HTTPError
from urllib.request import Request, urlopen

request = Request('https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + '/pages',
                  headers={'Authorization':'Bearer ' + os.environ['PAGES_TOKEN'],
                           'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
try:
    with urlopen(request, timeout=30) as response:
        data=json.load(response)
        result={'httpStatus':200,'buildType':data.get('build_type'),'configured':True,
                'cname':data.get('cname'),'httpsEnforced':data.get('https_enforced'),
                'certificateState':(data.get('https_certificate') or {}).get('state'),
                'status':data.get('status')}
        def probe(url):
            host=urlparse(url).hostname
            observed={'url':url}
            try:
                addresses=sorted({r[4][0] for r in socket.getaddrinfo(host,None)})
                observed['addresses']=addresses
                if not addresses or not all(ipaddress.ip_address(address).is_global for address in addresses):
                    observed['error']='DNS sem endereço público';return observed
                with urlopen(Request(url,headers={'User-Agent':'MR1-deployment-check'}),timeout=15) as response:
                    body=response.read(262144).decode('utf-8',errors='replace')
                    observed['httpStatus']=response.status
                    final=urlparse(response.geturl())
                    observed['finalOrigin']=final.scheme+'://'+str(final.hostname)
                    observed['storefront']='account-dialog' in body and 'backend.js' in body
            except HTTPError as error:
                observed['httpStatus']=error.code
            except Exception as error:
                observed['error']=type(error).__name__
            return observed
        owner,repo=os.environ['GITHUB_REPOSITORY'].split('/',1)
        result['defaultProbe']=probe('https://'+owner.lower()+'.github.io/'+repo+'/')
        domain=data.get('cname') or ''
        if domain and all(c.isalnum() or c in '.-' for c in domain):
            result['httpsProbe']=probe('https://'+domain+'/')
            result['httpProbe']=probe('http://'+domain+'/')
        health=Request('https://api.github.com/repos/'+os.environ['GITHUB_REPOSITORY']+'/pages/health',
                       headers={'Authorization':'Bearer '+os.environ['PAGES_TOKEN'],'Accept':'application/vnd.github+json'})
        try:
            with urlopen(health,timeout=20) as response:
                details=json.load(response).get('domain') or {}
                result['domainHealth']={k:v for k,v in details.items() if isinstance(v,bool)}
        except HTTPError as error:
            result['domainHealthStatus']=error.code
except HTTPError as error:
    result={'httpStatus':error.code,'configured':False}
with open(os.environ['GITHUB_OUTPUT'],'a') as output:
    output.write('report=' + json.dumps(result,separators=(',', ':')) + '\n')
