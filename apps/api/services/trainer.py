"""
LightGBM auto-retrainer.
Called every 120 candles (~30 days on 4h).
Fetches fresh OHLCV from HL REST, builds 56 non-Chronos features,
trains LightGBM with walk-forward validation, saves to models/lgbm_latest.pkl.
"""

import asyncio
import json
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

MODEL_DIR         = Path(__file__).parent.parent / "models"
MODEL_PATH        = MODEL_DIR / "lgbm_latest.pkl"
PRUNED_MODEL_PATH = MODEL_DIR / "lgbm_pruned.pkl"
MODEL_1H_PATH     = MODEL_DIR / "lgbm_1h_latest.pkl"

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
        symbol:                        str   = "BTC",
        lookback_candles:              int   = 500,
        wf_n_splits:                   int   = 5,
        wf_purge_gap:                  int   = 5,
        use_feature_pruning:           bool  = False,
        feature_pruning_min_importance: float = 0.005,
        use_chronos_calibration:       bool  = False,
        use_1h_lgbm_gate:              bool  = False,
    ) -> dict:
        """
        Full retraining pipeline. Returns metrics dict.
        Blocks if another retrain is in progress (returns immediately with status='busy').
        """
        if _retrain_lock.locked():
            log.warning("Retraining already in progress — skipping this trigger")
            return {"status": "busy"}

        async with _retrain_lock:
            return await self._run(
                symbol, lookback_candles, wf_n_splits, wf_purge_gap,
                use_feature_pruning, feature_pruning_min_importance,
                use_chronos_calibration, use_1h_lgbm_gate,
            )

    async def _run(
        self,
        symbol:                        str,
        lookback_candles:              int,
        wf_n_splits:                   int   = 5,
        wf_purge_gap:                  int   = 5,
        use_feature_pruning:           bool  = False,
        feature_pruning_min_importance: float = 0.005,
        use_chronos_calibration:       bool  = False,
        use_1h_lgbm_gate:              bool  = False,
    ) -> dict:
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
        wf_results = _walk_forward_splits(X, y, n_splits=wf_n_splits, purge_gap=wf_purge_gap)
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

        # ── 8. Save full model ────────────────────────────────────────────────
        MODEL_DIR.mkdir(exist_ok=True)
        payload = {"model": model, "features": available}
        with open(MODEL_PATH, "wb") as f:
            pickle.dump(payload, f)

        # ── 9. Feature importance JSON (always saved, used by UI endpoint) ────
        importances = model.feature_importances_
        total_imp   = importances.sum() or 1.0
        imp_dict    = {
            name: round(float(imp / total_imp), 5)
            for name, imp in sorted(
                zip(available, importances), key=lambda x: -x[1]
            )
        }
        with open(MODEL_DIR / "feature_importance.json", "w") as f:
            json.dump({"trained_at": t0.isoformat(), "features": imp_dict}, f, indent=2)
        log.info("Feature importance saved (%d features)", len(imp_dict))

        # ── 10. Optional feature pruning ──────────────────────────────────────
        prune_metrics: Optional[dict] = None
        if use_feature_pruning:
            _, _, prune_metrics = self._build_pruned_model(
                model, X_tr, y_tr, X_val, y_val,
                threshold=feature_pruning_min_importance,
            )

        # ── 11. Optional Chronos calibration ──────────────────────────────────
        cal_metrics: Optional[dict] = None
        if use_chronos_calibration:
            cal_metrics = await self.retrain_calibrator()

        # ── 12. Optional 1H gate model retrain ────────────────────────────────
        lgbm_1h_metrics: Optional[dict] = None
        if use_1h_lgbm_gate:
            try:
                lgbm_1h_metrics = await self.retrain_1h(symbol)
            except Exception as exc:
                log.warning("1H gate retrain failed: %s", exc)
                lgbm_1h_metrics = {"status": "failed", "error": str(exc)}

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
            "wf_n_splits":     wf_n_splits,
            "wf_purge_gap":    wf_purge_gap,
            "pruning":         prune_metrics,
            "calibrator":      cal_metrics,
            "lgbm_1h":         lgbm_1h_metrics,
        }
        log.info(
            "Retraining complete: OOS acc=%.2f%% ll=%.4f | WF acc=%.2f%% ll=%.4f (%.1fs)",
            oos_acc * 100, oos_ll,
            (wf_acc or 0) * 100, wf_ll or 0,
            elapsed_s,
        )
        return metrics

    async def retrain_calibrator(self) -> dict:
        """
        Fitta IsotonicCalibrator su trade storici (inference_logs × trades join).
        Chiamato automaticamente da _run() quando use_chronos_calibration=True.
        Può essere richiamato manualmente tramite POST /calibrator/refit.
        Ritorna metrics dict con status 'ok' | 'skipped' e n_samples.
        """
        from services.calibration import IsotonicCalibrator
        from services.supabase_client import get_supabase
        cal = IsotonicCalibrator()
        n   = await cal.fit(get_supabase())

        if n >= 50:
            cal.save(MODEL_DIR / "chronos_calibrator.pkl")
            return {"status": "ok", "n_samples": n}

        log.warning("Calibrator skipped: insufficient samples (%d < 50)", n)
        return {"status": "skipped", "n_samples": n}

    async def retrain_1h(
        self,
        symbol:           str = "BTC",
        lookback_candles: int = 2000,
    ) -> dict:
        """
        Train LightGBM on 1H candles as a gate/confirmation model for 4H signals.
        Uses the same LGBM_FEATURES and build_all_features pipeline.
        Target: close[+1] > close[0] (1-candle horizon on 1H).
        Saves to models/lgbm_1h_latest.pkl.
        """
        t0 = datetime.now(timezone.utc)
        log.info("1H LightGBM gate training started (lookback=%d candles)", lookback_candles)

        fetch_n  = lookback_candles + 128
        df_ohlcv = await self._hl.get_ohlcv(symbol, "1h", limit=fetch_n)
        df_fund  = await self._hl.get_funding_history(symbol, hours=fetch_n)

        df_feat = build_all_features(df_ohlcv, df_fund, pd.DataFrame(), pd.DataFrame())
        df_feat["_target"] = (df_feat["close"].shift(-1) > df_feat["close"]).astype(int)

        available = [f for f in LGBM_FEATURES if f in df_feat.columns]
        df_feat[available] = df_feat[available].fillna(0)
        df_clean = df_feat.dropna(subset=["_target"]).iloc[64:]

        if len(df_clean) > lookback_candles:
            df_clean = df_clean.iloc[-lookback_candles:]

        if len(df_clean) < 200:
            raise ValueError(f"Insufficient 1H data for training: {len(df_clean)} rows")

        X = df_clean[available]
        y = df_clean["_target"]
        log.info("1H training set: %d rows × %d features", len(X), len(available))

        split        = int(len(X) * 0.80)
        X_tr, X_val  = X.iloc[:split], X.iloc[split:]
        y_tr, y_val  = y.iloc[:split], y.iloc[split:]

        model_1h = lgb.LGBMClassifier(**_LGB_PARAMS)
        model_1h.fit(
            X_tr, y_tr,
            eval_set=[(X_val, y_val)],
            callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
        )

        y_pred_1h = model_1h.predict(X_val)
        y_prob_1h = model_1h.predict_proba(X_val)[:, 1]
        oos_acc   = float(accuracy_score(y_val, y_pred_1h))
        oos_ll    = float(log_loss(y_val, y_prob_1h))

        MODEL_DIR.mkdir(exist_ok=True)
        payload = {"model": model_1h, "features": available}
        with open(MODEL_1H_PATH, "wb") as f:
            pickle.dump(payload, f)

        elapsed_s = (datetime.now(timezone.utc) - t0).total_seconds()
        log.info(
            "1H model trained: OOS acc=%.2f%% ll=%.4f | best_iter=%s (%.1fs)",
            oos_acc * 100, oos_ll,
            getattr(model_1h, "best_iteration_", "?"), elapsed_s,
        )
        return {
            "status":          "ok",
            "trained_at":      t0.isoformat(),
            "elapsed_s":       round(elapsed_s, 1),
            "train_rows":      split,
            "val_rows":        len(X_val),
            "n_features":      len(available),
            "oos_accuracy":    round(oos_acc, 4),
            "oos_log_loss":    round(oos_ll, 4),
            "best_iteration":  getattr(model_1h, "best_iteration_", None),
        }

    def _build_pruned_model(
        self,
        model:     lgb.LGBMClassifier,
        X_train:   pd.DataFrame,
        y_train:   pd.Series,
        X_val:     pd.DataFrame,
        y_val:     pd.Series,
        threshold: float = 0.005,
    ) -> tuple[lgb.LGBMClassifier, list[str], dict]:
        """
        Trains a second model on the subset of features with normalised gain
        importance >= threshold, saves it as lgbm_pruned.pkl.
        Returns (pruned_model, kept_features, comparison_metrics).
        Falls back to the full model when too few features survive pruning.
        """
        importances = model.feature_importances_
        total       = importances.sum() or 1.0
        norm        = importances / total

        kept    = [f for f, imp in zip(X_train.columns, norm) if imp >= threshold]
        removed = [f for f, imp in zip(X_train.columns, norm) if imp < threshold]

        if len(kept) < 10:
            log.warning("Pruning skipped: too few features would survive (%d)", len(kept))
            return model, list(X_train.columns), {"status": "skipped", "reason": "too_few_features"}

        log.info(
            "Pruning: keeping %d/%d features, removing %d (threshold=%.3f)",
            len(kept), len(X_train.columns), len(removed), threshold,
        )

        pruned = lgb.LGBMClassifier(**_LGB_PARAMS)
        pruned.fit(
            X_train[kept], y_train,
            eval_set=[(X_val[kept], y_val)],
            callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
        )

        full_acc   = float(accuracy_score(y_val, model.predict(X_val)))
        pruned_acc = float(accuracy_score(y_val, pruned.predict(X_val[kept])))

        prune_result = {
            "status":           "ok",
            "threshold":        threshold,
            "features_kept":    len(kept),
            "features_removed": len(removed),
            "removed_names":    removed,
            "full_accuracy":    round(full_acc,   4),
            "pruned_accuracy":  round(pruned_acc, 4),
            "accuracy_delta":   round(pruned_acc - full_acc, 4),
        }

        # Persist pruned model and its stats
        payload_pruned = {"model": pruned, "features": kept}
        with open(PRUNED_MODEL_PATH, "wb") as f:
            pickle.dump(payload_pruned, f)
        with open(MODEL_DIR / "pruned_features.json", "w") as f:
            json.dump({"trained_at": datetime.now(timezone.utc).isoformat(), **prune_result}, f, indent=2)

        log.info(
            "Pruned model saved: %d features | acc delta=%+.4f (full=%.4f pruned=%.4f)",
            len(kept), prune_result["accuracy_delta"], full_acc, pruned_acc,
        )
        return pruned, kept, prune_result


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


def load_1h_model() -> Optional[tuple]:
    """
    Load the 1H gate model from disk.
    Returns (model, features_list) or None if not found.
    """
    if not MODEL_1H_PATH.exists():
        return None
    with open(MODEL_1H_PATH, "rb") as f:
        payload = pickle.load(f)
    return payload["model"], payload["features"]


def load_correct_model(use_pruning: bool = False) -> Optional[tuple]:
    """
    Load the appropriate model based on the use_pruning flag.
    When use_pruning=True: loads lgbm_pruned.pkl, falls back to full model if absent.
    Returns (model, features_list) or None if no model exists at all.
    """
    if use_pruning and PRUNED_MODEL_PATH.exists():
        with open(PRUNED_MODEL_PATH, "rb") as f:
            payload = pickle.load(f)
        log.info("Loaded PRUNED model (%d features)", len(payload["features"]))
        return payload["model"], payload["features"]
    if use_pruning:
        log.warning("Pruned model not found — falling back to full model")
    return load_model()
