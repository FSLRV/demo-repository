import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('repair_email', ROOT / 'scripts/repair-gmail-settings.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
OWNER = 'owner@example.test'


class EmailSettingsTests(unittest.TestCase):
    def setUp(self):
        self.digest = patch.object(helper, 'SMTP_ACCOUNT_HASH', helper.hashlib.sha256(OWNER.encode()).hexdigest())
        self.digest.start()
        self.addCleanup(self.digest.stop)

    def test_mismatched_user_and_port_are_corrected_without_changing_password(self):
        # Use a real Gmail-shaped fixture and an isolated digest for this test.
        email = 'fixture@gmail.com'
        with patch.object(helper, 'SMTP_ACCOUNT_HASH', helper.hashlib.sha256(email.encode()).hexdigest()):
            config = {'smtp_host': 'smtp.gmail.com', 'smtp_admin_email': email, 'smtp_user': 'wrong', 'smtp_port': 25, 'smtp_pass': 'fixture-private-password'}
            changes, error = helper.plan(config)
            self.assertIsNone(error)
            self.assertEqual(changes, {'smtp_user': email, 'smtp_port': 465})
            self.assertNotIn('smtp_pass', changes)
            self.assertNotIn('site_url', changes)
            self.assertNotIn(email, str(helper.facts(config)))
            self.assertNotIn('fixture-private-password', str(helper.facts(config)))

    def test_other_provider_or_unknown_mail_account_is_not_modified(self):
        self.assertEqual(helper.plan({'smtp_host': 'smtp.example.test'})[1], 'gmail_not_selected')
        self.assertEqual(helper.plan({'smtp_host': 'smtp.gmail.com', 'smtp_user': 'another@gmail.com', 'smtp_admin_email': 'another@gmail.com', 'smtp_port': 465})[1], 'gmail_account_needs_confirmation')

    def test_valid_gmail_settings_do_not_trigger_an_update(self):
        email = 'fixture@gmail.com'
        with patch.object(helper, 'SMTP_ACCOUNT_HASH', helper.hashlib.sha256(email.encode()).hexdigest()):
            config = {'smtp_host': 'smtp.gmail.com', 'smtp_admin_email': email, 'smtp_user': email, 'smtp_port': 587}
            self.assertEqual(helper.plan(config), ({}, None))

    def test_repair_is_verified_and_report_contains_no_credentials(self):
        email = 'fixture@gmail.com'
        initial = {'smtp_host': 'smtp.gmail.com', 'smtp_admin_email': email, 'smtp_user': 'wrong', 'smtp_port': 465, 'smtp_pass': 'fixture-private-password'}
        final = {**initial, 'smtp_user': email}
        with patch.object(helper, 'SMTP_ACCOUNT_HASH', helper.hashlib.sha256(email.encode()).hexdigest()), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN': 'fixture-management-token'}), patch.object(helper, 'request_config', side_effect=[initial, {}, final]) as request:
            report = helper.main()
        self.assertTrue(report['valid'])
        self.assertEqual(report['changedFields'], ['smtp_user'])
        self.assertEqual(request.call_args_list[1].args[1], {'smtp_user': email})
        self.assertNotIn(email, str(report))
        self.assertNotIn('fixture-private-password', str(report))
        self.assertNotIn('fixture-management-token', str(report))


if __name__ == '__main__':
    unittest.main()
