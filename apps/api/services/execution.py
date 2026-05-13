"""
Execution Engine — main asyncio loop.
Every 4h close: fetch data → SMC/features → Chronos-2 → LightGBM → decide → execute → log.
Runs as a background task inside the FastAPI process.
"""

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

import numpy as np

from services.hyperliquid_data import HyperliquidData
from services.smc import build_all_features, ALL_FEATURES
from services.chronos_model import ChronosForecaster
from services.decision import DecisionEngine, DecisionResult
from services.risk import RiskManager
from services.notifications import TelegramNotifier
from services.supabase_client import get_supabase

log = logging.getLogger(__name__)

SYMBOL    = "BTC"
INTERVAL  = "4h"
CANDLE_MS = 14_400_000  # 4h in ms


class BotConfig:
    def __init__(self, **kw):
        self.sl_atr_mult           = kw.get("sl_atr_mult", 2.0)
        self.tp_atr_mult           = kw.get("tp_atr_mult", 3.5)
        self.position_size_pct     = kw.get("position_size_pct", 1.5)
        self.max_daily_dd_pct      = kw.get("max_daily_dd_pct", 3.0)
        self.directional_threshold = kw.get("directional_threshold", 0.62)
        self.adx_gate              = kw.get("adx_gate", 20.0)
        self.confluence_gate       = kw.get("confluence_gate", 60.0)
        self.max_consecutive_losses= kw.get("max_consecutive_losses", 4)
        self.mode                  = kw.get("mode", "paper")

    def model_dump(self):
        return self.__dict__


class ExecutionEngine:
    def __init__(self):
        self.config  = BotConfig()
        self.running = False
        self.mode    = "paper"

        self._hl        = HyperliquidData()
        self._chronos   = ChronosForecaster()
        self._notifier  = TelegramNotifier()
        self._lgbm      = None   # loaded lazily from saved model file
        self._position  = None   # {side, entry_price, stop_loss, take_profit, size, inference_id}
        self._equity    = 10_000.0  # paper equity (USD)
        self._task: Optional[asyncio.Task] = None

    # ── Config ────────────────────────────────────────────────────────────────

    def update_config(self, cfg):
        for k, v in cfg.model_dump().items():
            setattr(self.config, k, v)
        log.info(f"Config updated: {cfg.model_dump()}")

    # ── Start / Stop / Kill ───────────────────────────────────────────────────

    async def start(self, mode: str = "paper"):
        if self.running:
            return
        self.mode = mode
        self.running = True
        log.info(f"Execution engine starting in {mode.upper()} mode")
        await self._notifier.send_bot_started(mode)
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        if not self.running:
            return
        self.running = False
        if self._task:
            self._task.cancel()
        log.info("Execution engine stopped")
        await self._notifier.send_bot_stopped("manual")

    async def kill(self) -> dict:
        """Emergency: cancel open orders, close positions."""
        self.running = False
        if self._task:
            self._task.cancel()

        orders_cancelled = 0
        positions_closed = 0

        if self._position and self.mode == "live":
            # TODO: submit market close order via HL SDK
            positions_closed = 1

        self._position = None
        log.warning("KILL SWITCH activated")
        return {"orders_cancelled": orders_cancelled, "positions_closed": positions_closed}

    async def get_status(self) -> dict:
        risk = RiskManager(
            sl_atr_mult=self.config.sl_atr_mult,
            tp_atr_mult=self.config.tp_atr_mult,
            position_size_pct=self.config.position_size_pct,
            max_daily_dd_pct=self.config.max_daily_dd_pct,
            max_consecutive_losses=self.config.max_consecutive_losses,
        )
        return {
            "running":   self.running,
            "mode":      self.mode,
            "equity":    self._equity,
            "position":  self._position,
            "config":    self.config.model_dump(),
        }

    # ── Main Loop ─────────────────────────────────────────────────────────────

    async def _loop(self):
        """Runs every 4h candle close. Uses time-based scheduling, not cron."""
        while self.running:
            try:
                await self._cycle()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error(f"Cycle error: {e}", exc_info=True)
                await self._notifier.send_error(str(e), "main loop")

            # Wait until next 4h candle close
            await self._sleep_until_next_candle()

    async def _cycle(self):
        """One full inference cycle."""
        cycle_start = datetime.now(timezone.utc)
        log.info(f"Cycle starting at {cycle_start.isoformat()}")

        # 1. Fetch data
        df_4h     = await self._hl.get_ohlcv(SYMBOL, "4h", limit=512)
        snap      = await self._hl.get_market_snapshot(SYMBOL)
        df_fund   = await self._hl.get_funding_history(SYMBOL, hours=200)
        import pandas as pd
        df_oi     = pd.DataFrame()
        df_liq    = pd.DataFrame()

        # 2. Build features (SMC + CVD + OB + MTF + indicators)
        df_feat   = build_all_features(df_4h, df_fund, df_oi, df_liq)
        latest    = df_feat.iloc[-1].to_dict()
        atr       = latest.get("atr_14", None)

        # 3. Chronos-2 inference
        c2_out = self._chronos.forecast(df_4h["close"].values, horizon=3, atr=atr)

        # 4. LightGBM probability
        lgbm_prob = self._get_lgbm_prob(df_feat)

        # 5. Confluence score from Supabase (QT frontend writes it)
        confluence = self._read_confluence_score()

        # 6. Decision
        risk    = self._build_risk_manager()
        allowed, reason = risk.can_trade()

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

        # 7. Execute
        inference_id = str(uuid.uuid4())[:12]
        await self._log_inference(inference_id, latest, c2_out, lgbm_prob, result)

        if result.action != "no_trade" and allowed and not self._position:
            await self._open_position(result, snap, atr, inference_id)
        elif not allowed:
            log.info(f"Trade blocked: {reason}")

        # 8. Manage existing position (SL/TP check)
        if self._position:
            await self._manage_position(snap["mark_price"], risk)

        # 9. Heartbeat
        await risk.write_heartbeat()

        elapsed = (datetime.now(timezone.utc) - cycle_start).total_seconds() * 1000
        log.info(f"Cycle completed in {elapsed:.0f}ms | action={result.action}")

    async def _sleep_until_next_candle(self):
        """Sleep until next 4h UTC candle close (0:00, 4:00, 8:00, 12:00, 16:00, 20:00)."""
        now_ts = datetime.now(timezone.utc).timestamp() * 1000
        next_close = ((now_ts // CANDLE_MS) + 1) * CANDLE_MS + 5_000  # +5s buffer
        wait_s = (next_close - now_ts) / 1000
        log.info(f"Sleeping {wait_s/60:.1f} min until next candle close")
        await asyncio.sleep(max(wait_s, 1))

    def _build_risk_manager(self) -> RiskManager:
        return RiskManager(
            sl_atr_mult=self.config.sl_atr_mult,
            tp_atr_mult=self.config.tp_atr_mult,
            position_size_pct=self.config.position_size_pct,
            max_daily_dd_pct=self.config.max_daily_dd_pct,
            max_consecutive_losses=self.config.max_consecutive_losses,
        )

    def _get_lgbm_prob(self, df_feat) -> float:
        """Load saved LightGBM model and predict on latest candle."""
        if self._lgbm is None:
            model_path = os.path.join(os.path.dirname(__file__), "..", "models", "lgbm_latest.pkl")
            if os.path.exists(model_path):
                import pickle
                with open(model_path, "rb") as f:
                    self._lgbm = pickle.load(f)
                log.info("LightGBM model loaded from disk")
            else:
                log.warning("No LightGBM model found — using 0.5 (neutral)")
                return 0.5

        import pandas as pd
        features = [f for f in ALL_FEATURES if f in df_feat.columns]
        row = df_feat.iloc[[-1]][features].fillna(0)
        return float(self._lgbm.predict_proba(row)[0, 1])

    def _read_confluence_score(self) -> Optional[float]:
        """Read latest QT Confluence Score from Supabase (written by frontend)."""
        try:
            db = get_supabase()
            result = db.table("covariates").select("value").eq("key", "confluence_score").eq("source", "quantum_trade").order("time", desc=True).limit(1).execute()
            if result.data:
                return float(result.data[0]["value"])
        except Exception:
            pass
        return None

    async def _open_position(self, result: DecisionResult, snap: dict, atr: Optional[float], inference_id: str):
        risk = self._build_risk_manager()
        price = snap["mark_price"]
        atr   = atr or price * 0.01  # fallback 1% ATR

        params = risk.calculate_trade_params(
            side=result.action,
            entry_price=price,
            atr=atr,
            equity_usd=self._equity,
        )

        if self.mode == "paper":
            log.info(f"[PAPER] {result.action.upper()} {params.size_contracts:.4f} BTC @ {price:.2f}")
            self._position = {
                "side": result.action,
                "entry_price": price,
                "stop_loss": params.stop_loss,
                "take_profit": params.take_profit,
                "size_usd": params.size_usd,
                "size_contracts": params.size_contracts,
                "inference_id": inference_id,
                "opened_at": datetime.now(timezone.utc).isoformat(),
            }
        else:
            # TODO: submit real order via HL SDK
            pass

        db = get_supabase()
        db.table("orders").insert({
            "bot_id": "default",
            "symbol": SYMBOL,
            "side": result.action,
            "size": params.size_contracts,
            "price": price,
            "status": "filled" if self.mode == "paper" else "pending",
            "inference_id": inference_id,
        }).execute()

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

    async def _manage_position(self, current_price: float, risk: RiskManager):
        if not self._position:
            return
        side = self._position["side"]
        sl   = self._position["stop_loss"]
        tp   = self._position["take_profit"]

        reason = None
        if risk.should_stop_loss(side, current_price, sl):
            reason = "stop_loss"
        elif risk.should_take_profit(side, current_price, tp):
            reason = "take_profit"

        if reason:
            entry = self._position["entry_price"]
            size  = self._position["size_usd"]
            if side == "long":
                pnl_pct = (current_price - entry) / entry * 100
            else:
                pnl_pct = (entry - current_price) / entry * 100
            pnl_usd = size * pnl_pct / 100

            opened = datetime.fromisoformat(self._position["opened_at"])
            holding_h = (datetime.now(timezone.utc) - opened).total_seconds() / 3600

            self._equity += pnl_usd
            risk.record_trade_result(pnl_pct)

            log.info(f"Position closed: {reason} | PnL {pnl_pct:+.2f}% (${pnl_usd:+.2f})")

            await self._notifier.send_trade_closed(
                side=side,
                symbol=SYMBOL,
                pnl_usd=pnl_usd,
                pnl_pct=pnl_pct,
                reason=reason,
                holding_hours=holding_h,
            )

            db = get_supabase()
            db.table("equity_snapshots").insert({
                "bot_id": "default",
                "equity_usd": self._equity,
                "unrealized_pnl": 0.0,
                "realized_pnl": pnl_usd,
                "drawdown_pct": min(0.0, pnl_pct),
            }).execute()

            self._position = None

    async def _log_inference(
        self, inference_id: str, features: dict, c2: dict, lgbm_prob: float, result: DecisionResult
    ):
        try:
            db = get_supabase()
            db.table("inference_logs").insert({
                "id": inference_id,
                "bot_id": "default",
                "model": "chronos2_lgbm_ensemble_v1",
                "features": {k: (float(v) if hasattr(v, "__float__") else str(v)) for k, v in features.items()},
                "forecast": c2,
                "decision": result.action,
                "reasoning": result.reasoning,
                "latency_ms": c2.get("latency_ms", 0),
            }).execute()
        except Exception as e:
            log.warning(f"Inference log write failed: {e}")
