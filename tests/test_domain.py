"""Exercise domain migration without DNS changes, GitHub writes or real mail."""
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pages_preflight', ROOT / 'scripts/pages-preflight.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
DOMAIN = 'mr1storesp.com.br'


class Response(io.BytesIO):
    status = 200

    def __init__(self, value, url):
        super().__init__(value.encode() if isinstance(value, str) else json.dumps(value).encode())
        self.url = url

    def geturl(self):
        return self.url


class DomainTests(unittest.TestCase):
    def run_check(self, dns_ready=False, api_forbidden=False, tls_ready=False):
        pages = {'cname': None, 'https_enforced': False, 'build_type': 'workflow'}
        writes = []

        def resolve(host, port):
            if host in (DOMAIN, 'www.' + DOMAIN) and not dns_ready:
                raise socket.gaierror('not yet configured')
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('185.199.108.153', 0))]

        def request(req, timeout=None):
            url = req.full_url
            if '/repos/FSLRV/demo-repository/pages' in url:
                if url.endswith('/health'):
                    raise HTTPError(url, 403, 'Forbidden', {}, None)
                if req.get_method() == 'PUT':
                    body = json.loads(req.data)
                    writes.append(body)
                    if api_forbidden:
                        raise HTTPError(url, 403, 'Forbidden', {}, None)
                    if 'cname' in body:
                        pages['cname'] = body['cname']
                    if 'https_enforced' in body:
                        pages['https_enforced'] = body['https_enforced']
                return Response(pages, url)
            if url.startswith('https://rdap.registro.br/'):
                return Response({'nameservers': [{'ldhName': 'a.auto.dns.br'}], 'entities': [{'private': 'must-not-report'}]}, url)
            if url.startswith('https://' + DOMAIN) and not tls_ready:
                raise URLError('certificate pending')
            return Response('account-dialog backend.js', url)

        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'FSLRV/demo-repository', 'PAGES_TOKEN': 'fixture-secret-token'}), patch.object(helper.socket, 'getaddrinfo', side_effect=resolve), patch.object(helper, 'urlopen', side_effect=request), patch.object(helper, 'authoritative_dns', return_value={'available': False}):
            result = helper.main()
        self.assertNotIn('fixture-secret-token', json.dumps(result))
        self.assertNotIn('must-not-report', json.dumps(result))
        return result, writes

    def test_domain_pending_dns_keeps_the_current_pages_address(self):
        result, writes = self.run_check()
        self.assertEqual(writes, [])
        self.assertEqual(result['desiredDomain'], DOMAIN)
        self.assertEqual(result['domainUpdatePending'], 'awaiting_dns')
        self.assertIsNone(result['cname'])
        self.assertFalse(result['customDomainReady'])
        self.assertTrue(result['defaultProbe']['storefront'])
        self.assertEqual(result['registration']['nameservers'], ['a.auto.dns.br'])

    def test_insufficient_pages_permission_is_reported_for_the_correct_domain(self):
        result, writes = self.run_check(dns_ready=True, api_forbidden=True)
        self.assertEqual(writes, [{'cname': DOMAIN}])
        self.assertEqual(result['domainUpdateStatus'], 403)
        self.assertTrue(result['manualDomainConfigurationRequired'])
        self.assertIsNone(result['cname'])

    def test_https_is_enforced_only_after_the_new_domain_serves_the_store(self):
        pending, writes = self.run_check(dns_ready=True)
        self.assertEqual(writes, [{'cname': DOMAIN}])
        self.assertFalse(pending['customDomainReady'])
        ready, writes = self.run_check(dns_ready=True, tls_ready=True)
        self.assertEqual(writes, [{'cname': DOMAIN}, {'https_enforced': True}])
        self.assertEqual(ready['cname'], DOMAIN)
        self.assertTrue(ready['customDomainReady'])
        self.assertTrue(ready['httpsEnforced'])


if __name__ == '__main__':
    unittest.main()
