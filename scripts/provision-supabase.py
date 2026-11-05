#!/usr/bin/env python3
"""Apply the MR1 schema using the owner's Supabase management authorization.

Credentials stay in memory or in an owner-only file outside the checkout. Only
the publishable/anon key is written to config.js. No passwords enter GitHub Pages.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sys
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
REPORT = {'tokenPresent': False, 'schemaApplied': False, 'authConfigured': False,
          'publicConfigReady': False, 'ownerReady': False, 'stage': 'preflight', 'error': None}


def write_report():
    destination = os.environ.get('MR1_PROVISION_REPORT')
    if destination:
        Path(destination).write_text(json.dumps(REPORT))


def request(url, token, payload=None, method=None, api_key=None):
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    if api_key:
        headers['apikey'] = api_key
    req = Request(url, data=json.dumps(payload).encode() if payload is not None else None,
                  method=method, headers=headers)
    try:
        with urlopen(req, timeout=90) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except HTTPError as error:
        REPORT['httpStatus'] = error.code
        REPORT['endpoint'] = urlparse(url).path.rsplit('/', 1)[-1]
        # Report only SQLSTATE, never response bodies, keys, query values or PII.
        if REPORT['endpoint'] == 'query':
            raw = error.read(16384).decode('utf-8', errors='replace')
            state = re.search(r'\bERROR:\s*([0-9A-Z]{5}):', raw)
            if state:
                REPORT['sqlState'] = state[1]
        raise RuntimeError(f'A operação Supabase foi recusada (HTTP {error.code}); nenhuma credencial foi exibida.') from None
    except (URLError, TimeoutError):
        raise RuntimeError('Não foi possível acessar o Supabase. Confira a autorização e os domínios permitidos.') from None


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project-ref', default='tsrhrqwwunjyyujepppn')
    parser.add_argument('--site-url', default='https://mr1streetsp.com.br/')
    parser.add_argument('--admin-email', default=os.environ.get('MR1_ADMIN_EMAIL', ''))
    parser.add_argument('--skip-admin', action='store_true')
    parser.add_argument('--existing-admin-only', action='store_true')
    parser.add_argument('--credentials-dir', default='/workspace/private-access')
    parser.add_argument('--bootstrap-admin-hash', default=os.environ.get('MR1_BOOTSTRAP_ADMIN_SHA256', ''))
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9]{20}', args.project_ref):
        parser.error('Project ref inválido.')
    if not args.site_url.startswith('https://'):
        parser.error('O site precisa de URL HTTPS.')
    if not args.skip_admin and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', args.admin_email):
        parser.error('Informe --admin-email com o e-mail do responsável.')
    token = os.environ.get('SUPABASE_ACCESS_TOKEN', '')
    REPORT['tokenPresent'] = bool(token)
    if not token:
        parser.error('Adicione SUPABASE_ACCESS_TOKEN nas configurações seguras do ambiente. Não envie tokens no chat.')
    base = f'https://api.supabase.com/v1/projects/{args.project_ref}'
    def query(sql):
        return request(base + '/database/query', token, {'query': sql}, 'POST')

    query('create table if not exists public.mr1_schema_migrations(version text primary key, applied_at timestamptz not null default now());')
    applied = {r['version'] for r in query('select version from public.mr1_schema_migrations;')}
    for migration in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        if migration.stem in applied:
            continue
        REPORT['stage'] = 'migration:' + migration.name
        sql = "begin; select pg_advisory_xact_lock(hashtext('mr1-schema'));\n" + migration.read_text() + '\n'
        sql += 'insert into public.mr1_schema_migrations(version) values (' + literal(migration.stem) + ') on conflict do nothing; commit;'
        query(sql)
        print('Migração aplicada:', migration.name)
    REPORT['schemaApplied'] = True

    REPORT['stage'] = 'auth-configuration'
    auth = request(base + '/config/auth', token)
    redirects = {s.strip() for s in str(auth.get('uri_allow_list', '')).split(',') if s.strip()}
    redirects.add(args.site_url)
    request(base + '/config/auth', token, {'site_url': args.site_url, 'uri_allow_list': ','.join(sorted(redirects)),
                                          'external_email_enabled': True, 'mailer_autoconfirm': False,
                                          'password_min_length': 12}, 'PATCH')
    REPORT['authConfigured'] = True
    REPORT['stage'] = 'public-configuration'
    keys = request(base + '/api-keys', token)
    public_key = next((k['api_key'] for k in keys if k.get('name') == 'anon'), None)
    if not public_key:
        raise RuntimeError('Não foi encontrada a chave pública anon; não foi escrita nenhuma chave administrativa.')
    # Verify the returned key's purpose before any public file is written.
    import base64
    claims = json.loads(base64.urlsafe_b64decode(public_key.split('.')[1] + '==='))
    if claims.get('role') != 'anon':
        raise RuntimeError('A chave retornada não é publicável; publicação interrompida.')
    public_config = {'supabaseUrl': f'https://{args.project_ref}.supabase.co', 'supabasePublishableKey': public_key}
    (ROOT / 'config.js').write_text('// Apenas configuração pública; RLS protege os dados.\nwindow.MR1_CONFIG = Object.freeze(' + json.dumps(public_config) + ');\n')
    print('Configuração pública salva em config.js; valores de credenciais administrativas não foram publicados.')
    REPORT['publicConfigReady'] = True

    if args.bootstrap_admin_hash:
        if not re.fullmatch(r'[a-f0-9]{64}', args.bootstrap_admin_hash):
            raise RuntimeError('Digest do administrador inválido.')
        REPORT['stage'] = 'verified-owner-bootstrap'
        query("insert into public.mr1_owner_bootstrap(id,email_sha256) values ('owner'," + literal(args.bootstrap_admin_hash) + ") on conflict (id) do nothing;")
        query("select public.mr1_claim_owner(id) from auth.users where email_confirmed_at is not null and encode(sha256(convert_to(lower(trim(email)),'UTF8')),'hex')=" + literal(args.bootstrap_admin_hash) + ';')
        owner = query("select exists(select 1 from public.mr1_admins a join auth.users u on u.id=a.user_id where encode(sha256(convert_to(lower(trim(u.email)),'UTF8')),'hex')=" + literal(args.bootstrap_admin_hash) + ') as ready;')
        REPORT['ownerReady'] = bool(owner and owner[0]['ready'])
        print('Autorização administrativa preparada: somente a conta confirmada do responsável poderá reivindicá-la.')
    REPORT['stage'] = 'complete'

    if not args.skip_admin:
        matches = query('select id, email_confirmed_at is not null as confirmed from auth.users where lower(email)=' + literal(args.admin_email.lower()) + ';')
        if matches:
            account = matches[0]
            if not account['confirmed']:
                print('A conta já existe e precisa confirmar o e-mail antes de receber permissão administrativa.')
                return
            user_id = account['id']
        elif args.existing_admin_only:
            print('Crie e confirme sua conta pelo site antes de repetir a autorização de administrador.')
            return
        else:
            service_key = next((k['api_key'] for k in keys if k.get('name') == 'service_role'), None)
            if not service_key:
                raise RuntimeError('Sem autorização para criar o administrador. Crie e confirme sua conta pela loja.')
            password = secrets.token_urlsafe(24)
            account = request(f'https://{args.project_ref}.supabase.co/auth/v1/admin/users', service_key,
                              {'email': args.admin_email, 'password': password, 'email_confirm': True,
                               'user_metadata': {'name': 'Administrador MR1'}}, 'POST', service_key)
            user_id = account['id']
            destination = Path(args.credentials_dir).resolve()
            if ROOT == destination or ROOT in destination.parents:
                raise RuntimeError('O arquivo privado de acesso precisa ficar fora do repositório.')
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = destination / ('mr1-admin-' + secrets.token_hex(4) + '.txt')
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as file:
                file.write('Acesso privado de administrador MR1\nSite: ' + args.site_url + '\nE-mail: ' + args.admin_email + '\nSenha: ' + password + '\nNão publique este arquivo.\n')
            print('Acesso criado. Arquivo privado:', path)
        if not re.fullmatch(r'[0-9a-f-]{36}', user_id):
            raise RuntimeError('Identificador de usuário inválido.')
        query('insert into public.mr1_admins(user_id) values (' + literal(user_id) + '::uuid) on conflict do nothing;')
        print('Permissão administrativa configurada para a conta solicitada. Nenhuma senha existente foi alterada.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        REPORT['error'] = str(error)
        print(str(error), file=sys.stderr)
        sys.exit(1)
    finally:
        write_report()
