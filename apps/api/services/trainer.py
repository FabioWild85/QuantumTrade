"""
LightGBM auto-retrainer.
Called every 120 candles (~30 days on 4h).
Fetches fresh OHLCV from HL REST, builds 56 non-Chronos features,
trains LightGBM with walk-forward validation, saves to models/lgbm_latest.pkl.
"""

import asyncio
import logging
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, log_loss

from services.hyperliquid_data import HyperliquidData
from services.smc import build_all_features, ALL_FEATURES

log = logging.getLogger(__name__)

MODEL_DIR  = Path(__file__).parent.parent / "models"
MODEL_PATH = MODEL_DIR / "lgbm_latest.pkl"

# Chronos-2 features are inference-time only — not available for historical retraining.
# These names MUST match FEATURE_GROUPS["c2"] in smc.py exactly.
from services.smc import FEATURE_GROUPS as _FG
_C2_FEATURES  = frozenset(_FG["c2"])
LGBM_FEATURES = [f for f in ALL_FEATURES if f not in _C2_FEATURES]

_LGB_PARAMS = dict(
    n_estimators=500,
    learning_rate=0.03,
    max_depth=5,
    num_leaves=31,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_samples=20,
    reg_alpha=0.1,
    reg_lambda=0.1,
    random_state=42,
    class_weight="balanced",
    verbose=-1,
)

# Safety: never retrain concurrently
_retrain_lock = asyncio.Lock()


def _walk_forward_splits(
    X: pd.DataFrame,
    y: pd.Series,
    n_splits: int = 5,
    purge_gap: int = 5,
) -> list[dict]:
    """
    Expanding window walk-forward CV with purge gap.
    purge_gap: candele escluse tra train_end e val_start — elimina autocorrelazione
    temporale su serie finanziarie (look-ahead bias). Ogni fold espande il training set.
    """
    n         = len(X)
    min_train = int(n * 0.40)
    step      = max(1, (n - min_train - purge_gap * n_splits) // n_splits)
    results   = []

    for i in range(n_splits):
        train_end = min_train + i * step
        val_start = train_end + purge_gap
        val_end   = min(val_start + step, n)
        if val_end <= val_start or train_end >= n:
            break

        X_tr, y_tr   = X.iloc[:train_end], y.iloc[:train_end]
        X_val, y_val = X.iloc[val_start:val_end], y.iloc[val_start:val_end]

        m = lgb.LGBMClassifier(**_LGB_PARAMS)
        m.fit(
            X_tr, y_tr,
            eval_set=[(X_val, y_val)],
            callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
        )

        y_prob   = m.predict_proba(X_val)[:, 1]
        fold_ll  = float(log_loss(y_val, y_prob))
        fold_acc = float(accuracy_score(y_val, (y_prob > 0.5).astype(int)))
        results.append({
            "fold":     i,
            "train_n":  len(X_tr),
            "val_n":    len(X_val),
            "log_loss": round(fold_ll, 4),
            "accuracy": round(fold_acc, 4),
        })
        log.info(
            "WF fold %d/%d: train=%d val=%d acc=%.2f%% ll=%.4f",
            i + 1, n_splits, len(X_tr), len(X_val), fold_acc * 100, fold_ll,
        )

    return results


class LGBMTrainer:
    def __init__(self):
        self._hl = HyperliquidData()

    async def retrain(
        self,
        symbol: str = "BTC",
        lookback_candles: int = 500,
    ) -> dict:
        """
        Full retraining pipeline. Returns metrics dict.
        Blocks if another retrain is in progress (returns immediately with status='busy').
        """
        if _retrain_lock.locked():
            log.warning("Retraining already in progress — skipping this trigger")
            return {"status": "busy"}

        async with _retrain_lock:
            return await self._run(symbol, lookback_candles)

    async def _run(self, symbol: str, lookback_candles: int) -> dict:
        t0 = datetime.now(timezone.utc)
        log.info("LightGBM retraining started (lookback=%d candles)", lookback_candles)

        # ── 1. Fetch data ────────────────────────────────────────────────────
        # Fetch extra candles to account for feature warm-up (indicators need ~64 bars)
        fetch_n = lookback_candles + 128
        df_ohlcv = await self._hl.get_ohlcv(symbol, "4h", limit=fetch_n)
        df_fund  = await self._hl.get_funding_history(symbol, hours=fetch_n * 4)

        # ── 2. Build features ────────────────────────────────────────────────
        df_feat = build_all_features(
            df_ohlcv, df_fund,
            pd.DataFrame(), pd.DataFrame()  # OI/liq placeholders (fetched live in prod)
        )

        # ── 3. Target: next candle direction (1 = up, 0 = down) ─────────────
        df_feat["_target"] = (df_feat["close"].shift(-1) > df_feat["close"]).astype(int)

        # Select only LGBM features that actually exist in the dataframe
        available = [f for f in LGBM_FEATURES if f in df_feat.columns]

        # Fill NaN in sparse features (funding, OI, liq) with 0 before dropping rows.
        # These columns may be legitimately empty for some candles and must not
        # cause entire rows to be eliminated by dropna.
        df_feat[available] = df_feat[available].fillna(0)

        # Only require _target (last candle has NaN target — that's the only real drop)
        df_clean = df_feat.dropna(subset=["_target"]).copy()
        df_clean = df_clean.iloc[64:]  # skip indicator warm-up rows

        # Trim to requested lookback
        if len(df_clean) > lookback_candles:
            df_clean = df_clean.iloc[-lookback_candles:]

        if len(df_clean) < 100:
            raise ValueError(f"Insufficient clean rows for training: {len(df_clean)}")

        X = df_clean[available]
        y = df_clean["_target"]
        log.info("Training set: %d rows × %d features", len(X), len(available))

        # ── 4. Purged walk-forward CV (OOS reale senza look-ahead bias) ──────
        wf_results = _walk_forward_splits(X, y, n_splits=5, purge_gap=5)
        wf_ll  = float(np.mean([r["log_loss"]  for r in wf_results])) if wf_results else None
        wf_acc = float(np.mean([r["accuracy"]  for r in wf_results])) if wf_results else None
        log.info(
            "Walk-forward CV: avg_acc=%.2f%% avg_ll=%.4f (%d folds)",
            (wf_acc or 0) * 100, wf_ll or 0, len(wf_results),
        )

        # ── 5. Train finale — 80/20 split usato solo per l'early stopping ───
        split   = int(len(X) * 0.80)
        X_tr, X_val = X.iloc[:split], X.iloc[split:]
        y_tr, y_val = y.iloc[:split], y.iloc[split:]

        # ── 6. Train ─────────────────────────────────────────────────────────
        model = lgb.LGBMClassifier(**_LGB_PARAMS)
        model.fit(
            X_tr, y_tr,
            eval_set=[(X_val, y_val)],
            callbacks=[
                lgb.early_stopping(50, verbose=False),
                lgb.log_evaluation(0),
            ],
        )

        # ── 7. OOS metrics (split 80/20) ─────────────────────────────────────
        y_pred    = model.predict(X_val)
        y_prob    = model.predict_proba(X_val)[:, 1]
        oos_acc   = float(accuracy_score(y_val, y_pred))
        oos_ll    = float(log_loss(y_val, y_prob))

        # ── 8. Save ──────────────────────────────────────────────────────────
        MODEL_DIR.mkdir(exist_ok=True)
        payload = {"model": model, "features": available}
        with open(MODEL_PATH, "wb") as f:
            pickle.dump(payload, f)

        elapsed_s = (datetime.now(timezone.utc) - t0).total_seconds()
        metrics = {
            "status":          "ok",
            "trained_at":      t0.isoformat(),
            "elapsed_s":       round(elapsed_s, 1),
            "train_rows":      split,
            "val_rows":        len(X_val),
            "n_features":      len(available),
            "oos_accuracy":    round(oos_acc, 4),
            "oos_log_loss":    round(oos_ll, 4),
            "best_iteration":  getattr(model, "best_iteration_", None),
            "wf_avg_accuracy": round(wf_acc, 4) if wf_acc is not None else None,
            "wf_avg_log_loss": round(wf_ll,  4) if wf_ll  is not None else None,
            "wf_folds":        wf_results,
        }
        log.info(
            "Retraining complete: OOS acc=%.2f%% ll=%.4f | WF acc=%.2f%% ll=%.4f (%.1fs)",
            oos_acc * 100, oos_ll,
            (wf_acc or 0) * 100, wf_ll or 0,
            elapsed_s,
        )
        return metrics


def load_model() -> Optional[tuple]:
    """
    Load the saved model from disk.
    Returns (model, features_list) or None if not found.
    """
    if not MODEL_PATH.exists():
        return None
    with open(MODEL_PATH, "rb") as f:
        payload = pickle.load(f)

    # Support both legacy format (raw model) and new format (dict)
    if isinstance(payload, dict):
        return payload["model"], payload["features"]
    return payload, LGBM_FEATURES  # legacy: assume full feature list
