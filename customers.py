"""Customer accounts, favorites and order ownership for the MR1 store.

HTTP cookies, Origin and CSRF checks belong to the server handler. This module
receives the store and its password/error helpers to avoid importing server.py
again when it is executed as __main__.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import time
import uuid


CUSTOMER_SESSION_AGE = 30 * 24 * 3600


class CustomerService:
    def __init__(self, store, error_cls, hash_fn, verify_fn):
        self.store = store
        self.error = error_cls
        self.hash_password = hash_fn
        self.verify_password = verify_fn
        self.initialize()

    def initialize(self):
        """Idempotent migration; never replace existing customers or orders."""
        with self.store.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS customers(
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    created INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS customer_sessions(
                    token_hash TEXT PRIMARY KEY,
                    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                    csrf TEXT NOT NULL,
                    expires INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS customer_favorites(
                    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                    created INTEGER NOT NULL,
                    PRIMARY KEY(customer_id,product_id)
                );
                CREATE INDEX IF NOT EXISTS customer_session_owner
                    ON customer_sessions(customer_id);
            """)
            with db:
                db.execute("BEGIN IMMEDIATE")
                columns = {row[1] for row in db.execute("PRAGMA table_info(orders)")}
                if "customer_id" not in columns:
                    # NULL preserves guest order ownership. Never claim old orders
                    # merely because a new account supplies a matching e-mail.
                    db.execute("ALTER TABLE orders ADD COLUMN customer_id TEXT REFERENCES customers(id)")
                db.execute("CREATE INDEX IF NOT EXISTS order_customer_owner ON orders(customer_id,created)")

    @staticmethod
    def token_digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def _throttle(self, purpose, ip, limit):
        """Reserve a request before hashing, so parallel attempts count too."""
        now = int(time.time())
        key = self.token_digest("customer:" + purpose + ":" + str(ip))
        with self.store.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM login_attempts WHERE at<?", (now - 900,))
            if db.execute("SELECT COUNT(*) FROM login_attempts WHERE ip_hash=?", (key,)).fetchone()[0] >= limit:
                raise self.error(429, "Muitas tentativas. Aguarde 15 minutos para tentar novamente.", "account_rate_limited")
            db.execute("INSERT INTO login_attempts VALUES(?,?)", (key, now))
        return key

    def _credentials(self, value, registration=False):
        if not isinstance(value, dict):
            raise self.error(422, "Informe seus dados de acesso.", "invalid_account")
        email = value.get("email")
        password = value.get("password")
        if not isinstance(email, str) or not isinstance(password, str):
            raise self.error(422 if registration else 401, "E-mail ou senha inválidos.", "invalid_credentials")
        email = email.strip().lower()
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or not 1 <= len(password) <= 256:
            raise self.error(422 if registration else 401, "E-mail ou senha inválidos.", "invalid_credentials")
        if registration and len(password) < 12:
            raise self.error(422, "Crie uma senha com pelo menos 12 caracteres.", "weak_password")
        return email, password

    def _name(self, value):
        if not isinstance(value, str) or not 2 <= len(value.strip()) <= 100 or any(ord(char) < 32 for char in value):
            raise self.error(422, "Informe seu nome, com 2 a 100 caracteres.", "invalid_name")
        return value.strip()

    def _new_session(self, db, customer_id):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        db.execute("DELETE FROM customer_sessions WHERE expires<=?", (int(time.time()),))
        db.execute("INSERT INTO customer_sessions VALUES(?,?,?,?)",
                   (self.token_digest(token), customer_id, csrf, int(time.time()) + CUSTOMER_SESSION_AGE))
        return token

    def register(self, value, ip):
        self._throttle("register", ip, 10)
        email, password = self._credentials(value, registration=True)
        name = self._name(value.get("name"))
        hashed = self.hash_password(password)
        id_ = uuid.uuid4().hex
        try:
            with self.store.db() as db, db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("INSERT INTO customers VALUES(?,?,?,?,?)", (id_, email, name, hashed, int(time.time())))
                token = self._new_session(db, id_)
        except sqlite3.IntegrityError:
            raise self.error(409, "Não foi possível criar esta conta. Se você já tem cadastro, entre com seu e-mail e senha.", "account_exists")
        return token, self.session_info(token)

    def login(self, value, ip):
        key = self._throttle("login", ip, 5)
        email, password = self._credentials(value)
        with self.store.db() as db:
            customer = db.execute("SELECT id,password_hash FROM customers WHERE email=?", (email,)).fetchone()
        verified = self.verify_password(password, customer["password_hash"] if customer else self.store.dummy_hash)
        if not customer or not verified:
            raise self.error(401, "E-mail ou senha inválidos.", "invalid_credentials")
        with self.store.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM login_attempts WHERE ip_hash=?", (key,))
            token = self._new_session(db, customer["id"])
        return token, self.session_info(token)

    def session(self, token):
        if not isinstance(token, str) or not token or len(token) > 200:
            return None
        with self.store.db() as db:
            row = db.execute("""SELECT c.id,c.email,c.name,s.csrf
                FROM customer_sessions s JOIN customers c ON c.id=s.customer_id
                WHERE s.token_hash=? AND s.expires>?""",
                (self.token_digest(token), int(time.time()))).fetchone()
        return {"id": row["id"], "name": row["name"], "email": row["email"], "csrfToken": row["csrf"]} if row else None

    def session_info(self, token):
        value = self.session(token)
        return {"authenticated": bool(value), **(value or {})}

    def logout(self, token):
        if not isinstance(token, str):
            return
        with self.store.db() as db:
            db.execute("DELETE FROM customer_sessions WHERE token_hash=?", (self.token_digest(token),))

    def favorites(self, customer_id):
        with self.store.db() as db:
            rows = db.execute("""SELECT p.* FROM customer_favorites f
                JOIN products p ON p.id=f.product_id WHERE f.customer_id=?
                ORDER BY f.created DESC,p.rowid DESC""", (customer_id,)).fetchall()
        return [self.store.product(row) for row in rows]

    def add_favorite(self, customer_id, product_id):
        if not isinstance(product_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", product_id):
            raise self.error(422, "Peça inválida.", "invalid_product")
        with self.store.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM customers WHERE id=?", (customer_id,)).fetchone():
                raise self.error(401, "Entre na sua conta para continuar.", "customer_authentication_required")
            if not db.execute("SELECT 1 FROM products WHERE id=?", (product_id,)).fetchone():
                raise self.error(404, "Esta peça não está mais disponível.", "product_not_found")
            exists = db.execute("SELECT 1 FROM customer_favorites WHERE customer_id=? AND product_id=?", (customer_id, product_id)).fetchone()
            if not exists and db.execute("SELECT COUNT(*) FROM customer_favorites WHERE customer_id=?", (customer_id,)).fetchone()[0] >= 500:
                raise self.error(422, "Sua lista já tem 500 favoritos. Remova uma peça antes de adicionar outra.", "favorites_limit")
            db.execute("INSERT OR IGNORE INTO customer_favorites VALUES(?,?,?)", (customer_id, product_id, int(time.time())))
        return {"favorited": True, "productId": product_id}

    def remove_favorite(self, customer_id, product_id):
        with self.store.db() as db:
            db.execute("DELETE FROM customer_favorites WHERE customer_id=? AND product_id=?", (customer_id, product_id))
        return {"favorited": False, "productId": product_id}

    def orders(self, customer_id):
        with self.store.db() as db:
            rows = db.execute("""SELECT id,status,items,subtotal,shipping,total,created
                FROM orders WHERE customer_id=? ORDER BY created DESC,rowid DESC LIMIT 100""", (customer_id,)).fetchall()
        return [{"id": row["id"], "status": row["status"], "created": row["created"],
                 "subtotal": row["subtotal"] / 100, "shipping": row["shipping"] / 100,
                 "total": row["total"] / 100,
                 "items": [dict(item, unitPrice=item["unitPrice"] / 100) for item in json.loads(row["items"])]}
                for row in rows]

    def order(self, customer_id, order_id):
        """Return only an authenticated owner's order, never an e-mail match."""
        with self.store.db() as db:
            row = db.execute("SELECT * FROM orders WHERE id=? AND customer_id=?", (order_id, customer_id)).fetchone()
            if not row:
                raise self.error(404, "Pedido não encontrado.", "order_not_found")
            quote = db.execute("SELECT data FROM quotes WHERE id=?", (row["quote_id"],)).fetchone()
        return {"id": row["id"], "status": row["status"], "created": row["created"],
                "subtotal": row["subtotal"] / 100, "shipping": row["shipping"] / 100,
                "total": row["total"] / 100,
                "items": [dict(item, unitPrice=item["unitPrice"] / 100) for item in json.loads(row["items"])],
                "customer": json.loads(row["customer"]), "shippingService": json.loads(quote["data"]) if quote else None}
