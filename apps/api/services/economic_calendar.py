"""
Economic Calendar Service — Macro Event Pause

Data sources:
  Primary:  Static 2026 calendar (FOMC confirmed from federalreserve.gov,
            CPI/NFP from BLS release schedule, PPI/JOLTS estimated)
  Extended: Auto-fetch next-year FOMC from federalreserve.gov (best-effort, async)
  Future:   FMP API (/stable/economic-calendar) if user has a paid plan key

All times in UTC. FOMC: 14:00 ET (18:00 UTC Mar-Oct EDT, 19:00 UTC Nov-Feb EST).
CPI/NFP/PPI: 08:30 ET (12:30 UTC EDT, 13:30 UTC EST). JOLTS: 10:00 ET.
DST 2026: spring forward Mar 8, fall back Nov 1.
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

log = logging.getLogger(__name__)
UTC = timezone.utc

# ── Static 2026 event calendar ────────────────────────────────────────────────
_STATIC_2026: list[dict] = [
    # FOMC — confirmed from federalreserve.gov/monetarypolicy/fomccalendars.htm
    {"type": "fomc", "name": "FOMC Rate Decision", "dt": "2026-01-28T19:00:00Z"},
    {"type": "fomc", "name": "FOMC Rate Decision", "dt": "2026-03-18T18:00:00Z"},
    {"type": "fomc", "name": "FOMC Rate Decision", "dt": "2026-04-29T18:00:00Z"},
    {"type": "fomc", "name": "FOMC Rate Decision", "dt": "2026-06-17T18:00:00Z"},
    {"type": "fomc", "name": "FOMC Rate Decision", "dt": "2026-07-29T18:00:00Z"},
    {"type": "fomc", "name": "FOMC Rate Decision", "dt": "2026-09-16T18:00:00Z"},
    {"type": "fomc", "name": "FOMC Rate Decision", "dt": "2026-10-28T18:00:00Z"},
    {"type": "fomc", "name": "FOMC Rate Decision", "dt": "2026-12-09T19:00:00Z"},
    # CPI — BLS release schedule 2026
    {"type": "cpi", "name": "CPI USA",             "dt": "2026-05-12T12:30:00Z"},
    {"type": "cpi", "name": "CPI USA",             "dt": "2026-06-10T12:30:00Z"},
    {"type": "cpi", "name": "CPI USA",             "dt": "2026-07-15T12:30:00Z"},
    {"type": "cpi", "name": "CPI USA",             "dt": "2026-08-12T12:30:00Z"},
    {"type": "cpi", "name": "CPI USA",             "dt": "2026-09-09T12:30:00Z"},
    {"type": "cpi", "name": "CPI USA",             "dt": "2026-10-14T12:30:00Z"},
    {"type": "cpi", "name": "CPI USA",             "dt": "2026-11-12T13:30:00Z"},
    {"type": "cpi", "name": "CPI USA",             "dt": "2026-12-11T13:30:00Z"},
    # NFP — first Friday of month (Jul 10 due to Jul 4 observed holiday)
    {"type": "nfp", "name": "Non-Farm Payrolls",   "dt": "2026-05-08T12:30:00Z"},
    {"type": "nfp", "name": "Non-Farm Payrolls",   "dt": "2026-06-05T12:30:00Z"},
    {"type": "nfp", "name": "Non-Farm Payrolls",   "dt": "2026-07-10T12:30:00Z"},
    {"type": "nfp", "name": "Non-Farm Payrolls",   "dt": "2026-08-07T12:30:00Z"},
    {"type": "nfp", "name": "Non-Farm Payrolls",   "dt": "2026-09-04T12:30:00Z"},
    {"type": "nfp", "name": "Non-Farm Payrolls",   "dt": "2026-10-02T12:30:00Z"},
    {"type": "nfp", "name": "Non-Farm Payrolls",   "dt": "2026-11-06T13:30:00Z"},
    {"type": "nfp", "name": "Non-Farm Payrolls",   "dt": "2026-12-04T13:30:00Z"},
    # PPI — typically released one business day after CPI
    {"type": "ppi", "name": "PPI USA",             "dt": "2026-05-13T12:30:00Z"},
    {"type": "ppi", "name": "PPI USA",             "dt": "2026-06-11T12:30:00Z"},
    {"type": "ppi", "name": "PPI USA",             "dt": "2026-07-14T12:30:00Z"},
    {"type": "ppi", "name": "PPI USA",             "dt": "2026-08-13T12:30:00Z"},
    {"type": "ppi", "name": "PPI USA",             "dt": "2026-09-10T12:30:00Z"},
    {"type": "ppi", "name": "PPI USA",             "dt": "2026-10-15T12:30:00Z"},
    {"type": "ppi", "name": "PPI USA",             "dt": "2026-11-13T13:30:00Z"},
    {"type": "ppi", "name": "PPI USA",             "dt": "2026-12-10T13:30:00Z"},
    # JOLTS — 10:00 AM ET, ~4 weeks after survey month end
    {"type": "jolts", "name": "JOLTS Job Openings", "dt": "2026-06-02T14:00:00Z"},
    {"type": "jolts", "name": "JOLTS Job Openings", "dt": "2026-07-07T14:00:00Z"},
    {"type": "jolts", "name": "JOLTS Job Openings", "dt": "2026-08-04T14:00:00Z"},
    {"type": "jolts", "name": "JOLTS Job Openings", "dt": "2026-09-01T14:00:00Z"},
    {"type": "jolts", "name": "JOLTS Job Openings", "dt": "2026-10-06T14:00:00Z"},
    {"type": "jolts", "name": "JOLTS Job Openings", "dt": "2026-11-03T14:00:00Z"},
    {"type": "jolts", "name": "JOLTS Job Openings", "dt": "2026-12-01T14:00:00Z"},
]

_MONTH_MAP = {
    "January": 1, "February": 2, "March": 3, "April": 4,
    "May": 5, "June": 6, "July": 7, "August": 8,
    "September": 9, "October": 10, "November": 11, "December": 12,
}


@dataclass
class MacroEvent:
    event_type: str
    name:       str
    dt:         datetime


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class EconomicCalendarService:
    """
    Maintains the macro event list and checks whether NOW falls inside
    a configured pause window around any enabled event.
    """

    def __init__(self):
        self._events: list[MacroEvent] = [
            MacroEvent(event_type=e["type"], name=e["name"], dt=_parse_dt(e["dt"]))
            for e in _STATIC_2026
        ]
        self._refresh_lock = asyncio.Lock()
        self._last_refresh: Optional[datetime] = None
        log.info("Economic calendar: %d static events loaded (2026)", len(self._events))

    # ── Public API ────────────────────────────────────────────────────────────

    def get_upcoming(self, days_ahead: int = 30) -> list[dict]:
        """Return upcoming events sorted by datetime, within the next N days."""
        now    = datetime.now(UTC)
        cutoff = now + timedelta(days=days_ahead)
        out    = []
        for e in self._events:
            if now <= e.dt <= cutoff:
                out.append({
                    "type":         e.event_type,
                    "name":         e.name,
                    "datetime_utc": e.dt.isoformat(),
                    "days_away":    round((e.dt - now).total_seconds() / 86400, 1),
                })
        return sorted(out, key=lambda x: x["datetime_utc"])

    def is_in_pause_window(self, now: datetime, cfg) -> Optional[str]:
        """
        Returns the event name if `now` falls within ±window_min of an enabled
        event; returns None otherwise.
        """
        if not getattr(cfg, "macro_pause_enabled", False):
            return None
        window = timedelta(minutes=int(getattr(cfg, "macro_pause_window_min", 60)))
        enabled = {
            t for t in ("fomc", "cpi", "nfp", "ppi", "jolts")
            if getattr(cfg, f"macro_pause_{t}", False)
        }
        if not enabled:
            return None
        for e in self._events:
            if e.event_type not in enabled:
                continue
            if (e.dt - window) <= now <= (e.dt + window):
                return e.name
        return None

    # ── Auto-refresh ──────────────────────────────────────────────────────────

    async def try_refresh_fomc(self):
        """
        Fetch next-year FOMC dates from federalreserve.gov (HTML, best-effort).
        Runs at most once per 24h. Appends new events to self._events.
        """
        now = datetime.now(UTC)
        if self._last_refresh and (now - self._last_refresh).total_seconds() < 86400:
            return
        if self._refresh_lock.locked():
            return
        async with self._refresh_lock:
            try:
                next_year = now.year + 1
                async with httpx.AsyncClient(timeout=10) as client:
                    r = await client.get(
                        "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
                        headers={"User-Agent": "Mozilla/5.0"},
                    )
                if r.status_code != 200:
                    return
                html = r.text
                start = html.find(f"{next_year} FOMC Meetings")
                if start == -1:
                    return
                # Grab the section up to the previous year heading
                end     = html.find("FOMC Meetings", start + 20)
                section = html[start:end]
                months_raw = re.findall(r'fomc-meeting__month[^>]+><strong>(\w+)</strong>', section)
                dates_raw  = re.findall(r'fomc-meeting__date[^>]+>(\d+[-–]\d+)', section)
                if not months_raw:
                    return
                new_events = []
                for m_str, d_str in zip(months_raw, dates_raw):
                    month = _MONTH_MAP.get(m_str)
                    if not month:
                        continue
                    # Second day of two-day meeting = announcement day
                    day = int(re.split(r'[-–]', d_str)[-1])
                    # DST approximation: EDT (UTC-4) Mar–Oct, EST (UTC-5) Nov–Feb
                    hour = 18 if 3 <= month <= 10 else 19
                    dt = datetime(next_year, month, day, hour, 0, 0, tzinfo=UTC)
                    new_events.append(MacroEvent(event_type="fomc", name="FOMC Rate Decision", dt=dt))
                if new_events:
                    self._events = [
                        e for e in self._events
                        if not (e.event_type == "fomc" and e.dt.year == next_year)
                    ] + new_events
                    self._last_refresh = now
                    log.info("FOMC auto-refresh: %d events added for %d", len(new_events), next_year)
            except Exception as exc:
                log.debug("FOMC auto-refresh skipped: %s", exc)


# Module-level singleton
_svc: Optional[EconomicCalendarService] = None


def get_calendar() -> EconomicCalendarService:
    global _svc
    if _svc is None:
        _svc = EconomicCalendarService()
    return _svc
