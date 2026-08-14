#!/usr/bin/env python3
"""
Persistent Vinted scraper daemon.

Keeps ONE authenticated aiohttp session alive and reuses it across many searches,
instead of the previous design where every single search spawned a brand-new Python
process and repeated Vinted's full cookie-bootstrap dance (homepage visit + up to 6
retries) from zero. That bootstrap was the dominant cost of every search (~1-2s).

Communicates with the Node.js parent over stdin/stdout using line-delimited JSON:
  Node writes:  {"id": "...", "search_text": "...", "max_price": 50}
  Daemon writes: {"id": "...", "success": true, "items": [...]}

Reusing one session is not just faster — it's also LESS suspicious to Vinted's anti-bot
system than repeatedly hitting the homepage for fresh cookies every 60-180s across 15
brands. Two safety mechanisms specifically address "don't get us blocked":
  1. MIN_REQUEST_GAP_SEC paces every outbound Vinted request through this session,
     regardless of how many concurrent Node workers ask at once.
  2. The session is proactively rotated (fresh bootstrap) every SESSION_MAX_AGE_SEC,
     not just on failure, so it never runs on one very old session indefinitely.
"""
import asyncio
import json
import sys
import time
import aiohttp

from vinted_helper import bootstrap_session, fetch_catalog, _build_api_headers

MIN_REQUEST_GAP_SEC = 0.3
SESSION_MAX_AGE_SEC = 25 * 60
MAX_CONSECUTIVE_FAILURES = 3


class VintedSessionManager:
    def __init__(self):
        self.session: aiohttp.ClientSession | None = None
        self.session_started_at = 0.0
        self.consecutive_failures = 0
        self.request_lock = asyncio.Lock()
        self.last_request_at = 0.0
        self.bootstrap_lock = asyncio.Lock()

    async def ensure_session(self) -> bool:
        async with self.bootstrap_lock:
            needs_bootstrap = (
                self.session is None
                or self.session.closed
                or (time.monotonic() - self.session_started_at) > SESSION_MAX_AGE_SEC
                or self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES
            )
            if not needs_bootstrap:
                return True

            if self.session and not self.session.closed:
                await self.session.close()

            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15.0))
            ok = await bootstrap_session(self.session)
            if ok:
                self.session_started_at = time.monotonic()
                self.consecutive_failures = 0
            return ok

    async def _pace(self):
        """Serializes and paces every outbound Vinted request (search AND enrichment) through
        this one session, so guaranteeing per-item enrichment coverage never turns into a burst."""
        async with self.request_lock:
            elapsed = time.monotonic() - self.last_request_at
            if elapsed < MIN_REQUEST_GAP_SEC:
                await asyncio.sleep(MIN_REQUEST_GAP_SEC - elapsed)
            self.last_request_at = time.monotonic()

    async def search(self, search_text: str, max_price=None) -> dict:
        ok = await self.ensure_session()
        if not ok:
            return {"success": False, "error": "NO_SESSION_COOKIE"}

        await self._pace()
        result = await fetch_catalog(self.session, search_text, max_price)
        if result.get("success"):
            self.consecutive_failures = 0
        else:
            self.consecutive_failures += 1
        return result

    async def enrich_seller(self, seller_id) -> dict:
        """Real seller rating + country for ONE seller — called by Node for every item that
        actually survives dedup and is about to be posted, guaranteeing full coverage of
        published deals instead of a partial, position-dependent subset of raw search results."""
        if not seller_id:
            return {"success": False, "error": "NO_SELLER_ID"}

        ok = await self.ensure_session()
        if not ok:
            return {"success": False, "error": "NO_SESSION_COOKIE"}

        await self._pace()
        api_headers = _build_api_headers(self.session)
        try:
            async with self.session.get(f"https://www.vinted.de/api/v2/users/{seller_id}", headers=api_headers) as ures:
                if ures.status != 200:
                    self.consecutive_failures += 1
                    return {"success": False, "error": "USER_HTTP_ERROR", "status": ures.status}

                udata = json.loads(await ures.text())
                user = udata.get("user", {}) if isinstance(udata, dict) else {}
                result: dict = {"success": True}
                if user.get("feedback_count") is not None:
                    result["reviewCount"] = int(user["feedback_count"])
                if user.get("feedback_reputation") is not None:
                    result["reviewRating"] = round(float(user["feedback_reputation"]) * 5, 2)
                if user.get("country_iso_code"):
                    result["sellerCountryCode"] = str(user["country_iso_code"]).upper()
                self.consecutive_failures = 0
                return result
        except Exception as e:
            self.consecutive_failures += 1
            return {"success": False, "error": "ENRICH_REQUEST_FAILED", "exception": str(e)}


async def handle_request(manager: VintedSessionManager, line: str):
    try:
        req = json.loads(line)
    except Exception:
        return

    req_id = req.get("id")

    try:
        if req.get("action") == "enrich_seller":
            result = await manager.enrich_seller(req.get("seller_id"))
        else:
            result = await manager.search(req.get("search_text", ""), req.get("max_price"))
    except Exception as e:
        result = {"success": False, "error": "DAEMON_EXCEPTION", "exception": str(e)}

    result["id"] = req_id
    print(json.dumps(result), flush=True)


async def main():
    manager = VintedSessionManager()

    ok = await manager.ensure_session()
    print(json.dumps({"type": "ready", "ok": ok}), flush=True)

    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break  # stdin closed -> Node parent exited, shut down cleanly
        decoded = line.decode().strip()
        if not decoded:
            continue
        asyncio.create_task(handle_request(manager, decoded))


if __name__ == "__main__":
    asyncio.run(main())
