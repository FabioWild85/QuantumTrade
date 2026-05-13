"""
Backtesting engine — Settimana 3.
Runs the full 64-feature pipeline + LightGBM decision loop on historical data.
Chronos-2 is skipped for speed (uses neutral 0.5 prior); the ensemble still applies.
Fees: HL taker 0.035% per side, funding accrued every 2 candles (8h cycle).
"""

import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.hyperliquid_data import HyperliquidData
from services.smc import build_all_features
from services.decision import DecisionEngine
from services.risk import RiskManager
from services.trainer import load_model

log = logging.getLogger(__name__)

HL_TAKER_FEE = 0.00035   # 0.035% per trade side
FUNDING_INTERVAL_BARS = 2  # funding paid every 2×4h bars (8h cycle)


async def run_backtest(req) -> dict:
    """
    Main entry point, called from FastAPI /backtest endpoint.
    req: BacktestRequest with symbol, from_date, to_date, initial_capital, config.
    """
    symbol  = req.symbol
    capital = float(req.initial_capital)
    cfg     = req.config  # BotConfig-like pydantic model or None

    # Strategy parameters
    sl_atr_mult   = cfg.sl_atr_mult           if cfg else 2.0
    tp_atr_mult   = cfg.tp_atr_mult           if cfg else 3.5
    pos_size_pct  = cfg.position_size_pct     if cfg else 1.5
    dir_threshold = cfg.directional_threshold  if cfg else 0.62
    adx_gate      = cfg.adx_gate              if cfg else 20.0

    hl = HyperliquidData()

    # ── 1. Fetch OHLCV ───────────────────────────────────────────────────────
    from datetime import datetime
    dt_from = datetime.strptime(req.from_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    dt_to   = datetime.strptime(req.to_date,   "%Y-%m-%d").replace(tzinfo=timezone.utc)
    days    = (dt_to - dt_from).days + 1
    limit   = days * 6 + 128  # 6 bars/day on 4h tf + warm-up

    df_ohlcv = await hl.get_ohlcv(symbol, "4h", limit=limit, end_time=dt_to)
    df_ohlcv = df_ohlcv[df_ohlcv.index >= dt_from]

    if len(df_ohlcv) < 100:
        return {"error": f"Dati insufficienti per il periodo {req.from_date}→{req.to_date}"}

    df_fund = await hl.get_funding_history(symbol, hours=days * 24 + 200)

    # ── 2. Build features ────────────────────────────────────────────────────
    df_feat = build_all_features(df_ohlcv, df_fund, pd.DataFrame(), pd.DataFrame())

    # ── 3. Load LightGBM model ───────────────────────────────────────────────
    model_result = load_model()
    if model_result is None:
        return {"error": "Nessun modello LightGBM trovato. Avvia il bot almeno una volta o esegui POST /retrain."}
    lgbm_model, lgbm_features = model_result

    # ── 4. Build feature matrix for all candles ──────────────────────────────
    available = [f for f in lgbm_features if f in df_feat.columns]
    X_all     = df_feat[available].fillna(0)

    # ── 5. Run decision loop ─────────────────────────────────────────────────
    decision_engine = DecisionEngine(
        directional_threshold=dir_threshold,
        adx_gate=adx_gate,
        confluence_gate=0.0,   # disable in backtest (no QT score available)
    )
    risk = RiskManager(
        sl_atr_mult=sl_atr_mult,
        tp_atr_mult=tp_atr_mult,
        position_size_pct=pos_size_pct,
    )

    equity        = capital
    position      = None   # {side, entry, sl, tp, size_usd, bar_idx}
    trades        = []
    equity_curve  = [{"bar": 0, "equity": equity}]
    funding_col   = "funding" in df_feat.columns

    for i in range(len(df_feat)):
        row = df_feat.iloc[i]
        features = row.to_dict()
        atr      = features.get("atr_14") or row.get("close", 0) * 0.01

        # ── Funding accrual while in position ────────────────────────────────
        if position and i % FUNDING_INTERVAL_BARS == 0 and funding_col:
            fund_rate = abs(float(df_feat.iloc[i].get("funding", 0)))
            funding_cost = position["size_usd"] * fund_rate
            equity -= funding_cost

        # ── Manage existing position (SL/TP at candle close) ─────────────────
        if position:
            close_price = float(row["close"])
            side        = position["side"]
            hit_sl = (side == "long" and close_price <= position["sl"]) or \
                     (side == "short" and close_price >= position["sl"])
            hit_tp = (side == "long" and close_price >= position["tp"]) or \
                     (side == "short" and close_price <= position["tp"])

            if hit_sl or hit_tp:
                reason  = "stop_loss" if hit_sl else "take_profit"
                entry   = position["entry"]
                pnl_pct = (
                    (close_price - entry) / entry * 100 if side == "long"
                    else (entry - close_price) / entry * 100
                )
                pnl_usd = position["size_usd"] * pnl_pct / 100
                fee_exit = position["size_usd"] * HL_TAKER_FEE

                equity += pnl_usd - fee_exit
                trades.append({
                    "side":       side,
                    "entry":      entry,
                    "exit":       close_price,
                    "pnl_pct":    round(pnl_pct, 4),
                    "pnl_usd":    round(pnl_usd - fee_exit, 2),
                    "reason":     reason,
                    "holding_bars": i - position["bar_idx"],
                    "bar":        i,
                })
                equity_curve.append({"bar": i, "equity": round(equity, 2)})
                position = None

        # ── New signal decision ───────────────────────────────────────────────
        if position is None and i >= 64:  # skip warm-up rows
            # LightGBM probability (non-C2 features)
            row_x    = X_all.iloc[[i]]
            lgbm_p   = float(lgbm_model.predict_proba(row_x)[0, 1])
            # C2 neutral (not running Chronos-2 in backtest)
            c2_out   = {"c2_dir_prob": 0.5, "c2_p10": 0.0, "c2_p50": 0.0, "c2_p90": 0.0}

            result = decision_engine.decide(
                features=features,
                c2_output=c2_out,
                lgbm_prob=lgbm_p,
                confluence_score=None,
                current_price=float(row["close"]),
            )

            if result.action != "no_trade":
                close_price = float(row["close"])
                params = risk.calculate_trade_params(
                    side=result.action,
                    entry_price=close_price,
                    atr=atr,
                    equity_usd=equity,
                )
                fee_entry = params.size_usd * HL_TAKER_FEE
                equity   -= fee_entry
                position  = {
                    "side":     result.action,
                    "entry":    close_price,
                    "sl":       params.stop_loss,
                    "tp":       params.take_profit,
                    "size_usd": params.size_usd,
                    "bar_idx":  i,
                }

    # ── 6. Close any open position at last price ──────────────────────────────
    if position:
        last_price = float(df_feat.iloc[-1]["close"])
        side       = position["side"]
        pnl_pct = (
            (last_price - position["entry"]) / position["entry"] * 100 if side == "long"
            else (position["entry"] - last_price) / position["entry"] * 100
        )
        pnl_usd = position["size_usd"] * pnl_pct / 100 - position["size_usd"] * HL_TAKER_FEE
        equity += pnl_usd
        trades.append({
            "side": side, "entry": position["entry"], "exit": last_price,
            "pnl_pct": round(pnl_pct, 4), "pnl_usd": round(pnl_usd, 2),
            "reason": "end_of_period", "holding_bars": len(df_feat) - position["bar_idx"],
            "bar": len(df_feat) - 1,
        })
        equity_curve.append({"bar": len(df_feat) - 1, "equity": round(equity, 2)})

    # ── 7. Calculate statistics ───────────────────────────────────────────────
    stats = _calculate_stats(trades, equity_curve, capital)
    return {
        "symbol":        symbol,
        "from_date":     req.from_date,
        "to_date":       req.to_date,
        "initial_capital": capital,
        "final_equity":  round(equity, 2),
        "total_bars":    len(df_feat),
        "stats":         stats,
        "trades":        trades[-50:],      # last 50 trades for UI
        "equity_curve":  equity_curve,
    }


def _calculate_stats(trades: list, equity_curve: list, capital: float) -> dict:
    if not trades:
        return {"total_trades": 0}

    pnls     = [t["pnl_pct"] for t in trades]
    pnls_usd = [t["pnl_usd"] for t in trades]
    wins     = [p for p in pnls if p > 0]
    losses   = [p for p in pnls if p <= 0]

    total_pnl_usd = sum(pnls_usd)
    win_rate      = len(wins) / len(trades)
    avg_win       = np.mean(wins)  if wins   else 0.0
    avg_loss      = np.mean(losses) if losses else 0.0
    profit_factor = abs(sum(wins) / sum(losses)) if losses else float("inf")

    # Sharpe from equity curve returns
    eq_vals  = [e["equity"] for e in equity_curve]
    eq_rets  = np.diff(eq_vals) / np.array(eq_vals[:-1]) if len(eq_vals) > 1 else [0]
    sharpe   = float(np.mean(eq_rets) / (np.std(eq_rets) + 1e-9) * np.sqrt(365 * 6)) if len(eq_rets) > 1 else 0.0

    # Max drawdown from equity curve
    peak = capital
    max_dd = 0.0
    for e in equity_curve:
        v = e["equity"]
        if v > peak:
            peak = v
        dd = (peak - v) / peak * 100
        if dd > max_dd:
            max_dd = dd

    avg_holding_h = np.mean([t["holding_bars"] * 4 for t in trades])

    return {
        "total_trades":    len(trades),
        "win_rate":        round(win_rate * 100, 2),
        "avg_win_pct":     round(avg_win, 4),
        "avg_loss_pct":    round(avg_loss, 4),
        "profit_factor":   round(profit_factor, 3),
        "total_pnl_usd":   round(total_pnl_usd, 2),
        "total_pnl_pct":   round(total_pnl_usd / capital * 100, 2),
        "sharpe":          round(sharpe, 3),
        "max_drawdown_pct": round(max_dd, 2),
        "avg_holding_h":   round(avg_holding_h, 1),
        "best_trade_pct":  round(max(pnls), 4),
        "worst_trade_pct": round(min(pnls), 4),
    }
