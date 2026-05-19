"""
IsotonicCalibrator — corregge c2_dir_prob di Chronos-2 basandosi
sugli esiti reali dei trade storici.

Addestrato su:
  X = c2_dir_prob al momento dell'inferenza (colonna top-level in inference_logs)
  y = 1 se il trade corrispondente è stato profittevole (pnl_usd > 0), 0 altrimenti

Usa sklearn.isotonic.IsotonicRegression con vincolo monotono:
se Chronos è più sicuro, la correzione non inverte mai la direzione.
"""

import logging
import pickle
from pathlib import Path
from typing import Optional

import numpy as np
from sklearn.isotonic import IsotonicRegression

log = logging.getLogger(__name__)

MIN_SAMPLES = 50  # sotto questo numero non si fitta


class IsotonicCalibrator:

    def __init__(self):
        self._model: Optional[IsotonicRegression] = None
        self._n_samples: int = 0

    # ── Fit ──────────────────────────────────────────────────────────────────────

    async def fit(self, db) -> int:
        """
        Legge da Supabase il join inference_logs + trades tramite trades.inference_id,
        costruisce (X, y) e fitta IsotonicRegression.
        Ritorna il numero di campioni usati.
        """
        try:
            # Fetch all inference_logs with a c2_dir_prob recorded
            il_res = (
                db.table("inference_logs")
                .select("id, c2_dir_prob")
                .not_.is_("c2_dir_prob", "null")
                .execute()
            )
            logs = {row["id"]: float(row["c2_dir_prob"]) for row in (il_res.data or [])}
            if not logs:
                log.warning("Calibrator: no inference_logs with c2_dir_prob found")
                return 0

            # Fetch all closed trades with a linked inference_id
            tr_res = (
                db.table("trades")
                .select("inference_id, pnl_usd")
                .not_.is_("inference_id", "null")
                .not_.is_("pnl_usd", "null")
                .execute()
            )

            X, y = [], []
            for trade in (tr_res.data or []):
                inf_id = trade.get("inference_id")
                if inf_id not in logs:
                    continue
                prob    = logs[inf_id]
                outcome = 1 if float(trade.get("pnl_usd") or 0) > 0 else 0
                X.append(prob)
                y.append(outcome)

            if len(X) < MIN_SAMPLES:
                log.warning(
                    "Calibrator: only %d matched samples (need %d) — skipping fit",
                    len(X), MIN_SAMPLES,
                )
                return len(X)

            self._model = IsotonicRegression(out_of_bounds="clip")
            self._model.fit(np.array(X, dtype=np.float64), np.array(y, dtype=np.float64))
            self._n_samples = len(X)
            log.info("IsotonicCalibrator fitted on %d samples", self._n_samples)
            return self._n_samples

        except Exception as exc:
            log.warning("Calibrator fit failed: %s", exc)
            return 0

    # ── Transform ─────────────────────────────────────────────────────────────────

    def transform(self, prob: float) -> float:
        """Applica la correzione isotonica a una singola probabilità."""
        if self._model is None:
            return prob
        return float(self._model.predict(np.array([[prob]], dtype=np.float64).ravel())[0])

    def is_fitted(self) -> bool:
        return self._model is not None

    # ── Persist ───────────────────────────────────────────────────────────────────

    def save(self, path: "Path | str"):
        with open(path, "wb") as f:
            pickle.dump({"model": self._model, "n_samples": self._n_samples}, f)
        log.info("Calibrator saved to %s (%d samples)", path, self._n_samples)

    @classmethod
    def load(cls, path: "Path | str") -> "IsotonicCalibrator":
        obj = cls()
        with open(path, "rb") as f:
            data = pickle.load(f)
        obj._model     = data["model"]
        obj._n_samples = data.get("n_samples", 0)
        log.info("Calibrator loaded from %s (%d samples)", path, obj._n_samples)
        return obj

    # ── Stats ──────────────────────────────────────────────────────────────────────

    def calibration_stats(self) -> dict:
        """Ritorna statistiche di calibrazione per debug/UI."""
        if not self.is_fitted():
            return {"fitted": False, "n_samples": 0}
        # Tabulate how much the calibration moves probabilities at key anchors
        anchors = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
        mapping = {
            f"raw_{int(a * 100)}": round(self.transform(a), 4)
            for a in anchors
        }
        return {
            "fitted":    True,
            "n_samples": self._n_samples,
            "mapping":   mapping,
        }
