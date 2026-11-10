"""Configure the purchased domain when DNS points to Pages; report exact blockers."""
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
GITHUB_ADDRESSES = {f'185.199.{n}.153' for n in range(108, 112)} | {f'2606:50c0:800{n}::153' for n in range(4)}


def api(method='GET', patch=None, suffix=''):
    request = Request('https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + '/pages' + suffix,
        method=method, data=json.dumps(patch).encode() if patch is not None else None,
        headers={'Authorization': 'Bearer ' + os.environ['PAGES_TOKEN'], 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urlopen(request, timeout=25) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def dns(host):
    try:
        addresses = sorted({r[4][0] for r in socket.getaddrinfo(host, None)})
        return {'addresses': addresses, 'pointsToGitHub': bool(addresses) and all(address in GITHUB_ADDRESSES for address in addresses)}
    except socket.gaierror:
        return {'addresses': [], 'pointsToGitHub': False, 'error': 'DNS ainda não resolvido'}


def probe(url):
    observed = {'url': url}
    try:
        addresses = dns(urlparse(url).hostname)['addresses']
        observed['addresses'] = addresses
        if not addresses or not all(ipaddress.ip_address(value).is_global for value in addresses):
            observed['error'] = 'DNS sem endereço público'
            return observed
        with urlopen(Request(url, headers={'User-Agent': 'MR1-deployment-check'}), timeout=15) as response:
            body = response.read(262144).decode('utf-8', errors='replace')
            final = urlparse(response.geturl())
            observed.update(httpStatus=response.status, finalOrigin=final.scheme + '://' + str(final.hostname),
                            storefront='account-dialog' in body and 'backend.js' in body)
    except HTTPError as error:
        observed['httpStatus'] = error.code
    except (URLError, TimeoutError, OSError, ValueError) as error:
        observed['error'] = type(error).__name__
    return observed


def registration(domain):
    try:
        with urlopen(Request('https://rdap.registro.br/domain/' + domain,
                     headers={'Accept': 'application/rdap+json', 'User-Agent': 'MR1-deployment-check'}), timeout=15) as response:
            data = json.load(response)
            return {'httpStatus': response.status, 'nameservers': [value.get('ldhName') for value in data.get('nameservers', [])]}
    except HTTPError as error:
        return {'httpStatus': error.code}
    except (URLError, TimeoutError, OSError, ValueError) as error:
        return {'error': type(error).__name__}


def main():
    canonical = ROOT / 'CNAME'
    desired = canonical.read_text().strip().lower() if canonical.exists() else ''
    if desired and not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', desired):
        raise ValueError('Domínio inválido no arquivo CNAME.')
    result = {'desiredDomain': desired or None}
    if desired:
        result['domainDns'] = dns(desired)
        result['wwwDns'] = dns('www.' + desired)
        result['registration'] = registration(desired)
    try:
        data = api()
        result.update(httpStatus=200, configured=True)
        if desired and data.get('cname') != desired:
            if result['domainDns']['pointsToGitHub']:
                try:
                    api('PUT', {'cname': desired})
                    result['domainUpdateStatus'] = 200
                    data = api()
                except HTTPError as error:
                    result['domainUpdateStatus'] = error.code
                    result['manualDomainConfigurationRequired'] = error.code == 403
            else:
                result['domainUpdatePending'] = 'awaiting_dns'
        result.update(buildType=data.get('build_type'), cname=data.get('cname'), httpsEnforced=data.get('https_enforced'),
                      certificateState=(data.get('https_certificate') or {}).get('state'), status=data.get('status'))
        if desired:
            result['httpsProbe'] = probe('https://' + desired + '/')
            result['httpProbe'] = probe('http://' + desired + '/')
            result['wwwProbe'] = probe('https://www.' + desired + '/')
            secure = result['httpsProbe']
            result['customDomainReady'] = data.get('cname') == desired and secure.get('httpStatus') == 200 and secure.get('storefront') is True and secure.get('finalOrigin') == 'https://' + desired
            if result['customDomainReady'] and not data.get('https_enforced'):
                try:
                    api('PUT', {'https_enforced': True})
                    result.update(httpsUpdateStatus=200, httpsEnforced=True)
                except HTTPError as error:
                    result['httpsUpdateStatus'] = error.code
        owner, repo = os.environ['GITHUB_REPOSITORY'].split('/', 1)
        result['defaultProbe'] = probe('https://' + owner.lower() + '.github.io/' + repo + '/')
        try:
            health = api(suffix='/health').get('domain') or {}
            result['domainHealthStatus'] = 200
            result['domainHealth'] = {key: value for key, value in health.items() if isinstance(value, bool)}
        except HTTPError as error:
            result['domainHealthStatus'] = error.code
        except (URLError, TimeoutError, OSError, ValueError) as error:
            result['domainHealthError'] = type(error).__name__
    except HTTPError as error:
        result.update(httpStatus=error.code, configured=False)
    except (URLError, TimeoutError, OSError, ValueError) as error:
        result.update(configured=False, error=type(error).__name__)
    return result


if __name__ == '__main__':
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('report=' + json.dumps(main(), separators=(',', ':')) + '\n')
