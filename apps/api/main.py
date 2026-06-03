"""
AI Trading Hub — FastAPI Backend
Single-user, single-bot, BTC-PERP on Hyperliquid (4h Trend Following)
"""

import asyncio
import logging
import os
import threading
import time as _time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import psutil

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from services.execution import ExecutionEngine
from services.supabase_client import get_supabase
from services.notifications import TelegramNotifier

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
log = logging.getLogger("trading_hub")

# ─── Singleton engine (one bot, one process) ────────────────────────────────

engine: Optional[ExecutionEngine] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    log.info("AI Trading Hub starting…")
    engine = ExecutionEngine()

    # Restore last saved config from DB (survives restarts/deploys)
    _auto_start_mode: Optional[str] = None
    try:
        db = get_supabase()
        result = db.table("bot_configs").select("params,mode,running").eq("name", "default").execute()
        if result.data:
            row    = result.data[0]
            params = {**(row.get("params") or {}), "mode": row.get("mode", "paper")}
            engine.update_config(BotConfig(**params))
            log.info("Restored bot config from DB (mode=%s)", params.get("mode"))
            if row.get("running"):
                _auto_start_mode = params.get("mode", "paper")
        else:
            log.info("No saved config found — using defaults")
    except Exception as exc:
        log.warning("Could not restore config from DB: %s", exc)

    # Reconcile equity_snapshots against trades table on every startup.
    # Fixes orphaned snapshots from any trades deleted before snapshot cleanup was in place.
    try:
        _db = get_supabase()
        _rebuild_equity_from_trades(_db)
    except Exception as exc:
        log.warning("Startup equity reconcile failed: %s", exc)

    if _auto_start_mode:
        log.info("Auto-resuming bot (mode=%s) after restart", _auto_start_mode)
        asyncio.create_task(engine.start(_auto_start_mode))
        _log_event("bot_auto_resumed", f"Bot riavviato automaticamente (mode={_auto_start_mode}) dopo restart VPS", "info", {"mode": _auto_start_mode})

    yield
    log.info("AI Trading Hub shutting down…")
    _log_event("server_stopping", "Server in fase di spegnimento (deploy/restart)", "warning")
    if engine and engine.running:
        await engine.stop()
    _persist_running_state(False)


app = FastAPI(
    title="AI Trading Hub",
    version="1.0.0",
    description="BTC-PERP Trend Following on Hyperliquid with Chronos-2 + LightGBM",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Health ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    status = await engine.get_status() if engine else {}
    backtest_running = any(j["status"] == "running" for j in backtest_jobs.values())
    return {
        "status":           "ok",
        "running":          status.get("running", False),
        "mode":             status.get("mode", "paper"),
        "ws_connected":     status.get("ws_connected", False),
        "model_loaded":     status.get("model_loaded", False),
        "cycle_count":      status.get("cycle_count", 0),
        "backtest_running": backtest_running,
    }


# ─── Wallet ──────────────────────────────────────────────────────────────────

class ConnectWalletRequest(BaseModel):
    address: str = Field(..., description="Main wallet address (0x…)")


class CreateAgentRequest(BaseModel):
    main_address: str
    agent_name: str = "trading-hub-agent"


@app.post("/wallet/connect")
async def wallet_connect(req: ConnectWalletRequest):
    db = get_supabase()
    db.table("events").insert({
        "severity": "info",
        "kind": "wallet_connected",
        "message": f"Wallet {req.address[:10]}… connected",
        "payload": {"address": req.address},
    }).execute()
    return {"status": "connected", "address": req.address}


@app.post("/wallet/agent")
async def wallet_create_agent(req: CreateAgentRequest):
    """Creates an agent wallet on HL testnet and stores encrypted private key."""
    from services.hyperliquid_data import create_agent_wallet
    result = await create_agent_wallet(req.main_address, req.agent_name)
    return result


@app.delete("/wallet/agent/{agent_id}")
async def wallet_revoke_agent(agent_id: str):
    from services.hyperliquid_data import revoke_agent_wallet
    result = await revoke_agent_wallet(agent_id)
    return result


# ─── Bot ─────────────────────────────────────────────────────────────────────

class BotConfig(BaseModel):
    sl_atr_mult: float = Field(2.0, ge=0.5, le=5.0)
    tp_atr_mult: float = Field(3.5, ge=1.0, le=10.0)
    position_size_pct: float = Field(1.5, ge=0.1, le=5.0)
    max_daily_dd_pct: float = Field(3.0, ge=0.5, le=10.0)
    directional_threshold: float = Field(0.62, ge=0.50, le=0.90)
    adx_gate: float = Field(20.0, ge=10.0, le=40.0)
    confluence_gate: float = Field(60.0, ge=0.0, le=100.0)
    max_consecutive_losses: int = Field(4, ge=1, le=10)
    mode: str = Field("paper", pattern="^(paper|live)$")
    # Advanced exit strategies
    partial_tp_enabled: bool = Field(False)
    partial_tp_atr_mult: float = Field(1.5, ge=0.5, le=5.0)
    partial_tp_pct: float = Field(50.0, ge=10.0, le=90.0)
    trailing_sl_enabled: bool = Field(False)
    trailing_sl_activation: float = Field(1.5, ge=0.5, le=3.0)
    # LightGBM mid-trade exit (v2: consecutive-bar confirmation)
    lgbm_exit_enabled: bool = Field(False)
    lgbm_exit_threshold: float = Field(0.30, ge=0.15, le=0.50)
    lgbm_exit_min_hold_bars: int = Field(6, ge=1, le=48)
    lgbm_exit_confirm_bars: int = Field(2, ge=1, le=6)
    enhanced_exit_enabled: bool = Field(False)
    # Advanced signal controls
    chronos_enabled: bool = Field(True)
    chronos_weight: float = Field(0.40, ge=0.0, le=0.9)
    adx_gate_enabled: bool = Field(True)
    sweep_gate_enabled: bool = Field(True)
    sweep_gate_directional: bool = Field(False)
    fvg_filter_enabled: bool = Field(True)
    mtf_alignment_enabled: bool = Field(True)
    # Advanced exit
    be_sl_enabled: bool = Field(False)
    be_sl_activation: float = Field(1.0, ge=0.5, le=3.0)
    max_hold_bars_enabled: bool = Field(False)
    max_hold_bars: int = Field(48, ge=12, le=168)
    # Chronos-2 adaptive features
    c2_uncertainty_gate_enabled: bool = Field(False)
    c2_uncertainty_threshold: float = Field(0.05, ge=0.01, le=0.15)
    c2_cont_prob_gate_enabled: bool = Field(False)
    c2_cont_prob_threshold: float = Field(0.25, ge=0.05, le=0.80)
    dynamic_sl_tp_enabled: bool = Field(False)
    dynamic_sl_tp_blend: float = Field(0.50, ge=0.0, le=1.0)
    recalibrated_uncertainty_thresholds: bool = Field(True)
    p10_sl_floor_enabled: bool = Field(False)
    # Regime Bias: asymmetric threshold by market direction
    regime_bias_enabled: bool = Field(False)
    regime_bias_delta: float = Field(0.08, ge=0.01, le=0.20)
    regime_bias_size_factor: float = Field(1.0, ge=0.30, le=1.0)
    forced_regime: str = Field("auto", pattern="^(auto|bull|bear|neutral)$")
    regime_bias_enhanced: bool = Field(False)
    # CVD Absorption Filter
    absorption_filter_enabled: bool  = Field(False)
    absorption_z_threshold:    float = Field(2.0, ge=0.5, le=5.0)
    # Binance Cross-Exchange CVD (fetches Binance 4H klines for taker_buy_vol each cycle)
    # Adds 3 features: binance_cvd_slope, binance_absorption_z, cross_cvd_div.
    # Affects LightGBM only after a retrain with these features enabled.
    binance_cvd_enabled: bool = Field(False)
    # Signal quality filters
    exhaustion_guard_enabled:  bool  = Field(True)
    structural_sl_enabled:     bool  = Field(True)
    ob_buffer_pct:             float = Field(0.3, ge=0.0, le=2.0)
    ob_buffer_min_atr:         float = Field(0.0, ge=0.0, le=1.0)
    # OB-based TP
    ob_tp_enabled:             bool  = Field(False)
    ob_tp_blend:               float = Field(1.0, ge=0.0, le=1.0)
    # FVG-based SL
    fvg_sl_enabled:            bool  = Field(False)
    fvg_tp_enabled:            bool  = Field(False)
    fvg_tp_blend:              float = Field(1.0, ge=0.0, le=1.0)
    # Swing High/Low SL + TP
    swing_sl_enabled:          bool  = Field(False)
    swing_tp_enabled:          bool  = Field(False)
    swing_tp_blend:            float = Field(1.0, ge=0.0, le=1.0)
    # Dual ATR: separate ATR periods for SL (ATR_21, smoother) and TP (ATR_14, reactive)
    dual_atr_enabled: bool = Field(False)
    # Late Entry Distance Filter
    late_entry_filter_enabled: bool  = Field(False)
    late_entry_max_ob_dist:    float = Field(3.0, ge=1.0, le=8.0)
    # Path Obstruction Gate
    path_obstruction_enabled:  bool  = Field(False)
    path_obstruction_max_dist: float = Field(1.5, ge=0.5, le=4.0)
    # Consecutive Bars Filter (trend age / exhaustion)
    consec_bars_filter_enabled: bool = Field(False)
    consec_bars_max_long:       int  = Field(8, ge=3, le=20)
    consec_bars_max_short:      int  = Field(8, ge=3, le=20)
    # Walk-forward & retraining parameters
    auto_retrain_enabled:   bool = Field(True)
    retrain_every_n_cycles: int = Field(120, ge=20,  le=120)
    wf_n_splits:            int = Field(5,   ge=3,   le=12)
    wf_purge_gap:           int = Field(5,   ge=2,   le=20)
    # Feature Importance Pruning
    use_feature_pruning:            bool  = Field(False)
    feature_pruning_min_importance: float = Field(0.005, ge=0.001, le=0.05)
    # Isotonic calibration on c2_dir_prob
    use_chronos_calibration:        bool  = Field(False)
    # Gate LightGBM 1H — confirmation model on 1H timeframe
    use_1h_lgbm_gate:               bool  = Field(False)
    lgbm_1h_min_agreement:          float = Field(0.52, ge=0.50, le=0.70)
    lgbm_1h_block_threshold:        float = Field(0.45, ge=0.30, le=0.50)
    # Optuna hyperparameter tuning (manual/deep retrains only)
    use_optuna:                     bool  = Field(False)
    optuna_n_trials:                int   = Field(50,  ge=10, le=200)
    # Macro Event Pause
    macro_pause_enabled:        bool  = Field(False)
    macro_pause_window_min:     int   = Field(60, ge=15, le=240)
    macro_pause_close_position: bool  = Field(False)
    macro_pause_fomc:           bool  = Field(True)
    macro_pause_cpi:            bool  = Field(True)
    macro_pause_nfp:            bool  = Field(True)
    macro_pause_ppi:            bool  = Field(False)
    macro_pause_jolts:          bool  = Field(False)
    # Funding Rate Bias
    funding_gate_enabled:  bool  = Field(False)
    funding_gate_lookback: int   = Field(6,       ge=2,       le=24)
    funding_high_thr:      float = Field(0.00010, ge=0.00003, le=0.00050)
    funding_extreme_thr:   float = Field(0.00030, ge=0.00010, le=0.00100)
    funding_bias_delta:    float = Field(0.03,    ge=0.01,    le=0.08)
    # Fear & Greed Bias
    fng_gate_enabled:      bool  = Field(False)
    fng_extreme_fear_thr:  float = Field(20.0,    ge=5.0,     le=40.0)
    fng_fear_thr:          float = Field(35.0,    ge=20.0,    le=50.0)
    fng_greed_thr:         float = Field(65.0,    ge=50.0,    le=80.0)
    fng_extreme_greed_thr: float = Field(80.0,    ge=60.0,    le=95.0)
    fng_bias_delta:        float = Field(0.03,    ge=0.01,    le=0.08)


class StartBotRequest(BaseModel):
    mode: str = Field("paper", pattern="^(paper|live)$")


@app.get("/bot")
async def bot_get_config():
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    return engine.config.model_dump()


@app.put("/bot")
async def bot_update_config(cfg: BotConfig):
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    engine.update_config(cfg)
    db = get_supabase()
    # Preserve internal keys (e.g. _paper_position) that live in params
    # but are not part of BotConfig — a full overwrite would wipe them.
    existing = db.table("bot_configs").select("params").eq("name", "default").execute()
    existing_params = (existing.data[0].get("params") or {}) if existing.data else {}
    merged_params = {**existing_params, **cfg.model_dump()}
    db.table("bot_configs").upsert({
        "name": "default",
        "params": merged_params,
        "mode": cfg.mode,
        "status": "updated",
    }, on_conflict="name").execute()
    return {"status": "updated", "config": cfg.model_dump()}


@app.get("/bot/backtest")
async def bot_get_backtest_config():
    """Returns the saved backtest-specific config, falling back to BotConfig defaults."""
    db = get_supabase()
    result = db.table("bot_configs").select("params").eq("name", "backtest").execute()
    if result.data:
        params = result.data[0].get("params", {})
        defaults = BotConfig().model_dump()
        defaults.update(params)
        return defaults
    return BotConfig().model_dump()


@app.put("/bot/backtest")
async def bot_update_backtest_config(cfg: BotConfig):
    """Persist backtest-specific config independently from live config."""
    db = get_supabase()
    db.table("bot_configs").upsert({
        "name": "backtest",
        "params": cfg.model_dump(),
        "mode": "backtest",
        "status": "updated",
    }, on_conflict="name").execute()
    return {"status": "updated", "config": cfg.model_dump()}


def _persist_running_state(running: bool, mode: Optional[str] = None):
    """Fire-and-forget: write running state to bot_configs so auto-resume works after restart."""
    try:
        db = get_supabase()
        update: dict = {"running": running}
        if mode:
            update["mode"] = mode
        db.table("bot_configs").update(update).eq("name", "default").execute()
    except Exception as exc:
        log.warning("Could not persist running state: %s", exc)


@app.post("/bot/start")
async def bot_start(req: StartBotRequest, background_tasks: BackgroundTasks):
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    if engine.running:
        return {"status": "already_running", "mode": engine.mode}
    background_tasks.add_task(engine.start, req.mode)
    background_tasks.add_task(_persist_running_state, True, req.mode)
    background_tasks.add_task(_log_event, "bot_started", f"Bot avviato in modalità {req.mode}", "info", {"mode": req.mode})
    return {"status": "starting", "mode": req.mode}


@app.post("/bot/stop")
async def bot_stop():
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    await engine.stop()
    _persist_running_state(False)
    _log_event("bot_stopped", "Bot fermato dall'utente", "info")
    return {"status": "stopped"}


@app.get("/macro-events")
async def macro_events(days: int = 30):
    """Return upcoming macro events for the next N days (default 30)."""
    from services.economic_calendar import get_calendar
    cal = get_calendar()
    events = cal.get_upcoming(days_ahead=min(days, 180))
    # Mark which events are currently paused based on engine config
    pause_active = engine._macro_pause_active if engine else None
    return {
        "events":       events,
        "pause_active": pause_active,
        "total":        len(events),
    }


class ManualTradeRequest(BaseModel):
    side: str   = Field(..., pattern="^(long|short)$")
    mode: str   = Field("paper", pattern="^(paper|live)$")
    sl_pct: float  = Field(1.0, ge=0.1, le=10.0,   description="SL distance as % of entry price")
    tp_pct: float  = Field(2.0, ge=0.1, le=20.0,   description="TP distance as % of entry price")
    size_usd: float = Field(100.0, ge=10.0, le=50000.0, description="Position size in USD")


@app.post("/bot/trade/manual")
async def open_manual_trade(req: ManualTradeRequest):
    """Open a manual test trade without going through the ML pipeline."""
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    result = await engine.open_manual_trade(
        side=req.side,
        sl_pct=req.sl_pct,
        tp_pct=req.tp_pct,
        size_usd=req.size_usd,
        mode_override=req.mode,
    )
    if not result.get("ok"):
        raise HTTPException(409, result.get("error", "Manual trade failed"))
    return result


@app.post("/bot/position/close")
async def close_position_manual():
    """Close the open position at current mark price without stopping the bot."""
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    if not engine._position:
        raise HTTPException(404, "No open position")
    result = await engine.close_position_manual()
    _log_event(
        "position_closed_manual",
        f"Posizione chiusa manualmente @ ${result.get('exit_price', 0):,.2f}",
        "info",
        result,
    )
    return result


class RetrainRequest(BaseModel):
    from_date: Optional[str] = Field(
        None,
        description="YYYY-MM-DD — se impostato usa Binance dal quella data a oggi (deep training). "
                    "Se None usa gli ultimi 500 candles da HL (retrain standard).",
    )
    use_optuna: Optional[bool] = Field(
        None,
        description="Se True sovrascrive il valore in config per questo retrain.",
    )
    optuna_n_trials: Optional[int] = Field(
        None, ge=10, le=200,
        description="Numero di trial Optuna. Sovrascrive il valore in config se impostato.",
    )


@app.post("/retrain")
async def force_retrain(req: Optional[RetrainRequest] = None):
    """
    Manually trigger a LightGBM retrain.
    Pass {"from_date": "2021-01-01"} in the body to train on full historical data via Binance.
    Blocks until complete. Returns metrics on success, {"status": "busy"} if already running.
    """
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    from_date               = req.from_date        if req else None
    use_optuna_override     = req.use_optuna       if req else None
    optuna_n_trials_override = req.optuna_n_trials if req else None

    result = await engine.retrain_manual(
        from_date=from_date,
        use_optuna_override=use_optuna_override,
        optuna_n_trials_override=optuna_n_trials_override,
    )
    trigger = f"deep({from_date})" if from_date else "manual"
    optuna_note = f" optuna_ll={result.get('optuna', {}).get('best_ll', 'N/A')}" if result.get("optuna") else ""
    _log_event(
        "lgbm_retrain_manual",
        f"Retrain {trigger}: status={result.get('status')} oos_acc={result.get('oos_accuracy', 'N/A')} "
        f"n_rows={result.get('train_rows', 'N/A')} n_features={result.get('n_features', 'N/A')}{optuna_note}",
        "info",
        result,
    )
    return result


@app.post("/bot/kill")
async def bot_kill():
    """Emergency kill: cancels open orders, closes positions."""
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    result = await engine.kill()
    _persist_running_state(False)
    notifier = TelegramNotifier()
    await notifier.send_kill_alert(result)
    return {"status": "killed", "details": result}


@app.get("/bot/status")
async def bot_status():
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    return await engine.get_status()


# ─── Data & Forecast ─────────────────────────────────────────────────────────

@app.get("/forecast")
async def get_forecast(symbol: str = "BTC", horizon: int = 3):
    """On-demand Chronos-2 forecast with full fan-chart data for the UI."""
    import ta as _ta
    import pandas as pd
    from datetime import date, timedelta
    from services.chronos_model import ChronosForecaster
    from services.hyperliquid_data import HyperliquidData
    from services.external_data import get_best_oi

    hl = HyperliquidData()
    df = await hl.get_ohlcv(symbol, "4h", limit=512)

    # Compute current ATR so Chronos-2 can produce c2_p50_vs_atr
    atr_series = _ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"], 14).average_true_range()
    atr = float(atr_series.iloc[-1]) if not atr_series.empty else None

    # Funding rate covariate (same source as execution engine)
    try:
        df_fund = await hl.get_funding_history(symbol, hours=512 * 4)
        funding_series = df_fund["funding"].reindex(df.index, method="ffill").values if not df_fund.empty else None
    except Exception:
        funding_series = None

    # OI covariate (Coinglass → Coinalyze fallback)
    try:
        _today  = date.today().isoformat()
        _from_d = (date.today() - timedelta(days=90)).isoformat()
        df_oi  = await get_best_oi(symbol, start_date=_from_d, end_date=_today)
        oi_series = df_oi["oi"].reindex(df.index, method="ffill").values if not df_oi.empty else None
    except Exception:
        oi_series = None

    # CVD covariate — Haas approximation from OHLCV (no external API required)
    import numpy as _np
    try:
        _hl      = (df["high"] - df["low"]).replace(0, float("nan"))
        _buy_vol = df["volume"] * (df["close"] - df["low"]) / _hl
        cvd_series: Optional[_np.ndarray] = (_buy_vol - (df["volume"] - _buy_vol)).values
    except Exception:
        cvd_series = None

    forecaster = ChronosForecaster()
    result = forecaster.forecast(
        df["close"].values,
        horizon=horizon,
        atr=atr,
        volume_series=df["volume"].values if "volume" in df.columns else None,
        funding_series=funding_series,
        oi_series=oi_series,
        cvd_series=cvd_series,
    )

    return {
        "symbol":          symbol,
        "horizon_steps":   horizon,
        "horizon_hours":   horizon * 4,
        "current_price":   float(df["close"].iloc[-1]),
        "last_candle_time": df.index[-1].isoformat(),
        "atr":             atr,
        **result,   # includes all c2_* keys + fan dict + cov_used
    }


@app.get("/equity")
async def get_equity(from_ts: Optional[str] = None, to_ts: Optional[str] = None, limit: int = 200):
    db = get_supabase()
    q = db.table("equity_snapshots").select("*").order("time", desc=True).limit(limit)
    if from_ts:
        q = q.gte("time", from_ts)
    if to_ts:
        q = q.lte("time", to_ts)
    result = q.execute()
    return result.data


@app.get("/equity/stream")
async def equity_stream():
    """Server-Sent Events stream: pushes new equity snapshots as they arrive."""
    import json
    from fastapi.responses import StreamingResponse

    async def generate():
        last_time: Optional[str] = None
        while True:
            try:
                db   = get_supabase()
                rows = (
                    db.table("equity_snapshots")
                    .select("*")
                    .order("time", desc=True)
                    .limit(1)
                    .execute()
                    .data
                )
                if rows:
                    row = rows[0]
                    if row.get("time") != last_time:
                        last_time = row["time"]
                        yield f"data: {json.dumps(row)}\n\n"
                    else:
                        yield ": heartbeat\n\n"   # keep TCP connection alive
                else:
                    yield ": empty\n\n"
            except Exception as exc:
                yield f": error {exc}\n\n"
            await asyncio.sleep(10)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":       "keep-alive",
        },
    )


@app.get("/live/account")
async def live_account():
    """Real HL account state: balance, margin, open positions."""
    import os as _os
    wallet = _os.getenv("HL_WALLET_ADDRESS", "")
    if not wallet:
        return {"configured": False}
    try:
        from services.hyperliquid_data import HyperliquidData
        hl = HyperliquidData()
        data = await hl._post({"type": "clearinghouseState", "user": wallet})
        margin = data.get("marginSummary", {})
        positions = []
        for ap in data.get("assetPositions", []):
            pos = ap.get("position", {})
            szi = float(pos.get("szi", 0))
            if abs(szi) > 1e-6:
                lev = pos.get("leverage", {}) or {}
                positions.append({
                    "coin":             pos.get("coin"),
                    "side":             "long" if szi > 0 else "short",
                    "size":             abs(szi),
                    "entry_price":      float(pos.get("entryPx") or 0),
                    "unrealized_pnl":   float(pos.get("unrealizedPnl") or 0),
                    "return_on_equity": float(pos.get("returnOnEquity") or 0),
                    "leverage_value":   float(lev.get("value", 1)) if isinstance(lev, dict) else 1.0,
                    "leverage_type":    lev.get("type", "isolated") if isinstance(lev, dict) else "isolated",
                })
        return {
            "configured":        True,
            "account_value":     float(margin.get("accountValue", 0)),
            "total_margin_used": float(margin.get("totalMarginUsed", 0)),
            "total_ntl_pos":     float(margin.get("totalNtlPos", 0)),
            "withdrawable":      float(data.get("withdrawable", 0)),
            "positions":         positions,
        }
    except Exception as exc:
        log.warning("live_account fetch failed: %s", exc)
        return {"configured": True, "error": str(exc)}


@app.get("/trades")
async def get_trades(limit: int = 100):
    db = get_supabase()
    result = db.table("trades").select("*, orders!entry_order_id(*)").order("opened_at", desc=True).limit(limit).execute()
    return result.data


def _rebuild_equity_from_trades(db) -> float:
    """Recompute equity_snapshots from trades table and sync engine._equity.

    Deletes all existing equity_snapshots and re-inserts one per trade in
    chronological order, building the cumulative equity from INITIAL_EQUITY.
    Returns the reconciled equity value.
    """
    INITIAL_EQUITY = 10_000.0
    trades_res = db.table("trades").select("pnl_usd,closed_at").order("closed_at", desc=False).execute()
    trades = trades_res.data or []

    # Wipe all snapshots and rebuild from the ground truth (trades table)
    db.table("equity_snapshots").delete().gt("time", "2000-01-01").execute()

    equity = INITIAL_EQUITY
    for t in trades:
        pnl = float(t.get("pnl_usd") or 0.0)
        equity += pnl
        closed_at = t.get("closed_at")
        if closed_at:
            try:
                db.table("equity_snapshots").insert({
                    "bot_id":         "default",
                    "time":           closed_at,
                    "equity_usd":     round(equity, 2),
                    "unrealized_pnl": 0.0,
                    "realized_pnl":   round(pnl, 2),
                    "drawdown_pct":   round(min(0.0, (equity - INITIAL_EQUITY) / INITIAL_EQUITY * 100), 4),
                }).execute()
            except Exception as exc:
                log.warning("_rebuild_equity: insert snapshot failed: %s", exc)

    if engine:
        engine._equity = equity
    log.info("Equity reconciled: %d trades → equity=%.2f", len(trades), equity)
    return equity


@app.post("/equity/reconcile", status_code=200)
async def reconcile_equity():
    """Rebuild equity_snapshots from trades and sync the engine's in-memory equity."""
    db = get_supabase()
    new_equity = _rebuild_equity_from_trades(db)
    return {"equity": round(new_equity, 2)}


@app.delete("/trades/{trade_id}", status_code=200)
async def delete_trade(trade_id: str):
    """Delete a single trade, its events, then fully reconcile equity_snapshots."""
    db = get_supabase()
    db.table("trade_events").delete().eq("trade_id", trade_id).execute()
    db.table("trades").delete().eq("id", trade_id).execute()
    new_equity = _rebuild_equity_from_trades(db)
    return {"status": "deleted", "equity": round(new_equity, 2)}


@app.delete("/trades", status_code=200)
async def clear_trades():
    """Delete all trade history (trades, trade_events, equity_snapshots, inference_logs)."""
    db = get_supabase()
    counts: dict[str, int] = {}
    for table, col in [
        ("trade_events",     "time"),
        ("trades",           "opened_at"),
        ("equity_snapshots", "time"),
        ("inference_logs",   "time"),
    ]:
        try:
            res = db.table(table).delete().gt(col, "2000-01-01").execute()
            counts[table] = len(res.data) if res.data else 0
        except Exception as exc:
            log.warning("clear_trades: failed on %s — %s", table, exc)
            counts[table] = -1
    if engine:
        engine._equity = 10_000.0
    log.info("Trade history cleared: %s", counts)
    return {"status": "cleared", "deleted": counts}


@app.get("/inference-logs")
async def get_inference_logs(limit: int = 50):
    db = get_supabase()
    result = db.table("inference_logs").select("*").order("time", desc=True).limit(limit).execute()
    return result.data


# ─── Retraining ──────────────────────────────────────────────────────────────

@app.get("/retrain/status")
async def retrain_status():
    """Check model info and last retrain metrics."""
    from services.trainer import MODEL_PATH
    import os
    if not MODEL_PATH.exists():
        return {"model_exists": False, "model_loaded": False}
    mtime = os.path.getmtime(MODEL_PATH)
    trained_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
    return {
        "model_exists":  True,
        "trained_at":    trained_at,
        "model_loaded":  engine._lgbm_model is not None if engine else False,
        "last_retrain":  engine._last_retrain_metrics if engine else None,
    }


@app.get("/model/feature-importance")
async def get_feature_importance():
    """Return normalised gain importance for each feature from the last retrain."""
    import json as _json
    from services.trainer import MODEL_DIR
    path = MODEL_DIR / "feature_importance.json"
    if not path.exists():
        return {"available": False}
    with open(path) as f:
        return {"available": True, **_json.load(f)}


@app.get("/model/pruning-stats")
async def get_pruning_stats():
    """Return full vs pruned model comparison metrics from the last retrain."""
    import json as _json
    from services.trainer import MODEL_DIR, PRUNED_MODEL_PATH
    path = MODEL_DIR / "pruned_features.json"
    if not path.exists():
        return {"available": False, "pruned_model_exists": PRUNED_MODEL_PATH.exists()}
    with open(path) as f:
        return {
            "available":           True,
            "pruned_model_exists": PRUNED_MODEL_PATH.exists(),
            **_json.load(f),
        }


# ─── Model Versioning ────────────────────────────────────────────────────────

@app.get("/model/registry")
async def model_registry_endpoint():
    """
    Return the versioned model registry.
    Each entry has filename, trained_at, OOS metrics, and train metadata.
    The most recent model is last in the list.
    """
    from services.trainer import MODEL_REGISTRY_PATH
    import json as _json
    if not MODEL_REGISTRY_PATH.exists():
        return {"models": []}
    with open(MODEL_REGISTRY_PATH) as _f:
        return _json.load(_f)


@app.post("/model/rollback/{filename}")
async def model_rollback(filename: str):
    """
    Roll back the active model to a previously saved versioned file.
    The current lgbm_latest.pkl is backed up to lgbm_latest.bak.pkl before overwriting.
    Reloads the model into the running engine immediately.
    Only accepts filenames matching the pattern lgbm_YYYYMMDDTHHMMSSZ.pkl.
    """
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    from services.trainer import MODEL_DIR, MODEL_PATH, MODEL_REGISTRY_PATH
    import json as _json

    # Validate filename format — only versioned files, never overwrite with arbitrary paths
    if not (filename.startswith("lgbm_") and filename.endswith(".pkl") and "latest" not in filename):
        raise HTTPException(400, f"Invalid filename: must match lgbm_YYYYMMDDTHHMMSSZ.pkl")

    # Confirm the file is in the registry (extra safety — no arbitrary path loading)
    if MODEL_REGISTRY_PATH.exists():
        with open(MODEL_REGISTRY_PATH) as _f:
            registry = _json.load(_f)
        known_files = {m["filename"] for m in registry.get("models", [])}
        if filename not in known_files:
            raise HTTPException(404, f"Version not in registry: {filename}")

    target = MODEL_DIR / filename
    if not target.exists():
        raise HTTPException(404, f"File not found on disk: {filename}")

    import shutil as _shutil
    if MODEL_PATH.exists():
        _shutil.copy2(MODEL_PATH, MODEL_PATH.with_name("lgbm_latest.bak.pkl"))
    _shutil.copy2(target, MODEL_PATH)
    engine._load_model_from_disk()

    log.info("Model rolled back to %s", filename)
    return {"status": "ok", "rolled_back_to": filename, "features": len(engine._lgbm_features or [])}


# ─── Chronos Calibrator ───────────────────────────────────────────────────────

@app.post("/calibrator/refit")
async def calibrator_refit():
    """
    Force a manual re-fit of the IsotonicCalibrator without a full LightGBM retrain.
    Requires ≥50 closed trades with inference_id in the DB.
    Also reloads the calibrator in the running engine instance.
    """
    from services.trainer import LGBMTrainer
    _trainer = LGBMTrainer()
    result = await _trainer.retrain_calibrator()
    if engine is not None and result.get("status") == "ok":
        engine._chronos.reload_calibrator()
    return result


@app.get("/calibrator/stats")
async def calibrator_stats():
    """Return current calibrator status: fitted, n_samples, and probability mapping."""
    from services.trainer import MODEL_DIR
    from services.calibration import IsotonicCalibrator
    cal_path = MODEL_DIR / "chronos_calibrator.pkl"
    if not cal_path.exists():
        return {"fitted": False, "file_exists": False}
    try:
        cal = IsotonicCalibrator.load(cal_path)
        return {"file_exists": True, **cal.calibration_stats()}
    except Exception as exc:
        return {"file_exists": True, "fitted": False, "error": str(exc)}


# ─── Gate LightGBM 1H ────────────────────────────────────────────────────────

@app.post("/retrain/1h")
async def retrain_1h_endpoint():
    """
    Train the LightGBM 1H gate model on the last 2000 1H candles.
    Also reloads the model into the running engine instance.
    Independent from the main 4H retrain — safe to call at any time.
    """
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    from services.trainer import LGBMTrainer
    _trainer = LGBMTrainer()
    result = await _trainer.retrain_1h()
    if result.get("status") == "ok":
        engine._load_1h_model()
    return result


@app.get("/model/1h-status")
async def get_1h_model_status():
    """Return 1H gate model status: loaded in engine and file on disk."""
    from services.trainer import MODEL_1H_PATH
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    return {
        "loaded_in_engine": engine._lgbm_1h is not None,
        "file_exists":      MODEL_1H_PATH.exists(),
        "n_features":       len(engine._lgbm_1h_features) if engine._lgbm_1h_features else 0,
    }


# ─── Concept Drift ───────────────────────────────────────────────────────────

@app.get("/drift/status")
async def drift_status():
    """
    Return the result of the last concept drift check.
    Shows recent log-loss vs the baseline stored at last retrain.
    """
    from services.trainer import DRIFT_BASELINE_PATH
    import json as _json
    baseline = None
    if DRIFT_BASELINE_PATH.exists():
        with open(DRIFT_BASELINE_PATH) as _f:
            baseline = _json.load(_f)
    last_check = engine._last_drift_result if engine else None
    return {
        "baseline":    baseline,
        "last_check":  last_check,
    }


@app.post("/drift/check")
async def drift_check_now():
    """
    Manually trigger a concept drift evaluation.
    Does NOT trigger a retrain — read-only diagnostic.
    """
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    result = await engine._trainer.check_drift("BTC", use_pruning=engine.config.use_feature_pruning)
    engine._last_drift_result = {**result, "checked_at": datetime.now(timezone.utc).isoformat()}
    return result


# ─── Trade Events ────────────────────────────────────────────────────────────

@app.get("/trade-events")
async def get_trade_events(trade_id: str, limit: int = 50):
    """Return lifecycle events for a specific trade (sl_moved, be_sl, partial_tp…)."""
    try:
        db = get_supabase()
        result = db.table("trade_events") \
            .select("*") \
            .eq("trade_id", trade_id) \
            .order("time", desc=False) \
            .limit(limit) \
            .execute()
        return result.data or []
    except Exception:
        return []


# ─── Covariates ───────────────────────────────────────────────────────────────

@app.get("/covariates")
async def get_covariates():
    """Return latest external covariate values (F&G, BTC dominance, confluence)."""
    from services.covariates import get_latest_covariates
    return get_latest_covariates()


@app.post("/covariates/refresh")
async def refresh_covariates():
    """Force-fetch and store updated external covariates."""
    from services.covariates import update_covariates
    result = await update_covariates()
    return {"status": "ok", "values": result}


# ─── Backtesting ─────────────────────────────────────────────────────────────

class BacktestRequest(BaseModel):
    symbol: str = "BTC"
    from_date: str = Field(..., description="YYYY-MM-DD")
    to_date: str = Field(..., description="YYYY-MM-DD")
    initial_capital: float = Field(10000.0, gt=0)
    config: Optional[BotConfig] = None
    use_binance: bool = Field(True, description="Use Binance OHLCV for periods older than ~11 months")
    use_chronos: bool = Field(False, description="Enable Chronos-2 inference per candle (~3s/candle, slow)")
    name: Optional[str] = Field(None, description="Optional label stored in backtest_results.name")


backtest_jobs: dict = {}

# Single-slot executor: only one Chronos backtest at a time to avoid RAM exhaustion
_backtest_executor = ThreadPoolExecutor(max_workers=1)

# Track active job for reconnect and cancellation
_active_job_id: Optional[str] = None
_active_cancel_event: Optional[threading.Event] = None


def _cleanup_old_jobs(keep: int = 20):
    """Keep only the most recent `keep` jobs to avoid memory growth."""
    if len(backtest_jobs) > keep:
        old_keys = sorted(
            (k for k in backtest_jobs if k != _active_job_id),
            key=lambda k: backtest_jobs[k].get("_ts", 0),
        )[: len(backtest_jobs) - keep]
        for k in old_keys:
            del backtest_jobs[k]


@app.get("/backtest/active")
async def backtest_active():
    """Return the currently running job_id so the frontend can reconnect after a refresh."""
    if _active_job_id and backtest_jobs.get(_active_job_id, {}).get("status") == "running":
        return {"job_id": _active_job_id, "status": "running"}
    return {"job_id": None, "status": "idle"}


@app.post("/backtest")
async def backtest_start(req: BacktestRequest, background_tasks: BackgroundTasks):
    global _active_job_id, _active_cancel_event
    import uuid, time as _t

    # Cancel any job that is still running (e.g. leftover from before a page refresh)
    if _active_cancel_event is not None:
        _active_cancel_event.set()
    if _active_job_id and backtest_jobs.get(_active_job_id, {}).get("status") == "running":
        backtest_jobs[_active_job_id] = {
            "status": "cancelled",
            "result": {"error": "Annullato — nuovo backtest avviato"},
            "_ts": _t.time(),
        }

    job_id = str(uuid.uuid4())[:8]
    cancel_event = threading.Event()
    _active_job_id = job_id
    _active_cancel_event = cancel_event
    backtest_jobs[job_id] = {"status": "running", "result": None, "_ts": _t.time()}
    _cleanup_old_jobs()

    async def run():
        global _active_job_id, _active_cancel_event
        import time as _t2
        from services.backtesting import run_backtest
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                _backtest_executor,
                lambda: asyncio.run(run_backtest(req, cancel_event=cancel_event))
            )
            if cancel_event.is_set():
                backtest_jobs[job_id] = {"status": "cancelled", "result": {"error": "Backtest annullato"}, "_ts": _t2.time()}
            else:
                backtest_jobs[job_id] = {"status": "done", "result": result, "_ts": _t2.time()}
        except RuntimeError as e:
            if "backtest_cancelled" in str(e) or cancel_event.is_set():
                backtest_jobs[job_id] = {"status": "cancelled", "result": {"error": "Backtest annullato"}, "_ts": _t2.time()}
            else:
                log.error(f"Backtest job {job_id} failed: {e}")
                backtest_jobs[job_id] = {"status": "error", "result": {"error": str(e)}, "_ts": _t2.time()}
        except Exception as e:
            if cancel_event.is_set():
                backtest_jobs[job_id] = {"status": "cancelled", "result": {"error": "Backtest annullato"}, "_ts": _t2.time()}
            else:
                log.error(f"Backtest job {job_id} failed: {e}")
                backtest_jobs[job_id] = {"status": "error", "result": {"error": str(e)}, "_ts": _t2.time()}
        finally:
            if _active_job_id == job_id:
                _active_job_id = None
                _active_cancel_event = None

    background_tasks.add_task(run)
    return {"job_id": job_id, "status": "running"}


@app.delete("/backtest/{job_id}")
async def backtest_cancel(job_id: str):
    global _active_job_id, _active_cancel_event
    import time as _t
    job = backtest_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "running":
        return {"status": job["status"]}
    if _active_cancel_event is not None and _active_job_id == job_id:
        _active_cancel_event.set()
    backtest_jobs[job_id] = {"status": "cancelled", "result": {"error": "Backtest annullato dall'utente"}, "_ts": _t.time()}
    if _active_job_id == job_id:
        _active_job_id = None
        _active_cancel_event = None
    return {"status": "cancelled"}


@app.get("/backtest/{job_id}")
async def backtest_status(job_id: str):
    job = backtest_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


# ─── Backtest History ─────────────────────────────────────────────────────────

@app.get("/backtest-history")
async def backtest_history(limit: int = 50):
    db = get_supabase()
    result = db.table("backtest_results").select("id,created_at,name,symbol,from_date,to_date,initial_capital,duration_days,summary").order("created_at", desc=True).limit(limit).execute()
    return result.data


@app.get("/backtest-history/{record_id}")
async def backtest_history_get(record_id: str):
    db = get_supabase()
    result = db.table("backtest_results").select("*").eq("id", record_id).execute()
    if not result.data:
        raise HTTPException(404, "Backtest not found")
    return result.data[0]


@app.patch("/backtest-history/{record_id}")
async def backtest_history_rename(record_id: str, body: dict):
    db = get_supabase()
    db.table("backtest_results").update({"name": body.get("name", "")}).eq("id", record_id).execute()
    return {"status": "ok"}


@app.delete("/backtest-history/{record_id}")
async def backtest_history_delete(record_id: str):
    db = get_supabase()
    db.table("backtest_results").delete().eq("id", record_id).execute()
    return {"status": "deleted"}


# ─── Server Events Log ───────────────────────────────────────────────────────

@app.get("/events")
async def get_events(limit: int = 100, since: Optional[str] = None):
    """Return recent server events (bot start/stop, trades, errors, cycles)."""
    db = get_supabase()
    q = db.table("events").select("*").order("time", desc=True).limit(limit)
    if since:
        q = q.gt("time", since)
    result = q.execute()
    return result.data


# ─── Regime Detection ────────────────────────────────────────────────────────

@app.get("/regime/current")
async def regime_current():
    """Return the latest regime detection signal.

    Priority: in-memory (current run) → latest row in regime_log DB table.
    The in-memory signal resets on every service restart, so the DB fallback
    ensures the UI always shows the last known regime instead of 'No data'.
    """
    if not engine:
        raise HTTPException(503, "Engine not initialized")

    signal = engine._regime_signal
    from_db = False

    if signal is not None:
        regime_data = {
            "regime":          signal.regime,
            "confidence":      signal.confidence,
            "adx":             signal.adx,
            "atr_percentile":  signal.atr_percentile,
            "trend_slope_pct": signal.trend_slope_pct,
            "bb_width_pct":    signal.bb_width_pct,
            "bars_in_regime":  signal.bars_in_regime,
            "transition_risk": signal.transition_risk,
            "reasoning":       signal.reasoning,
        }
    else:
        # Fallback: read latest persisted snapshot from regime_log
        try:
            db = get_supabase()
            result = (
                db.table("regime_log")
                .select("*")
                .order("detected_at", desc=True)
                .limit(1)
                .execute()
            )
            row = (result.data or [None])[0]
        except Exception:
            row = None

        if row:
            from_db = True
            regime_data = {
                "regime":          row["regime"],
                "confidence":      row.get("confidence", 0.5),
                "adx":             row.get("adx", 0.0),
                "atr_percentile":  row.get("atr_pct", 50.0),
                "trend_slope_pct": row.get("slope_pct", 0.0),
                "bb_width_pct":    row.get("bb_width_pct", 0.0),
                "bars_in_regime":  row.get("bars_in_regime", 0),
                "transition_risk": row.get("transition_risk", 0.0),
                "reasoning":       [],
                "detected_at":     row.get("detected_at"),
            }
        else:
            regime_data = None

    return {
        "regime_signal": regime_data,
        "from_db":        from_db,
    }


@app.get("/regime/history")
async def regime_history(limit: int = 48):
    """
    Return recent regime snapshots from the regime_log table.
    Returns [] if the table does not exist yet (DDL not yet applied).

    SQL to create the table in Supabase:
    CREATE TABLE regime_log (
        id              BIGSERIAL PRIMARY KEY,
        detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        regime          TEXT NOT NULL,
        confidence      FLOAT,
        adx             FLOAT,
        atr_pct         FLOAT,
        slope_pct       FLOAT,
        bars_in_regime  INT,
        transition_risk FLOAT,
        profile_applied TEXT
    );
    CREATE INDEX ON regime_log (detected_at DESC);
    """
    try:
        db = get_supabase()
        result = (
            db.table("regime_log")
            .select("*")
            .order("detected_at", desc=True)
            .limit(min(limit, 200))
            .execute()
        )
        return result.data or []
    except Exception as exc:
        log.debug("regime_history: table may not exist yet: %s", exc)
        return []


# ── Config Presets ────────────────────────────────────────────────────────────

class PresetCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    params: dict

class PresetUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    params: dict | None = None


@app.get("/presets")
async def list_presets():
    """Return all saved config presets ordered by name."""
    try:
        db = get_supabase()
        result = (
            db.table("config_presets")
            .select("id, name, params, created_at, updated_at")
            .order("name")
            .execute()
        )
        return result.data or []
    except Exception as exc:
        log.warning("list_presets failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/presets", status_code=201)
async def create_preset(body: PresetCreate):
    """Create a new named preset with the provided params dict."""
    try:
        db = get_supabase()
        result = (
            db.table("config_presets")
            .insert({"name": body.name, "params": body.params})
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=500, detail="Insert returned no data")
        return result.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("create_preset failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/presets/{preset_id}")
async def update_preset(preset_id: int, body: PresetUpdate):
    """Rename and/or update the params of an existing preset."""
    update_data: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if body.name   is not None: update_data["name"]   = body.name
    if body.params is not None: update_data["params"] = body.params
    if len(update_data) == 1:
        raise HTTPException(status_code=422, detail="Provide at least name or params")
    try:
        db = get_supabase()
        result = (
            db.table("config_presets")
            .update(update_data)
            .eq("id", preset_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Preset not found")
        return result.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("update_preset failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/presets/{preset_id}", status_code=204)
async def delete_preset(preset_id: int):
    """Delete a preset by id."""
    try:
        db = get_supabase()
        db.table("config_presets").delete().eq("id", preset_id).execute()
    except Exception as exc:
        log.warning("delete_preset failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─── Server Status ────────────────────────────────────────────────────────────

# Track previous network counters for bandwidth calculation
_net_prev: dict = {}

@app.get("/server/status")
async def server_status():
    """
    Return real-time VPS resource usage: CPU, RAM, disk, network bandwidth,
    load average, uptime, and the current API process stats.
    """
    global _net_prev

    # ── CPU ──────────────────────────────────────────────────────────────────
    cpu_pct        = psutil.cpu_percent(interval=0.2)
    cpu_per_core   = psutil.cpu_percent(interval=None, percpu=True)
    cpu_count_log  = psutil.cpu_count(logical=True)
    cpu_count_phys = psutil.cpu_count(logical=False)
    try:
        freq = psutil.cpu_freq()
        cpu_freq_mhz = round(freq.current) if freq else None
        cpu_freq_max = round(freq.max)      if freq else None
    except Exception:
        cpu_freq_mhz = cpu_freq_max = None

    # ── RAM ──────────────────────────────────────────────────────────────────
    vm = psutil.virtual_memory()
    swap = psutil.swap_memory()

    # ── Disk ─────────────────────────────────────────────────────────────────
    disk_path = "/opt/quantum-trade" if os.path.exists("/opt/quantum-trade") else "/"
    try:
        disk = psutil.disk_usage(disk_path)
        disk_root = psutil.disk_usage("/")
    except Exception:
        disk = disk_root = None

    # ── Network bandwidth (bytes/s since last call) ───────────────────────────
    net_now = psutil.net_io_counters()
    now_ts  = _time.monotonic()
    net_rx_bps = net_tx_bps = 0.0
    if _net_prev:
        dt = max(now_ts - _net_prev["ts"], 0.001)
        net_rx_bps = (net_now.bytes_recv - _net_prev["rx"]) / dt
        net_tx_bps = (net_now.bytes_sent - _net_prev["tx"]) / dt
    _net_prev = {"ts": now_ts, "rx": net_now.bytes_recv, "tx": net_now.bytes_sent}

    # ── Load average ─────────────────────────────────────────────────────────
    try:
        load1, load5, load15 = psutil.getloadavg()
    except Exception:
        load1 = load5 = load15 = 0.0

    # ── Uptime ───────────────────────────────────────────────────────────────
    boot_ts  = psutil.boot_time()
    uptime_s = int(_time.time() - boot_ts)

    # ── Current process (API) ─────────────────────────────────────────────────
    proc = psutil.Process(os.getpid())
    with proc.oneshot():
        proc_cpu  = proc.cpu_percent(interval=0.1)
        proc_mem  = proc.memory_info()
        proc_thr  = proc.num_threads()
        proc_fds  = proc.num_fds() if hasattr(proc, "num_fds") else None
        proc_up   = int(_time.time() - proc.create_time())

    # ── Top processes by CPU ──────────────────────────────────────────────────
    top_procs = []
    for p in sorted(
        psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "status"]),
        key=lambda x: x.info.get("cpu_percent") or 0,
        reverse=True,
    )[:6]:
        top_procs.append({
            "pid":    p.info["pid"],
            "name":   p.info["name"],
            "cpu":    round(p.info.get("cpu_percent") or 0, 1),
            "mem":    round(p.info.get("memory_percent") or 0, 1),
            "status": p.info.get("status", ""),
        })

    def _gb(b):
        return round(b / 1024 ** 3, 2)

    def _mb(b):
        return round(b / 1024 ** 2, 1)

    return {
        "cpu": {
            "percent":    round(cpu_pct, 1),
            "per_core":   [round(c, 1) for c in (cpu_per_core or [])],
            "cores_logical":  cpu_count_log,
            "cores_physical": cpu_count_phys,
            "freq_mhz":   cpu_freq_mhz,
            "freq_max_mhz": cpu_freq_max,
        },
        "ram": {
            "total_gb":  _gb(vm.total),
            "used_gb":   _gb(vm.used),
            "avail_gb":  _gb(vm.available),
            "percent":   round(vm.percent, 1),
            "swap_total_gb": _gb(swap.total),
            "swap_used_gb":  _gb(swap.used),
            "swap_percent":  round(swap.percent, 1),
        },
        "disk": {
            "path":      disk_path,
            "total_gb":  _gb(disk.total)  if disk else 0,
            "used_gb":   _gb(disk.used)   if disk else 0,
            "free_gb":   _gb(disk.free)   if disk else 0,
            "percent":   round(disk.percent, 1) if disk else 0,
            "root_total_gb": _gb(disk_root.total) if disk_root else 0,
            "root_used_gb":  _gb(disk_root.used)  if disk_root else 0,
            "root_percent":  round(disk_root.percent, 1) if disk_root else 0,
        },
        "network": {
            "rx_bps":        round(net_rx_bps, 1),
            "tx_bps":        round(net_tx_bps, 1),
            "rx_total_gb":   _gb(net_now.bytes_recv),
            "tx_total_gb":   _gb(net_now.bytes_sent),
            "rx_packets":    net_now.packets_recv,
            "tx_packets":    net_now.packets_sent,
        },
        "load": {
            "load1":  round(load1, 2),
            "load5":  round(load5, 2),
            "load15": round(load15, 2),
            "cores":  cpu_count_log or 1,
        },
        "uptime_s": uptime_s,
        "process": {
            "pid":        os.getpid(),
            "cpu_pct":    round(proc_cpu, 1),
            "rss_mb":     _mb(proc_mem.rss),
            "vms_mb":     _mb(proc_mem.vms),
            "threads":    proc_thr,
            "fds":        proc_fds,
            "uptime_s":   proc_up,
        },
        "top_processes": top_procs,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _log_event(kind: str, message: str, severity: str = "info", payload: dict | None = None):
    """Write a server event to the events table (sync, fire-and-forget)."""
    try:
        db = get_supabase()
        db.table("events").insert({
            "severity": severity,
            "kind": kind,
            "message": message,
            "payload": payload or {},
        }).execute()
    except Exception as exc:
        log.warning("Event log write failed: %s", exc)
