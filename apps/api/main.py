"""
AI Trading Hub — FastAPI Backend
Single-user, single-bot, BTC-PERP on Hyperliquid (4h Trend Following)
"""

import asyncio
import logging
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
    yield
    log.info("AI Trading Hub shutting down…")
    if engine and engine.running:
        await engine.stop()


app = FastAPI(
    title="AI Trading Hub",
    version="1.0.0",
    description="BTC-PERP Trend Following on Hyperliquid with Chronos-2 + LightGBM",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Health ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    status = await engine.get_status() if engine else {}
    return {
        "status":       "ok",
        "running":      status.get("running", False),
        "mode":         status.get("mode", "paper"),
        "ws_connected": status.get("ws_connected", False),
        "model_loaded": status.get("model_loaded", False),
        "cycle_count":  status.get("cycle_count", 0),
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
    trailing_sl_activation: float = Field(1.0, ge=0.5, le=3.0)


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
    }).execute()
    return {"status": "updated", "config": cfg.model_dump()}


@app.post("/bot/start")
async def bot_start(req: StartBotRequest, background_tasks: BackgroundTasks):
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    if engine.running:
        return {"status": "already_running", "mode": engine.mode}
    background_tasks.add_task(engine.start, req.mode)
    return {"status": "starting", "mode": req.mode}


@app.post("/bot/stop")
async def bot_stop():
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    await engine.stop()
    return {"status": "stopped"}


@app.post("/bot/kill")
async def bot_kill():
    """Emergency kill: cancels open orders, closes positions."""
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    result = await engine.kill()
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


backtest_jobs: dict = {}


@app.post("/backtest")
async def backtest_start(req: BacktestRequest, background_tasks: BackgroundTasks):
    import uuid
    job_id = str(uuid.uuid4())[:8]
    backtest_jobs[job_id] = {"status": "running", "result": None}

    async def run():
        from services.backtesting import run_backtest
        result = await run_backtest(req)
        backtest_jobs[job_id] = {"status": "done", "result": result}

    background_tasks.add_task(run)
    return {"job_id": job_id, "status": "running"}


@app.get("/backtest/{job_id}")
async def backtest_status(job_id: str):
    job = backtest_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job
