"""
Execution Engine — main asyncio loop.
Event-driven via Hyperliquid WebSocket candle close.
Every 4h close: fetch data → features → Chronos-2 → LightGBM → decide → execute → log.
LightGBM is retrained automatically every 120 cycles (~30 days).
"""

import asyncio
import logging
import math
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.hl_websocket import HLWebSocket
from services.hyperliquid_data import HyperliquidData
from services.smc import build_all_features, ALL_FEATURES
from services.chronos_model import ChronosForecaster
from services.decision import DecisionEngine, DecisionResult, compute_qt_score
from services.risk import RiskManager
from services.notifications import TelegramNotifier
from services.trainer import LGBMTrainer, load_model, _retrain_lock
from services.covariates import update_covariates, get_latest_covariates
from services.supabase_client import get_supabase

HL_TAKER_FEE = 0.00035  # 0.035% per side

log = logging.getLogger(__name__)

SYMBOL    = "BTC"
INTERVAL  = "4h"
CANDLE_MS = 14_400_000  # 4h in ms

HL_TESTNET        = os.getenv("HL_TESTNET", "true").lower() == "true"
HL_AGENT_PRIVKEY  = os.getenv("HL_AGENT_PRIVATE_KEY", "")  # for live order signing

# Retrain every N completed cycles (~30 days on 4h bars)
RETRAIN_INTERVAL = 120

CIRCUIT_BREAKER_THRESHOLD = 5   # stop bot after N consecutive cycle errors


# ── Config dataclass ──────────────────────────────────────────────────────────

class BotConfig:
    def __init__(self, **kw):
        self.sl_atr_mult            = kw.get("sl_atr_mult", 2.0)
        self.tp_atr_mult            = kw.get("tp_atr_mult", 3.5)
        self.position_size_pct      = kw.get("position_size_pct", 1.5)
        self.max_daily_dd_pct       = kw.get("max_daily_dd_pct", 3.0)
        self.directional_threshold  = kw.get("directional_threshold", 0.62)
        self.adx_gate               = kw.get("adx_gate", 20.0)
        self.confluence_gate        = kw.get("confluence_gate", 60.0)
        self.max_consecutive_losses = kw.get("max_consecutive_losses", 4)
        self.mode                   = kw.get("mode", "paper")
        # ── Advanced exit strategies ──────────────────────────────────────────
        # Partial TP: close partial_tp_pct% of position at partial_tp_atr_mult×ATR
        self.partial_tp_enabled     = kw.get("partial_tp_enabled", False)
        self.partial_tp_atr_mult    = kw.get("partial_tp_atr_mult", 1.5)
        self.partial_tp_pct         = kw.get("partial_tp_pct", 50.0)
        # Trailing SL: move SL to break-even once price moves trailing_sl_activation×ATR in our favour
        self.trailing_sl_enabled    = kw.get("trailing_sl_enabled", False)
        self.trailing_sl_activation = kw.get("trailing_sl_activation", 1.5)
        # LightGBM mid-trade exit: exit only after N consecutive bars below threshold
        self.lgbm_exit_enabled       = kw.get("lgbm_exit_enabled",       False)
        self.lgbm_exit_threshold     = kw.get("lgbm_exit_threshold",     0.30)
        self.lgbm_exit_min_hold_bars = kw.get("lgbm_exit_min_hold_bars", 6)
        self.lgbm_exit_confirm_bars  = kw.get("lgbm_exit_confirm_bars",  2)
        self.enhanced_exit_enabled   = kw.get("enhanced_exit_enabled",   False)
        # ── Advanced signal controls ──────────────────────────────────────────
        self.chronos_enabled         = kw.get("chronos_enabled",         True)
        self.chronos_weight          = kw.get("chronos_weight",          0.40)
        self.adx_gate_enabled        = kw.get("adx_gate_enabled",        True)
        self.sweep_gate_enabled      = kw.get("sweep_gate_enabled",      True)
        self.fvg_filter_enabled      = kw.get("fvg_filter_enabled",      True)
        self.mtf_alignment_enabled   = kw.get("mtf_alignment_enabled",   True)
        # ── Advanced exit ─────────────────────────────────────────────────────
        self.be_sl_enabled           = kw.get("be_sl_enabled",           False)
        self.be_sl_activation        = kw.get("be_sl_activation",        1.0)
        self.max_hold_bars_enabled      = kw.get("max_hold_bars_enabled",      False)
        self.max_hold_bars              = kw.get("max_hold_bars",              48)
        # Chronos-2 adaptive features
        self.c2_uncertainty_gate_enabled = kw.get("c2_uncertainty_gate_enabled", False)
        self.c2_uncertainty_threshold    = kw.get("c2_uncertainty_threshold",    0.05)
        self.c2_cont_prob_gate_enabled   = kw.get("c2_cont_prob_gate_enabled",   False)
        self.c2_cont_prob_threshold      = kw.get("c2_cont_prob_threshold",      0.25)
        self.dynamic_sl_tp_enabled       = kw.get("dynamic_sl_tp_enabled",       False)
        self.dynamic_sl_tp_blend         = kw.get("dynamic_sl_tp_blend",         0.50)
        self.p10_sl_floor_enabled        = kw.get("p10_sl_floor_enabled",        False)

    def model_dump(self) -> dict:
        return self.__dict__


# ── Execution Engine ──────────────────────────────────────────────────────────

class ExecutionEngine:
    def __init__(self):
        self.config  = BotConfig()
        self.running = False
        self.mode    = "paper"

        # Services
        self._hl        = HyperliquidData()
        self._ws        = HLWebSocket(SYMBOL)
        self._chronos   = ChronosForecaster()
        self._notifier  = TelegramNotifier()
        self._trainer   = LGBMTrainer()

        # Persistent risk manager — must survive across cycles to track daily PnL
        self._risk = self._build_risk_manager()

        # Model cache — load immediately if available on disk
        self._lgbm_model    = None
        self._lgbm_features = None
        self._load_model_from_disk()

        # State
        self._position: Optional[dict]  = None   # active position dict
        self._equity: float             = 10_000.0  # paper equity (USD)
        self._cycle_count: int          = 0
        self._consecutive_errors: int   = 0
        self._retrain_task: Optional[asyncio.Task] = None
        self._task: Optional[asyncio.Task]         = None
        self._last_retrain_metrics: Optional[dict] = None

    # ── Config ────────────────────────────────────────────────────────────────

    def update_config(self, cfg):
        for k, v in cfg.model_dump().items():
            setattr(self.config, k, v)
        self._risk.update_limits(
            sl_atr_mult=self.config.sl_atr_mult,
            tp_atr_mult=self.config.tp_atr_mult,
            position_size_pct=self.config.position_size_pct,
            max_daily_dd_pct=self.config.max_daily_dd_pct,
            max_consecutive_losses=self.config.max_consecutive_losses,
        )
        log.info("Config updated: %s", cfg.model_dump())

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self, mode: str = "paper"):
        if self.running:
            return
        self.mode    = mode
        self.running = True
        self._consecutive_errors = 0

        # Load model from disk if available
        self._load_model_from_disk()

        # Restore paper equity from last DB snapshot (avoids reset to $10k on every restart)
        if mode == "paper":
            await self._restore_paper_state()

        # Start WebSocket
        await self._ws.start()

        # Live only: reconcile open positions before starting the loop
        if mode == "live":
            await self._reconcile_position()

        # Kick off the main loop
        self._task = asyncio.create_task(self._loop())

        log.info("Execution engine starting in %s mode", mode.upper())
        await self._notifier.send_bot_started(mode)

    async def stop(self):
        if not self.running:
            return
        self.running = False
        if self._task:
            self._task.cancel()
        await self._ws.stop()
        log.info("Execution engine stopped")
        await self._notifier.send_bot_stopped("manual")

    async def close_position_manual(self) -> dict:
        """Close the current position at mark price without stopping the bot."""
        if not self._position:
            return {"closed": False, "reason": "no_position"}

        # Snapshot entry_price before the await so we have a safe fallback
        # even if _cycle() closes the position concurrently during the network call.
        fallback_price = self._position["entry_price"]
        snap  = await self._hl.get_market_snapshot(SYMBOL)
        price = snap.get("mark_price", fallback_price)
        await self._close_position(price, "manual")  # _close_position guards None internally
        return {"closed": True, "exit_price": price}

    async def kill(self) -> dict:
        """Emergency: cancel open orders, close positions immediately."""
        self.running = False
        if self._task:
            self._task.cancel()
        await self._ws.stop()

        orders_cancelled = 0
        positions_closed = 0

        if self._position:
            if self.mode == "live":
                try:
                    await self._submit_close_order()
                    positions_closed = 1
                except Exception as exc:
                    log.error("Kill: close order failed: %s", exc)
            else:
                # Paper: book the position at current mark price
                snap  = await self._hl.get_market_snapshot(SYMBOL)
                price = snap.get("mark_price", self._position["entry_price"])
                await self._close_position(price, "kill")
                positions_closed = 1

        self._position = None
        log.warning("KILL SWITCH activated")
        return {"orders_cancelled": orders_cancelled, "positions_closed": positions_closed}

    async def _reconcile_position(self):
        """
        On live startup: query HL for any existing open position and restore
        self._position from it, preventing a double-open on restart.
        """
        wallet = os.getenv("HL_WALLET_ADDRESS", "")
        if not wallet:
            log.warning("Reconciliation skipped: HL_WALLET_ADDRESS not set")
            return

        hl_pos = await self._hl.get_open_position(wallet, SYMBOL)
        if hl_pos is None:
            log.info("Reconciliation: no open position on HL")
            return

        # Restore in-memory position from HL state (HL is authoritative for size/entry)
        self._position = {
            "side":               hl_pos["side"],
            "entry_price":        hl_pos["entry_price"],
            "stop_loss":          0.0,   # overwritten below if we have saved state
            "take_profit":        0.0,   # overwritten below if we have saved state
            "size_usd":           hl_pos["size_contracts"] * hl_pos["entry_price"],
            "size_contracts":     hl_pos["size_contracts"],
            "entry_atr":          None,
            "inference_id":       None,
            "hl_order_id":        None,
            "opened_at":          datetime.now(timezone.utc).isoformat(),
            "bars_held":          0,
            "lgbm_strikes":       0,
            "be_sl_applied":      False,
            "sl_trailing_active": False,
            "high_water":         hl_pos["entry_price"],
            "partial_done":       False,
            "reconciled":         True,   # flag: position was re-read from HL on restart
        }

        # Merge saved in-flight state from DB (trailing SL progress, partial TP status, etc.)
        try:
            db = get_supabase()
            cfg_row = db.table("bot_configs").select("params").eq("name", "default").execute()
            saved_state = (cfg_row.data[0].get("params") or {}).get("_live_position_state") if cfg_row.data else None
            if saved_state and saved_state.get("stop_loss", 0.0) > 0.0:
                self._position.update({
                    "stop_loss":               saved_state.get("stop_loss", 0.0),
                    "take_profit":             saved_state.get("take_profit", 0.0),
                    "bars_held":               saved_state.get("bars_held", 0),
                    "lgbm_strikes":            saved_state.get("lgbm_strikes", 0),
                    "be_sl_applied":           saved_state.get("be_sl_applied", False),
                    "sl_trailing_active":      saved_state.get("sl_trailing_active", False),
                    "high_water":              saved_state.get("high_water") or hl_pos["entry_price"],
                    "partial_done":            saved_state.get("partial_done", False),
                    "sl_original":             saved_state.get("sl_original"),
                    "entry_atr":               saved_state.get("entry_atr"),
                    "inference_id":            saved_state.get("inference_id"),
                    "hl_order_id":             saved_state.get("hl_order_id"),
                    "opened_at":               saved_state.get("opened_at") or self._position["opened_at"],
                    "partial_tp_price":        saved_state.get("partial_tp_price"),
                    "trailing_sl_activation_price": saved_state.get("trailing_sl_activation_price"),
                    "trailing_sl_dist":        saved_state.get("trailing_sl_dist"),
                    "trade_id":                saved_state.get("trade_id"),
                    # Use HL-authoritative values for size (partial TP may have updated on exchange)
                    "size_usd":                saved_state.get("size_usd") or self._position["size_usd"],
                    "size_contracts":          saved_state.get("size_contracts") or self._position["size_contracts"],
                })
                log.info(
                    "Reconciliation: restored in-flight state from DB — "
                    "bars_held=%d sl=%.2f partial_done=%s trailing=%s",
                    self._position["bars_held"], self._position["stop_loss"],
                    self._position["partial_done"], self._position["sl_trailing_active"],
                )
        except Exception as exc:
            log.warning("Could not restore live position state from DB: %s", exc)

        sl_tp_note = (
            f"SL={self._position['stop_loss']:.2f} TP={self._position['take_profit']:.2f}"
            if self._position["stop_loss"] > 0.0
            else "SL/TP non noti — verificare manualmente"
        )
        log.warning(
            "Reconciliation: restored %s position %.4f BTC @ %.2f (unrealized PnL: $%.2f). %s",
            hl_pos["side"].upper(), hl_pos["size_contracts"],
            hl_pos["entry_price"], hl_pos["unrealized_pnl"], sl_tp_note,
        )
        try:
            db = get_supabase()
            db.table("events").insert({
                "severity": "warning",
                "kind":     "position_reconciled",
                "message":  (
                    f"Posizione esistente rilevata su HL al restart: "
                    f"{hl_pos['side'].upper()} {hl_pos['size_contracts']} BTC @ {hl_pos['entry_price']:.2f}"
                ),
                "payload":  hl_pos,
            }).execute()
        except Exception:
            pass
        await self._notifier.send_error(
            f"⚠️ Posizione esistente rilevata su HL al restart: "
            f"{hl_pos['side'].upper()} {hl_pos['size_contracts']} BTC @ {hl_pos['entry_price']:.2f}. "
            f"{sl_tp_note}",
            "reconciliation"
        )

    async def _restore_paper_state(self):
        """
        Paper mode startup: restore equity from last DB snapshot and
        rehydrate any open paper position from bot_configs.params.
        Prevents equity reset to $10k and open-trade loss on every restart.
        """
        try:
            db = get_supabase()

            # 1. Restore equity from most recent snapshot
            snap = db.table("equity_snapshots") \
                     .select("equity_usd") \
                     .order("time", desc=True) \
                     .limit(1).execute()
            if snap.data:
                self._equity = float(snap.data[0]["equity_usd"])
                log.info("Paper equity restored from DB: $%.2f", self._equity)

            # 2. Restore open paper position if saved in bot_configs
            cfg_row = db.table("bot_configs") \
                        .select("params") \
                        .eq("name", "default").execute()
            if cfg_row.data:
                saved_pos = (cfg_row.data[0].get("params") or {}).get("_paper_position")
                if saved_pos:
                    self._position = saved_pos
                    log.info(
                        "Paper position restored: %s %.4f BTC @ %.2f",
                        saved_pos["side"].upper(), saved_pos["size_contracts"], saved_pos["entry_price"],
                    )
                    # Backfill UI-display fields added after this position was saved.
                    # _manage_position() recomputes these independently; these copies
                    # exist only so the Monitor card can show them immediately.
                    _e    = self._position.get("entry_price", 0)
                    _atr  = self._position.get("entry_atr") or _e * 0.01
                    _long = self._position.get("side", "long") == "long"
                    if "sl_original" not in self._position:
                        self._position["sl_original"] = self._position.get("stop_loss")
                    if "partial_tp_price" not in self._position:
                        self._position["partial_tp_price"] = (
                            (_e + self.config.partial_tp_atr_mult * _atr) if _long
                            else (_e - self.config.partial_tp_atr_mult * _atr)
                        ) if self.config.partial_tp_enabled else None
                    if "trailing_sl_activation_price" not in self._position:
                        self._position["trailing_sl_activation_price"] = (
                            (_e + self.config.trailing_sl_activation * _atr) if _long
                            else (_e - self.config.trailing_sl_activation * _atr)
                        ) if self.config.trailing_sl_enabled else None
                    if "trailing_sl_dist" not in self._position:
                        self._position["trailing_sl_dist"] = (
                            self.config.trailing_sl_activation * _atr
                        ) if self.config.trailing_sl_enabled else None
        except Exception as exc:
            log.warning("Could not restore paper state: %s", exc)

    def _save_paper_position(self):
        """Persist current paper position (or None) to bot_configs.params._paper_position."""
        try:
            db = get_supabase()
            row = db.table("bot_configs").select("params").eq("name", "default").execute()
            existing = (row.data[0].get("params") or {}) if row.data else {}
            existing["_paper_position"] = self._position  # None clears it
            db.table("bot_configs").update({"params": existing}).eq("name", "default").execute()
        except Exception as exc:
            log.warning("Could not save paper position: %s", exc)

    def _persist_position_state(self):
        """
        Persist in-flight position state (trailing SL, partial_done, be_sl_applied, etc.)
        so that bot restarts can fully restore mid-trade state.

        Paper mode: reuses _paper_position (same key, same restore path).
        Live mode:  saves to _live_position_state (restored in _reconcile_position).
        """
        if not self._position:
            return
        try:
            db = get_supabase()
            row = db.table("bot_configs").select("params").eq("name", "default").execute()
            existing = (row.data[0].get("params") or {}) if row.data else {}
            if self.mode == "paper":
                existing["_paper_position"] = self._position
            else:
                existing["_live_position_state"] = {
                    "bars_held":               self._position.get("bars_held", 0),
                    "lgbm_strikes":            self._position.get("lgbm_strikes", 0),
                    "be_sl_applied":           self._position.get("be_sl_applied", False),
                    "sl_trailing_active":      self._position.get("sl_trailing_active", False),
                    "high_water":              self._position.get("high_water"),
                    "partial_done":            self._position.get("partial_done", False),
                    "stop_loss":               self._position.get("stop_loss", 0.0),
                    "take_profit":             self._position.get("take_profit", 0.0),
                    "sl_original":             self._position.get("sl_original"),
                    "size_usd":                self._position.get("size_usd"),
                    "size_contracts":          self._position.get("size_contracts"),
                    "entry_atr":               self._position.get("entry_atr"),
                    "inference_id":            self._position.get("inference_id"),
                    "hl_order_id":             self._position.get("hl_order_id"),
                    "opened_at":               self._position.get("opened_at"),
                    "partial_tp_price":        self._position.get("partial_tp_price"),
                    "trailing_sl_activation_price": self._position.get("trailing_sl_activation_price"),
                    "trailing_sl_dist":        self._position.get("trailing_sl_dist"),
                    "trade_id":                self._position.get("trade_id"),
                }
            db.table("bot_configs").update({"params": existing}).eq("name", "default").execute()
        except Exception as exc:
            log.warning("Could not persist position state: %s", exc)

    async def get_status(self) -> dict:
        return {
            "running":              self.running,
            "mode":                 self.mode,
            "hl_testnet":           HL_TESTNET,
            "equity":               self._equity,
            "position":             self._position,
            "mark_price":           self._ws.latest_mark,
            "cycle_count":          self._cycle_count,
            "ws_connected":         self._ws.is_connected,
            "model_loaded":         self._lgbm_model is not None,
            "retrain_in_progress":  _retrain_lock.locked(),
            "last_retrain":         self._last_retrain_metrics,
            "config":               self.config.model_dump(),
        }

    # ── Main Loop ─────────────────────────────────────────────────────────────

    async def _loop(self):
        """
        Event-driven loop: waits for WS candle close, then runs a full cycle.
        Falls back to time-based sleep if WS times out (e.g. connection issue).
        """
        while self.running:
            try:
                # Wait for next 4h candle close (WS event-driven)
                ws_data = await self._ws.wait_for_candle_close()

                if ws_data is None:
                    # WS timeout — fall back to time-based alignment
                    await self._sleep_until_next_candle()

                await self._cycle()
                self._consecutive_errors = 0  # reset on successful cycle

            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._consecutive_errors += 1
                log.error(
                    "Cycle error [%d/%d]: %s",
                    self._consecutive_errors, CIRCUIT_BREAKER_THRESHOLD,
                    exc, exc_info=True,
                )
                await self._notifier.send_error(str(exc), "main loop")
                try:
                    db = get_supabase()
                    db.table("events").insert({
                        "severity": "error",
                        "kind": "cycle_error",
                        "message": f"Errore nel ciclo di trading [{self._consecutive_errors}/{CIRCUIT_BREAKER_THRESHOLD}]: {type(exc).__name__}: {exc}",
                        "payload": {
                            "error": str(exc), "type": type(exc).__name__,
                            "consecutive": self._consecutive_errors,
                        },
                    }).execute()
                except Exception:
                    pass

                if self._consecutive_errors >= CIRCUIT_BREAKER_THRESHOLD:
                    log.critical(
                        "Circuit breaker triggered after %d consecutive errors — stopping bot.",
                        self._consecutive_errors,
                    )
                    try:
                        db = get_supabase()
                        db.table("events").insert({
                            "severity": "critical",
                            "kind":     "circuit_breaker",
                            "message":  f"Circuit breaker attivato dopo {self._consecutive_errors} errori consecutivi. Bot fermato automaticamente.",
                            "payload":  {"consecutive_errors": self._consecutive_errors},
                        }).execute()
                    except Exception:
                        pass
                    await self._notifier.send_error(
                        f"🚨 Circuit breaker attivato dopo {self._consecutive_errors} errori consecutivi. "
                        "Bot fermato automaticamente. Controlla i log.",
                        "circuit_breaker"
                    )
                    self.running = False
                    # Persist stopped state so no auto-resume until manually restarted
                    try:
                        db = get_supabase()
                        db.table("bot_configs").update({"running": False}).eq("name", "default").execute()
                    except Exception:
                        pass
                    break

                await asyncio.sleep(60)  # brief pause before retry

    async def _cycle(self):
        """One full inference cycle: fetch → features → C2 → LGBM → decide → execute → log."""
        cycle_start = datetime.now(timezone.utc)
        log.info("Cycle %d starting at %s", self._cycle_count + 1, cycle_start.isoformat())

        # 1. WS snapshot (CVD, liquidations, live OI) — reset accumulators
        ws_snap = self._ws.get_snapshot_and_reset()

        # 2. Fetch OHLCV + market snapshot from REST (ground truth)
        df_4h   = await self._hl.get_ohlcv(SYMBOL, "4h", limit=512)
        snap    = await self._hl.get_market_snapshot(SYMBOL)
        df_fund = await self._hl.get_funding_history(SYMBOL, hours=200)

        # Prefer live WS OI if available, fall back to REST snapshot
        if ws_snap["ws_latest_oi"] > 0:
            snap["open_interest"] = ws_snap["ws_latest_oi"]

        # Build liquidation df from WS accumulators (approximate)
        df_liq = _make_liq_df(ws_snap)

        # Fetch real OI history for Chronos-2 covariate (non-blocking: empty df on failure)
        try:
            from services.external_data import get_best_oi
            from datetime import date, timedelta
            _today  = date.today().isoformat()
            _from_d = (date.today() - timedelta(days=90)).isoformat()
            df_oi = await get_best_oi(SYMBOL, start_date=_from_d, end_date=_today)
        except Exception:
            df_oi = pd.DataFrame()

        # 3. Build full 64-feature matrix
        df_feat = build_all_features(df_4h, df_fund, df_oi, df_liq)
        latest  = df_feat.iloc[-1].to_dict()
        atr     = latest.get("atr_14")

        # Inject live WS CVD into features (overrides Haas approximation with real data)
        latest["cvd_delta"] = ws_snap["ws_cvd_delta"]

        # 4. Chronos-2 inference (skip if disabled — use neutral prior)
        cur_px = float(df_4h["close"].iloc[-1])
        if self.config.chronos_enabled:
            c2_out = self._chronos.forecast(
                df_feat["close"].values,
                horizon=3,
                atr=atr,
                volume_series= df_feat["volume"].values    if "volume"    in df_feat.columns else None,
                oi_series=     df_feat["oi_raw"].values    if "oi_raw"    in df_feat.columns else None,
                funding_series=df_feat["funding"].values   if "funding"   in df_feat.columns else None,
                cvd_series=    df_feat["delta_raw"].values if "delta_raw" in df_feat.columns else None,
            )
        else:
            mark = snap["mark_price"]
            c2_out = {
                "c2_dir_prob":    0.5,
                "c2_p10":         mark,
                "c2_p50":         mark,
                "c2_p90":         mark,
                "c2_uncertainty": 0.0,
                "c2_vol_prob":    0.0,
                "c2_cont_prob":   1.0,
                "c2_p50_vs_atr":  0.0,
            }

        # 5. LightGBM probability (non-C2 features)
        lgbm_prob = self._get_lgbm_prob(df_feat)

        # 6. External covariates (F&G, BTC dominance)
        await update_covariates()
        covars = get_latest_covariates()

        # Confluence score: computed from bar features (same formula as backtest)
        # so confluence_gate has identical effect live vs. simulated.
        confluence = (compute_qt_score(latest)
                      if self.config.confluence_gate > 0 else None)

        # 7. Decision gate
        allowed, block_reason = self._risk.can_trade()
        decision_engine = DecisionEngine(
            directional_threshold       = self.config.directional_threshold,
            adx_gate                    = self.config.adx_gate,
            confluence_gate             = self.config.confluence_gate,
            adx_gate_enabled            = self.config.adx_gate_enabled,
            sweep_gate_enabled          = self.config.sweep_gate_enabled,
            fvg_filter_enabled          = self.config.fvg_filter_enabled,
            mtf_alignment_enabled       = self.config.mtf_alignment_enabled,
            chronos_weight              = self.config.chronos_weight if self.config.chronos_enabled else 0.0,
            c2_uncertainty_gate_enabled = self.config.c2_uncertainty_gate_enabled if self.config.chronos_enabled else False,
            c2_uncertainty_threshold    = self.config.c2_uncertainty_threshold,
            c2_cont_prob_gate_enabled   = self.config.c2_cont_prob_gate_enabled if self.config.chronos_enabled else False,
            c2_cont_prob_threshold      = self.config.c2_cont_prob_threshold,
        )
        result = decision_engine.decide(
            features=latest,
            c2_output=c2_out,
            lgbm_prob=lgbm_prob,
            confluence_score=confluence,
            current_price=snap["mark_price"],
        )

        # 8. Execute
        _raw_id = str(uuid.uuid4())[:12]
        inference_id = await self._log_inference(_raw_id, latest, c2_out, lgbm_prob, result, covars)
        # inference_id is None if log write failed; orders insert will use NULL FK (safe)

        if result.action != "no_trade" and allowed and self._position is None:
            await self._open_position(result, snap, atr, inference_id)
        elif not allowed:
            log.info("Trade blocked: %s", block_reason)
        elif result.action != "no_trade" and self._position is not None:
            open_side    = self._position["side"]
            signal_side  = result.action
            ensemble_pct = round(result.confidence * 100, 1)
            is_opposite  = (signal_side != open_side)

            kind  = "signal_blocked_opposite" if is_opposite else "signal_blocked_same"
            label = "SEGNALE CONTRARIO IGNORATO" if is_opposite else "Segnale uguale ignorato"
            log.info(
                "[%s] %s — %s mentre posizione %s aperta | ensemble=%.1f%% | %s",
                self.mode.upper(), label, signal_side.upper(), open_side.upper(),
                ensemble_pct, result.reasoning[-1] if result.reasoning else "—",
            )
            try:
                db = get_supabase()
                db.table("events").insert({
                    "severity": "warning" if is_opposite else "info",
                    "kind":     kind,
                    "message":  (
                        f"{'⚠️' if is_opposite else 'ℹ️'} {label}: {signal_side.upper()} "
                        f"@ {ensemble_pct}% (posizione {open_side.upper()} aperta)"
                    ),
                    "payload": {
                        "signal":       signal_side,
                        "open_side":    open_side,
                        "ensemble_pct": ensemble_pct,
                        "is_opposite":  is_opposite,
                        "reasoning":    result.reasoning,
                        "inference_id": inference_id,
                    },
                }).execute()
            except Exception as exc:
                log.warning("signal_blocked event insert failed: %s", exc)

            if is_opposite:
                asyncio.create_task(self._notifier.send_signal_blocked_opposite(
                    signal_side=signal_side,
                    open_side=open_side,
                    ensemble_pct=ensemble_pct,
                    reasoning=result.reasoning,
                ))

        # 9. Manage existing position (SL/TP + optional LightGBM mid-trade exit)
        if self._position:
            await self._manage_position(snap["mark_price"], df_feat, c2_out)

        # 10. Heartbeat
        await self._risk.write_heartbeat()

        # 11. Auto-retrain (background — never blocks the loop)
        self._cycle_count += 1
        if self._cycle_count % RETRAIN_INTERVAL == 0:
            asyncio.create_task(self._retrain_background())

        elapsed_ms = (datetime.now(timezone.utc) - cycle_start).total_seconds() * 1000
        log.info("Cycle %d done in %.0fms | action=%s", self._cycle_count, elapsed_ms, result.action)

    # ── LightGBM ──────────────────────────────────────────────────────────────

    def _load_model_from_disk(self):
        result = load_model()
        if result:
            self._lgbm_model, self._lgbm_features = result
            log.info("LightGBM model loaded from disk (%d features)", len(self._lgbm_features))
        else:
            log.warning("No LightGBM model on disk — using neutral probability (0.5) until first retrain")

    def _get_lgbm_prob(self, df_feat: pd.DataFrame) -> float:
        if self._lgbm_model is None:
            return 0.5  # neutral prior before first model is trained

        features = self._lgbm_features or [f for f in ALL_FEATURES if f in df_feat.columns]
        row = df_feat.iloc[[-1]][features].fillna(0)
        try:
            return float(self._lgbm_model.predict_proba(row)[0, 1])
        except Exception as exc:
            log.warning("LightGBM predict failed: %s — using 0.5", exc)
            return 0.5

    # ── Retraining ────────────────────────────────────────────────────────────

    async def _reload_model_after_retrain(self, metrics: dict, trigger: str = "auto"):
        """Common post-retrain logic: reload model, persist metrics, log to Supabase."""
        result = load_model()
        if result:
            self._lgbm_model, self._lgbm_features = result
        self._last_retrain_metrics = metrics
        log.info(
            "LightGBM model reloaded (%s): OOS acc=%.2f%%, ll=%.4f",
            trigger, metrics["oos_accuracy"] * 100, metrics["oos_log_loss"],
        )
        try:
            db = get_supabase()
            db.table("events").insert({
                "severity": "info",
                "kind":     "lgbm_retrained",
                "message":  f"LightGBM retrained ({trigger}): OOS acc={metrics['oos_accuracy']:.2%}",
                "payload":  {**metrics, "trigger": trigger},
            }).execute()
        except Exception:
            pass

    async def _retrain_background(self):
        log.info("Auto-retraining triggered (cycle %d)", self._cycle_count)
        try:
            metrics = await self._trainer.retrain(SYMBOL, lookback_candles=500)
            if metrics.get("status") == "ok":
                await self._reload_model_after_retrain(metrics, trigger="auto")
        except Exception as exc:
            log.error("Retraining failed: %s", exc, exc_info=True)

    async def retrain_manual(self) -> dict:
        """
        Manual retrain triggered from the UI.
        Blocks until complete (~10-30s) and returns the metrics dict.
        Returns {"status": "busy"} immediately if a retrain is already in progress.
        """
        metrics = await self._trainer.retrain(SYMBOL, lookback_candles=500)
        if metrics.get("status") == "ok":
            await self._reload_model_after_retrain(metrics, trigger="manual")
        return metrics

    # ── Position management ───────────────────────────────────────────────────

    async def _open_position(
        self,
        result: DecisionResult,
        snap: dict,
        atr: Optional[float],
        inference_id: str,
    ):
        price = snap["mark_price"]
        atr   = atr or price * 0.01  # fallback 1% ATR

        _use_dynamic   = self.config.dynamic_sl_tp_enabled and self.config.chronos_enabled
        _p10_available = self.config.chronos_enabled and result.forecast_p10 > 0
        # Pass c2 quantiles when EITHER adaptive SL/TP or P10 floor needs them
        _needs_quantiles = _use_dynamic or (self.config.p10_sl_floor_enabled and _p10_available)
        params = self._risk.calculate_trade_params(
            side=result.action,
            entry_price=price,
            atr=atr,
            equity_usd=self._equity,
            c2_p10=result.forecast_p10 if _needs_quantiles else None,
            c2_p90=result.forecast_p90 if _needs_quantiles else None,
            c2_uncertainty=result.forecast_uncertainty if (_use_dynamic and result.forecast_uncertainty > 0) else None,
            dynamic_sl_tp_enabled=_use_dynamic,
            dynamic_sl_tp_blend=self.config.dynamic_sl_tp_blend,
            recalibrated_uncertainty_thresholds=self.config.recalibrated_uncertainty_thresholds,
            p10_sl_floor_enabled=self.config.p10_sl_floor_enabled and _p10_available,
        )
        # Round to 4 decimal places (HL BTC min size = 0.001)
        size = max(round(params.size_contracts, 4), 0.001)

        if self.mode == "live":
            # Idempotency guard: abort if a position already exists on HL
            wallet = os.getenv("HL_WALLET_ADDRESS", "")
            if wallet:
                existing = await self._hl.get_open_position(wallet, SYMBOL)
                if existing is not None:
                    log.warning(
                        "Idempotency guard: position already open on HL (%s %.4f BTC). Skipping order.",
                        existing["side"].upper(), existing["size_contracts"],
                    )
                    # Reconcile in-memory state instead of opening a duplicate
                    await self._reconcile_position()
                    return
            hl_order_id = await self._submit_open_order(result.action, size, price, params.stop_loss, inference_id)
        else:
            hl_order_id = None
            log.info(
                "[PAPER] %s %.4f BTC @ %.2f | SL=%.2f TP=%.2f R:R=%.2f",
                result.action.upper(), size, price,
                params.stop_loss, params.take_profit, params.rr_ratio,
            )

        # Pre-calculate level prices so the UI can show them immediately
        _atr = atr or price * 0.01
        _is_long = result.action == "long"
        _partial_tp_price = (
            (price + self.config.partial_tp_atr_mult * _atr) if _is_long
            else (price - self.config.partial_tp_atr_mult * _atr)
        ) if self.config.partial_tp_enabled else None
        _trailing_activation_price = (
            (price + self.config.trailing_sl_activation * _atr) if _is_long
            else (price - self.config.trailing_sl_activation * _atr)
        ) if self.config.trailing_sl_enabled else None

        self._position = {
            "side":           result.action,
            "entry_price":    price,
            "stop_loss":      params.stop_loss,
            "take_profit":    params.take_profit,
            "sl_original":    params.stop_loss,
            "size_usd":       params.size_usd,
            "size_contracts": size,
            "entry_atr":      _atr,
            "inference_id":   inference_id,
            "hl_order_id":    hl_order_id,
            "opened_at":      datetime.now(timezone.utc).isoformat(),
            "bars_held":          0,
            "lgbm_strikes":       0,
            "be_sl_applied":      False,
            "sl_trailing_active": False,
            "high_water":         price,
            "partial_done":       False,
            # Pre-calculated level prices for UI
            "partial_tp_price":              _partial_tp_price,
            "trailing_sl_activation_price":  _trailing_activation_price,
            "trailing_sl_dist":              (self.config.trailing_sl_activation * _atr) if self.config.trailing_sl_enabled else None,
        }

        # Persist paper position immediately so it survives a restart
        if self.mode == "paper":
            self._save_paper_position()

        try:
            db = get_supabase()
            order_res = db.table("orders").insert({
                "bot_id":       "default",
                "hl_order_id":  hl_order_id,
                "symbol":       SYMBOL,
                "side":         result.action,
                "size":         size,
                "price":        price,
                "status":       "filled" if self.mode == "paper" else "pending",
                "inference_id": inference_id,
            }).execute()
            # Capture the generated order ID and store it in the position
            # so _emit_trade_event() can link events to this trade.
            if order_res.data:
                self._position["trade_id"] = order_res.data[0].get("id")
                # Re-persist with trade_id now populated (first persist at line above had no ID yet)
                if self.mode == "paper":
                    self._save_paper_position()
            db.table("events").insert({
                "severity": "info",
                "kind": "trade_opened",
                "message": f"[{self.mode.upper()}] {result.action.upper()} {size} BTC @ {price:.2f} | SL={params.stop_loss:.2f} TP={params.take_profit:.2f} R:R={params.rr_ratio:.2f}",
                "payload": {
                    "side": result.action, "symbol": SYMBOL, "size": size,
                    "price": price, "sl": params.stop_loss, "tp": params.take_profit,
                    "rr": params.rr_ratio, "size_usd": params.size_usd, "mode": self.mode,
                },
            }).execute()
        except Exception as exc:
            log.warning("Order DB insert failed: %s", exc)

        await self._notifier.send_trade_opened(
            side=result.action,
            symbol=SYMBOL,
            size_usd=params.size_usd,
            entry_price=price,
            stop_loss=params.stop_loss,
            take_profit=params.take_profit,
            rr=params.rr_ratio,
            dir_prob=result.directional_prob,
            inference_id=inference_id,
        )

    async def _emit_trade_event(self, kind: str, payload: dict):
        """Insert a trade lifecycle event into Supabase trade_events table (best-effort)."""
        if not self._position:
            return
        try:
            db = get_supabase()
            db.table("trade_events").insert({
                "trade_id": self._position.get("trade_id"),
                "kind":     kind,
                "payload":  payload,
                "time":     datetime.now(timezone.utc).isoformat(),
            }).execute()
        except Exception as exc:
            log.debug("trade_event insert skipped: %s", exc)

    async def _manage_position(self, current_price: float, df_feat: pd.DataFrame, c2_out: dict = None):
        if not self._position:
            return

        self._position["bars_held"] = self._position.get("bars_held", 0) + 1
        side    = self._position["side"]
        entry   = self._position["entry_price"]
        atr_val = float(df_feat.iloc[-1].get("atr_14") or current_price * 0.01)

        # ── 1. Trailing SL update (always first, before any exit) ─────────────
        if self.config.trailing_sl_enabled:
            trail_dist = self.config.trailing_sl_activation * atr_val
            if not self._position.get("sl_trailing_active"):
                moved = (side == "long"  and current_price >= entry + trail_dist) or \
                        (side == "short" and current_price <= entry - trail_dist)
                if moved:
                    self._position["sl_trailing_active"] = True
                    self._position["high_water"] = current_price
                    log.info("Trailing SL activated — high_water=%.2f trail_dist=%.2f", current_price, trail_dist)
            if self._position.get("sl_trailing_active"):
                if side == "long":
                    self._position["high_water"] = max(self._position["high_water"], current_price)
                    new_sl = self._position["high_water"] - trail_dist
                    if new_sl > self._position["stop_loss"]:
                        old_sl = self._position["stop_loss"]
                        log.info("Trailing SL updated: %.2f → %.2f", old_sl, new_sl)
                        self._position["stop_loss"] = new_sl
                        asyncio.create_task(self._emit_trade_event("sl_moved", {
                            "sl_old": old_sl, "sl_new": new_sl,
                            "high_water": self._position["high_water"],
                            "current_price": current_price, "reason": "trailing",
                        }))
                        asyncio.create_task(self._notifier.send_sl_moved(
                            side, SYMBOL, old_sl=old_sl, new_sl=new_sl,
                            high_water=self._position["high_water"], reason="trailing",
                        ))
                else:
                    self._position["high_water"] = min(self._position["high_water"], current_price)
                    new_sl = self._position["high_water"] + trail_dist
                    if new_sl < self._position["stop_loss"]:
                        old_sl = self._position["stop_loss"]
                        log.info("Trailing SL updated: %.2f → %.2f", old_sl, new_sl)
                        self._position["stop_loss"] = new_sl
                        asyncio.create_task(self._emit_trade_event("sl_moved", {
                            "sl_old": old_sl, "sl_new": new_sl,
                            "high_water": self._position["high_water"],
                            "current_price": current_price, "reason": "trailing",
                        }))
                        asyncio.create_task(self._notifier.send_sl_moved(
                            side, SYMBOL, old_sl=old_sl, new_sl=new_sl,
                            high_water=self._position["high_water"], reason="trailing",
                        ))

        # ── 2. Break-even SL ──────────────────────────────────────────────────
        if self.config.be_sl_enabled and not self._position.get("be_sl_applied", False):
            activation_dist = self.config.be_sl_activation * atr_val
            if side == "long" and current_price >= entry + activation_dist:
                self._position["stop_loss"] = max(self._position["stop_loss"], entry)
                self._position["be_sl_applied"] = True
                log.info("Break-even SL activated (long) — SL moved to entry %.2f", entry)
                asyncio.create_task(self._emit_trade_event("be_sl", {
                    "sl_new": entry, "current_price": current_price,
                }))
                asyncio.create_task(self._notifier.send_breakeven_sl(side, SYMBOL, entry_price=entry))
            elif side == "short" and current_price <= entry - activation_dist:
                self._position["stop_loss"] = min(self._position["stop_loss"], entry)
                self._position["be_sl_applied"] = True
                log.info("Break-even SL activated (short) — SL moved to entry %.2f", entry)
                asyncio.create_task(self._emit_trade_event("be_sl", {
                    "sl_new": entry, "current_price": current_price,
                }))
                asyncio.create_task(self._notifier.send_breakeven_sl(side, SYMBOL, entry_price=entry))

        # ── 3. Partial TP (partial close, does not fully exit) ────────────────
        if self.config.partial_tp_enabled and not self._position.get("partial_done", False):
            entry_atr    = self._position.get("entry_atr") or atr_val
            partial_tgt  = (entry + self.config.partial_tp_atr_mult * entry_atr
                            if side == "long"
                            else entry - self.config.partial_tp_atr_mult * entry_atr)
            hit_partial  = ((side == "long"  and current_price >= partial_tgt) or
                            (side == "short" and current_price <= partial_tgt))
            if hit_partial:
                frac              = self.config.partial_tp_pct / 100.0
                partial_size_usd  = self._position["size_usd"] * frac
                partial_contracts = round(self._position["size_contracts"] * frac, 4)
                pnl_pct_p  = ((current_price - entry) / entry * 100 if side == "long"
                              else (entry - current_price) / entry * 100)
                fee_p      = partial_size_usd * HL_TAKER_FEE
                pnl_usd_p  = partial_size_usd * pnl_pct_p / 100 - fee_p

                self._equity                       += pnl_usd_p
                self._position["size_usd"]         *= (1.0 - frac)
                self._position["size_contracts"]    = round(self._position["size_contracts"] * (1.0 - frac), 4)
                self._position["partial_done"]      = True
                # Auto-move SL to break-even after partial TP (protects remaining position)
                if not self._position.get("be_sl_applied", False):
                    if side == "long":
                        self._position["stop_loss"] = max(self._position["stop_loss"], entry)
                    else:
                        self._position["stop_loss"] = min(self._position["stop_loss"], entry)
                    self._position["be_sl_applied"] = True

                if self.mode == "live":
                    await self._submit_partial_close(partial_contracts, current_price, side)

                log.info(
                    "[%s] Partial TP %.0f%% @ %.2f | pnl=+%.2f%% ($%.2f)",
                    self.mode.upper(), self.config.partial_tp_pct, current_price,
                    pnl_pct_p, pnl_usd_p,
                )
                asyncio.create_task(self._emit_trade_event("partial_tp", {
                    "price": current_price,
                    "pct_closed": self.config.partial_tp_pct,
                    "pnl_usd": round(pnl_usd_p, 2),
                    "pnl_pct": round(pnl_pct_p, 4),
                    "remaining_usd": self._position["size_usd"],
                    "remaining_contracts": self._position["size_contracts"],
                    "new_sl": self._position["stop_loss"],
                }))
                asyncio.create_task(self._notifier.send_partial_tp(
                    side=side, symbol=SYMBOL,
                    pct=self.config.partial_tp_pct,
                    price=current_price,
                    pnl_usd=pnl_usd_p,
                    pnl_pct=pnl_pct_p,
                    remaining_usd=self._position["size_usd"],
                    new_sl=self._position["stop_loss"],
                ))

        # ── 4. LightGBM mid-trade exit ────────────────────────────────────────
        if (self.config.lgbm_exit_enabled and self._lgbm_model is not None
                and self._position["bars_held"] >= self.config.lgbm_exit_min_hold_bars):
            lgbm_p   = self._get_lgbm_prob(df_feat)
            entry_px = self._position["entry_price"]

            if self.config.enhanced_exit_enabled and c2_out:
                c2_p50 = c2_out.get("c2_p50", 0.0)
                # Guard: only use c2_p50 when it's not trivially equal to current price
                c2_available = c2_p50 > 0.0 and abs(c2_p50 - current_price) > (0.001 * current_price)
                if c2_available:
                    # Both LGBM signal flip AND c2_p50 must confirm direction
                    flip_long  = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold and c2_p50 < entry_px
                    flip_short = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold) and c2_p50 > entry_px
                else:
                    # c2_p50 unavailable — fall back to LGBM-only
                    flip_long  = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold
                    flip_short = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold)
            else:
                flip_long  = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold
                flip_short = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold)

            if flip_long or flip_short:
                self._position["lgbm_strikes"] = self._position.get("lgbm_strikes", 0) + 1
            else:
                self._position["lgbm_strikes"] = 0
            if self._position.get("lgbm_strikes", 0) >= self.config.lgbm_exit_confirm_bars:
                log.info(
                    "LightGBM mid-trade exit: %s | p=%.3f | bars_held=%d | strikes=%d",
                    side, lgbm_p, self._position["bars_held"], self._position["lgbm_strikes"],
                )
                await self._close_position(current_price, "lgbm_exit")
                return

        # ── 5. Max hold bars: time-based exit ─────────────────────────────────
        if (self.config.max_hold_bars_enabled
                and self._position["bars_held"] >= self.config.max_hold_bars):
            log.info("Max hold bars reached (%d) — closing position", self.config.max_hold_bars)
            await self._close_position(current_price, "max_hold_bars")
            return

        # ── 6. Standard SL / TP check ─────────────────────────────────────────
        sl = self._position["stop_loss"]
        tp = self._position["take_profit"]
        # Skip SL/TP checks when values are 0.0 (unknown after reconciliation).
        # The native HL trigger order still protects capital in live mode.
        # Values get recalculated from ATR on the next new-trade cycle.
        reason = None
        if sl > 0.0 or tp > 0.0:
            if sl > 0.0 and self._risk.should_stop_loss(side, current_price, sl):
                reason = "stop_loss"
            elif tp > 0.0 and self._risk.should_take_profit(side, current_price, tp):
                reason = "take_profit"

        if reason:
            await self._close_position(current_price, reason)
        else:
            # Position is still open — persist any in-flight state changes (trailing SL,
            # partial_done, be_sl_applied, lgbm_strikes, bars_held, high_water, etc.)
            self._persist_position_state()

    async def _close_position(self, exit_price: float, reason: str):
        if not self._position:
            return

        side  = self._position["side"]
        entry = self._position["entry_price"]
        size  = self._position["size_usd"]

        pnl_pct  = (
            (exit_price - entry) / entry * 100 if side == "long"
            else (entry - exit_price) / entry * 100
        )
        fee_exit = size * HL_TAKER_FEE
        pnl_usd  = size * pnl_pct / 100 - fee_exit

        opened      = datetime.fromisoformat(self._position["opened_at"])
        holding_h   = (datetime.now(timezone.utc) - opened).total_seconds() / 3600

        self._equity += pnl_usd
        self._risk.record_trade_result(pnl_pct)

        if self.mode == "live":
            try:
                await self._submit_close_order()
            except Exception as exc:
                log.error("Close order failed: %s", exc)

        log.info(
            "Position closed: %s | %s | PnL %+.2f%% ($%+.2f)",
            side.upper(), reason, pnl_pct, pnl_usd,
        )

        await self._notifier.send_trade_closed(
            side=side,
            symbol=SYMBOL,
            pnl_usd=pnl_usd,
            pnl_pct=pnl_pct,
            reason=reason,
            holding_hours=holding_h,
        )

        try:
            db = get_supabase()
            db.table("equity_snapshots").insert({
                "bot_id":        "default",
                "equity_usd":    self._equity,
                "unrealized_pnl": 0.0,
                "realized_pnl":  pnl_usd,
                "drawdown_pct":  min(0.0, pnl_pct),
            }).execute()
            severity = "info" if pnl_usd >= 0 else "warning"
            db.table("events").insert({
                "severity": severity,
                "kind": "trade_closed",
                "message": f"[{self.mode.upper()}] {side.upper()} chiuso ({reason}) | PnL {pnl_pct:+.2f}% (${pnl_usd:+.2f}) in {holding_h:.1f}h",
                "payload": {
                    "side": side, "symbol": SYMBOL, "reason": reason,
                    "pnl_pct": round(pnl_pct, 4), "pnl_usd": round(pnl_usd, 2),
                    "entry": entry, "exit": exit_price, "holding_h": round(holding_h, 2),
                    "mode": self.mode,
                },
            }).execute()
        except Exception as exc:
            log.warning("Equity snapshot write failed: %s", exc)

        self._position = None

        # Clear persisted position state now that the trade is closed
        if self.mode == "paper":
            self._save_paper_position()
        else:
            # Live mode: clear saved in-flight state so a future restart doesn't
            # re-apply stale state from the closed trade to a new position.
            try:
                db = get_supabase()
                row = db.table("bot_configs").select("params").eq("name", "default").execute()
                existing = (row.data[0].get("params") or {}) if row.data else {}
                existing.pop("_live_position_state", None)
                db.table("bot_configs").update({"params": existing}).eq("name", "default").execute()
            except Exception as exc:
                log.warning("Could not clear live position state: %s", exc)

    # ── Live order submission (Hyperliquid SDK) ───────────────────────────────

    async def _submit_open_order(
        self, side: str, size: float, mark_price: float, stop_loss: float,
        inference_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        Submit a market-like IOC entry + native SL trigger order via HL SDK.
        Uses HL_AGENT_PRIVATE_KEY env var.
        Returns the HL order ID string, or None on failure.
        """
        if not HL_AGENT_PRIVKEY:
            log.error("HL_AGENT_PRIVATE_KEY not set — cannot submit live order")
            return None

        try:
            from hyperliquid.exchange import Exchange
            from hyperliquid.utils import constants
            import eth_account

            wallet   = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
            endpoint = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
            exchange = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))

            # Derive deterministic cloid from inference_id for deduplication
            # HL expects a 16-byte hex string prefixed with "0x"
            import hashlib
            _seed = (inference_id or str(uuid.uuid4())).encode()
            cloid = "0x" + hashlib.md5(_seed).hexdigest()  # 16 bytes = 32 hex chars

            is_buy  = (side == "long")
            # IOC at 50bps slippage for market-like fill
            slip_px = mark_price * (1.005 if is_buy else 0.995)
            slip_px = round(slip_px, 1)

            result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, is_buy, size, slip_px,
                {"limit": {"tif": "Ioc"}},
                False,   # reduce_only
                cloid,   # client order ID for deduplication
            )
            log.info("Live entry order submitted: %s", result)

            # Native SL trigger order
            sl_is_buy = not is_buy
            _sl_seed = (_seed + b"_sl")
            sl_cloid = "0x" + hashlib.md5(_sl_seed).hexdigest()
            sl_result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, sl_is_buy, size, stop_loss,
                {"trigger": {"triggerPx": round(stop_loss, 1), "isMarket": True, "tpsl": "sl"}},
                True,    # reduce_only
                sl_cloid,
            )
            log.info("Native SL order submitted: %s", sl_result)

            oid = str(result.get("response", {}).get("data", {}).get("statuses", [{}])[0].get("resting", {}).get("oid", ""))
            return oid or None

        except Exception as exc:
            log.error("Live open order failed: %s", exc, exc_info=True)
            return None

    async def _submit_partial_close(self, partial_contracts: float, price: float, side: str):
        """Submit a reduce-only IOC order to close partial_contracts of the position."""
        if not HL_AGENT_PRIVKEY:
            return
        try:
            from hyperliquid.exchange import Exchange
            from hyperliquid.utils import constants
            import eth_account

            wallet    = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
            endpoint  = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
            exchange  = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))
            is_buy    = (side == "short")  # closing long = sell, closing short = buy
            close_px  = round(price * (1.005 if is_buy else 0.995), 1)
            size      = max(round(partial_contracts, 4), 0.001)

            result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, is_buy, size, close_px,
                {"limit": {"tif": "Ioc"}},
                True,  # reduce_only
            )
            log.info("Partial TP close order submitted: %s", result)
        except Exception as exc:
            log.error("Partial TP close order failed: %s", exc, exc_info=True)

    async def _submit_close_order(self):
        """Submit a market close order for the current position."""
        if not self._position or not HL_AGENT_PRIVKEY:
            return

        try:
            from hyperliquid.exchange import Exchange
            from hyperliquid.utils import constants
            import eth_account

            wallet   = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
            endpoint = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
            exchange = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))

            side     = self._position["side"]
            size     = self._position["size_contracts"]
            snap     = await self._hl.get_market_snapshot(SYMBOL)
            price    = snap["mark_price"]
            is_buy   = (side == "short")  # closing: opposite of position side
            close_px = round(price * (1.005 if is_buy else 0.995), 1)

            result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, is_buy, size, close_px,
                {"limit": {"tif": "Ioc"}},
                True,    # reduce_only = True for close
            )
            log.info("Live close order submitted: %s", result)

        except Exception as exc:
            log.error("Live close order failed: %s", exc, exc_info=True)

    # ── Inference logging ─────────────────────────────────────────────────────

    @staticmethod
    def _safe_float(v):
        """Convert to float, returning None for NaN/Inf (not JSON-safe)."""
        if hasattr(v, "__float__"):
            f = float(v)
            return None if (math.isnan(f) or math.isinf(f)) else f
        return str(v)

    async def _log_inference(
        self,
        inference_id: str,
        features: dict,
        c2: dict,
        lgbm_prob: float,
        result: DecisionResult,
        covars: dict,
    ) -> Optional[str]:
        """Write inference log. Returns inference_id on success, None on failure."""
        try:
            safe_lgbm = self._safe_float(lgbm_prob)
            db = get_supabase()
            db.table("inference_logs").insert({
                "id":       inference_id,
                "bot_id":   None,
                "model":    "chronos2_lgbm_ensemble_v2",
                "features": {
                    k: self._safe_float(v)
                    for k, v in {**features, **covars}.items()
                },
                "forecast": {
                    **{k: (self._safe_float(v) if isinstance(v, float) else v)
                       for k, v in c2.items()},
                    "lgbm_prob": safe_lgbm,
                },
                "decision": result.action,
                "reasoning": result.reasoning,
                "latency_ms": c2.get("latency_ms", 0),
            }).execute()
            return inference_id
        except Exception as exc:
            log.warning("Inference log write failed: %s", exc)
            return None

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _build_risk_manager(self) -> RiskManager:
        return RiskManager(
            sl_atr_mult=self.config.sl_atr_mult,
            tp_atr_mult=self.config.tp_atr_mult,
            position_size_pct=self.config.position_size_pct,
            max_daily_dd_pct=self.config.max_daily_dd_pct,
            max_consecutive_losses=self.config.max_consecutive_losses,
        )

    async def _sleep_until_next_candle(self):
        """Fallback: sleep until next 4h UTC candle close."""
        import time as _time
        now_ms    = _time.time() * 1000
        next_ms   = ((now_ms // CANDLE_MS) + 1) * CANDLE_MS + 5_000  # +5s buffer
        wait_s    = (next_ms - now_ms) / 1000
        log.info("Fallback sleep %.1f min until next candle", wait_s / 60)
        await asyncio.sleep(max(wait_s, 1))


# ── Utility ───────────────────────────────────────────────────────────────────

def _make_liq_df(ws_snap: dict) -> pd.DataFrame:
    """
    Convert WS-accumulated liquidation totals into a single-row DataFrame
    compatible with build_all_features() liq input signature.
    """
    now = datetime.now(timezone.utc)
    return pd.DataFrame([{
        "time":         now,
        "liq_long_usd": ws_snap.get("ws_liq_long_usd", 0.0),
        "liq_short_usd": ws_snap.get("ws_liq_short_usd", 0.0),
    }]).set_index("time")
