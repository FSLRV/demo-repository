"""Public presentation settings backed by SQLite, with no executable content.

HTTP handlers must enforce administrator authentication and CSRF before calling
``update``. Text is plain content: clients must use textContent/escaping when
rendering it. Provider credentials and account permissions are deliberately not
part of this schema.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


METADATA_KEY = "site-settings.v1"
ROOT = Path(__file__).resolve().parent
DEFAULTS = {
    "brandName": "MR1 streetwear",
    "logoUrl": "assets/logo-navy.svg",
    "logoLightUrl": "assets/logo-ice.svg",
    "heroImage": "assets/hero-branded.jpg",
    "announcementText": "STREETWEAR SEM RÓTULOS. FEITO PARA O SEU CORRE.",
    "heroEyebrow": "NOVA COLEÇÃO",
    "heroTitleLine1": "SEU ESTILO.",
    "heroTitleLine2": "SUAS",
    "heroTitleAccent": "REGRAS.",
    "heroDescription": "Da rua para o seu dia a dia. Peças que vestem atitude e deixam você ser quem é.",
    "heroButtonText": "ENCONTRE SEU ESTILO",
    "manifestoEyebrow": "MUITO ALÉM DO QUE VOCÊ VESTE",
    "manifestoTitleLine1": "A RUA É DE TODOS.",
    "manifestoTitleLine2": "O ESTILO É",
    "manifestoTitleAccent": "SEU.",
    "manifestoText": "Uma marca para quem cria o próprio caminho. Nascemos da cultura urbana e acreditamos que a melhor tendência é se sentir à vontade para ser você.",
    "footerText": "SEU ESTILO. SUAS REGRAS.\nSTREETWEAR INDEPENDENTE.",
    "contactEmail": "",
    "instagramUrl": "",
    "primaryColor": "#142B49",
    "accentColor": "#88765B",
    "backgroundColor": "#F4F7F8",
}
TEXT_LIMITS = {
    "brandName": 80,
    "announcementText": 200,
    "heroEyebrow": 80,
    "heroTitleLine1": 60,
    "heroTitleLine2": 60,
    "heroTitleAccent": 60,
    "heroDescription": 600,
    "heroButtonText": 60,
    "manifestoEyebrow": 100,
    "manifestoTitleLine1": 80,
    "manifestoTitleLine2": 80,
    "manifestoTitleAccent": 60,
    "manifestoText": 1200,
    "footerText": 350,
}
REQUIRED_TEXT = {"brandName", "heroTitleLine1", "heroButtonText"}
IMAGE_FIELDS = {"logoUrl", "logoLightUrl", "heroImage"}
COLOR_FIELDS = {"primaryColor", "accentColor", "backgroundColor"}


class SiteSettings:
    def __init__(self, store, error_cls):
        self.store = store
        self.error_cls = error_cls
        with store.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")

    def _invalid(self, field):
        raise self.error_cls(422, f"Revise o campo de aparência: {field}.", "invalid_site_settings")

    def _image(self, value, field):
        if not isinstance(value, str):
            self._invalid(field)
        value = value.strip()
        if not 1 <= len(value) <= 2048 or re.search(r"[\s<>\"'\\\x00-\x1f\x7f]", value):
            self._invalid(field)
        # Only known, repository-owned SVG files are permitted. User uploads use
        # the existing raster-image uploader, whose MIME and magic are checked.
        local = re.fullmatch(r"/?assets/[A-Za-z0-9._/-]+\.(?:svg|png|jpe?g|webp)", value, re.I)
        if local and all(part not in (".", "..") for part in value.split("/")):
            candidate = (ROOT / value.lstrip("/")).resolve()
            if ROOT / "assets" in candidate.parents and candidate.is_file():
                return value
            self._invalid(field)
        if re.fullmatch(r"/uploads/[a-f0-9]{32}\.(?:jpg|png|webp)", value):
            candidate = self.store.uploads / value.rsplit("/", 1)[-1]
            if candidate.is_file() and not candidate.is_symlink():
                return value
            self._invalid(field)
        try:
            url = urlsplit(value)
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.fragment or url.port not in (None, 443)
                    or re.search(r"[\x00-\x20\x7f\\]", unquote(value))
                    or url.path.lower().endswith((".svg", ".html", ".htm", ".js", ".css"))):
                self._invalid(field)
        except ValueError:
            self._invalid(field)
        return value

    def validate(self, payload):
        if not isinstance(payload, dict):
            self._invalid("configurações")
        if set(payload) - set(DEFAULTS):
            self._invalid("campo desconhecido")
        cleaned = {}
        for key, value in payload.items():
            if key in TEXT_LIMITS:
                if not isinstance(value, str):
                    self._invalid(key)
                value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
                if (len(value) > TEXT_LIMITS[key]
                        or re.search(r"[\x00-\x08\x0b-\x1f\x7f]", value)
                        or (key in REQUIRED_TEXT and not value)):
                    self._invalid(key)
                cleaned[key] = value
            elif key in IMAGE_FIELDS:
                cleaned[key] = self._image(value, key)
            elif key in COLOR_FIELDS:
                if not isinstance(value, str) or not re.fullmatch(r"#[A-Fa-f0-9]{6}", value):
                    self._invalid(key)
                cleaned[key] = value.upper()
            elif key == "contactEmail":
                if not isinstance(value, str):
                    self._invalid(key)
                value = value.strip().lower()
                if value and (len(value) > 254 or not re.fullmatch(r"[^\s@<>\"']+@[^\s@<>\"']+\.[^\s@<>\"']+", value)):
                    self._invalid(key)
                cleaned[key] = value
            elif key == "instagramUrl":
                if not isinstance(value, str):
                    self._invalid(key)
                value = value.strip()
                if value:
                    try:
                        url = urlsplit(value)
                        if (len(value) > 500 or url.scheme != "https" or url.hostname not in ("instagram.com", "www.instagram.com")
                                or url.username or url.password or url.port not in (None, 443) or url.fragment
                                or re.search(r"[\s<>\"'\\\x00-\x1f\x7f]", unquote(value))):
                            self._invalid(key)
                    except ValueError:
                        self._invalid(key)
                cleaned[key] = value
        return cleaned

    def _read(self, db):
        row = db.execute("SELECT value FROM metadata WHERE key=?", (METADATA_KEY,)).fetchone()
        if not row:
            return dict(DEFAULTS)
        try:
            stored = json.loads(row["value"])
            # Validate persisted content too, rather than returning unknown
            # metadata keys or accepting corrupted data as executable content.
            return {**DEFAULTS, **self.validate(stored)}
        except (json.JSONDecodeError, TypeError):
            raise self.error_cls(500, "Não foi possível carregar a aparência da loja.", "site_settings_unavailable")

    def read(self):
        with self.store.db() as db:
            return self._read(db)

    def update(self, payload):
        patch = self.validate(payload)
        with self.store.db() as db, db:
            # Read inside the same write transaction to preserve independent
            # partial updates submitted by multiple admin sessions.
            db.execute("BEGIN IMMEDIATE")
            settings = {**self._read(db), **patch}
            data = json.dumps(settings, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            db.execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (METADATA_KEY, data))
            return settings

    def css(self):
        """Return safe CSS for a same-origin stylesheet endpoint (no inline CSS)."""
        settings = self.read()
        primary, accent, background = (settings[key] for key in ("primaryColor", "accentColor", "backgroundColor"))
        # Only strict, validated #RRGGBB values are interpolated. No text, URL,
        # user-provided selector or arbitrary CSS is included.
        return (
            f":root{{--ink:{primary};--paper:{background};--acid:{accent};"
            f"--primary-color:{primary};--accent-color:{accent};--background-color:{background};}}\n"
            "body,.site-header,.hero-copy,dialog,.dialog-header{background:var(--paper);color:var(--ink)}\n"
            ".announcement,.button-dark,.manifesto,.bag-button #cart-count,.size-button.is-active,"
            ".category-filters button.is-active,.empty-state .button{background:var(--ink);color:var(--paper)}\n"
            ".ticker{background:var(--acid);color:var(--paper)}.ticker span{color:var(--paper)}\n"
            ".outlined-word{color:transparent;-webkit-text-stroke-color:var(--acid)}\n"
            ".title-dot,.hero .little-cross,.category-filters .sale-filter{color:var(--acid)}\n"
            ".category-filters .sale-filter.is-active{background:var(--acid);color:var(--paper)}\n"
            ".product-badge.sale{color:var(--ink);background:var(--paper);border-color:var(--acid)}\n"
            ".hero-coordinate,.hero-footnote,.hero-copy>p,.hero-footnote strong,.footer-top>p,"
            ".footer-bottom,.section-intro,.benefits small,.product-category{color:var(--ink)}\n"
            ".newsletter,.site-footer{background:color-mix(in srgb,var(--acid) 16%,var(--paper));color:var(--ink)}\n"
            ".newsletter .eyebrow,.newsletter h2>span{color:var(--accent-color)}\n"
            ".toast{border-left-color:var(--acid)}.close-button:hover{background:color-mix(in srgb,var(--acid) 20%,var(--paper))}\n"
            ".manifesto-copy h2 em,.manifesto-copy>a>span{color:var(--acid)}\n"
        )
