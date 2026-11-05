"""Integration tests use isolated temporary databases and mocked provider responses.

No real account, remote API, customer data or payment is involved.
"""
import base64
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock

import server


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mr1-test-")
        self.env = {"MR1_PUBLIC_URL": "https://shop.example.test", "MP_ACCESS_TOKEN": "fixture-access",
                    "MP_WEBHOOK_SECRET": "fixture-signature", "MELHOR_ENVIO_TOKEN": "fixture-shipping",
                    "MR1_PAYMENT_PROVIDER": "mercadopago", "MR1_SHIPPING_PROVIDER": "melhorenvio"}
        self.store = server.Store(self.tmp.name, self.env)
        self.product = self.store.products()[0]
        self.product["measurementsConfirmed"] = True
        self.store.save_product(self.product, self.product["id"])
        self.items = [{"id": self.product["id"], "size": "M", "quantity": 2}]
        self.customer = {"name": "Cliente de teste", "email": "test@example.test", "phone": "11999999999",
                         "address": {"cep": "05879450", "street": "Rua de teste", "number": "10", "complement": "", "neighborhood": "Bairro", "city": "São Paulo", "state": "SP"}}
        self.payment = {}
        self.provider_calls = []

        def provider(url, payload=None, headers=None):
            self.provider_calls.append((url, payload))
            if "shipment/calculate" in url:
                return [{"id": 1, "name": "PAC", "company": {"name": "Correios"}, "price": "22.90", "custom_price": "19.90", "delivery_time": 5},
                        {"id": 2, "name": "Not available", "error": "not available"}]
            if "checkout/preferences" in url:
                return {"id": "fixture-preference", "init_point": "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=fixture", "sandbox_init_point": "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=fixture"}
            if "/payments/" in url:
                return self.payment
            raise AssertionError(url)

        self.store.provider_json = provider

    def tearDown(self):
        self.tmp.cleanup()

    def quote(self, items=None):
        return self.store.quote({"cep": "05879-450", "items": items or self.items})["quotes"][0]

    def checkout(self):
        q = self.quote()
        value = {"items": self.items, "quoteId": q["id"], "customer": self.customer}
        response = self.store.checkout(value, "fixture-key-0000000001")
        return response, value

    def sign_webhook(self, status="approved", amount=None, currency="BRL", id_="123456"):
        response, _ = self.checkout()
        self.payment = {"id": int(id_), "external_reference": response["orderId"], "status": status,
                        "transaction_amount": amount if amount is not None else 319.70, "currency_id": currency}
        ts, request_id = str(int(time.time())), "fixture-request"
        manifest = f"id:{id_};request-id:{request_id};ts:{ts};"
        signature = hmac.new(self.env["MP_WEBHOOK_SECRET"].encode(), manifest.encode(), hashlib.sha256).hexdigest()
        return response, id_, request_id, f"ts={ts},v1={signature}"

    def test_catalog_is_persistent_and_not_reseeded_when_empty(self):
        self.store.save_product(dict(self.product, price=99.90), self.product["id"])
        self.assertEqual(server.Store(self.tmp.name, self.env).products()[0]["price"], 99.9)
        for p in self.store.products():
            self.store.delete_product(p["id"])
        self.assertEqual(server.Store(self.tmp.name, self.env).products(), [])

    def test_validation_and_photo_upload(self):
        for update in ({"price": -1}, {"oldPrice": 10}, {"stock": True}, {"image": "javascript:alert(1)"}, {"weight": 0}, {"sizes": []}):
            with self.subTest(update=update), self.assertRaises(server.APIError):
                self.store.save_product(dict(self.product, **update), self.product["id"])
        image = base64.b64encode(b"\x89PNG\r\n\x1a\n" + bytes(20)).decode()
        url = self.store.upload({"dataUrl": "data:image/png;base64," + image})
        self.assertTrue((self.store.uploads / url.split("/")[-1]).is_file())
        with self.assertRaises(server.APIError):
            self.store.upload({"dataUrl": "data:image/png;base64," + base64.b64encode(b"<script>bad</script>").decode()})

    def test_login_hash_session_and_rate_limit(self):
        self.store.create_admin("owner@example.test", "test-password-long")
        with self.store.db() as db:
            stored = db.execute("SELECT password_hash FROM admins").fetchone()[0]
            self.assertNotIn("test-password-long", stored)
        token, session = self.store.login({"email": "OWNER@example.test", "password": "test-password-long"}, "fixture-ip")
        self.assertTrue(self.store.session_info(token)["authenticated"])
        self.assertEqual(self.store.session(token)["csrf"], session["csrfToken"])
        self.store.logout(token)
        self.assertFalse(self.store.session_info(token)["authenticated"])
        for _ in range(5):
            with self.assertRaises(server.APIError) as error:
                self.store.login({"email": "owner@example.test", "password": "wrong"}, "abusive-ip")
            self.assertEqual(error.exception.status, 401)
        with self.assertRaises(server.APIError) as error:
            self.store.login({"email": "owner@example.test", "password": "test-password-long"}, "abusive-ip")
        self.assertEqual(error.exception.status, 429)

    def test_stock_aggregated_across_sizes(self):
        with self.store.db() as db:
            with self.assertRaises(server.APIError) as error:
                self.store.cart(db, [{"id": self.product["id"], "size": "M", "quantity": 15}, {"id": self.product["id"], "size": "G", "quantity": 15}])
        self.assertEqual(error.exception.code, "insufficient_stock")

    def test_shipping_uses_authoritative_measurements_and_real_adapter(self):
        q = self.quote()
        self.assertEqual(q["price"], 19.9)
        self.assertEqual(q["deliveryDays"], 5)
        url, payload = self.provider_calls[0]
        self.assertIn("sandbox.melhorenvio.com.br", url)
        self.assertEqual(payload["from"]["postal_code"], "05879450")
        self.assertEqual(payload["products"][0]["insurance_value"], self.product["price"])
        self.assertEqual(payload["products"][0]["quantity"], 2)

    def test_shipping_refuses_sample_measurements_or_missing_credentials(self):
        self.product["measurementsConfirmed"] = False
        self.store.save_product(self.product, self.product["id"])
        with self.assertRaises(server.APIError) as error:
            self.quote()
        self.assertEqual(error.exception.code, "shipping_measurements_required")
        del self.env["MELHOR_ENVIO_TOKEN"]
        with self.assertRaises(server.APIError) as error:
            self.quote()
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(self.provider_calls, [])

    def test_credentials_do_not_select_providers_implicitly(self):
        self.env.pop("MR1_PAYMENT_PROVIDER")
        self.env.pop("MR1_SHIPPING_PROVIDER")
        config = self.store.config()
        self.assertEqual(config["payment"]["provider"], "unconfigured")
        self.assertEqual(config["shipping"]["provider"], "unconfigured")
        self.assertFalse(config["payment"]["configured"])
        self.assertFalse(config["shipping"]["configured"])
        self.assertFalse(config["checkoutReady"])
        with self.assertRaises(server.APIError) as error:
            self.quote()
        self.assertEqual(error.exception.code, "shipping_provider_not_selected")
        with self.assertRaises(server.APIError) as error:
            self.store.webhook("123", "request", "")
        self.assertEqual(error.exception.code, "payment_provider_not_selected")
        self.assertEqual(self.provider_calls, [])

    def test_invalid_provider_shapes_fail_safely(self):
        self.store.provider_json = lambda *a, **k: [{"id": 1, "name": "PAC", "price": "19.90", "delivery_time": 5, "company": None}]
        self.assertEqual(self.quote()["company"], "")
        q = self.quote()
        self.store.provider_json = lambda *a, **k: []
        with self.assertRaises(server.APIError) as error:
            self.store.checkout({"items": self.items, "quoteId": q["id"], "customer": self.customer}, "fixture-key-0000000001")
        self.assertEqual(error.exception.code, "payment_unconfirmed")

    def test_free_shipping_has_no_zero_price_provider_line_item(self):
        original = self.store.provider_json
        def provider(url, payload=None, headers=None):
            if "shipment/calculate" in url:
                return [{"id": 1, "name": "PAC", "price": "22.90", "custom_price": 0, "delivery_time": 5}]
            return original(url, payload, headers)
        self.store.provider_json = provider
        self.checkout()
        payload = next(p for u, p in self.provider_calls if "preferences" in u)
        self.assertEqual(len(payload["items"]), 1)
        self.assertTrue(all(i["unit_price"] > 0 for i in payload["items"]))

    def test_quote_bound_to_cart_cep_and_price(self):
        q = self.quote()
        value = {"items": self.items, "quoteId": q["id"], "customer": dict(self.customer, address=dict(self.customer["address"], cep="01001000"))}
        with self.assertRaises(server.APIError) as error:
            self.store.checkout(value, "fixture-key-0000000001")
        self.assertEqual(error.exception.code, "quote_invalid")
        value["customer"] = self.customer
        self.store.save_product(dict(self.product, price=159.9), self.product["id"])
        with self.assertRaises(server.APIError):
            self.store.checkout(value, "fixture-key-0000000001")

    def test_checkout_prices_reserves_idempotency_and_no_payment_by_return_url(self):
        response, value = self.checkout()
        self.assertEqual(self.store.products()[0]["stock"], 18)
        payload = next(p for u, p in self.provider_calls if "preferences" in u)
        self.assertEqual(payload["items"][0]["unit_price"], 149.9)
        self.assertEqual(payload["items"][-1]["unit_price"], 19.9)
        self.assertNotIn("cost", payload["shipments"])
        self.assertTrue(payload["expires"])
        self.assertEqual(self.store.order_status(response["orderId"], response["orderToken"])["status"], "pending")
        repeated = self.store.checkout(value, "fixture-key-0000000001")
        self.assertEqual(repeated, response)
        self.assertEqual(len([u for u, _ in self.provider_calls if "preferences" in u]), 1)
        with self.assertRaises(server.APIError):
            self.store.order_status(response["orderId"], "incorrect")
        with self.assertRaises(server.APIError):
            self.store.save_product(self.product, self.product["id"])

    def test_provider_timeout_does_not_create_duplicate_preference(self):
        q = self.quote()
        value = {"items": self.items, "quoteId": q["id"], "customer": self.customer}
        self.store.provider_json = Mock(side_effect=server.APIError(502, "fixture timeout", "provider_unavailable"))
        with self.assertRaises(server.APIError) as error:
            self.store.checkout(value, "fixture-key-0000000001")
        self.assertEqual(error.exception.code, "payment_unconfirmed")
        with self.assertRaises(server.APIError) as error:
            self.store.checkout(value, "fixture-key-0000000001")
        self.assertEqual(error.exception.code, "order_in_progress")
        self.assertEqual(self.store.provider_json.call_count, 1)

    def test_webhook_hmac_amount_currency_and_idempotent_commit(self):
        response, id_, request_id, signature = self.sign_webhook()
        with self.assertRaises(server.APIError) as error:
            self.store.webhook(id_, request_id, signature[:-1] + ("0" if signature[-1] != "0" else "1"))
        self.assertEqual(error.exception.status, 401)
        self.payment["transaction_amount"] = 1
        with self.assertRaises(server.APIError) as error:
            self.store.webhook(id_, request_id, signature)
        self.assertEqual(error.exception.code, "payment_mismatch")
        self.payment["transaction_amount"] = 319.7
        self.payment["currency_id"] = "USD"
        with self.assertRaises(server.APIError):
            self.store.webhook(id_, request_id, signature)
        self.payment["currency_id"] = "BRL"
        self.store.webhook(id_, request_id, signature)
        self.store.webhook(id_, request_id, signature)
        self.assertEqual(self.store.products()[0]["stock"], 18)
        self.assertEqual(self.store.order_status(response["orderId"], response["orderToken"])["status"], "paid")

    def test_reservation_expiry_releases_once_but_verified_pending_keeps_stock(self):
        response, id_, request_id, signature = self.sign_webhook(status="pending")
        self.store.webhook(id_, request_id, signature)
        with self.store.db() as db:
            db.execute("UPDATE orders SET expires=0 WHERE id=?", (response["orderId"],))
        self.assertEqual(self.store.products()[0]["stock"], 18)
        self.payment["status"] = "rejected"
        self.store.webhook(id_, request_id, signature)
        self.store.products()
        self.store.products()
        self.assertEqual(self.store.products()[0]["stock"], 20)

    def test_late_approval_without_stock_goes_to_manual_review(self):
        response, id_, request_id, signature = self.sign_webhook()
        with self.store.db() as db:
            db.execute("UPDATE orders SET expires=0 WHERE id=?", (response["orderId"],))
        self.store.products()
        self.store.save_product(dict(self.product, stock=0), self.product["id"])
        self.store.webhook(id_, request_id, signature)
        self.assertEqual(self.store.order_status(response["orderId"], response["orderToken"])["status"], "paid_review")
        self.assertEqual(self.store.products()[0]["stock"], 0)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="mr1-http-test-")
        cls.store = server.Store(cls.tmp.name, {})
        cls.store.create_admin("owner@example.test", "test-password-long")
        cls.http = server.make_server(cls.store, port=0)
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        client = http.client.HTTPConnection("127.0.0.1", self.http.server_port)
        merged = {"Content-Type": "application/json", **(headers or {})}
        client.request(method, path, json.dumps(body) if body is not None else None, merged)
        response = client.getresponse()
        data, result_headers = response.read(), dict(response.getheaders())
        status = response.status
        client.close()
        return status, data, result_headers

    def test_private_paths_never_served(self):
        for path in ("/.git/config", "/server.py", "/README.md", "/tests/test_server.py", "/assets/%2e%2e/server.py", "/uploads/../server.py", "/node_modules/@primer/css/package.json"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.request("GET", "/")[0], 200)
        self.assertEqual(self.request("GET", "/api/products")[0], 200)

    def test_admin_authentication_cookie_csrf_and_cross_origin(self):
        self.assertEqual(self.request("POST", "/api/products", {})[0], 401)
        status, data, headers = self.request("POST", "/api/login", {"email": "owner@example.test", "password": "test-password-long"})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Lax", headers["Set-Cookie"])
        csrf = json.loads(data)["csrfToken"]
        cookie = headers["Set-Cookie"].split(";")[0]
        p = self.store.products()[0]
        self.assertEqual(self.request("PUT", "/api/products/" + p["id"], p, {"Cookie": cookie})[0], 403)
        self.assertEqual(self.request("PUT", "/api/products/" + p["id"], p, {"Cookie": cookie, "X-CSRF-Token": csrf, "Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("PUT", "/api/products/" + p["id"], p, {"Cookie": cookie, "X-CSRF-Token": csrf})[0], 200)
        self.assertEqual(self.request("POST", "/api/logout", {}, {"Cookie": cookie, "X-CSRF-Token": csrf})[0], 200)
        self.assertEqual(self.request("PUT", "/api/products/" + p["id"], p, {"Cookie": cookie, "X-CSRF-Token": csrf})[0], 401)

    def test_missing_integrations_are_explicit_not_simulated(self):
        self.assertEqual(self.request("POST", "/api/shipping", {})[0], 503)
        self.assertEqual(self.request("POST", "/api/checkout", {})[0], 503)
        status, data, _ = self.request("GET", "/api/config")
        self.assertEqual(status, 200)
        config = json.loads(data)
        self.assertFalse(config["checkoutReady"])
        self.assertEqual(config["payment"]["provider"], "unconfigured")
        self.assertEqual(config["shipping"]["provider"], "unconfigured")


if __name__ == "__main__":
    unittest.main()
