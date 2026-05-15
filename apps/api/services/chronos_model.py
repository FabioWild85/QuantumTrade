"""
Chronos-2 wrapper service.
Produces 8 probabilistic features from a price series.
Singleton — loads the model once on first call (800MB, ~10s on CPU).
"""

import logging
import time
from typing import Optional

import numpy as np
import torch

log = logging.getLogger(__name__)

_pipeline = None
_device: Optional[str] = None


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

    from chronos import BaseChronosPipeline

    _device = _get_device()
    log.info(f"Loading Chronos-2 Base on {_device}…")
    t0 = time.perf_counter()

    _pipeline = BaseChronosPipeline.from_pretrained(
        "amazon/chronos-t5-base",
        device_map=_device,
        dtype=torch.bfloat16,
    )
    log.info(f"Chronos-2 loaded in {time.perf_counter() - t0:.1f}s")
    return _pipeline


class ChronosForecaster:
    """
    Wraps Chronos-2 Base and returns the 8 probabilistic features
    used by LightGBM in the stacked ensemble.
    """

    N_SAMPLES    = 200
    CONTEXT_LEN  = 512
    MODEL_ID     = "amazon/chronos-t5-base"

    def forecast(
        self,
        close_series: np.ndarray,
        horizon: int = 3,
        atr: Optional[float] = None,
    ) -> dict:
        """
        Args:
            close_series: 1D array of close prices (most recent last).
            horizon:      forecast steps (3 = 12h on 4h tf).
            atr:          current ATR(14) for p50_vs_atr feature.

        Returns dict with keys:
            c2_dir_prob, c2_vol_prob, c2_p10, c2_p50, c2_p90,
            c2_uncertainty, c2_cont_prob, c2_p50_vs_atr,
            latency_ms
        """
        pipeline = _load_pipeline()
        t0 = time.perf_counter()

        ctx = close_series[-self.CONTEXT_LEN:]
        tensor = torch.tensor(ctx, dtype=torch.float32).unsqueeze(0)

        with torch.no_grad():
            samples = pipeline.predict(tensor, prediction_length=horizon, num_samples=self.N_SAMPLES)

        samples_np = samples[0].cpu().numpy()  # shape: (N_SAMPLES, horizon)
        last_price  = float(close_series[-1])
        final_step  = samples_np[:, -1]        # distribution at horizon end

        p10  = float(np.percentile(final_step, 10))
        p25  = float(np.percentile(final_step, 25))
        p50  = float(np.percentile(final_step, 50))
        p75  = float(np.percentile(final_step, 75))
        p90  = float(np.percentile(final_step, 90))

        dir_prob  = float(np.mean(final_step > last_price))
        vol_prob  = float(np.mean(np.abs(final_step - last_price) / last_price > 0.030))

        # Continuation: fraction of individual Monte Carlo paths that are directionally
        # coherent (all steps up OR all steps down).
        # Median-path approach fails because Chronos quantizes output into ~4096 discrete
        # bins — the median snaps to the same bin at every step, giving diffs=[0,0,…].
        # Per-sample analysis is immune to this because individual samples span different bins.
        if horizon > 1:
            sample_diffs = np.diff(samples_np, axis=1)          # (N_SAMPLES, horizon-1)
            all_up   = (sample_diffs > 0).all(axis=1)           # each sample monotonically rising
            all_down = (sample_diffs < 0).all(axis=1)           # each sample monotonically falling
            cont_prob = float((all_up | all_down).mean())
        else:
            cont_prob = 0.0

        uncertainty = float((p90 - p10) / (last_price + 1e-9))

        p50_vs_atr = float((p50 - last_price) / atr) if atr and atr > 0 else 0.0

        # Per-step fan data (for UI fan chart visualization).
        # p50 uses mean instead of median: Chronos quantizes output into ~4096 discrete bins,
        # so the median snaps to the same bin at every step → flat line on the chart.
        # The mean interpolates continuously between bins and gives a meaningful trend path.
        fan = {
            "p10": [float(np.percentile(samples_np[:, i], 10)) for i in range(horizon)],
            "p25": [float(np.percentile(samples_np[:, i], 25)) for i in range(horizon)],
            "p50": [float(np.mean(samples_np[:, i]))            for i in range(horizon)],
            "p75": [float(np.percentile(samples_np[:, i], 75)) for i in range(horizon)],
            "p90": [float(np.percentile(samples_np[:, i], 90)) for i in range(horizon)],
        }

        latency_ms = (time.perf_counter() - t0) * 1000
        log.debug(f"Chronos-2 inference: {latency_ms:.0f}ms | dir_prob={dir_prob:.3f} | p50={p50:.1f}")

        return {
            "c2_dir_prob":    dir_prob,
            "c2_vol_prob":    vol_prob,
            "c2_p10":         p10,
            "c2_p50":         p50,
            "c2_p90":         p90,
            "c2_uncertainty": uncertainty,
            "c2_cont_prob":   cont_prob,
            "c2_p50_vs_atr":  p50_vs_atr,
            "fan":            fan,       # per-step quantile bands for UI
            "latency_ms":     round(latency_ms, 1),
        }

    def forecast_fan(self, close_series: np.ndarray, horizon: int = 3) -> dict:
        """Returns full distribution for fan-chart rendering in the UI."""
        pipeline = _load_pipeline()
        ctx = close_series[-self.CONTEXT_LEN:]
        tensor = torch.tensor(ctx, dtype=torch.float32).unsqueeze(0)

        with torch.no_grad():
            samples = pipeline.predict(tensor, prediction_length=horizon, num_samples=self.N_SAMPLES)

        samples_np = samples[0].cpu().numpy()
        return {
            "p10": [float(np.percentile(samples_np[:, i], 10)) for i in range(horizon)],
            "p25": [float(np.percentile(samples_np[:, i], 25)) for i in range(horizon)],
            "p50": [float(np.percentile(samples_np[:, i], 50)) for i in range(horizon)],
            "p75": [float(np.percentile(samples_np[:, i], 75)) for i in range(horizon)],
            "p90": [float(np.percentile(samples_np[:, i], 90)) for i in range(horizon)],
        }
