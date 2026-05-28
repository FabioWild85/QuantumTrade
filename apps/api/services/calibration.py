"""
IsotonicCalibrator — corregge c2_dir_prob di Chronos-2 basandosi
sulla direzione effettiva del mercato sui trade storici.

Addestrato su:
  X = c2_dir_prob al momento dell'inferenza (colonna top-level in inference_logs)
  y = 1 se il prezzo è salito (exit_price > entry_price), 0 altrimenti

c2_dir_prob è P(price_horizon > current_price) — sempre P(bullish).
Il target y deve riflettere la stessa cosa: il mercato è effettivamente salito?
Usare pnl_usd > 0 è sbagliato perché per i trade SHORT profittevoli il mercato
è sceso (y dovrebbe essere 0), non salito.

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

            # Fetch all closed trades with a linked inference_id.
            # We use entry_price / exit_price to derive actual market direction:
            # exit > entry → market went UP → y=1 (matches c2_dir_prob = P(bullish))
            # exit < entry → market went DOWN → y=0
            # This is correct for both long and short trades; pnl_usd > 0 was wrong
            # for shorts (profitable short = market fell = y should be 0, not 1).
            tr_res = (
                db.table("trades")
                .select("inference_id, entry_price, exit_price")
                .not_.is_("inference_id", "null")
                .not_.is_("entry_price", "null")
                .not_.is_("exit_price", "null")
                .execute()
            )

            X, y = [], []
            for trade in (tr_res.data or []):
                inf_id   = trade.get("inference_id")
                if inf_id not in logs:
                    continue
                entry_px = float(trade.get("entry_price") or 0)
                exit_px  = float(trade.get("exit_price")  or 0)
                if entry_px <= 0 or exit_px <= 0:
                    continue
                prob = logs[inf_id]
                X.append(prob)
                y.append(1 if exit_px > entry_px else 0)

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
