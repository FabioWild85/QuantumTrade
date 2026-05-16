"""
Chronos-2 wrapper service  (amazon/chronos-2 via Chronos2Pipeline).

Upgrade from chronos-t5-base:
  • Uses Chronos2Pipeline — quantile regression, fully deterministic (no sampling).
  • Accepts past_covariates: volume, open interest, funding rate.
  • dir_prob / vol_prob derived from quantile CDF interpolation.
  • cont_prob derived from quantile-band monotonicity across horizon steps.
  • Fan chart filled directly from quantile outputs — no sampling artefacts.

Output dict is identical to the old interface (same 8 c2_* keys + fan + latency_ms)
so decision.py, execution.py, backtesting.py and the frontend need no structural changes.
"""

import logging
import time
from typing import Optional

import numpy as np
import torch

log = logging.getLogger(__name__)

_pipeline = None
_device: Optional[str] = None

# Chronos-2 native quantile levels — all 21 levels supported by amazon/chronos-2.
# Verified via Chronos2Pipeline.quantiles on the VPS with chronos-forecasting 2.2.2.
_Q_LEVELS = np.array(
    [0.01, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45,
     0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99],
    dtype=np.float32,
)
# Exact index mapping for standard fan-chart quantiles
_Q10, _Q25, _Q50, _Q75, _Q90 = 2, 5, 10, 15, 18


def _get_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _load_pipeline():
    global _pipeline, _device
    if _pipeline is not None:
        return _pipeline

    from chronos import Chronos2Pipeline

    _device = _get_device()
    log.info(f"Loading Chronos-2 (amazon/chronos-2) on {_device}…")
    t0 = time.perf_counter()

    _pipeline = Chronos2Pipeline.from_pretrained(
        "amazon/chronos-2",
        device_map=_device,
        dtype=torch.bfloat16,
    )
    log.info(f"Chronos-2 loaded in {time.perf_counter() - t0:.1f}s")
    return _pipeline


def _cdf(x: float, q_values: np.ndarray) -> float:
    """
    Estimate P(X <= x) by linear interpolation of the empirical quantile CDF.
    q_values: sorted array of 21 price quantiles corresponding to _Q_LEVELS.
    """
    if x <= q_values[0]:
        return float(_Q_LEVELS[0])
    if x >= q_values[-1]:
        return float(_Q_LEVELS[-1])
    idx = int(np.searchsorted(q_values, x))
    idx = max(1, min(idx, len(q_values) - 1))
    q_lo, q_hi = float(q_values[idx - 1]), float(q_values[idx])
    p_lo, p_hi = float(_Q_LEVELS[idx - 1]), float(_Q_LEVELS[idx])
    frac = (x - q_lo) / (q_hi - q_lo + 1e-9)
    return float(np.clip(p_lo + frac * (p_hi - p_lo), 0.0, 1.0))


class ChronosForecaster:
    """
    Wraps amazon/chronos-2 and returns the 8 probabilistic features
    consumed by the decision engine, plus fan-chart data for the UI.
    """

    CONTEXT_LEN = 512
    MODEL_ID    = "amazon/chronos-2"

    def forecast(
        self,
        close_series: np.ndarray,
        horizon: int = 3,
        atr: Optional[float] = None,
        seed: Optional[int] = None,           # kept for API compatibility — ignored (deterministic model)
        volume_series:  Optional[np.ndarray] = None,
        oi_series:      Optional[np.ndarray] = None,
        funding_series: Optional[np.ndarray] = None,
        cvd_series:     Optional[np.ndarray] = None,
    ) -> dict:
        """
        Args:
            close_series:   1-D array of close prices, most-recent last.
            horizon:        forecast steps (3 = 12 h on the 4 h timeframe).
            atr:            current ATR(14) for the p50_vs_atr feature.
            seed:           ignored — Chronos-2 is deterministic (quantile regression).
            volume_series:  past volume aligned with close_series (optional).
            oi_series:      past open-interest aligned with close_series (optional).
            funding_series: past funding-rate aligned with close_series (optional).
            cvd_series:     past cumulative-volume-delta aligned with close_series (optional).

        Returns dict with keys:
            c2_dir_prob, c2_vol_prob, c2_p10, c2_p50, c2_p90,
            c2_uncertainty, c2_cont_prob, c2_p50_vs_atr, fan, latency_ms, cov_used
        """
        pipeline = _load_pipeline()
        t0 = time.perf_counter()

        # ── 1. Build aligned context arrays ────────────────────────────────
        ctx_len = min(len(close_series), self.CONTEXT_LEN)
        ctx = close_series[-ctx_len:].astype(np.float32)

        def _prep_covariate(arr: Optional[np.ndarray]) -> Optional[np.ndarray]:
            """Trim covariate to ctx_len, replace NaN/inf with 0. Skip if too short."""
            if arr is None or len(arr) == 0:
                return None
            a = arr[-ctx_len:].astype(np.float32)
            if len(a) < len(ctx):   # covariate shorter than price context — skip
                return None
            return np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)

        vol  = _prep_covariate(volume_series)
        oi   = _prep_covariate(oi_series)
        fund = _prep_covariate(funding_series)
        cvd  = _prep_covariate(cvd_series)

        # ── 2. Assemble model input ─────────────────────────────────────────
        past_covariates: dict = {}
        if vol  is not None: past_covariates["volume"]  = torch.from_numpy(vol)
        if oi   is not None: past_covariates["oi"]      = torch.from_numpy(oi)
        if fund is not None: past_covariates["funding"] = torch.from_numpy(fund)
        if cvd  is not None: past_covariates["cvd"]     = torch.from_numpy(cvd)

        if past_covariates:
            model_input = [{"target": torch.from_numpy(ctx), "past_covariates": past_covariates}]
        else:
            model_input = [torch.from_numpy(ctx)]

        # ── 3. Inference (deterministic quantile regression) ───────────────
        with torch.no_grad():
            predictions = pipeline.predict(model_input, prediction_length=horizon)

        # Output: list[Tensor], one per input item.
        # Each tensor shape: (n_variates, n_quantiles, horizon) = (1, 9, horizon).
        step_q = predictions[0].cpu().float().numpy()[0]  # (21, horizon)

        last_price = float(close_series[-1])
        final_q    = step_q[:, -1]             # 9 quantile values at the final horizon step

        # ── 4. Scalar features ──────────────────────────────────────────────

        p10 = float(final_q[_Q10])   # quantile 0.1
        p50 = float(final_q[_Q50])   # quantile 0.5
        p90 = float(final_q[_Q90])   # quantile 0.9

        # P(price_horizon > current_price)
        dir_prob = float(np.clip(1.0 - _cdf(last_price, final_q), 0.0, 1.0))

        # P(|return| > 3%)
        p_above  = 1.0 - _cdf(last_price * 1.03, final_q)
        p_below  =       _cdf(last_price * 0.97, final_q)
        vol_prob = float(np.clip(p_above + p_below, 0.0, 1.0))

        # Normalised spread (p90 - p10) / price
        uncertainty = float((p90 - p10) / (last_price + 1e-9))

        # Continuation probability: directional coherence of the 21 quantile bands.
        # For each band, compute the net displacement (final step − first step).
        # Bands that are strictly up or strictly down count toward the dominant direction.
        # Flat bands (net == 0) count against coherence — they signal indecision.
        # A widening fan (lower bands go down, upper go up) gives a low score.
        # Formula: n_dominant / 21, where n_dominant = max(bands going up, bands going down).
        # This was redesigned from a monotonicity check (always 100% for horizon=3)
        # to a net-direction agreement check that varies meaningfully with market structure.
        if horizon > 1:
            band_net = step_q[:, -1] - step_q[:, 0]
            n_up     = int(np.sum(band_net > 0))
            n_down   = int(np.sum(band_net < 0))
            # Net directional imbalance: opposing bands cancel each other out.
            # A widening fan (equal up + down) gives 0%; all bands one-way gives 100%.
            cont_prob = float(abs(n_up - n_down) / len(_Q_LEVELS))
        else:
            cont_prob = 0.0

        p50_vs_atr = float((p50 - last_price) / atr) if atr and atr > 0 else 0.0

        # ── 5. Fan chart data (direct from quantiles — no sampling noise) ──
        # q=0.1 → p10, q=0.2 → p25 proxy, q=0.5 → p50, q=0.8 → p75 proxy, q=0.9 → p90
        fan = {
            "p10": [float(step_q[_Q10, i]) for i in range(horizon)],
            "p25": [float(step_q[_Q25, i]) for i in range(horizon)],
            "p50": [float(step_q[_Q50, i]) for i in range(horizon)],
            "p75": [float(step_q[_Q75, i]) for i in range(horizon)],
            "p90": [float(step_q[_Q90, i]) for i in range(horizon)],
        }

        latency_ms = (time.perf_counter() - t0) * 1000
        cov_used   = list(past_covariates.keys())
        log.debug(
            f"Chronos-2 | {latency_ms:.0f}ms | dir={dir_prob:.3f} | "
            f"p50={p50:.1f} | cov={cov_used or 'none'}"
        )

        return {
            "c2_dir_prob":    dir_prob,
            "c2_vol_prob":    vol_prob,
            "c2_p10":         p10,
            "c2_p50":         p50,
            "c2_p90":         p90,
            "c2_uncertainty": uncertainty,
            "c2_cont_prob":   cont_prob,
            "c2_p50_vs_atr":  p50_vs_atr,
            "fan":            fan,
            "latency_ms":     round(latency_ms, 1),
            "cov_used":       cov_used,
        }
