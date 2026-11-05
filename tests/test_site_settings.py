"""Settings tests use isolated databases and never change the live storefront."""
import base64
from concurrent.futures import ThreadPoolExecutor
import tempfile
import unittest

import server
from site_settings import DEFAULTS, METADATA_KEY, SiteSettings


class SiteSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mr1-settings-")
        self.store = server.Store(self.tmp.name, {})
        self.settings = SiteSettings(self.store, server.APIError)

    def tearDown(self):
        self.tmp.cleanup()

    def test_defaults_and_partial_updates_survive_restart(self):
        self.assertEqual(self.settings.read(), DEFAULTS)
        result = self.settings.update({"brandName": "Minha marca", "primaryColor": "#Aa1100"})
        self.assertEqual(result["primaryColor"], "#AA1100")
        self.settings.update({"heroDescription": "Uma coleção nova."})
        reopened = SiteSettings(server.Store(self.tmp.name, {}), server.APIError).read()
        self.assertEqual(reopened["brandName"], "Minha marca")
        self.assertEqual(reopened["heroDescription"], "Uma coleção nova.")
        self.assertEqual(reopened["heroImage"], DEFAULTS["heroImage"])
        self.assertEqual(reopened["primaryColor"], "#AA1100")

    def test_unknown_fields_and_executable_styles_are_rejected_atomically(self):
        invalid = [
            {"MP_ACCESS_TOKEN": "do-not-store"},
            {"primaryColor": "red; } body{display:none}"},
            {"accentColor": "#fff"},
            {"backgroundColor": 123},
            {"brandName": ""},
            {"heroButtonText": ""},
            {"heroTitleLine1": "A" * 61},
            {"heroDescription": "abc\x00def"},
            {"announcementText": False},
        ]
        for patch in invalid:
            with self.subTest(patch=patch), self.assertRaises(server.APIError) as caught:
                self.settings.update({"brandName": "Must not be saved", **patch})
            self.assertEqual(caught.exception.status, 422)
            self.assertEqual(self.settings.read(), DEFAULTS)

    def test_plain_text_is_preserved_without_entering_generated_css(self):
        text = '<script>alert("unsafe")</script><img src=x onerror=alert(1)>'
        settings = self.settings.update({"heroDescription": text})
        self.assertEqual(settings["heroDescription"], text)
        css = self.settings.css()
        self.assertNotIn(text, css)
        self.assertNotIn("<script", css)
        self.assertIn("--ink:#142B49", css)

    def test_image_urls_reject_scripts_traversal_unsafe_svg_and_credentials(self):
        invalid = [
            "javascript:alert(1)", "data:image/svg+xml,<svg onload=alert(1)>",
            "assets/../server.py", "/assets/../assets/logo-navy.svg", "assets/missing.png",
            "https://example.test/logo.svg", "http://example.test/logo.png",
            "https://token@example.test/logo.png", "https://example.test/logo.png#frag",
            "https://example.test:444/logo.png", "https://example.test/%0aevil.png",
            "https://example.test/logo.png' onerror='alert(1)",
            "/uploads/" + "a" * 32 + ".png",
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(server.APIError):
                self.settings.update({"logoUrl": value})
        self.assertEqual(self.settings.update({"logoUrl": "assets/logo-navy.svg"})["logoUrl"], "assets/logo-navy.svg")
        remote = "https://images.example.test/logo.png?version=2"
        self.assertEqual(self.settings.update({"logoUrl": remote})["logoUrl"], remote)

    def test_real_raster_upload_can_be_selected_for_logo(self):
        png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"fixture-image-data").decode()
        url = self.store.upload({"dataUrl": "data:image/png;base64," + png})
        self.assertEqual(self.settings.update({"logoUrl": url})["logoUrl"], url)

    def test_contact_fields_are_optional_but_validated(self):
        saved = self.settings.update({"contactEmail": " CONTACT@EXAMPLE.TEST ", "instagramUrl": "https://www.instagram.com/mr1/"})
        self.assertEqual(saved["contactEmail"], "contact@example.test")
        for patch in ({"contactEmail": "abc"}, {"contactEmail": "a@b.test\nBcc:x@y.test"},
                      {"instagramUrl": "javascript:alert(1)"}, {"instagramUrl": "https://instagram.com.attacker.test/x"},
                      {"instagramUrl": "https://token@instagram.com/x"}):
            with self.subTest(patch=patch), self.assertRaises(server.APIError):
                self.settings.update(patch)
        self.assertEqual(self.settings.update({"contactEmail": "", "instagramUrl": ""})["contactEmail"], "")

    def test_parallel_partial_updates_do_not_drop_other_fields(self):
        updates = [("brandName", "Concorrente"), ("primaryColor", "#112233"),
                   ("heroEyebrow", "COLEÇÃO 02"), ("footerText", "Novo rodapé")]
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda item: self.settings.update({item[0]: item[1]}), updates))
        result = self.settings.read()
        for key, value in updates:
            self.assertEqual(result[key], value)

    def test_settings_are_isolated_from_operational_metadata(self):
        self.settings.update({"brandName": "Custom"})
        with self.store.db() as db:
            self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='initialized'").fetchone()[0], "1")
            self.assertTrue(db.execute("SELECT value FROM metadata WHERE key=?", (METADATA_KEY,)).fetchone())
        self.assertEqual(len(self.store.products()), 6)


if __name__ == "__main__":
    unittest.main()
