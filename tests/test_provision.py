"""No network calls: exercise provisioning, key handling and safe CI reports."""
import base64
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parents[1]


def module():
    spec=importlib.util.spec_from_file_location('mr1_provision',ROOT/'scripts/provision-supabase.py')
    result=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class ProvisionTests(unittest.TestCase):
    def test_provision_preserves_redirects_and_writes_only_public_key(self):
        helper=module()
        key='eyJfixture.'+base64.urlsafe_b64encode(json.dumps({'role':'anon'}).encode()).decode().rstrip('=')+'.fixture'
        private='fixture-service-key-never-publish'
        calls=[]
        def request(url,token,payload=None,method=None,api_key=None):
            calls.append((url,payload,method))
            if url.endswith('/database/query'):
                return [{'ready':True}] if 'as ready;' in payload['query'] else []
            if url.endswith('/config/auth'):
                if method=='PATCH':
                    self.assertIn('https://previous.example.test',payload['uri_allow_list'])
                    self.assertFalse(payload['mailer_autoconfirm'])
                return {'uri_allow_list':'https://previous.example.test'}
            if url.endswith('/api-keys'): return [{'name':'anon','api_key':key},{'name':'service_role','api_key':private}]
            self.fail(url)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'supabase/migrations').mkdir(parents=True)
            (root/'supabase/migrations/001.sql').write_text('select 1;')
            helper.ROOT=root
            logs=io.StringIO()
            with patch.dict(os.environ,{'SUPABASE_ACCESS_TOKEN':'fixture-pac'}), patch('sys.argv',['provision','--skip-admin','--bootstrap-admin-hash','0'*64]), patch.object(helper,'request',side_effect=request), redirect_stdout(logs):
                helper.main()
            config=(root/'config.js').read_text()
            self.assertIn(key,config)
            self.assertNotIn(private,config)
            self.assertNotIn('fixture-pac',config)
            self.assertNotIn(key,logs.getvalue())
            self.assertTrue(helper.REPORT['schemaApplied'])
            self.assertTrue(helper.REPORT['ownerReady'])

    def test_provider_error_does_not_echo_body_or_credentials(self):
        helper=module()
        body=io.BytesIO(b'{"message":"fixture-pac secret echo"}')
        error=HTTPError('https://api.supabase.com/v1/projects/ref/database/query',401,'Unauthorized',{},body)
        with patch.object(helper,'urlopen',side_effect=error):
            with self.assertRaises(RuntimeError) as caught:
                helper.request('https://api.supabase.com/v1/projects/ref/database/query','fixture-pac')
        self.assertIn('HTTP 401',str(caught.exception))
        self.assertNotIn('fixture-pac',str(caught.exception))
        self.assertNotIn('fixture-pac',json.dumps(helper.REPORT))

    def test_status_report_excludes_unrecognized_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            env={'RUNNER_TEMP':directory,'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'123','GITHUB_REPOSITORY':'owner/repo',
                 'BUILD_RESULT':'success','DEPLOY_RESULT':'success','SUPABASE_REPORT':json.dumps({'schemaApplied':True,'secret':'must-not-be-saved'})}
            with patch.dict(os.environ,env):runpy.run_path(str(ROOT/'scripts/deployment-report.py'),run_name='__main__')
            result=json.loads((Path(directory)/'mr1-deployment-status.json').read_text())
            self.assertTrue(result['supabase']['schemaApplied'])
            self.assertNotIn('must-not-be-saved',json.dumps(result))


if __name__=='__main__':unittest.main()
