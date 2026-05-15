"""
AI Trading Hub — FastAPI Backend
Single-user, single-bot, BTC-PERP on Hyperliquid (4h Trend Following)
"""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

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
    # Advanced signal controls
    chronos_enabled: bool = Field(True)
    chronos_weight: float = Field(0.40, ge=0.0, le=0.9)
    adx_gate_enabled: bool = Field(True)
    sweep_gate_enabled: bool = Field(True)
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
    db.table("bot_configs").upsert({
        "name": "default",
        "params": cfg.model_dump(),
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
    from services.chronos_model import ChronosForecaster
    from services.hyperliquid_data import HyperliquidData

    hl = HyperliquidData()
    df = await hl.get_ohlcv(symbol, "4h", limit=512)

    # Compute current ATR so Chronos-2 can produce c2_p50_vs_atr
    atr_series = _ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"], 14).average_true_range()
    atr = float(atr_series.iloc[-1]) if not atr_series.empty else None

    forecaster = ChronosForecaster()
    result = forecaster.forecast(df["close"].values, horizon=horizon, atr=atr)

    return {
        "symbol":          symbol,
        "horizon_steps":   horizon,
        "horizon_hours":   horizon * 4,
        "current_price":   float(df["close"].iloc[-1]),
        "last_candle_time": df.index[-1].isoformat(),
        "atr":             atr,
        **result,   # includes all c2_* keys + fan dict
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


@app.get("/trades")
async def get_trades(limit: int = 100):
    db = get_supabase()
    result = db.table("trades").select("*, orders!entry_order_id(*)").order("opened_at", desc=True).limit(limit).execute()
    return result.data


@app.get("/inference-logs")
async def get_inference_logs(limit: int = 50):
    db = get_supabase()
    result = db.table("inference_logs").select("*").order("time", desc=True).limit(limit).execute()
    return result.data


# ─── Retraining ──────────────────────────────────────────────────────────────

@app.post("/retrain")
async def retrain_now(background_tasks: BackgroundTasks):
    """Trigger an immediate LightGBM retrain (runs in background)."""
    if not engine:
        raise HTTPException(503, "Engine not initialized")

    async def _run():
        from services.trainer import LGBMTrainer
        trainer = LGBMTrainer()
        metrics = await trainer.retrain()
        if metrics.get("status") == "ok":
            from services.trainer import load_model
            result = load_model()
            if result and engine:
                engine._lgbm_model, engine._lgbm_features = result
        log.info("Manual retrain complete: %s", metrics)

    background_tasks.add_task(_run)
    return {"status": "retraining_started"}


@app.get("/retrain/status")
async def retrain_status():
    """Check model info from disk."""
    from services.trainer import MODEL_PATH
    import os
    if not MODEL_PATH.exists():
        return {"model_exists": False}
    mtime = os.path.getmtime(MODEL_PATH)
    trained_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
    return {
        "model_exists":  True,
        "trained_at":    trained_at,
        "model_loaded":  engine._lgbm_model is not None if engine else False,
    }


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


backtest_jobs: dict = {}

# Single-slot executor: only one Chronos backtest at a time to avoid RAM exhaustion
_backtest_executor = ThreadPoolExecutor(max_workers=1)


@app.post("/backtest")
async def backtest_start(req: BacktestRequest, background_tasks: BackgroundTasks):
    import uuid
    job_id = str(uuid.uuid4())[:8]
    backtest_jobs[job_id] = {"status": "running", "result": None}

    async def run():
        from services.backtesting import run_backtest
        try:
            # Run in a thread so the event loop stays free for health checks and polling.
            # asyncio.run() inside the thread creates its own loop for the async I/O inside run_backtest.
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                _backtest_executor,
                lambda: asyncio.run(run_backtest(req))
            )
            backtest_jobs[job_id] = {"status": "done", "result": result}
        except Exception as e:
            logger.error(f"Backtest job {job_id} failed: {e}")
            backtest_jobs[job_id] = {"status": "error", "result": {"error": str(e)}}

    background_tasks.add_task(run)
    return {"job_id": job_id, "status": "running"}


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
