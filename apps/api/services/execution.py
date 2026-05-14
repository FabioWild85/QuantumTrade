"""
Execution Engine — main asyncio loop.
Event-driven via Hyperliquid WebSocket candle close.
Every 4h close: fetch data → features → Chronos-2 → LightGBM → decide → execute → log.
LightGBM is retrained automatically every 120 cycles (~30 days).
"""

import asyncio
import logging
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
from services.decision import DecisionEngine, DecisionResult
from services.risk import RiskManager
from services.notifications import TelegramNotifier
from services.trainer import LGBMTrainer, load_model
from services.covariates import update_covariates, get_latest_covariates
from services.supabase_client import get_supabase

log = logging.getLogger(__name__)

SYMBOL    = "BTC"
INTERVAL  = "4h"
CANDLE_MS = 14_400_000  # 4h in ms

HL_TESTNET        = os.getenv("HL_TESTNET", "true").lower() == "true"
HL_AGENT_PRIVKEY  = os.getenv("HL_AGENT_PRIVATE_KEY", "")  # for live order signing

# Retrain every N completed cycles (~30 days on 4h bars)
RETRAIN_INTERVAL = 120


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
        self.trailing_sl_activation = kw.get("trailing_sl_activation", 1.0)
        # LightGBM mid-trade exit: exit only after N consecutive bars below threshold
        self.lgbm_exit_enabled       = kw.get("lgbm_exit_enabled",       False)
        self.lgbm_exit_threshold     = kw.get("lgbm_exit_threshold",     0.30)
        self.lgbm_exit_min_hold_bars = kw.get("lgbm_exit_min_hold_bars", 6)
        self.lgbm_exit_confirm_bars  = kw.get("lgbm_exit_confirm_bars",  2)

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
        self._retrain_task: Optional[asyncio.Task] = None
        self._task: Optional[asyncio.Task]         = None

    # ── Config ────────────────────────────────────────────────────────────────

    def update_config(self, cfg):
        for k, v in cfg.model_dump().items():
            setattr(self.config, k, v)
        # Rebuild risk manager with new limits (preserve daily counters)
        self._risk = self._build_risk_manager()
        log.info("Config updated: %s", cfg.model_dump())

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self, mode: str = "paper"):
        if self.running:
            return
        self.mode    = mode
        self.running = True

        # Load model from disk if available
        self._load_model_from_disk()

        # Start WebSocket
        await self._ws.start()

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

    async def get_status(self) -> dict:
        return {
            "running":       self.running,
            "mode":          self.mode,
            "equity":        self._equity,
            "position":      self._position,
            "cycle_count":   self._cycle_count,
            "ws_connected":  self._ws.is_connected,
            "model_loaded":  self._lgbm_model is not None,
            "config":        self.config.model_dump(),
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

            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.error("Cycle error: %s", exc, exc_info=True)
                await self._notifier.send_error(str(exc), "main loop")
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
        df_oi  = pd.DataFrame()  # OI delta handled inside build_all_features via WS values

        # 3. Build full 64-feature matrix
        df_feat = build_all_features(df_4h, df_fund, df_oi, df_liq)
        latest  = df_feat.iloc[-1].to_dict()
        atr     = latest.get("atr_14")

        # Inject live WS CVD into features (overrides Haas approximation with real data)
        latest["cvd_delta"] = ws_snap["ws_cvd_delta"]

        # 4. Chronos-2 inference
        c2_out = self._chronos.forecast(df_4h["close"].values, horizon=3, atr=atr)

        # 5. LightGBM probability (non-C2 features)
        lgbm_prob = self._get_lgbm_prob(df_feat)

        # 6. External covariates (F&G, BTC dominance) + confluence score
        await update_covariates()
        covars     = get_latest_covariates()
        confluence = covars.get("confluence_score")

        # 7. Decision gate
        allowed, block_reason = self._risk.can_trade()
        decision_engine = DecisionEngine(
            directional_threshold=self.config.directional_threshold,
            adx_gate=self.config.adx_gate,
            confluence_gate=self.config.confluence_gate,
        )
        result = decision_engine.decide(
            features=latest,
            c2_output=c2_out,
            lgbm_prob=lgbm_prob,
            confluence_score=confluence,
            current_price=snap["mark_price"],
        )

        # 8. Execute
        inference_id = str(uuid.uuid4())[:12]
        await self._log_inference(inference_id, latest, c2_out, lgbm_prob, result, covars)

        if result.action != "no_trade" and allowed and self._position is None:
            await self._open_position(result, snap, atr, inference_id)
        elif not allowed:
            log.info("Trade blocked: %s", block_reason)

        # 9. Manage existing position (SL/TP + optional LightGBM mid-trade exit)
        if self._position:
            await self._manage_position(snap["mark_price"], df_feat)

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

    async def _retrain_background(self):
        log.info("Auto-retraining triggered (cycle %d)", self._cycle_count)
        try:
            metrics = await self._trainer.retrain(SYMBOL, lookback_candles=500)
            if metrics.get("status") == "ok":
                # Reload the freshly trained model
                result = load_model()
                if result:
                    self._lgbm_model, self._lgbm_features = result
                log.info(
                    "Model reloaded after retrain: OOS acc=%.2f%%, ll=%.4f",
                    metrics["oos_accuracy"] * 100, metrics["oos_log_loss"],
                )
                # Log event to Supabase
                try:
                    db = get_supabase()
                    db.table("events").insert({
                        "severity": "info",
                        "kind":     "lgbm_retrained",
                        "message":  f"LightGBM retrained: OOS acc={metrics['oos_accuracy']:.2%}",
                        "payload":  metrics,
                    }).execute()
                except Exception:
                    pass
        except Exception as exc:
            log.error("Retraining failed: %s", exc, exc_info=True)

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

        params = self._risk.calculate_trade_params(
            side=result.action,
            entry_price=price,
            atr=atr,
            equity_usd=self._equity,
        )
        # Round to 4 decimal places (HL BTC min size = 0.001)
        size = max(round(params.size_contracts, 4), 0.001)

        if self.mode == "live":
            hl_order_id = await self._submit_open_order(result.action, size, price, params.stop_loss)
        else:
            hl_order_id = None
            log.info(
                "[PAPER] %s %.4f BTC @ %.2f | SL=%.2f TP=%.2f R:R=%.2f",
                result.action.upper(), size, price,
                params.stop_loss, params.take_profit, params.rr_ratio,
            )

        self._position = {
            "side":           result.action,
            "entry_price":    price,
            "stop_loss":      params.stop_loss,
            "take_profit":    params.take_profit,
            "size_usd":       params.size_usd,
            "size_contracts": size,
            "inference_id":   inference_id,
            "hl_order_id":    hl_order_id,
            "opened_at":      datetime.now(timezone.utc).isoformat(),
            "bars_held":      0,
            "lgbm_strikes":   0,
        }

        try:
            db = get_supabase()
            db.table("orders").insert({
                "bot_id":       "default",
                "hl_order_id":  hl_order_id,
                "symbol":       SYMBOL,
                "side":         result.action,
                "size":         size,
                "price":        price,
                "status":       "filled" if self.mode == "paper" else "pending",
                "inference_id": inference_id,
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

    async def _manage_position(self, current_price: float, df_feat: pd.DataFrame):
        if not self._position:
            return

        self._position["bars_held"] = self._position.get("bars_held", 0) + 1
        side  = self._position["side"]
        sl    = self._position["stop_loss"]
        tp    = self._position["take_profit"]

        # ── LightGBM mid-trade exit (v2: consecutive-bar confirmation) ─────────
        if (self.config.lgbm_exit_enabled and self._lgbm_model is not None
                and self._position["bars_held"] >= self.config.lgbm_exit_min_hold_bars):
            lgbm_p     = self._get_lgbm_prob(df_feat)
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

        # ── Standard SL / TP check ───────────────────────────────────────────
        reason = None
        if self._risk.should_stop_loss(side, current_price, sl):
            reason = "stop_loss"
        elif self._risk.should_take_profit(side, current_price, tp):
            reason = "take_profit"

        if reason:
            await self._close_position(current_price, reason)

    async def _close_position(self, exit_price: float, reason: str):
        if not self._position:
            return

        side  = self._position["side"]
        entry = self._position["entry_price"]
        size  = self._position["size_usd"]

        pnl_pct = (
            (exit_price - entry) / entry * 100 if side == "long"
            else (entry - exit_price) / entry * 100
        )
        pnl_usd = size * pnl_pct / 100

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
        except Exception as exc:
            log.warning("Equity snapshot write failed: %s", exc)

        self._position = None

    # ── Live order submission (Hyperliquid SDK) ───────────────────────────────

    async def _submit_open_order(
        self, side: str, size: float, mark_price: float, stop_loss: float
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

            is_buy  = (side == "long")
            # IOC at 50bps slippage for market-like fill
            slip_px = mark_price * (1.005 if is_buy else 0.995)
            slip_px = round(slip_px, 1)

            result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, is_buy, size, slip_px,
                {"limit": {"tif": "Ioc"}},
                False,   # reduce_only
            )
            log.info("Live entry order submitted: %s", result)

            # Native SL trigger order
            sl_is_buy = not is_buy
            sl_result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, sl_is_buy, size, stop_loss,
                {"trigger": {"triggerPx": round(stop_loss, 1), "isMarket": True, "tpsl": "sl"}},
                True,    # reduce_only
            )
            log.info("Native SL order submitted: %s", sl_result)

            oid = str(result.get("response", {}).get("data", {}).get("statuses", [{}])[0].get("resting", {}).get("oid", ""))
            return oid or None

        except Exception as exc:
            log.error("Live open order failed: %s", exc, exc_info=True)
            return None

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

    async def _log_inference(
        self,
        inference_id: str,
        features: dict,
        c2: dict,
        lgbm_prob: float,
        result: DecisionResult,
        covars: dict,
    ):
        try:
            db = get_supabase()
            db.table("inference_logs").insert({
                "id":       inference_id,
                "bot_id":   None,  # UUID lookup not needed; NULL is allowed
                "model":    "chronos2_lgbm_ensemble_v2",
                "features": {
                    k: (float(v) if hasattr(v, "__float__") else str(v))
                    for k, v in {**features, **covars}.items()
                },
                "forecast": {**c2, "lgbm_prob": lgbm_prob},
                "decision": result.action,
                "reasoning": result.reasoning,
                "latency_ms": c2.get("latency_ms", 0),
            }).execute()
        except Exception as exc:
            log.warning("Inference log write failed: %s", exc)

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
