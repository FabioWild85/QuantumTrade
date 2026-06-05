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
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, log_loss

from services.hyperliquid_data import HyperliquidData
from services.smc import (
    build_all_features, ALL_FEATURES,
    build_4h_context_for_1h, LGBM_1H_EXTRA_FEATURES,
)

try:
    import optuna as _optuna
    _optuna.logging.set_verbosity(_optuna.logging.WARNING)
    _OPTUNA_AVAILABLE = True
except ImportError:
    _optuna = None  # type: ignore[assignment]
    _OPTUNA_AVAILABLE = False

log = logging.getLogger(__name__)

MODEL_DIR              = Path(__file__).parent.parent / "models"
MODEL_PATH             = MODEL_DIR / "lgbm_latest.pkl"
PRUNED_MODEL_PATH      = MODEL_DIR / "lgbm_pruned.pkl"
MODEL_1H_PATH          = MODEL_DIR / "lgbm_1h_latest.pkl"
DRIFT_BASELINE_PATH    = MODEL_DIR / "drift_baseline.json"
MODEL_REGISTRY_PATH    = MODEL_DIR / "model_registry.json"
MODEL_REGISTRY_MAX_VERSIONS = 10  # versioned pkl files to keep on disk

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
_retrain_lock    = asyncio.Lock()
_retrain_1h_lock = asyncio.Lock()  # separate lock so 1H retrain can run alone, but never twice

# ── Optuna hyperparameter search ──────────────────────────────────────────────
OPTUNA_N_TRIALS_DEFAULT = 50


def _optuna_objective(
    trial,
    X: pd.DataFrame,
    y: pd.Series,
    wf_n_splits: int,
    wf_purge_gap: int,
) -> float:
    """
    Objective for Optuna: avg WF log-loss over 3 fast folds with trial params.
    n_estimators is capped at 300 here; the real value is derived from best_iteration_
    in the main WF CV that runs after tuning with the winning params.
    """
    trial_params = {
        "num_leaves":        trial.suggest_int("num_leaves",        15, 63),
        "max_depth":         trial.suggest_int("max_depth",         3, 8),
        "min_child_samples": trial.suggest_int("min_child_samples", 10, 60),
        "subsample":         trial.suggest_float("subsample",        0.5, 1.0),
        "colsample_bytree":  trial.suggest_float("colsample_bytree", 0.5, 1.0),
        "reg_alpha":         trial.suggest_float("reg_alpha",        1e-3, 1.0, log=True),
        "reg_lambda":        trial.suggest_float("reg_lambda",       1e-3, 1.0, log=True),
        "learning_rate":     trial.suggest_float("learning_rate",    0.01, 0.1, log=True),
        "n_estimators":      300,
    }
    n_folds = min(3, wf_n_splits)
    folds = _walk_forward_splits(
        X, y,
        n_splits=n_folds,
        purge_gap=wf_purge_gap,
        params_override=trial_params,
    )
    if not folds:
        return 1.0
    return float(np.mean([f["log_loss"] for f in folds]))


async def _run_optuna_tuning(
    X: pd.DataFrame,
    y: pd.Series,
    wf_n_splits: int,
    wf_purge_gap: int,
    n_trials: int = OPTUNA_N_TRIALS_DEFAULT,
) -> dict:
    """
    Bayesian hyperparameter search via Optuna TPE sampler.
    Runs in a ThreadPoolExecutor to avoid blocking the async event loop.
    Returns {"params": {...}, "best_ll": float, "n_trials": int}
    or {} when Optuna is not installed.
    """
    if not _OPTUNA_AVAILABLE:
        log.warning("Optuna not installed — skipping hyperparameter tuning. Run: pip install optuna")
        return {}

    log.info("Optuna tuning: %d trials × 3-fold fast CV (estimating best params before main WF CV)", n_trials)

    study = _optuna.create_study(
        direction="minimize",
        sampler=_optuna.samplers.TPESampler(seed=42),
    )

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        None,
        lambda: study.optimize(
            lambda trial: _optuna_objective(trial, X, y, wf_n_splits, wf_purge_gap),
            n_trials=n_trials,
            show_progress_bar=False,
        ),
    )

    best_params = study.best_params
    best_value  = study.best_value
    log.info(
        "Optuna done: best_ll=%.4f (trial %d/%d) | num_leaves=%d max_depth=%d lr=%.4f",
        best_value,
        study.best_trial.number + 1,
        n_trials,
        best_params.get("num_leaves", 0),
        best_params.get("max_depth", 0),
        best_params.get("learning_rate", 0),
    )
    return {
        "params":   best_params,
        "best_ll":  round(best_value, 4),
        "n_trials": n_trials,
    }


def _update_model_registry(entry: dict) -> int:
    """
    Append a versioned model entry to model_registry.json.
    Prunes the oldest versioned pkl file and registry entry when the count
    exceeds MODEL_REGISTRY_MAX_VERSIONS.
    Returns the total number of entries in the registry after the update.
    """
    MODEL_REGISTRY_PATH.parent.mkdir(exist_ok=True)
    if MODEL_REGISTRY_PATH.exists():
        with open(MODEL_REGISTRY_PATH) as _f:
            registry = json.load(_f)
    else:
        registry = {"models": []}

    registry["models"].append(entry)

    # Prune oldest entries + their pkl files when over the limit
    while len(registry["models"]) > MODEL_REGISTRY_MAX_VERSIONS:
        oldest = registry["models"].pop(0)
        old_path = MODEL_DIR / oldest["filename"]
        if old_path.exists():
            old_path.unlink()
            log.info("Model registry: pruned old version %s", oldest["filename"])

    with open(MODEL_REGISTRY_PATH, "w") as _f:
        json.dump(registry, _f, indent=2)

    return len(registry["models"])


def _walk_forward_splits(
    X: pd.DataFrame,
    y: pd.Series,
    n_splits: int = 5,
    purge_gap: int = 5,
    params_override: Optional[dict] = None,
) -> list[dict]:
    """
    Expanding window walk-forward CV with purge gap.
    purge_gap: candele escluse tra train_end e val_start — elimina autocorrelazione
    temporale su serie finanziarie (look-ahead bias). Ogni fold espande il training set.
    params_override: when set (e.g. from Optuna), overrides the base _LGB_PARAMS.
    """
    params    = {**_LGB_PARAMS, **(params_override or {})}
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

        m = lgb.LGBMClassifier(**params)
        m.fit(
            X_tr, y_tr,
            eval_set=[(X_val, y_val)],
            callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
        )

        y_prob   = m.predict_proba(X_val)[:, 1]
        fold_ll  = float(log_loss(y_val, y_prob))
        fold_acc = float(accuracy_score(y_val, (y_prob > 0.5).astype(int)))
        results.append({
            "fold":           i,
            "train_n":        len(X_tr),
            "val_n":          len(X_val),
            "log_loss":       round(fold_ll, 4),
            "accuracy":       round(fold_acc, 4),
            "best_iteration": getattr(m, "best_iteration_", None),
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
        from_date:                     Optional[str] = None,
        wf_n_splits:                   int   = 5,
        wf_purge_gap:                  int   = 5,
        use_feature_pruning:           bool  = False,
        feature_pruning_min_importance: float = 0.005,
        use_chronos_calibration:       bool  = False,
        use_1h_lgbm_gate:              bool  = False,
        use_optuna:                    bool  = False,
        optuna_n_trials:               int   = OPTUNA_N_TRIALS_DEFAULT,
        binance_cvd_enabled:           bool  = False,
        reversal_mode_enabled:         bool  = False,
    ) -> dict:
        """
        Full retraining pipeline. Returns metrics dict.
        from_date: "YYYY-MM-DD" — if set, fetches from Binance from that date to today
                   instead of the last lookback_candles from HL.
        use_optuna: when True, runs Bayesian hyperparameter search before the main WF CV.
                    Adds ~3-8 min per retrain. Recommended for deep retrains only.
        Blocks if another retrain is in progress (returns immediately with status='busy').
        """
        if _retrain_lock.locked():
            log.warning("Retraining already in progress — skipping this trigger")
            return {"status": "busy"}

        async with _retrain_lock:
            return await self._run(
                symbol, lookback_candles, from_date, wf_n_splits, wf_purge_gap,
                use_feature_pruning, feature_pruning_min_importance,
                use_chronos_calibration, use_1h_lgbm_gate,
                use_optuna, optuna_n_trials,
                binance_cvd_enabled=binance_cvd_enabled,
                reversal_mode_enabled=reversal_mode_enabled,
            )

    async def _run(
        self,
        symbol:                        str,
        lookback_candles:              int,
        from_date:                     Optional[str] = None,
        wf_n_splits:                   int   = 5,
        wf_purge_gap:                  int   = 5,
        use_feature_pruning:           bool  = False,
        feature_pruning_min_importance: float = 0.005,
        use_chronos_calibration:       bool  = False,
        use_1h_lgbm_gate:              bool  = False,
        use_optuna:                    bool  = False,
        optuna_n_trials:               int   = OPTUNA_N_TRIALS_DEFAULT,
        binance_cvd_enabled:           bool  = False,
        reversal_mode_enabled:         bool  = False,
    ) -> dict:
        t0 = datetime.now(timezone.utc)

        # ── 1. Fetch data ────────────────────────────────────────────────────
        if from_date:
            from services.binance_data import get_ohlcv_binance
            df_ohlcv = await get_ohlcv_binance(symbol, "4h", start_date=from_date)
            log.info(
                "Deep training: Binance OHLCV from %s — %d candles",
                from_date, len(df_ohlcv),
            )
        else:
            fetch_n  = lookback_candles + 128
            df_ohlcv = await self._hl.get_ohlcv(symbol, "4h", limit=fetch_n)

        log.info("LightGBM retraining started (%d OHLCV candles)", len(df_ohlcv))

        # Funding history — HL only stores ~330 days; older bars will have 0 funding.
        fund_hours = min(len(df_ohlcv) * 4 + 128, 8760)
        df_fund    = await self._hl.get_funding_history(symbol, hours=fund_hours)

        # ── 2. Build features ────────────────────────────────────────────────
        df_binance_train = None
        if binance_cvd_enabled:
            try:
                from services.binance_data import get_ohlcv_binance
                if from_date:
                    df_binance_train = await get_ohlcv_binance(symbol, "4h", start_date=from_date)
                else:
                    df_binance_train = await get_ohlcv_binance(symbol, "4h", limit=lookback_candles + 200)
                log.info("Binance CVD data for training: %d candles", len(df_binance_train))
            except Exception as _bnc_err:
                log.warning("Binance CVD fetch for training failed (non-blocking): %s", _bnc_err)

        df_feat = build_all_features(
            df_ohlcv, df_fund,
            pd.DataFrame(), pd.DataFrame(),  # OI/liq placeholders (fetched live in prod)
            df_binance=df_binance_train,
            binance_cvd_enabled=binance_cvd_enabled,
            reversal_mode_enabled=reversal_mode_enabled,
        )

        # ── 3. Target: ATR-threshold direction ──────────────────────────────
        # Label a candle 1 (up) only if the next close is > k×ATR above current,
        # 0 (down) if > k×ATR below. Flat moves (|ret| < k×ATR_pct) are set to NaN
        # and excluded from training — the model never learns to predict noise.
        _atr_pct = df_feat["atr_14"] / df_feat["close"].replace(0, np.nan)
        _fut_ret = df_feat["close"].shift(-1) / df_feat["close"].replace(0, np.nan) - 1
        _k = 0.3
        df_feat["_target"] = np.where(
            _fut_ret > _k * _atr_pct, 1,
            np.where(_fut_ret < -_k * _atr_pct, 0, np.nan),
        )

        # Select only LGBM features that actually exist in the dataframe
        available = [f for f in LGBM_FEATURES if f in df_feat.columns]

        # Fill NaN in sparse features (funding, OI, liq) with 0 before dropping rows.
        df_feat[available] = df_feat[available].fillna(0)

        # Skip warmup rows (indicators need ~64 bars to stabilise)
        df_clean = df_feat.iloc[64:].copy()

        # Trim to requested lookback only for short-history retrains.
        # Deep training (from_date set) uses the full dataset.
        if not from_date and len(df_clean) > lookback_candles:
            df_clean = df_clean.iloc[-lookback_candles:]

        # Remove neutral bars and the last candle (no future target)
        n_before = len(df_clean)
        df_clean = df_clean.dropna(subset=["_target"]).copy()
        n_excluded = n_before - len(df_clean)
        log.info(
            "Target filter (k=%.1f×ATR): %d/%d bars excluded as neutral (%.1f%%)",
            _k, n_excluded, n_before, 100.0 * n_excluded / max(n_before, 1),
        )

        if len(df_clean) < 100:
            raise ValueError(f"Insufficient clean rows for training: {len(df_clean)}")

        X = df_clean[available]
        y = df_clean["_target"]
        log.info("Training set: %d rows × %d features", len(X), len(available))

        # ── 3.5 Optional Optuna hyperparameter search ────────────────────────
        # Runs BEFORE the main WF CV so that CV and final model both use tuned params.
        # Skipped for drift/auto retrains (use_optuna=False) to keep them fast.
        optuna_result: Optional[dict] = None
        tuned_params:  Optional[dict] = None
        if use_optuna:
            optuna_result = await _run_optuna_tuning(X, y, wf_n_splits, wf_purge_gap, optuna_n_trials)
            tuned_params  = optuna_result.get("params") if optuna_result else None
            if tuned_params:
                log.info(
                    "Optuna params accepted: num_leaves=%d max_depth=%d lr=%.4f — will use for WF CV and final model",
                    tuned_params.get("num_leaves", 0),
                    tuned_params.get("max_depth", 0),
                    tuned_params.get("learning_rate", 0),
                )
            else:
                log.warning("Optuna returned no params (not installed?) — using default _LGB_PARAMS")

        # ── 4. Purged walk-forward CV (OOS reale senza look-ahead bias) ──────
        # Uses tuned_params if Optuna ran, otherwise falls back to default _LGB_PARAMS.
        wf_results = _walk_forward_splits(X, y, n_splits=wf_n_splits, purge_gap=wf_purge_gap, params_override=tuned_params)
        wf_ll  = float(np.mean([r["log_loss"]  for r in wf_results])) if wf_results else None
        wf_acc = float(np.mean([r["accuracy"]  for r in wf_results])) if wf_results else None
        log.info(
            "Walk-forward CV: avg_acc=%.2f%% avg_ll=%.4f (%d folds)",
            (wf_acc or 0) * 100, wf_ll or 0, len(wf_results),
        )

        # ── 5. Derive optimal n_estimators from WF CV ────────────────────────
        # Average best_iteration across folds — no fixed holdout needed.
        # Early stopping was already measured honestly on OOS fold data.
        best_iters = [r["best_iteration"] for r in wf_results if r.get("best_iteration")]
        best_n_trees = int(np.mean(best_iters)) if best_iters else _LGB_PARAMS["n_estimators"]
        log.info("WF-derived n_estimators: %d (avg of %d folds)", best_n_trees, len(best_iters))

        # Internal 80/20 split — used ONLY for feature pruning eval, not for OOS metrics.
        _split = int(len(X) * 0.80)
        X_tr_prune, X_val_prune = X.iloc[:_split], X.iloc[_split:]
        y_tr_prune, y_val_prune = y.iloc[:_split], y.iloc[_split:]

        # ── 6. Train final model on ALL data ─────────────────────────────────
        # n_estimators fixed from WF CV — no early stopping, no wasted holdout.
        # Exponential decay weights: oldest ≈ 0.05, most recent = 1.0.
        n_all = len(X)
        sample_weights_all = np.exp(np.linspace(np.log(0.05), 0.0, n_all))

        # Merge: base params ← Optuna tuned params ← WF-derived n_estimators (highest priority)
        final_params = {**_LGB_PARAMS, **(tuned_params or {}), "n_estimators": best_n_trees}
        model = lgb.LGBMClassifier(**final_params)
        model.fit(X, y, sample_weight=sample_weights_all)

        # ── 7. OOS metrics — last WF fold (most recent market, no look-ahead) ─
        last_fold = wf_results[-1] if wf_results else {}
        oos_acc   = float(last_fold.get("accuracy", 0.0))
        oos_ll    = float(last_fold.get("log_loss",  0.0))

        # ── 8. Save drift baseline ───────────────────────────────────────────
        # Threshold = WF avg_ll + max(2×std, 0.05).
        # The 0.05 floor prevents hair-trigger alerts when all folds were very similar.
        # Only written when WF CV produced at least one fold (guards against empty results).
        wf_lls    = [r["log_loss"] for r in wf_results] if wf_results else []
        wf_std_ll = float(np.std(wf_lls)) if len(wf_lls) >= 2 else 0.05
        _base_ll  = wf_ll if wf_ll is not None else oos_ll
        if wf_results and _base_ll > 0:
            drift_threshold = _base_ll + max(2.0 * wf_std_ll, 0.05)
            MODEL_DIR.mkdir(exist_ok=True)
            with open(DRIFT_BASELINE_PATH, "w") as _f:
                json.dump({
                    "trained_at":      t0.isoformat(),
                    "wf_avg_log_loss": round(_base_ll,       4),
                    "wf_std_log_loss": round(wf_std_ll,      4),
                    "threshold":       round(drift_threshold, 4),
                    "wf_avg_accuracy": round(wf_acc if wf_acc is not None else oos_acc, 4),
                }, _f, indent=2)
            log.info(
                "Drift baseline saved: avg_ll=%.4f ± %.4f → threshold=%.4f",
                _base_ll, wf_std_ll, drift_threshold,
            )
        else:
            log.warning("Drift baseline not saved: WF CV produced no folds or baseline_ll=0")

        # ── 9. Save full model (backup + versioned copy + registry) ────────
        MODEL_DIR.mkdir(exist_ok=True)
        if MODEL_PATH.exists():
            shutil.copy2(MODEL_PATH, MODEL_PATH.with_name("lgbm_latest.bak.pkl"))
        payload = {"model": model, "features": available}
        with open(MODEL_PATH, "wb") as f:
            pickle.dump(payload, f)

        # Versioned copy: lgbm_YYYYMMDDTHHMMSSZ.pkl — enables rollback to any past model
        _ts_str      = t0.strftime("%Y%m%dT%H%M%SZ")
        _version_path = MODEL_DIR / f"lgbm_{_ts_str}.pkl"
        shutil.copy2(MODEL_PATH, _version_path)
        _n_versions = _update_model_registry({
            "filename":             _version_path.name,
            "trained_at":           t0.isoformat(),
            "oos_accuracy":         round(oos_acc, 4),
            "oos_log_loss":         round(oos_ll, 4),
            "wf_avg_accuracy":      round(wf_acc, 4) if wf_acc is not None else None,
            "wf_avg_log_loss":      round(wf_ll,  4) if wf_ll  is not None else None,
            "n_features":           len(available),
            "train_rows":           n_all,
            "best_iteration":       best_n_trees,
            "neutral_excluded_pct": round(100.0 * n_excluded / max(n_before, 1), 1),
            "optuna_best_ll":       optuna_result.get("best_ll") if optuna_result else None,
        })
        log.info("Model versioned as %s (registry: %d/%d)", _version_path.name, _n_versions, MODEL_REGISTRY_MAX_VERSIONS)

        # ── 10. Feature importance JSON (always saved, used by UI endpoint) ───
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

        # ── 11. Optional feature pruning ──────────────────────────────────────
        prune_metrics: Optional[dict] = None
        if use_feature_pruning:
            _, _, prune_metrics = self._build_pruned_model(
                model, X_tr_prune, y_tr_prune, X_val_prune, y_val_prune,
                threshold=feature_pruning_min_importance,
            )

        # ── 12. Optional Chronos calibration ──────────────────────────────────
        cal_metrics: Optional[dict] = None
        if use_chronos_calibration:
            cal_metrics = await self.retrain_calibrator()

        # ── 13. Optional 1H gate model retrain ────────────────────────────────
        # When doing a deep retrain (from_date set), pass the same date to the 1H model
        # so it also trains on years of Binance data instead of the HL window.
        lgbm_1h_metrics: Optional[dict] = None
        if use_1h_lgbm_gate:
            try:
                lgbm_1h_metrics = await self.retrain_1h(
                    symbol,
                    from_date=from_date,
                    wf_n_splits=wf_n_splits,
                    wf_purge_gap=wf_purge_gap,
                    use_optuna=use_optuna,
                    optuna_n_trials=optuna_n_trials,
                )
            except Exception as exc:
                log.warning("1H gate retrain failed: %s", exc)
                lgbm_1h_metrics = {"status": "failed", "error": str(exc)}

        elapsed_s = (datetime.now(timezone.utc) - t0).total_seconds()
        metrics = {
            "status":          "ok",
            "trained_at":      t0.isoformat(),
            "elapsed_s":       round(elapsed_s, 1),
            "train_rows":      n_all,
            "val_rows":        last_fold.get("val_n", 0),
            "n_features":      len(available),
            "oos_accuracy":    round(oos_acc, 4),
            "oos_log_loss":    round(oos_ll, 4),
            "best_iteration":  best_n_trees,
            "wf_avg_accuracy": round(wf_acc, 4) if wf_acc is not None else None,
            "wf_avg_log_loss": round(wf_ll,  4) if wf_ll  is not None else None,
            "wf_folds":        wf_results,
            "wf_n_splits":        wf_n_splits,
            "wf_purge_gap":       wf_purge_gap,
            "neutral_excluded_pct": round(100.0 * n_excluded / max(n_before, 1), 1),
            "pruning":            prune_metrics,
            "calibrator":         cal_metrics,
            "optuna":             optuna_result,
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
        symbol:           str   = "BTC",
        lookback_candles: int   = 2000,
        from_date:        Optional[str] = None,
        wf_n_splits:      int   = 5,
        wf_purge_gap:     int   = 5,
        forward_bars:     int   = 4,
        use_optuna:       bool  = False,
        optuna_n_trials:  int   = 30,
    ) -> dict:
        """
        Train LightGBM on 1H candles as a gate/confirmation model for 4H signals.

        Improvements over the baseline:
        - from_date: when set, fetches full Binance 1H history from that date (years of data
          instead of HL's ~2000-candle window). Dramatically increases training set size.
        - forward_bars: prediction horizon in 1H bars (default 4 = 4H equivalent). Target
          is the multi-bar return over the next `forward_bars` candles, with ATR threshold
          scaled by sqrt(forward_bars) to match the horizon. Aligns semantically with the
          4H signal the gate is confirming.
        - 4H context features: build_4h_context_for_1h() resamples the 1H data to 4H and
          adds h4_ema50_dist, h4_adx, h4_rsi, h4_regime as features — the model sees the
          same 4H regime context during training that it will see at inference time.
        - use_optuna: optional Bayesian hyperparameter search (30 trials by default, fewer
          than the 4H model since 1H data is denser and convergence is faster).

        Saves to models/lgbm_1h_latest.pkl.
        Returns {"status": "busy"} immediately if another 1H retrain is already running.
        """
        if _retrain_1h_lock.locked():
            log.warning("1H retraining already in progress — skipping this trigger")
            return {"status": "busy"}

        async with _retrain_1h_lock:
            return await self._run_1h(
                symbol=symbol, lookback_candles=lookback_candles, from_date=from_date,
                wf_n_splits=wf_n_splits, wf_purge_gap=wf_purge_gap,
                forward_bars=forward_bars, use_optuna=use_optuna, optuna_n_trials=optuna_n_trials,
            )

    async def _run_1h(
        self,
        symbol:           str,
        lookback_candles: int,
        from_date:        Optional[str],
        wf_n_splits:      int,
        wf_purge_gap:     int,
        forward_bars:     int,
        use_optuna:       bool,
        optuna_n_trials:  int,
    ) -> dict:
        t0 = datetime.now(timezone.utc)
        log.info(
            "1H LightGBM gate training started (from_date=%s, lookback=%d, forward_bars=%d, optuna=%s)",
            from_date or "HL", lookback_candles, forward_bars, use_optuna,
        )

        # ── 1. Fetch OHLCV ───────────────────────────────────────────────────
        if from_date:
            from services.binance_data import get_ohlcv_binance
            df_ohlcv = await get_ohlcv_binance(symbol, "1h", start_date=from_date)
            log.info("1H deep training: Binance OHLCV from %s — %d candles", from_date, len(df_ohlcv))
        else:
            fetch_n  = lookback_candles + 128
            df_ohlcv = await self._hl.get_ohlcv(symbol, "1h", limit=fetch_n)
            log.info("1H data fetched from HL: %d candles", len(df_ohlcv))

        # Funding: HL only; use what's available and let merge fill gaps with 0
        fund_hours = min(len(df_ohlcv) + 128, 8760)
        df_fund    = await self._hl.get_funding_history(symbol, hours=fund_hours)

        # ── 2. Build base features + 4H context ─────────────────────────────
        df_feat = build_all_features(df_ohlcv, df_fund, pd.DataFrame(), pd.DataFrame())
        df_feat = build_4h_context_for_1h(df_feat)

        # ── 3. Target: multi-bar ATR-threshold direction ─────────────────────
        # Return over the next `forward_bars` 1H candles; threshold scaled by sqrt(forward_bars)
        # so larger horizons get proportionally larger required moves (random-walk scaling).
        _atr_pct  = df_feat["atr_14"] / df_feat["close"].replace(0, np.nan)
        _fut_ret  = df_feat["close"].shift(-forward_bars) / df_feat["close"].replace(0, np.nan) - 1
        _k        = 0.3 * (forward_bars ** 0.5)
        df_feat["_target"] = np.where(
            _fut_ret > _k * _atr_pct, 1,
            np.where(_fut_ret < -_k * _atr_pct, 0, np.nan),
        )

        # ── 4. Feature selection ─────────────────────────────────────────────
        available = [
            f for f in (LGBM_FEATURES + LGBM_1H_EXTRA_FEATURES)
            if f in df_feat.columns
        ]
        df_feat[available] = df_feat[available].fillna(0)

        # Skip warmup rows, then trim to lookback (only for HL mode — Binance already sized)
        df_clean = df_feat.iloc[64:].copy()
        if not from_date and len(df_clean) > lookback_candles:
            df_clean = df_clean.iloc[-lookback_candles:]

        # Exclude neutral bars
        n_before   = len(df_clean)
        df_clean   = df_clean.dropna(subset=["_target"]).copy()
        n_excluded = n_before - len(df_clean)
        log.info(
            "1H target filter (k=%.2f×ATR, %d-bar horizon): %d/%d bars neutral (%.1f%%)",
            _k, forward_bars, n_excluded, n_before, 100.0 * n_excluded / max(n_before, 1),
        )

        if len(df_clean) < 300:
            raise ValueError(f"Insufficient 1H clean rows for training: {len(df_clean)}")

        X = df_clean[available]
        y = df_clean["_target"]
        log.info("1H training set: %d rows × %d features (incl. 4H context)", len(X), len(available))

        # ── 5. Optional Optuna tuning ────────────────────────────────────────
        tuned_params: Optional[dict] = None
        optuna_metrics: Optional[dict] = None
        if use_optuna:
            optuna_result = await _run_optuna_tuning(
                X, y, wf_n_splits=wf_n_splits, wf_purge_gap=wf_purge_gap, n_trials=optuna_n_trials,
            )
            if optuna_result:
                tuned_params  = optuna_result.get("params")
                optuna_metrics = {
                    "params":   tuned_params,
                    "best_ll":  round(optuna_result.get("best_ll", 0.0), 4),
                    "n_trials": optuna_result.get("n_trials", 0),
                }

        # ── 6. Purged walk-forward CV ────────────────────────────────────────
        wf_results = _walk_forward_splits(
            X, y, n_splits=wf_n_splits, purge_gap=wf_purge_gap,
            params_override=tuned_params,
        )
        wf_ll  = float(np.mean([r["log_loss"]  for r in wf_results])) if wf_results else None
        wf_acc = float(np.mean([r["accuracy"]  for r in wf_results])) if wf_results else None
        log.info(
            "1H WF CV: avg_acc=%.2f%% avg_ll=%.4f (%d folds)",
            (wf_acc or 0) * 100, wf_ll or 0, len(wf_results),
        )

        # ── 7. Derive optimal n_estimators from WF CV ────────────────────────
        best_iters   = [r["best_iteration"] for r in wf_results if r.get("best_iteration")]
        best_n_trees = int(np.mean(best_iters)) if best_iters else _LGB_PARAMS["n_estimators"]
        log.info("1H WF-derived n_estimators: %d", best_n_trees)

        # ── 8. Train final model on ALL data ─────────────────────────────────
        n_all = len(X)
        sample_weights_all = np.exp(np.linspace(np.log(0.05), 0.0, n_all))

        final_params = {**_LGB_PARAMS, **(tuned_params or {}), "n_estimators": best_n_trees}
        model_1h = lgb.LGBMClassifier(**final_params)
        model_1h.fit(X, y, sample_weight=sample_weights_all)

        # ── 9. OOS metrics — last WF fold ────────────────────────────────────
        last_fold = wf_results[-1] if wf_results else {}
        oos_acc   = float(last_fold.get("accuracy", 0.0))
        oos_ll    = float(last_fold.get("log_loss",  0.0))

        # ── 10. Save model ────────────────────────────────────────────────────
        MODEL_DIR.mkdir(exist_ok=True)
        payload = {
            "model":        model_1h,
            "features":     available,
            "forward_bars": forward_bars,
            "trained_at":   t0.isoformat(),
        }
        with open(MODEL_1H_PATH, "wb") as f:
            pickle.dump(payload, f)

        elapsed_s = (datetime.now(timezone.utc) - t0).total_seconds()
        log.info(
            "1H model trained: OOS acc=%.2f%% ll=%.4f | WF acc=%.2f%% ll=%.4f | "
            "n_est=%d n_feat=%d horizon=%dh (%.1fs)",
            oos_acc * 100, oos_ll,
            (wf_acc or 0) * 100, wf_ll or 0,
            best_n_trees, len(available), forward_bars, elapsed_s,
        )
        return {
            "status":               "ok",
            "trained_at":           t0.isoformat(),
            "elapsed_s":            round(elapsed_s, 1),
            "train_rows":           n_all,
            "val_rows":             last_fold.get("val_n", 0),
            "n_features":           len(available),
            "forward_bars":         forward_bars,
            "oos_accuracy":         round(oos_acc, 4),
            "oos_log_loss":         round(oos_ll, 4),
            "best_iteration":       best_n_trees,
            "wf_avg_accuracy":      round(wf_acc, 4) if wf_acc is not None else None,
            "wf_avg_log_loss":      round(wf_ll,  4) if wf_ll  is not None else None,
            "wf_folds":             wf_results,
            "neutral_excluded_pct": round(100.0 * n_excluded / max(n_before, 1), 1),
            "optuna":               optuna_metrics,
        }

    async def check_drift(self, symbol: str = "BTC", use_pruning: bool = False) -> dict:
        """
        Evaluate the current model's log-loss on recent candles and compare to
        the baseline saved at the last retrain.

        use_pruning: must match the engine's use_feature_pruning config so the
                     correct model (full or pruned) is evaluated.

        Returns a dict:
          drift        — True if log-loss exceeds the stored threshold
          recent_ll    — log-loss on the last ~100 clean bars
          recent_acc   — accuracy on the same bars
          baseline_ll  — WF avg log-loss at last retrain
          threshold    — baseline_ll + max(2×std, 0.05)
          n_samples    — number of labeled bars evaluated
          reason       — set only when drift=False due to a guard (no_baseline, etc.)
        """
        if not DRIFT_BASELINE_PATH.exists():
            return {"drift": False, "reason": "no_baseline"}

        with open(DRIFT_BASELINE_PATH) as _f:
            baseline = json.load(_f)

        model_data = load_correct_model(use_pruning)
        if model_data is None:
            return {"drift": False, "reason": "no_model"}
        model, feat_cols = model_data

        try:
            df_ohlcv = await self._hl.get_ohlcv(symbol, "4h", limit=200)
            df_fund  = await self._hl.get_funding_history(symbol, hours=900)
        except Exception as exc:
            log.warning("Drift check: data fetch failed — %s", exc)
            return {"drift": False, "reason": f"fetch_error: {exc}"}

        df_feat = build_all_features(df_ohlcv, df_fund, pd.DataFrame(), pd.DataFrame())

        # Same ATR-threshold labeling as training
        _atr_pct = df_feat["atr_14"] / df_feat["close"].replace(0, np.nan)
        _fut_ret  = df_feat["close"].shift(-1) / df_feat["close"].replace(0, np.nan) - 1
        _k = 0.3
        df_feat["_target"] = np.where(
            _fut_ret > _k * _atr_pct, 1,
            np.where(_fut_ret < -_k * _atr_pct, 0, np.nan),
        )

        df_clean = df_feat.iloc[64:].dropna(subset=["_target"]).copy()

        if len(df_clean) < 30:
            log.warning("Drift check: only %d labeled bars (need 30) — skipping", len(df_clean))
            return {"drift": False, "reason": "insufficient_data", "n_samples": len(df_clean)}

        X_recent = df_clean.reindex(columns=feat_cols, fill_value=0).fillna(0)
        y_recent  = df_clean["_target"]

        y_prob     = model.predict_proba(X_recent)[:, 1]
        recent_ll  = float(log_loss(y_recent, y_prob))
        recent_acc = float(accuracy_score(y_recent, (y_prob > 0.5).astype(int)))

        threshold      = baseline["threshold"]
        drift_detected = recent_ll > threshold

        log.info(
            "Drift check: recent_ll=%.4f | baseline=%.4f | threshold=%.4f | drift=%s (%d samples)",
            recent_ll, baseline["wf_avg_log_loss"], threshold, drift_detected, len(df_clean),
        )

        return {
            "drift":       drift_detected,
            "recent_ll":   round(recent_ll,  4),
            "recent_acc":  round(recent_acc, 4),
            "baseline_ll": round(baseline["wf_avg_log_loss"], 4),
            "threshold":   round(threshold,  4),
            "n_samples":   len(df_clean),
            "baseline_at": baseline.get("trained_at"),
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
