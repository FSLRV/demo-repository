#!/usr/bin/env python3
"""MR1 storefront: SQLite catalog, authenticated administration and provider adapters.

Run `python3 server.py create-admin --email owner@example.com` before administration.
Provider credentials are read only from the server environment, never returned by APIs.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import getpass
import hashlib
import hmac
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen
import uuid

ROOT = Path(__file__).resolve().parent
CATEGORIES = {"camisetas", "moletons", "calcas", "acessorios"}
ORIGIN_CEP = "05879450"
MAX_BODY = 3_000_000
SESSION_AGE = 8 * 3600
RESERVATION_AGE = 30 * 60


class APIError(Exception):
    def __init__(self, status, message, code="request_error", details=None):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code
        self.details = details or {}


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def cents(value):
    if isinstance(value, bool):
        raise ValueError("Invalid amount")
    amount = Decimal(str(value))
    if not amount.is_finite() or amount != amount.quantize(Decimal("0.01")):
        raise ValueError("Invalid amount")
    return int(amount * 100)


def password_hash(password):
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600000)
    return f"pbkdf2-sha256$600000${salt}${key.hex()}"


def password_matches(password, encoded):
    try:
        algorithm, iterations, salt, expected = encoded.split("$")
        if algorithm != "pbkdf2-sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def default_catalog():
    common = {"weight": 0.3, "width": 25, "height": 5, "length": 30,
              "measurementsConfirmed": False, "description": "Essencial para acompanhar o seu estilo. Confirme os detalhes da peça com a loja."}
    values = [
        ("tee-essential", "Camiseta Essential MR1", "camisetas", 149.90, 179.90, "product-tee-mr1.jpg", ["P", "M", "G", "GG"], 20, "#142b49"),
        ("hoodie-heavy", "Moletom Heavy Club", "moletons", 289.90, None, "product-hoodie.jpg", ["P", "M", "G", "GG"], 15, "#142b49"),
        ("cargo-utility", "Calça Cargo Utility", "calcas", 249.90, 299.90, "product-cargo.jpg", ["38", "40", "42", "44"], 12, "#88765b"),
        ("cap-signature", "Boné Signature MR1", "acessorios", 99.90, None, "product-cap-mr1.jpg", ["Único"], 18, "#88765b"),
        ("tee-offwhite", "Camiseta Off White", "camisetas", 139.90, None, "product-tee-white.jpg", ["P", "M", "G", "GG"], 16, "#f4f7f8"),
        ("hoodie-concrete", "Moletom Concrete", "moletons", 269.90, 319.90, "product-hoodie-gray.jpg", ["P", "M", "G", "GG"], 10, "#b4b6b5"),
    ]
    return [dict(common, id=id_, name=name, category=category, price=price, oldPrice=old,
                 image="assets/" + image, sizes=sizes, stock=stock, color=color, badge="")
            for id_, name, category, price, old, image, sizes, stock, color in values]


class Store:
    def __init__(self, data_dir=None, environ=None):
        self.env = os.environ if environ is None else environ
        self.data_dir = Path(data_dir or self.env.get("MR1_DATA_DIR", "/workspace/.mr1-data")).resolve()
        if self.data_dir == ROOT or ROOT in self.data_dir.parents:
            raise ValueError("MR1_DATA_DIR must remain outside the public checkout")
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.uploads = self.data_dir / "uploads"
        self.uploads.mkdir(mode=0o700, exist_ok=True)
        self.path = self.data_dir / "store.sqlite3"
        self.dummy_hash = password_hash(secrets.token_urlsafe(32))
        with self.db() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,data TEXT NOT NULL,stock INTEGER NOT NULL CHECK(stock>=0));
                CREATE TABLE IF NOT EXISTS admins(email TEXT PRIMARY KEY,password_hash TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,email TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS login_attempts(ip_hash TEXT NOT NULL,at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,cart_hash TEXT NOT NULL,cep TEXT NOT NULL,price INTEGER NOT NULL,data TEXT NOT NULL,expires INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,idempotency TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,stock_state TEXT NOT NULL,items TEXT NOT NULL,customer TEXT NOT NULL,subtotal INTEGER NOT NULL,shipping INTEGER NOT NULL,total INTEGER NOT NULL,quote_id TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,checkout_url TEXT,payment_id TEXT,provider_error TEXT);
                CREATE INDEX IF NOT EXISTS orders_expiry ON orders(stock_state,expires);
            """)
            # An empty catalog after intentional deletion must stay empty.
            db.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            if not db.execute("SELECT value FROM metadata WHERE key='initialized'").fetchone():
                with db:
                    db.execute("BEGIN IMMEDIATE")
                    for p in default_catalog():
                        db.execute("INSERT INTO products VALUES(?,?,?)", (p["id"], compact(p), p["stock"]))
                    db.execute("INSERT INTO metadata VALUES('initialized','1')")
        os.chmod(self.path, 0o600)
        from customers import CustomerService
        from site_settings import SiteSettings
        self.customers = CustomerService(self, APIError, password_hash, password_matches)
        self.site_settings = SiteSettings(self, APIError)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
        finally:
            connection.close()

    def config(self):
        public = self.public_url()
        payment_provider = "mercadopago" if self.env.get("MR1_PAYMENT_PROVIDER") == "mercadopago" else "unconfigured"
        shipping_provider = "melhorenvio" if self.env.get("MR1_SHIPPING_PROVIDER") == "melhorenvio" else "unconfigured"
        payment = bool(payment_provider == "mercadopago" and self.env.get("MP_ACCESS_TOKEN") and self.env.get("MP_WEBHOOK_SECRET"))
        shipping = bool(shipping_provider == "melhorenvio" and self.env.get("MELHOR_ENVIO_TOKEN"))
        return {"payment": {"provider": payment_provider, "configured": payment, "sandbox": self.env.get("MP_SANDBOX", "true").lower() != "false"},
                "shipping": {"provider": shipping_provider, "configured": shipping, "origin": ORIGIN_CEP,
                             "sandbox": self.env.get("MELHOR_ENVIO_SANDBOX", "true").lower() != "false"},
                "publicUrlConfigured": bool(public), "checkoutReady": bool(payment and shipping and public)}

    def public_url(self):
        value = self.env.get("MR1_PUBLIC_URL", "").rstrip("/")
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            return ""
        if parsed.hostname in ("localhost", "127.0.0.1", "::1"):
            return ""
        return value

    @staticmethod
    def product(row):
        data = json.loads(row["data"])
        data["stock"] = row["stock"]
        return data

    def release_expired(self, db):
        now = int(time.time())
        for order in db.execute("SELECT * FROM orders WHERE stock_state='reserved' AND expires<? AND status NOT IN ('payment_pending','payment_in_process')", (now,)).fetchall():
            for item in json.loads(order["items"]):
                db.execute("UPDATE products SET stock=stock+? WHERE id=?", (item["quantity"], item["id"]))
            db.execute("UPDATE orders SET stock_state='released',status=CASE WHEN status IN ('creating','pending') THEN 'expired' ELSE status END WHERE id=?", (order["id"],))

    def products(self):
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.release_expired(db)
            return [self.product(row) for row in db.execute("SELECT * FROM products ORDER BY rowid")]

    def validate_product(self, value, id_=None):
        try:
            if not isinstance(value, dict):
                raise ValueError()
            p = {"id": id_ or uuid.uuid4().hex, "name": str(value["name"]).strip(), "category": value["category"],
                 "price": cents(value["price"]) / 100, "oldPrice": cents(value["oldPrice"]) / 100 if value.get("oldPrice") is not None else None,
                 "image": str(value["image"]).strip(), "sizes": value["sizes"], "stock": value["stock"],
                 "color": value.get("color", "#142b49"), "badge": str(value.get("badge", ""))[:30],
                 "description": str(value.get("description", ""))[:1000]}
            if not (1 <= len(p["name"]) <= 100 and p["category"] in CATEGORIES and 0 < p["price"] <= 100000):
                raise ValueError()
            if p["oldPrice"] is not None and not p["price"] < p["oldPrice"] <= 100000:
                raise ValueError()
            if type(p["stock"]) is not int or not 0 <= p["stock"] <= 99999:
                raise ValueError()
            if not isinstance(p["sizes"], list) or not 1 <= len(p["sizes"]) <= 15 or not all(isinstance(s, str) and 1 <= len(s.strip()) <= 12 for s in p["sizes"]):
                raise ValueError()
            p["sizes"] = list(dict.fromkeys(s.strip() for s in p["sizes"]))
            image = p["image"]
            valid_local = re.fullmatch(r"/?assets/[a-zA-Z0-9._/-]+", image) and ".." not in image
            valid_upload = re.fullmatch(r"/uploads/[0-9a-f]{32}\.(jpg|png|webp)", image)
            remote = urlparse(image)
            if not (valid_local or valid_upload or (remote.scheme == "https" and remote.hostname and not remote.username)):
                raise ValueError()
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(p["color"])):
                p["color"] = "#142b49"
            for field, upper in (("weight", 100), ("width", 200), ("height", 200), ("length", 200)):
                num = float(value.get(field, 0))
                if not 0 < num <= upper:
                    raise ValueError()
                p[field] = num
            p["measurementsConfirmed"] = value.get("measurementsConfirmed") is True
            return p
        except (KeyError, ValueError, TypeError, InvalidOperation, OverflowError):
            raise APIError(422, "Revise nome, categoria, preços, tamanhos, estoque, foto e peso/medidas positivos.", "invalid_product")

    def save_product(self, value, id_=None):
        p = self.validate_product(value, id_)
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.release_expired(db)
            if id_:
                if not db.execute("SELECT id FROM products WHERE id=?", (id_,)).fetchone():
                    raise APIError(404, "Peça não encontrada.")
                # Avoid silently invalidating pending orders or modifying reserved inventory.
                if self.has_reservation(db, id_):
                    raise APIError(409, "Esta peça tem um pedido aguardando pagamento. Aguarde a reserva terminar para editar.", "product_reserved")
                db.execute("UPDATE products SET data=?,stock=? WHERE id=?", (compact(p), p["stock"], id_))
            else:
                db.execute("INSERT INTO products VALUES(?,?,?)", (p["id"], compact(p), p["stock"]))
        return p

    @staticmethod
    def has_reservation(db, id_):
        return any(any(i["id"] == id_ for i in json.loads(row["items"])) for row in db.execute("SELECT items FROM orders WHERE stock_state='reserved'"))

    def delete_product(self, id_):
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.release_expired(db)
            if self.has_reservation(db, id_):
                raise APIError(409, "A peça tem uma reserva de pedido ativa.", "product_reserved")
            if not db.execute("DELETE FROM products WHERE id=?", (id_,)).rowcount:
                raise APIError(404, "Peça não encontrada.")

    def create_admin(self, email, password):
        email = email.strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
            raise ValueError("Informe um e-mail válido.")
        if len(password) < 12 or len(password) > 256:
            raise ValueError("A senha deve ter de 12 a 256 caracteres.")
        hashed = password_hash(password)
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO admins VALUES(?,?) ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash", (email, hashed))
            db.execute("DELETE FROM sessions WHERE email=?", (email,))

    def session(self, token):
        if not token:
            return None
        with self.db() as db:
            row = db.execute("SELECT email,csrf FROM sessions WHERE token_hash=? AND expires>?", (digest(token), int(time.time()))).fetchone()
            return dict(row) if row else None

    def session_info(self, token):
        session = self.session(token)
        with self.db() as db:
            configured = bool(db.execute("SELECT 1 FROM admins LIMIT 1").fetchone())
        return {"authenticated": bool(session), "adminConfigured": configured,
                **({"email": session["email"], "csrfToken": session["csrf"]} if session else {})}

    def login(self, value, ip):
        email, password = str(value.get("email", "")).strip().lower(), str(value.get("password", ""))
        if len(password) > 256 or len(email) > 254:
            raise APIError(401, "E-mail ou senha inválidos.", "invalid_credentials")
        now, ip_hash = int(time.time()), digest(ip)
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM login_attempts WHERE at<?", (now - 900,))
            if db.execute("SELECT COUNT(*) FROM login_attempts WHERE ip_hash=?", (ip_hash,)).fetchone()[0] >= 5:
                raise APIError(429, "Muitas tentativas. Aguarde 15 minutos para tentar novamente.", "login_rate_limited")
            row = db.execute("SELECT password_hash FROM admins WHERE email=?", (email,)).fetchone()
        # Always perform the expensive hash, including nonexistent users.
        good = password_matches(password, row[0] if row else self.dummy_hash) and row is not None
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            if not good:
                db.execute("INSERT INTO login_attempts VALUES(?,?)", (ip_hash, now))
            else:
                db.execute("DELETE FROM login_attempts WHERE ip_hash=?", (ip_hash,))
                token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
                db.execute("DELETE FROM sessions WHERE expires<?", (now,))
                db.execute("INSERT INTO sessions VALUES(?,?,?,?)", (digest(token), email, csrf, now + SESSION_AGE))
        if not good:
            raise APIError(401, "E-mail ou senha inválidos.", "invalid_credentials")
        return token, {"authenticated": True, "email": email, "csrfToken": csrf, "adminConfigured": True}

    def logout(self, token):
        with self.db() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (digest(token),))

    def upload(self, value):
        data_url = value.get("dataUrl", "")
        if not isinstance(data_url, str) or len(data_url) > 2_800_000:
            raise APIError(422, "Use uma foto JPG, PNG ou WebP de até 2 MB.", "invalid_upload")
        match = re.fullmatch(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)", data_url)
        if not match:
            raise APIError(422, "Formato de imagem inválido.", "invalid_upload")
        try:
            data = base64.b64decode(match[2], validate=True)
        except ValueError:
            raise APIError(422, "Imagem inválida.", "invalid_upload")
        kind = match[1]
        valid = ((kind == "jpeg" and data.startswith(b"\xff\xd8\xff")) or
                 (kind == "png" and data.startswith(b"\x89PNG\r\n\x1a\n")) or
                 (kind == "webp" and data.startswith(b"RIFF") and data[8:12] == b"WEBP"))
        if not valid or not 12 <= len(data) <= 2_000_000:
            raise APIError(422, "Arquivo não corresponde a uma foto válida de até 2 MB.", "invalid_upload")
        name = uuid.uuid4().hex + (".jpg" if kind == "jpeg" else "." + kind)
        path = self.uploads / name
        with path.open("xb") as file:
            file.write(data)
        os.chmod(path, 0o600)
        return "/uploads/" + name

    def cart(self, db, items, measurements=False):
        if not isinstance(items, list) or not 1 <= len(items) <= 100:
            raise APIError(422, "Adicione peças válidas à sacola.", "invalid_cart")
        normalized, quantities = {}, {}
        for line in items:
            if not isinstance(line, dict) or not isinstance(line.get("id"), str) or type(line.get("quantity")) is not int or not 1 <= line["quantity"] <= 999:
                raise APIError(422, "Quantidade ou peça inválida.", "invalid_cart")
            row = db.execute("SELECT * FROM products WHERE id=?", (line["id"],)).fetchone()
            if not row:
                raise APIError(409, "Uma peça da sacola não está mais disponível.", "invalid_cart")
            p = self.product(row)
            if line.get("size") not in p["sizes"]:
                raise APIError(422, "Selecione um tamanho disponível.", "invalid_cart")
            quantities[p["id"]] = quantities.get(p["id"], 0) + line["quantity"]
            if quantities[p["id"]] > p["stock"]:
                raise APIError(409, f"Estoque insuficiente: {p['name']}.", "insufficient_stock")
            if measurements and not p.get("measurementsConfirmed"):
                raise APIError(422, "A loja precisa confirmar o peso e as medidas reais de todas as peças antes de cotar o frete.", "shipping_measurements_required")
            key = (p["id"], line["size"])
            if key in normalized:
                normalized[key]["quantity"] += line["quantity"]
            else:
                normalized[key] = {"id": p["id"], "size": line["size"], "quantity": line["quantity"], "name": p["name"],
                                   "unitPrice": cents(p["price"]), "weight": p["weight"], "width": p["width"], "height": p["height"], "length": p["length"]}
        return sorted(normalized.values(), key=lambda x: (x["id"], x["size"]))

    @staticmethod
    def cart_hash(items):
        return digest(compact(items))

    def provider_json(self, url, payload=None, headers=None):
        request = Request(url, data=compact(payload).encode() if payload is not None else None,
                          headers={"Accept": "application/json", "Content-Type": "application/json", **(headers or {})})
        try:
            with urlopen(request, timeout=25) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise APIError(502, "Resposta do provedor excedeu o limite.", "provider_response_invalid")
                return json.loads(raw)
        except HTTPError as error:
            # Never include provider response bodies: they may echo credentials or PII.
            raise APIError(502, f"O provedor recusou a operação (HTTP {error.code}). Revise a conta e tente novamente.", "provider_rejected")
        except (URLError, TimeoutError, json.JSONDecodeError, OSError):
            raise APIError(502, "Não foi possível confirmar a resposta do provedor. Tente novamente mais tarde.", "provider_unavailable")

    def quote(self, value):
        if self.config()["shipping"]["provider"] != "melhorenvio":
            raise APIError(503, "Provedor de frete ainda não selecionado. Informe à loja qual serviço será utilizado.", "shipping_provider_not_selected")
        if not self.env.get("MELHOR_ENVIO_TOKEN"):
            raise APIError(503, "Frete real ainda não foi ativado. Falta configurar a conta Melhor Envio no servidor.", "shipping_not_configured")
        cep = re.sub(r"\D", "", str(value.get("cep", "")))
        if not re.fullmatch(r"\d{8}", cep) or len(set(cep)) == 1:
            raise APIError(422, "Informe um CEP válido com 8 números.", "invalid_cep")
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.release_expired(db)
            items = self.cart(db, value.get("items"), measurements=True)
        sandbox = self.env.get("MELHOR_ENVIO_SANDBOX", "true").lower() != "false"
        host = "sandbox.melhorenvio.com.br" if sandbox else "melhorenvio.com.br"
        result = self.provider_json(f"https://{host}/api/v2/me/shipment/calculate",
                                   {"from": {"postal_code": ORIGIN_CEP}, "to": {"postal_code": cep},
                                    "products": [{"id": i["id"], "width": i["width"], "height": i["height"], "length": i["length"],
                                                  "weight": i["weight"], "insurance_value": i["unitPrice"] / 100, "quantity": i["quantity"]} for i in items],
                                    "options": {"receipt": False, "own_hand": False}},
                                   {"Authorization": "Bearer " + self.env["MELHOR_ENVIO_TOKEN"], "User-Agent": "MR1Streetwear/1.0"})
        if not isinstance(result, list):
            raise APIError(502, "Resposta de frete inválida.", "provider_response_invalid")
        quotes, expires = [], int(time.time()) + 600
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM quotes WHERE expires<? AND id NOT IN (SELECT quote_id FROM orders)", (int(time.time()),))
            for option in result[:50]:
                if not isinstance(option, dict) or option.get("error"):
                    continue
                try:
                    price = cents(option.get("custom_price") if option.get("custom_price") not in (None, "") else option["price"])
                    days = int(option.get("custom_delivery_time") or option["delivery_time"])
                    if not 0 <= price <= 1000000 or not 0 <= days <= 365:
                        continue
                    q = {"id": uuid.uuid4().hex, "serviceId": str(option["id"]), "name": str(option["name"])[:100],
                         "company": str((option.get("company") or {}).get("name", ""))[:100], "price": price / 100,
                         "deliveryDays": days, "days": days, "expiresAt": expires}
                    db.execute("INSERT INTO quotes VALUES(?,?,?,?,?,?)", (q["id"], self.cart_hash(items), cep, price, compact(q), expires))
                except (KeyError, ValueError, TypeError, InvalidOperation):
                    continue
                quotes.append(q)
        if not quotes:
            raise APIError(422, "Nenhuma modalidade de entrega foi retornada para esta sacola e CEP.", "shipping_unavailable")
        return {"quotes": sorted(quotes, key=lambda q: q["price"]), "origin": ORIGIN_CEP, "cep": cep, "sandbox": sandbox}

    def customer(self, value):
        if not isinstance(value, dict) or not isinstance(value.get("address"), dict):
            raise APIError(422, "Preencha seus dados e endereço de entrega.", "invalid_customer")
        address = value["address"]
        clean = {"name": str(value.get("name", "")).strip(), "email": str(value.get("email", "")).strip().lower(),
                 "phone": re.sub(r"\D", "", str(value.get("phone", ""))),
                 "address": {field: str(address.get(field, "")).strip() for field in ("cep", "street", "number", "complement", "neighborhood", "city", "state")}}
        a = clean["address"]
        a["cep"] = re.sub(r"\D", "", a["cep"])
        a["state"] = a["state"].upper()
        states = {"AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"}
        if not (2 <= len(clean["name"]) <= 100 and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", clean["email"]) and len(clean["email"]) <= 254
                and 10 <= len(clean["phone"]) <= 13 and re.fullmatch(r"\d{8}", a["cep"]) and a["state"] in states
                and all(1 <= len(a[field]) <= 150 for field in ("street", "number", "neighborhood", "city")) and len(a["complement"]) <= 150):
            raise APIError(422, "Revise nome, e-mail, telefone e endereço completo.", "invalid_customer")
        return clean

    def checkout(self, value, idempotency, customer_id=None):
        if not self.config()["checkoutReady"]:
            raise APIError(503, "Pagamento ainda não foi ativado. A loja precisa selecionar e configurar os provedores de pagamento e frete, a verificação do pagamento e o endereço público HTTPS.", "payment_not_configured")
        if not isinstance(idempotency, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", idempotency):
            raise APIError(422, "Identificador do pedido ausente. Atualize a página.", "idempotency_required")
        customer = self.customer(value.get("customer"))
        quote_id = value.get("quoteId")
        request_hash = digest(compact({"items": value.get("items"), "quoteId": quote_id, "customer": customer, "accountId": customer_id}))
        now, token = int(time.time()), secrets.token_urlsafe(32)
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.release_expired(db)
            previous = db.execute("SELECT * FROM orders WHERE idempotency=?", (idempotency,)).fetchone()
            if previous:
                if previous["request_hash"] != request_hash:
                    raise APIError(409, "Este identificador já pertence a outro pedido.", "idempotency_conflict")
                if previous["checkout_url"] and previous["expires"] > now and previous["stock_state"] == "reserved":
                    # The original order token is deterministically reproducible only via HMAC server secret.
                    return self.checkout_response(previous)
                raise APIError(409, "Este pedido já está em processamento ou expirou. Consulte seu status antes de criar outro.", "order_in_progress", {"orderId": previous["id"], "orderToken": self.order_token(previous["id"])})
            items = self.cart(db, value.get("items"), measurements=True)
            q = db.execute("SELECT * FROM quotes WHERE id=? AND expires>?", (quote_id, now)).fetchone()
            if not q or q["cart_hash"] != self.cart_hash(items) or q["cep"] != customer["address"]["cep"]:
                raise APIError(409, "A cotação expirou ou não corresponde à sacola e ao CEP. Calcule novamente.", "quote_invalid")
            id_ = uuid.uuid4().hex
            # Stable opaque token lets legitimate retries receive the same response, without storing a raw secret.
            token = self.order_token(id_)
            subtotal = sum(i["unitPrice"] * i["quantity"] for i in items)
            for i in items:
                if db.execute("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?", (i["quantity"], i["id"], i["quantity"])).rowcount != 1:
                    raise APIError(409, "Uma peça acabou de esgotar. Atualize a sacola.", "insufficient_stock")
            db.execute("INSERT INTO orders(id,token_hash,idempotency,request_hash,status,stock_state,items,customer,subtotal,shipping,total,quote_id,created,expires,customer_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (id_, digest(token), idempotency, request_hash, "creating", "reserved", compact(items), compact(customer), subtotal, q["price"], subtotal + q["price"], quote_id, now, now + RESERVATION_AGE, customer_id))
        public = self.public_url()
        shipping_quote = json.loads(q["data"])
        payload = {"external_reference": id_,
                   "items": [{"id": i["id"], "title": i["name"] + " — " + i["size"], "quantity": i["quantity"], "unit_price": i["unitPrice"] / 100, "currency_id": "BRL"} for i in items] + ([{"id": "shipping", "title": "Entrega — " + shipping_quote["name"], "quantity": 1, "unit_price": q["price"] / 100, "currency_id": "BRL"}] if q["price"] > 0 else []),
                   "payer": {"name": customer["name"], "email": customer["email"]},
                   "shipments": {"mode": "not_specified", "receiver_address": {"zip_code": customer["address"]["cep"], "street_name": customer["address"]["street"], "street_number": customer["address"]["number"], "apartment": customer["address"]["complement"]}},
                   "notification_url": public + "/api/webhooks/mercadopago",
                   "back_urls": {status: f"{public}/?order={id_}&token={token}&status={status}" for status in ("success", "pending", "failure")},
                   "auto_return": "approved", "expires": True,
                   "expiration_date_from": datetime.fromtimestamp(now, timezone.utc).isoformat(),
                   "expiration_date_to": datetime.fromtimestamp(now + RESERVATION_AGE, timezone.utc).isoformat()}
        try:
            result = self.provider_json("https://api.mercadopago.com/checkout/preferences", payload,
                                        {"Authorization": "Bearer " + self.env["MP_ACCESS_TOKEN"], "X-Idempotency-Key": idempotency})
            if not isinstance(result, dict):
                raise APIError(502, "Resposta de pagamento inválida.", "provider_response_invalid")
            sandbox = self.env.get("MP_SANDBOX", "true").lower() != "false"
            url = result.get("sandbox_init_point") if sandbox else result.get("init_point")
            parsed = urlparse(str(url or ""))
            if parsed.scheme != "https" or not parsed.hostname or not (parsed.hostname == "mercadopago.com.br" or parsed.hostname.endswith(".mercadopago.com.br") or parsed.hostname.endswith(".mercadopago.com")):
                raise APIError(502, "Link de pagamento inválido na resposta do provedor.", "provider_response_invalid")
        except APIError as error:
            # A timeout is ambiguous: hold the reservation, do not issue another preference automatically.
            with self.db() as db:
                db.execute("UPDATE orders SET status='payment_unconfirmed',provider_error=? WHERE id=? AND status='creating'", (error.code, id_))
            raise APIError(502, "Não foi possível confirmar a criação do pagamento. Nenhum novo pagamento será criado para a mesma tentativa; a reserva expira em 30 minutos.", "payment_unconfirmed", {"orderId": id_, "orderToken": token})
        with self.db() as db:
            db.execute("UPDATE orders SET status=CASE WHEN status='creating' THEN 'pending' ELSE status END,checkout_url=? WHERE id=?", (url, id_))
            order = db.execute("SELECT * FROM orders WHERE id=?", (id_,)).fetchone()
            return self.checkout_response(order)

    def order_token(self, id_):
        # Persisted random local key is never available via HTTP or committed to the repository.
        path = self.data_dir / "order-token.key"
        try:
            key = path.read_bytes()
        except FileNotFoundError:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as file:
                    file.write(secrets.token_bytes(32))
            except FileExistsError:
                pass
            key = path.read_bytes()
        return hmac.new(key, id_.encode(), hashlib.sha256).hexdigest()

    def checkout_response(self, order):
        return {"orderId": order["id"], "orderToken": self.order_token(order["id"]), "checkoutUrl": order["checkout_url"], "status": order["status"]}

    def order_status(self, id_, token):
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.release_expired(db)
            row = db.execute("SELECT * FROM orders WHERE id=?", (id_,)).fetchone()
            if not row or not hmac.compare_digest(row["token_hash"], digest(token or "")):
                raise APIError(404, "Pedido não encontrado.")
            return {"orderId": row["id"], "status": row["status"], "total": row["total"] / 100, "expiresAt": row["expires"]}

    def webhook(self, data_id, request_id, signature):
        if self.config()["payment"]["provider"] != "mercadopago":
            raise APIError(503, "Provedor de pagamento ainda não selecionado.", "payment_provider_not_selected")
        secret = self.env.get("MP_WEBHOOK_SECRET", "")
        if not secret:
            raise APIError(503, "Webhook não configurado.", "webhook_not_configured")
        parts = dict(part.strip().split("=", 1) for part in signature.split(",") if "=" in part)
        ts, supplied = parts.get("ts", ""), parts.get("v1", "")
        if not re.fullmatch(r"\d{10,13}", ts) or not request_id or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", data_id):
            raise APIError(401, "Assinatura inválida.", "invalid_signature")
        seconds = int(ts) / (1000 if len(ts) == 13 else 1)
        if abs(time.time() - seconds) > 600:
            raise APIError(401, "Assinatura expirada.", "invalid_signature")
        manifest = f"id:{data_id.lower()};request-id:{request_id};ts:{ts};"
        expected = hmac.new(secret.encode(), manifest.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, supplied):
            raise APIError(401, "Assinatura inválida.", "invalid_signature")
        payment = self.provider_json("https://api.mercadopago.com/v1/payments/" + data_id,
                                     headers={"Authorization": "Bearer " + self.env.get("MP_ACCESS_TOKEN", "")})
        if not isinstance(payment, dict):
            raise APIError(502, "Resposta de pagamento inválida.", "provider_response_invalid")
        if str(payment.get("id")) != data_id:
            raise APIError(409, "Pagamento não corresponde à notificação.", "payment_mismatch")
        with self.db() as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.release_expired(db)
            row = db.execute("SELECT * FROM orders WHERE id=?", (str(payment.get("external_reference", "")),)).fetchone()
            if not row:
                raise APIError(404, "Pedido não encontrado.")
            try:
                exact = cents(payment.get("transaction_amount")) == row["total"]
            except (ValueError, InvalidOperation, TypeError):
                exact = False
            if not exact or payment.get("currency_id") != "BRL":
                raise APIError(409, "Valor ou moeda do pagamento diverge do pedido.", "payment_mismatch")
            # A different payment cannot roll back an already confirmed sale.
            if row["stock_state"] == "committed" and row["payment_id"] and row["payment_id"] != data_id:
                raise APIError(409, "Pedido já vinculado a outro pagamento.", "payment_mismatch")
            state, status = row["stock_state"], payment.get("status")
            if status == "approved":
                if state == "released":
                    items = json.loads(row["items"])
                    quantities = {}
                    for i in items:
                        quantities[i["id"]] = quantities.get(i["id"], 0) + i["quantity"]
                    can_commit = all((r := db.execute("SELECT stock FROM products WHERE id=?", (id_,)).fetchone()) and r[0] >= n for id_, n in quantities.items())
                    if not can_commit:
                        db.execute("UPDATE orders SET status='paid_review',payment_id=? WHERE id=?", (data_id, row["id"]))
                        return {"received": True, "status": "paid_review"}
                    for id_, n in quantities.items():
                        db.execute("UPDATE products SET stock=stock-? WHERE id=?", (n, id_))
                db.execute("UPDATE orders SET status='paid',stock_state='committed',payment_id=? WHERE id=?", (data_id, row["id"]))
            elif status in ("pending", "in_process", "authorized") and state == "reserved":
                db.execute("UPDATE orders SET status=? WHERE id=? AND stock_state='reserved'", ("payment_pending" if status == "pending" else "payment_in_process", row["id"]))
            elif status in ("cancelled", "rejected") and state == "reserved":
                for i in json.loads(row["items"]):
                    db.execute("UPDATE products SET stock=stock+? WHERE id=?", (i["quantity"], i["id"]))
                db.execute("UPDATE orders SET status=?,stock_state='released' WHERE id=?", (status, row["id"]))
            elif status in ("refunded", "charged_back") and row["payment_id"] == data_id:
                # Returned physical stock requires an explicit inventory operation by the owner.
                db.execute("UPDATE orders SET status=? WHERE id=?", (status, row["id"]))
        return {"received": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "MR1"

    @property
    def store(self):
        return self.server.store

    def log_message(self, format, *args):
        # URL query strings contain order access tokens; never log them or request bodies.
        code = str(args[1]) if len(args) > 1 else "-"
        print(f"{self.command} {urlparse(self.path).path} {code}", flush=True)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        if self.store.public_url():
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        super().end_headers()

    def send_json(self, value, status=200, cookie=None):
        payload = compact(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(payload)

    def body(self):
        if self.headers.get("Transfer-Encoding"):
            raise APIError(400, "Formato de requisição inválido.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise APIError(400, "Tamanho de requisição inválido.")
        if not 0 < length <= MAX_BODY:
            raise APIError(413, "Requisição vazia ou muito grande.")
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            raise APIError(415, "Use JSON na requisição.")
        try:
            value = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise APIError(400, "JSON inválido.")
        if not isinstance(value, dict):
            raise APIError(400, "O corpo precisa ser um objeto JSON.")
        return value

    def token(self, name="mr1_session"):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            return cookie[name].value if name in cookie else ""
        except Exception:
            return ""

    def same_origin(self):
        origin = self.headers.get("Origin")
        fetch_site = self.headers.get("Sec-Fetch-Site", "")
        if fetch_site == "cross-site":
            raise APIError(403, "Origem não permitida.", "origin_denied")
        if origin:
            allowed = self.store.public_url()
            if not allowed:
                host = self.headers.get("Host", "")
                if host not in ("localhost:8000", "127.0.0.1:8000", f"localhost:{self.server.server_port}", f"127.0.0.1:{self.server.server_port}"):
                    raise APIError(403, "Configure o endereço público HTTPS da loja.", "origin_denied")
                allowed = "http://" + host
            if not hmac.compare_digest(origin.rstrip("/"), allowed):
                raise APIError(403, "Origem não permitida.", "origin_denied")

    def require_admin(self):
        self.same_origin()
        session = self.store.session(self.token())
        if not session:
            raise APIError(401, "Entre no painel para continuar.", "authentication_required")
        if self.command not in ("GET", "HEAD") and not hmac.compare_digest(session["csrf"], self.headers.get("X-CSRF-Token", "")):
            raise APIError(403, "Sessão expirada ou token de segurança inválido. Entre novamente.", "csrf_invalid")
        return session

    def cookie(self, token, clear=False):
        secure = "; Secure" if self.store.public_url() else ""
        return f"mr1_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={0 if clear else SESSION_AGE}{secure}"

    def customer_cookie(self, token, clear=False):
        from customers import CUSTOMER_SESSION_AGE
        secure = "; Secure" if self.store.public_url() else ""
        return f"mr1_customer_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={0 if clear else CUSTOMER_SESSION_AGE}{secure}"

    def require_customer(self):
        self.same_origin()
        session = self.store.customers.session(self.token("mr1_customer_session"))
        if not session:
            raise APIError(401, "Entre na sua conta para continuar.", "customer_authentication_required")
        if self.command not in ("GET", "HEAD") and not hmac.compare_digest(session["csrfToken"], self.headers.get("X-CSRF-Token", "")):
            raise APIError(403, "Sessão inválida. Entre novamente para continuar.", "csrf_invalid")
        return session

    def send_css(self, css):
        payload = css.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/css; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_PUT(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def dispatch(self):
        try:
            parsed = urlparse(self.path)
            path, method = unquote(parsed.path), self.command
            if path == "/api/health" and method == "GET":
                with self.store.db() as db:
                    db.execute("SELECT 1").fetchone()
                return self.send_json({"status": "ok"})
            if path == "/api/site/theme.css" and method == "GET":
                return self.send_css(self.store.site_settings.css())
            if path == "/api/site/settings" and method == "GET":
                return self.send_json({"settings": self.store.site_settings.read()})
            if path == "/api/site/settings" and method == "PUT":
                self.require_admin()
                return self.send_json({"settings": self.store.site_settings.update(self.body())})
            if path == "/api/account/session" and method == "GET":
                return self.send_json(self.store.customers.session_info(self.token("mr1_customer_session")))
            if path in ("/api/account/register", "/api/account/login") and method == "POST":
                self.same_origin()
                action = self.store.customers.register if path.endswith("register") else self.store.customers.login
                token, info = action(self.body(), self.client_address[0])
                return self.send_json(info, 201 if path.endswith("register") else 200, cookie=self.customer_cookie(token))
            if path == "/api/account/logout" and method == "POST":
                self.require_customer()
                self.store.customers.logout(self.token("mr1_customer_session"))
                return self.send_json({"authenticated": False}, cookie=self.customer_cookie("", True))
            if path == "/api/account/favorites" and method == "GET":
                account = self.require_customer()
                return self.send_json({"products": self.store.customers.favorites(account["id"])})
            favorite_match = re.fullmatch(r"/api/account/favorites/([a-zA-Z0-9_-]{1,80})", path)
            if favorite_match and method in ("PUT", "DELETE"):
                account = self.require_customer()
                action = self.store.customers.add_favorite if method == "PUT" else self.store.customers.remove_favorite
                return self.send_json(action(account["id"], favorite_match[1]))
            if path == "/api/account/orders" and method == "GET":
                account = self.require_customer()
                return self.send_json({"orders": self.store.customers.orders(account["id"])})
            own_order = re.fullmatch(r"/api/account/orders/([a-f0-9]{32})", path)
            if own_order and method == "GET":
                account = self.require_customer()
                return self.send_json({"order": self.store.customers.order(account["id"], own_order[1])})
            if path == "/api/products" and method == "GET":
                return self.send_json({"products": self.store.products()})
            if path == "/api/config" and method == "GET":
                return self.send_json(self.store.config())
            if path == "/api/session" and method == "GET":
                return self.send_json(self.store.session_info(self.token()))
            if path == "/api/login" and method == "POST":
                self.same_origin()
                token, info = self.store.login(self.body(), self.client_address[0])
                return self.send_json(info, cookie=self.cookie(token))
            if path == "/api/logout" and method == "POST":
                self.require_admin()
                self.store.logout(self.token())
                return self.send_json({"authenticated": False}, cookie=self.cookie("", True))
            if path == "/api/products" and method == "POST":
                self.require_admin()
                return self.send_json({"product": self.store.save_product(self.body())}, 201)
            match = re.fullmatch(r"/api/products/([a-zA-Z0-9_-]{1,80})", path)
            if match and method in ("PUT", "DELETE"):
                self.require_admin()
                if method == "PUT":
                    return self.send_json({"product": self.store.save_product(self.body(), match[1])})
                self.store.delete_product(match[1])
                return self.send_json({"deleted": True})
            if path == "/api/uploads" and method == "POST":
                self.require_admin()
                return self.send_json({"url": self.store.upload(self.body())}, 201)
            if path == "/api/admin/orders" and method == "GET":
                self.require_admin()
                with self.store.db() as db:
                    orders = [{"id": row["id"], "status": row["status"], "total": row["total"] / 100, "created": row["created"]}
                              for row in db.execute("SELECT id,status,total,created FROM orders ORDER BY created DESC LIMIT 100")]
                return self.send_json({"orders": orders})
            match = re.fullmatch(r"/api/admin/orders/([a-f0-9]{32})", path)
            if match and method == "GET":
                self.require_admin()
                with self.store.db() as db:
                    row = db.execute("SELECT * FROM orders WHERE id=?", (match[1],)).fetchone()
                    if not row:
                        raise APIError(404, "Pedido não encontrado.")
                    quote = db.execute("SELECT data FROM quotes WHERE id=?", (row["quote_id"],)).fetchone()
                    order = {"id": row["id"], "status": row["status"], "created": row["created"], "expiresAt": row["expires"],
                             "total": row["total"] / 100, "subtotal": row["subtotal"] / 100, "shipping": row["shipping"] / 100,
                             "customer": json.loads(row["customer"]),
                             "items": [dict(i, unitPrice=i["unitPrice"] / 100) for i in json.loads(row["items"])],
                             "shippingService": json.loads(quote["data"]) if quote else None}
                return self.send_json({"order": order})
            if path == "/api/shipping" and method == "POST":
                self.same_origin()
                return self.send_json(self.store.quote(self.body()))
            if path == "/api/checkout" and method == "POST":
                self.same_origin()
                account = self.store.customers.session(self.token("mr1_customer_session"))
                if account and not hmac.compare_digest(account["csrfToken"], self.headers.get("X-Customer-CSRF-Token", "")):
                    raise APIError(403, "Atualize sua sessão de cliente antes de continuar.", "customer_csrf_invalid")
                return self.send_json(self.store.checkout(self.body(), self.headers.get("Idempotency-Key"), account["id"] if account else None), 201)
            match = re.fullmatch(r"/api/orders/([a-f0-9]{32})", path)
            if match and method == "GET":
                return self.send_json(self.store.order_status(match[1], parse_qs(parsed.query).get("token", [""])[0]))
            if path == "/api/webhooks/mercadopago" and method == "POST":
                # MP signs data.id from the URL query, not from an arbitrary body supplied by a caller.
                query = parse_qs(parsed.query)
                data_id = query.get("data.id", [""])[0]
                self.body()
                return self.send_json(self.store.webhook(data_id, self.headers.get("X-Request-Id", ""), self.headers.get("X-Signature", "")))
            if method == "GET" and not path.startswith("/api/"):
                return self.static(path)
            raise APIError(404, "Recurso não encontrado.")
        except APIError as error:
            return self.send_json({"error": error.message, "code": error.code, **error.details}, error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            # Do not disclose filesystem paths, SQL, secrets, payloads or provider errors.
            return self.send_json({"error": "Não foi possível concluir a operação.", "code": "internal_error"}, 500)

    def static(self, path):
        if path == "/":
            file = ROOT / "index.html"
        elif path in ("/index.html", "/styles.css", "/app.js", "/account.js", "/site-editor.js"):
            file = ROOT / path[1:]
        elif path.startswith("/assets/") and ".." not in path.split("/"):
            file = (ROOT / path[1:]).resolve()
            if ROOT / "assets" not in file.parents:
                raise APIError(404, "Arquivo não encontrado.")
        elif re.fullmatch(r"/uploads/[a-f0-9]{32}\.(jpg|png|webp)", path):
            file = self.store.uploads / path.split("/")[-1]
        else:
            raise APIError(404, "Arquivo não encontrado.")
        if not file.is_file() or file.is_symlink():
            raise APIError(404, "Arquivo não encontrado.")
        body = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache" if file.suffix in (".html", ".js", ".css") else "public,max-age=3600")
        self.end_headers()
        self.wfile.write(body)


def make_server(store, host="127.0.0.1", port=8000):
    server = ThreadingHTTPServer((host, port), Handler)
    server.store = store
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description="Servidor MR1 streetwear")
    subparsers = parser.add_subparsers(dest="command")
    serve = subparsers.add_parser("serve", help="Iniciar servidor")
    serve.add_argument("--host", default=os.environ.get("MR1_HOST", "127.0.0.1"))
    serve.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    admin = subparsers.add_parser("create-admin", help="Criar administrador ou redefinir sua senha localmente")
    admin.add_argument("--email", required=True)
    parser.add_argument("--host", default=os.environ.get("MR1_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    store = Store()
    if args.command == "create-admin":
        first = getpass.getpass("Senha de administrador (mínimo 12 caracteres): ")
        if first != getpass.getpass("Confirme a senha: "):
            parser.error("As senhas não coincidem.")
        try:
            store.create_admin(args.email, first)
        except ValueError as error:
            parser.error(str(error))
        print("Administrador configurado. Entre no painel com o e-mail informado.")
        return
    server = make_server(store, args.host, args.port)
    print(f"MR1 server on {args.host}:{args.port}; credentials and database remain outside the public root.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
