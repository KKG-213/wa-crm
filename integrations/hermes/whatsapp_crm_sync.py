"""Record Graph-accepted WhatsApp sends in the CRM; never send to WhatsApp.

Local source extension for Hermes bd0affe5. No agent tools or model hooks.
Only pending deliveries live on disk; successful CRM acknowledgements remove them.
"""
from __future__ import annotations

import asyncio
from contextlib import closing, suppress
from datetime import datetime, timezone
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)
DOMAIN = b"hermes-crm-outbound-v1\n"
TYPES = {"text", "image", "video", "audio", "document", "sticker", "interactive", "location", "contacts", "template"}


def sign_body(raw: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), DOMAIN + raw, hashlib.sha256).hexdigest()


def message_content(payload: dict) -> str:
    kind = payload.get("type")
    if kind == "text":
        return str((payload.get("text") or {}).get("body") or "")
    if kind == "interactive":
        data = payload.get("interactive") or {}
        parts = [str((data.get(key) or {}).get("text") or "") for key in ("header", "body", "footer")]
        action = data.get("action") or {}
        titles = [str((b.get("reply") or {}).get("title") or "") for b in action.get("buttons") or []]
        titles += [str(row.get("title") or "") for section in action.get("sections") or [] for row in section.get("rows") or []]
        if any(titles): parts.append("Options: " + " | ".join(filter(None, titles)))
        return "\n".join(filter(None, parts)) or "[interactive]"
    block = payload.get(kind) or {}
    if isinstance(block, dict) and block.get("caption"):
        return str(block["caption"])
    return f"[{kind}]"


class WhatsAppCrmSync:
    def __init__(self, endpoint: str, secret: str, phone_number_id: str, directory: Path, client):
        target = urlsplit(endpoint)
        if (target.scheme != "https" or not target.hostname or target.username or target.password
                or target.query or target.fragment or target.path != "/api/hermes/outbound"):
            raise ValueError("Invalid CRM endpoint")
        if not secret or not re.fullmatch(r"\d{6,32}", phone_number_id):
            raise ValueError("Missing CRM signing identity")
        self.endpoint, self.secret, self.phone_number_id = endpoint, secret, phone_number_id
        self.directory = Path(directory)
        self.db_path = self.directory / f"outbound-{phone_number_id}.sqlite3"
        self.client = client
        self.task = None
        self.wake = asyncio.Event()

    @classmethod
    async def create(cls, endpoint: str, secret: str, phone_number_id: str, directory: Path):
        if not endpoint.strip(): return None
        client = None
        try:
            import httpx
            # Dedicated client: the CRM must never receive the Graph access token.
            client = httpx.AsyncClient(timeout=5.0, follow_redirects=False)
            instance = cls(endpoint.strip(), secret, phone_number_id, directory, client)
            await asyncio.to_thread(instance.initialize)
            instance.task = asyncio.create_task(instance.run(), name="whatsapp-crm-sync")
            logger.info("[whatsapp_crm_sync] enabled")
            return instance
        except Exception:
            if client is not None:
                with suppress(Exception): await client.aclose()
            logger.error("[whatsapp_crm_sync] initialization_failed")
            return None

    def initialize(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        descriptor = os.open(self.db_path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        os.chmod(self.db_path, 0o600)
        with closing(sqlite3.connect(self.db_path, timeout=5)) as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS outbox(
                wamid TEXT PRIMARY KEY, body BLOB NOT NULL, created REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                last_error TEXT)""")

    async def capture(self, payload: dict, messages: list):
        try:
            recipient = str(payload.get("to") or "").removeprefix("+")
            kind = str(payload.get("type") or "")
            if kind not in TYPES or not re.fullmatch(r"\d{6,15}", recipient): return
            content = message_content(payload)
            if not content or len(content) > 65536: raise ValueError("Invalid content")
            sent_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            rows = []
            for message in messages:
                wamid = message.get("id") if isinstance(message, dict) else None
                if not isinstance(wamid, str) or not 0 < len(wamid) <= 512: continue
                event = {"version": 1, "phone_number_id": self.phone_number_id, "recipient": recipient,
                         "wamid": wamid, "message_type": kind, "content": content, "sent_at": sent_at}
                raw = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()
                if len(raw) > 256 * 1024: raise ValueError("Payload too large")
                rows.append((wamid, raw, time.time()))
            if rows:
                await asyncio.to_thread(self.enqueue, rows)
                self.wake.set()
        except Exception:
            # Meta has already accepted this send. Never turn a CRM write failure
            # into a WhatsApp send failure (which could resend the customer text).
            logger.error("[whatsapp_crm_sync] enqueue_failed")

    def enqueue(self, rows):
        with closing(sqlite3.connect(self.db_path, timeout=5)) as db, db:
            db.executemany("INSERT OR IGNORE INTO outbox(wamid,body,created) VALUES (?,?,?)", rows)

    def pending(self, now):
        with closing(sqlite3.connect(self.db_path, timeout=5)) as db:
            return db.execute("SELECT wamid,body,attempts FROM outbox WHERE next_attempt<=? ORDER BY created LIMIT 20", (now,)).fetchall()

    def complete(self, wamid):
        with closing(sqlite3.connect(self.db_path, timeout=5)) as db, db:
            db.execute("DELETE FROM outbox WHERE wamid=?", (wamid,))

    def retry(self, wamid, attempts, now, error):
        delay = min(300, 2 ** min(attempts, 9))
        with closing(sqlite3.connect(self.db_path, timeout=5)) as db, db:
            db.execute("UPDATE outbox SET attempts=attempts+1,next_attempt=?,last_error=? WHERE wamid=?", (now + delay, error, wamid))

    async def drain_once(self, now=None):
        now = time.time() if now is None else now
        for wamid, raw, attempts in await asyncio.to_thread(self.pending, now):
            error = "network_error"
            try:
                response = await self.client.post(self.endpoint, content=raw,
                    headers={"Content-Type": "application/json", "X-Hermes-Signature-256": sign_body(raw, self.secret)},
                    timeout=5.0, follow_redirects=False)
                if 200 <= response.status_code < 300:
                    data = response.json()
                    if data.get("status") == "ok" and isinstance(data.get("inserted"), bool):
                        await asyncio.to_thread(self.complete, wamid)
                        continue
                    error = "invalid_ack"
                else:
                    error = f"http_{response.status_code}"
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.to_thread(self.retry, wamid, attempts, now, error)
            logger.warning("[whatsapp_crm_sync] delivery_pending")

    async def run(self):
        while True:
            self.wake.clear()
            try:
                await self.drain_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("[whatsapp_crm_sync] worker_failed")
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=1.0)
            except TimeoutError:
                pass

    async def close(self):
        if self.task is not None:
            self.task.cancel()
            try: await self.task
            except asyncio.CancelledError: pass
            self.task = None
        await self.client.aclose()
