"""Customer tests use isolated SQLite stores, never real users or providers."""
import json
import tempfile
import time
import unittest
import uuid

import server
from customers import CustomerService


class CustomerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mr1-customer-test-")
        self.store = server.Store(self.tmp.name, {})
        self.accounts = CustomerService(self.store, server.APIError, server.password_hash, server.password_matches)
        self.password = "Fixture-password-12345"

    def tearDown(self):
        self.tmp.cleanup()

    def register(self, name="Cliente Um", email="customer1@example.test", ip="fixture-register"):
        return self.accounts.register({"name": name, "email": email, "password": self.password}, ip)

    def insert_order(self, customer_id, email="customer1@example.test", status="paid"):
        id_ = uuid.uuid4().hex
        snapshot = [{"id": "tee-essential", "name": "Camiseta Essential MR1", "size": "M", "quantity": 2, "unitPrice": 14990}]
        customer = {"name": "Pessoa do pedido", "email": email, "address": {"city": "São Paulo"}}
        with self.store.db() as db:
            db.execute("""INSERT INTO orders(id,token_hash,idempotency,request_hash,status,stock_state,
                       items,customer,subtotal,shipping,total,quote_id,created,expires,customer_id)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (id_, "fixture-hash", uuid.uuid4().hex, "fixture-request", status, "committed",
                        json.dumps(snapshot), json.dumps(customer), 29980, 1990, 31970, "fixture-quote",
                        int(time.time()), int(time.time()) + 60, customer_id))
        return id_

    def test_registration_hashes_password_and_does_not_create_admin(self):
        token, info = self.accounts.register({"name": " Cliente Um ", "email": "CUSTOMER1@example.test",
                                             "password": self.password, "role": "admin"}, "fixture")
        self.assertTrue(info["authenticated"])
        self.assertEqual(info["name"], "Cliente Um")
        self.assertEqual(info["email"], "customer1@example.test")
        self.assertEqual(info["csrfToken"], self.accounts.session(token)["csrfToken"])
        with self.store.db() as db:
            row = db.execute("SELECT * FROM customers").fetchone()
            self.assertNotIn(self.password, row["password_hash"])
            self.assertTrue(server.password_matches(self.password, row["password_hash"]))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM admins").fetchone()[0], 0)
            session = db.execute("SELECT token_hash FROM customer_sessions").fetchone()
            self.assertNotEqual(session[0], token)
        with self.assertRaises(server.APIError) as error:
            self.register(email="customer1@example.test", ip="different-ip")
        self.assertEqual(error.exception.status, 409)

    def test_invalid_registration_and_rate_limit(self):
        for update in ({"password": "short"}, {"name": ""}, {"name": "A\nB"}, {"email": "bad"}, {"password": {"value": "x"}}):
            payload = {"name": "Cliente Um", "email": "customer1@example.test", "password": self.password, **update}
            with self.subTest(update=update), self.assertRaises(server.APIError):
                self.accounts.register(payload, "validation-ip")
        for _ in range(5):
            with self.assertRaises(server.APIError):
                self.accounts.register({}, "validation-ip")
        with self.assertRaises(server.APIError) as error:
            self.register(ip="validation-ip")
        self.assertEqual(error.exception.status, 429)

    def test_login_logout_expiry_and_rate_limits_do_not_affect_admin_namespace(self):
        token, _ = self.register()
        self.accounts.logout(token)
        self.assertEqual(self.accounts.session_info(token), {"authenticated": False})
        token, info = self.accounts.login({"email": "CUSTOMER1@example.test", "password": self.password}, "login-ip")
        self.assertTrue(info["authenticated"])
        with self.store.db() as db:
            db.execute("UPDATE customer_sessions SET expires=0")
        self.assertIsNone(self.accounts.session(token))
        for _ in range(5):
            with self.assertRaises(server.APIError) as error:
                self.accounts.login({"email": "customer1@example.test", "password": "wrong"}, "abusive-ip")
            self.assertEqual(error.exception.status, 401)
        with self.assertRaises(server.APIError) as error:
            self.accounts.login({"email": "customer1@example.test", "password": self.password}, "abusive-ip")
        self.assertEqual(error.exception.status, 429)
        self.store.create_admin("owner@example.test", self.password)
        _, admin = self.store.login({"email": "owner@example.test", "password": self.password}, "abusive-ip")
        self.assertTrue(admin["authenticated"])

    def test_favorites_are_private_persistent_idempotent_and_follow_product_deletion(self):
        _, first = self.register()
        _, second = self.register(name="Cliente Dois", email="customer2@example.test")
        product = self.store.products()[0]
        self.accounts.add_favorite(first["id"], product["id"])
        self.accounts.add_favorite(first["id"], product["id"])
        self.assertEqual([p["id"] for p in self.accounts.favorites(first["id"])], [product["id"]])
        self.assertEqual(self.accounts.favorites(second["id"]), [])
        # Another user's remove request never affects the owner's list.
        self.accounts.remove_favorite(second["id"], product["id"])
        self.assertEqual(len(self.accounts.favorites(first["id"])), 1)
        restored_store = server.Store(self.tmp.name, {})
        restored = CustomerService(restored_store, server.APIError, server.password_hash, server.password_matches)
        self.assertEqual(len(restored.favorites(first["id"])), 1)
        with self.assertRaises(server.APIError) as error:
            self.accounts.add_favorite(first["id"], "nonexistent")
        self.assertEqual(error.exception.status, 404)
        self.store.delete_product(product["id"])
        self.assertEqual(self.accounts.favorites(first["id"]), [])

    def test_history_uses_authenticated_id_and_never_claims_matching_email(self):
        _, first = self.register()
        _, second = self.register(name="Cliente Dois", email="customer2@example.test")
        first_order = self.insert_order(first["id"])
        second_order = self.insert_order(second["id"], email=first["email"])
        guest_order = self.insert_order(None, email=first["email"])
        first_history = self.accounts.orders(first["id"])
        self.assertEqual([o["id"] for o in first_history], [first_order])
        self.assertEqual(first_history[0]["total"], 319.7)
        self.assertEqual(first_history[0]["items"][0]["unitPrice"], 149.9)
        self.assertNotIn("customer", first_history[0])
        self.assertEqual([o["id"] for o in self.accounts.orders(second["id"])], [second_order])
        detail = self.accounts.order(first["id"], first_order)
        self.assertEqual(detail["items"][0]["quantity"], 2)
        for forbidden in (second_order, guest_order):
            with self.subTest(order=forbidden), self.assertRaises(server.APIError) as error:
                self.accounts.order(first["id"], forbidden)
            self.assertEqual(error.exception.status, 404)

    def test_migration_is_repeatable_and_preserves_existing_guest_orders(self):
        guest = self.insert_order(None)
        self.accounts.initialize()
        self.accounts.initialize()
        with self.store.db() as db:
            self.assertIsNone(db.execute("SELECT customer_id FROM orders WHERE id=?", (guest,)).fetchone()[0])
            self.assertEqual(len([c for c in db.execute("PRAGMA table_info(orders)") if c[1] == "customer_id"]), 1)


if __name__ == "__main__":
    unittest.main()
