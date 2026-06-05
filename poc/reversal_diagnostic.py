"""
Reversal diagnostic — measures empirically why the ReversalZoneDetector almost
never fires on the available BTC 4H history.

For every bar it computes bear/bull totals + per-component scores (mirroring the
backtest loop, including a RegimeDetector update every 4 bars), then reports:
  - distribution of the max(bear,bull) reversal score
  - per-component activation rate (% bars where component > component_min_score)
  - how many bars pass score_threshold, component_count, and the combined gate
  - which single condition is the binding constraint
"""

import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "apps", "api"))

from services.smc import build_all_features
from services.reversal_detector import ReversalZoneDetector
from services.regime_detector import RegimeDetector


class Cfg:
    """Mirror the BotConfig reversal defaults (apps/api/main.py)."""
    reversal_score_threshold     = 0.34
    reversal_min_components      = 3
    reversal_component_min_score = 0.40
    reversal_ob_dist_max         = 2.0
    reversal_consec_bars_min     = 5
    reversal_adx_peak_min        = 35.0
    reversal_ema50_dist_extreme  = 3.0
    reversal_ret48_extreme       = 0.08
    reversal_transition_risk_min = 0.55
    reversal_bars_in_regime_min  = 40
    reversal_funding_extreme_thr = 0.000028
    reversal_absorption_z        = 1.8
    reversal_wick_threshold      = 0.50
    reversal_vol_climax_z        = 2.0
    reversal_daily_rsi_extreme_high = 75.0
    reversal_daily_rsi_extreme_low  = 25.0
    reversal_daily_ema_dist_extreme = 4.0
    reversal_iv_exhaustion_high  = 80.0


def main():
    import sys as _sys
    pdir = os.path.dirname(os.path.abspath(__file__))
    dataset = _sys.argv[1] if len(_sys.argv) > 1 else "hl2y"

    if dataset == "btc3y":
        ohlcv = pd.read_parquet(os.path.join(pdir, "btc3y_ohlcv.parquet"))
        fund  = pd.read_parquet(os.path.join(pdir, "btc3y_funding.parquet"))
        # No OI/liq for the 3y Binance pull — zero-fill (detector is price-based).
        oi  = pd.DataFrame({"oi": 0.0}, index=ohlcv.index)
        liq = pd.DataFrame({"liq_long": 0.0, "liq_short": 0.0}, index=ohlcv.index)
    else:
        ohlcv = pd.read_parquet(os.path.join(pdir, "data_ohlcv.parquet"))
        fund  = pd.read_parquet(os.path.join(pdir, "data_funding.parquet"))
        oi    = pd.read_parquet(os.path.join(pdir, "data_oi.parquet"))
        liq   = pd.read_parquet(os.path.join(pdir, "data_liq.parquet"))

    print(f"Dataset: {dataset}  Bars: {len(ohlcv)}  range: {ohlcv.index.min()} -> {ohlcv.index.max()}")

    df = build_all_features(ohlcv, fund, oi, liq, reversal_mode_enabled=True)

    cfg = Cfg()
    det = ReversalZoneDetector()
    regime = RegimeDetector()

    weights = ReversalZoneDetector.WEIGHTS
    comps = list(weights.keys())

    rows = []
    comp_rows = {c: [] for c in comps}
    regime_sig = None
    n = len(df)
    for i in range(n):
        if i % 4 == 0 and i >= 120:
            try:
                regime_sig = regime.detect(df.iloc[: i + 1])
            except Exception:
                pass
        if i < 64:
            continue
        res = det.score(df.iloc[: i + 1], regime_sig, cfg)
        rows.append({
            "score": res.score,
            "direction": res.direction,
            "active": res.component_count,
        })
        for c in comps:
            comp_rows[c].append(res.components.get(c, 0.0))

    R = pd.DataFrame(rows)
    total = len(R)
    print(f"\nEvaluated bars: {total}")

    print("\n=== Max reversal score distribution ===")
    for q in [50, 75, 90, 95, 99, 100]:
        print(f"  P{q:<3}: {np.percentile(R['score'], q):.4f}")
    print(f"  mean: {R['score'].mean():.4f}")

    thr = cfg.reversal_score_threshold
    minc = cfg.reversal_min_components
    pass_score = R["score"] >= thr
    has_dir    = R["direction"].notna()
    pass_comp  = R["active"] >= minc
    full_gate  = pass_score & has_dir & pass_comp

    print(f"\n=== Gate funnel (thr={thr}, min_components={minc}, comp_min={cfg.reversal_component_min_score}) ===")
    print(f"  score >= {thr:<4}          : {pass_score.sum():5d}  ({100*pass_score.mean():.2f}%)")
    print(f"  direction != None        : {has_dir.sum():5d}  ({100*has_dir.mean():.2f}%)")
    print(f"  active_components >= {minc}    : {pass_comp.sum():5d}  ({100*pass_comp.mean():.2f}%)")
    print(f"  ALL combined (fires)     : {full_gate.sum():5d}  ({100*full_gate.mean():.2f}%)")

    print("\n=== Per-component stats (over all evaluated bars) ===")
    cm = cfg.reversal_component_min_score
    print(f"{'component':<12}{'weight':>8}{'mean':>9}{'P90':>9}{'P99':>9}{'%>'+str(cm):>9}")
    for c in comps:
        v = np.array(comp_rows[c])
        print(f"{c:<12}{weights[c]:>8.2f}{v.mean():>9.3f}{np.percentile(v,90):>9.3f}"
              f"{np.percentile(v,99):>9.3f}{100*(v>cm).mean():>8.2f}%")

    print("\n=== active_components histogram ===")
    vc = R["active"].value_counts().sort_index()
    for k, cnt in vc.items():
        print(f"  {k} active: {cnt:5d}  ({100*cnt/total:.2f}%)")

    print("\n=== Sensitivity: fires count vs (score_threshold, min_components) [comp_min=0.40] ===")
    print(f"{'thr':>6} | " + " ".join(f"mc{m:>2}" for m in [2,3,4,5]))
    for t in [0.30, 0.34, 0.38, 0.42, 0.46, 0.50]:
        ps = R["score"] >= t
        cells = []
        for m in [2, 3, 4, 5]:
            fires = (ps & has_dir & (R["active"] >= m)).sum()
            cells.append(f"{fires:>4}")
        print(f"{t:>6.2f} | " + " ".join(cells))

    # Recompute active_count under different comp_min cutoffs (needs raw comp values)
    comp_mat = {c: np.array(comp_rows[c]) for c in comps}
    score_arr = R["score"].values
    dir_arr   = has_dir.values

    print("\n=== Sensitivity: fire RATE vs (comp_min, min_components) [score_thr=0.38] ===")
    print("    (1 fire per ~N bars; 4H bars -> N*4 hours between setups)")
    print(f"{'comp_min':>9} | " + " ".join(f"mc{m:>2}" for m in [2,3,4]))
    for cmv in [0.25, 0.30, 0.33, 0.40]:
        active_cm = np.sum([(comp_mat[c] > cmv).astype(int) for c in comps], axis=0)
        ps = score_arr >= 0.38
        cells = []
        for m in [2, 3, 4]:
            fires = int((ps & dir_arr & (active_cm >= m)).sum())
            rate = 100 * fires / total
            cells.append(f"{fires:>4}({rate:.1f}%)")
        print(f"{cmv:>9.2f} | " + " ".join(cells))

    # NOTE: the detector nulls `direction` when score < internal threshold (0.38),
    # so dir_arr above is already gated at 0.38. For an honest threshold sweep we
    # assign direction purely from score >= t (which is what lowering the cfg does).
    print("\n=== HONEST sweep: fires & rate vs (score_thr, comp_min, min_comp) ===")
    print("    direction assigned whenever score >= thr (mirrors lowering cfg threshold)")
    for t in [0.26, 0.28, 0.30, 0.32, 0.34, 0.38]:
        ps = score_arr >= t
        line = [f"thr={t:.2f} score_pass={ps.sum():4d}({100*ps.mean():.1f}%)"]
        for cmv in [0.30, 0.40]:
            active_cm = np.sum([(comp_mat[c] > cmv).astype(int) for c in comps], axis=0)
            for m in [2, 3]:
                fires = int((ps & (active_cm >= m)).sum())
                line.append(f"cm{cmv:.2f}/mc{m}={fires:3d}({100*fires/total:.1f}%)")
        print("  " + "  ".join(line))


if __name__ == "__main__":
    main()
