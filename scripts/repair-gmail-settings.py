#!/usr/bin/env python3
"""Repair public SMTP fields for the authorized project owner's chosen Gmail.

Never inspects, changes or reports the SMTP password. Never sends an email,
confirms a user, creates an account or changes the authentication redirect URL.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

PROJECT = 'tsrhrqwwunjyyujepppn'
SMTP_ACCOUNT_HASH = 'be6aa2ae80525eabdb98c96bf8c7fe8b0cd4b843aaf2f18830a9a98a13614c93'


def normalized(value):
    return str(value or '').strip().lower()


def facts(config):
    sender = normalized(config.get('smtp_admin_email'))
    login = normalized(config.get('smtp_user'))
    approved = lambda email: bool(email) and hashlib.sha256(email.encode()).hexdigest() == SMTP_ACCOUNT_HASH
    return {
        'gmailSelected': normalized(config.get('smtp_host')) == 'smtp.gmail.com',
        'portSupported': str(config.get('smtp_port')) in ('465', '587'),
        'usernamePresent': bool(login),
        'senderPresent': bool(sender),
        'senderMatchesUsername': bool(sender and sender == login),
        'senderMatchesApprovedAccount': approved(sender),
        'usernameMatchesApprovedAccount': approved(login),
    }


def plan(config):
    observed = facts(config)
    if not observed['gmailSelected']:
        return None, 'gmail_not_selected'
    if not observed['senderMatchesApprovedAccount'] and not observed['usernameMatchesApprovedAccount']:
        return None, 'gmail_account_needs_confirmation'
    # The owner supplied this account during setup. Select it only when the
    # existing sender or login matches its digest; never guess an email address.
    account = normalized(config.get('smtp_user') if observed['usernameMatchesApprovedAccount'] else config.get('smtp_admin_email'))
    if not re.fullmatch(r'[^\s@]+@(?:gmail\.com|googlemail\.com)', account):
        return None, 'gmail_account_needs_confirmation'
    desired = {'smtp_host': 'smtp.gmail.com', 'smtp_user': account, 'smtp_admin_email': account,
               'smtp_port': int(config['smtp_port']) if observed['portSupported'] else 465}
    patch = {key: value for key, value in desired.items() if str(config.get(key)) != str(value)}
    return patch, None


def request_config(token, patch=None):
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    req = Request(f'https://api.supabase.com/v1/projects/{PROJECT}/config/auth',
                  data=json.dumps(patch).encode() if patch is not None else None,
                  method='PATCH' if patch is not None else 'GET', headers=headers)
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def main():
    report = {'checked': False, 'applied': False, 'valid': False, 'changedFields': [], 'error': None}
    try:
        token = os.environ.get('SUPABASE_ACCESS_TOKEN', '')
        if not token:
            report['error'] = 'management_authorization_missing'
            return report
        config = request_config(token)
        report['checked'] = True
        report['before'] = facts(config)
        patch, error = plan(config)
        if error:
            report['error'] = error
            return report
        if patch:
            request_config(token, patch)
            report['applied'] = True
            report['changedFields'] = sorted(patch)
        verified = facts(request_config(token))
        report['after'] = verified
        report['valid'] = all(verified.get(key) for key in ('gmailSelected', 'portSupported', 'senderMatchesUsername', 'senderMatchesApprovedAccount'))
        if not report['valid']:
            report['error'] = 'settings_not_confirmed'
    except HTTPError as error:
        report['error'] = 'management_http_error'
        report['httpStatus'] = error.code
    except (URLError, TimeoutError):
        report['error'] = 'management_connection_error'
    except (ValueError, TypeError, KeyError):
        report['error'] = 'unexpected_configuration_response'
    return report


if __name__ == '__main__':
    from datetime import datetime, timezone
    result = main()
    result['createdAt'] = datetime.now(timezone.utc).isoformat()
    result['commit'] = os.environ.get('GITHUB_SHA', '')
    result['runUrl'] = 'https://github.com/FSLRV/demo-repository/actions/runs/' + os.environ.get('GITHUB_RUN_ID', '')
    destination = Path(os.environ['RUNNER_TEMP']) / 'mr1-email-status.json'
    destination.write_text(json.dumps(result, indent=2) + '\n')
    print('Checagem de campos SMTP concluída; nenhum endereço, senha ou conteúdo de e-mail foi exibido.')
    sys.exit(0 if result['valid'] else 1)
