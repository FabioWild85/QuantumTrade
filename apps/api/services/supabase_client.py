"""
Supabase client singleton — shared across all services.
Falls back gracefully if SUPABASE_URL is not configured yet (local dev).
"""

import asyncio
import os
import logging
from typing import Optional

log = logging.getLogger(__name__)

_client = None


async def run_db(fn):
    """Offload una chiamata Supabase bloccante al thread pool, liberando l'event loop."""
    return await asyncio.to_thread(fn)


def get_supabase():
    """Return the Supabase client. Call once per request, not per module load."""
    global _client
    if _client is not None:
        return _client

    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

    if not url or not key:
        log.warning("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using stub client")
        return _StubClient()

    from supabase import create_client
    _client = create_client(url, key)
    return _client


class _StubClient:
    """No-op Supabase client for local dev without Supabase credentials."""

    class _StubQuery:
        def __init__(self, data=None):
            self._data = data or []

        def select(self, *a, **kw): return self
        def insert(self, *a, **kw): return self
        def upsert(self, *a, **kw): return self
        def update(self, *a, **kw): return self
        def delete(self, *a, **kw): return self
        def eq(self, *a, **kw): return self
        def gte(self, *a, **kw): return self
        def lte(self, *a, **kw): return self
        def gt(self, *a, **kw): return self
        def lt(self, *a, **kw): return self
        def order(self, *a, **kw): return self
        def limit(self, *a, **kw): return self

        def execute(self):
            class R:
                data = []
            return R()

    def table(self, name: str):
        return self._StubQuery()
