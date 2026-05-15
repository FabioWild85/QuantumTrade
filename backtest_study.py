"""
Systematic backtest study — BTC Apr 14 → May 14, 2026
Runs ~21 config combinations, prints ranked results.
"""
import json
import time
import requests
from datetime import datetime

API = "http://localhost:8000"
FROM_DATE = "2026-04-14"
TO_DATE   = "2026-05-14"
CAPITAL   = 10_000.0

# ── Baseline config (all params explicit so every run is comparable) ─────────
BASELINE = {
    "sl_atr_mult":               2.0,
    "tp_atr_mult":               3.5,
    "position_size_pct":         1.5,
    "directional_threshold":     0.62,
    "adx_gate":                  20.0,
    "confluence_gate":           60.0,
    "max_consecutive_losses":    4,
    # exit features — all off in baseline
    "partial_tp_enabled":        False,
    "partial_tp_atr_mult":       1.5,
    "partial_tp_pct":            50.0,
    "trailing_sl_enabled":       False,
    "trailing_sl_activation":    1.0,
    "lgbm_exit_enabled":         False,
    "lgbm_exit_threshold":       0.30,
    "lgbm_exit_min_hold_bars":   6,
    "lgbm_exit_confirm_bars":    2,
    "be_sl_enabled":             False,
    "be_sl_activation":          1.0,
    "max_hold_bars_enabled":     False,
    "max_hold_bars":             48,
    # signal filters
    "adx_gate_enabled":          True,
    "sweep_gate_enabled":        True,
    "fvg_filter_enabled":        True,
    "mtf_alignment_enabled":     True,
    # Chronos gates — always off in non-chronos runs
    "c2_uncertainty_gate_enabled": False,
    "c2_uncertainty_threshold":    0.05,
    "c2_cont_prob_gate_enabled":   False,
    "c2_cont_prob_threshold":      0.25,
    # Chronos — off by default
    "chronos_enabled":           False,
    "chronos_weight":            0.40,
    "dynamic_sl_tp_enabled":     False,
    "dynamic_sl_tp_blend":       0.50,
}

def cfg(**overrides):
    c = dict(BASELINE)
    c.update(overrides)
    return c

# ── Test matrix ──────────────────────────────────────────────────────────────
TESTS = [
    # ── GROUP A: SL/TP ratio (RR) ─────────────────────────────────────────
    ("A0-baseline",         False, cfg()),
    ("A1-tight_rr_2.0",     False, cfg(sl_atr_mult=1.5, tp_atr_mult=3.0)),   # RR 2.0
    ("A2-wide_tp_rr_2.5",   False, cfg(sl_atr_mult=2.0, tp_atr_mult=5.0)),   # RR 2.5
    ("A3-tight_sl_high_tp", False, cfg(sl_atr_mult=1.5, tp_atr_mult=4.5)),   # RR 3.0
    ("A4-wider_sl",         False, cfg(sl_atr_mult=2.5, tp_atr_mult=4.0)),   # RR 1.6
    ("A5-very_wide_tp",     False, cfg(sl_atr_mult=2.0, tp_atr_mult=6.0)),   # RR 3.0

    # ── GROUP B: Entry quality (threshold + confluence) ───────────────────
    ("B1-permissive",       False, cfg(directional_threshold=0.57, confluence_gate=45)),
    ("B2-slightly_loose",   False, cfg(directional_threshold=0.59, confluence_gate=50)),
    ("B3-default",          False, cfg(directional_threshold=0.62, confluence_gate=60)),
    ("B4-moderate",         False, cfg(directional_threshold=0.65, confluence_gate=65)),
    ("B5-strict",           False, cfg(directional_threshold=0.68, confluence_gate=70)),

    # ── GROUP C: ADX gate ─────────────────────────────────────────────────
    ("C1-adx15",            False, cfg(adx_gate=15.0)),
    ("C2-adx20_default",    False, cfg(adx_gate=20.0)),
    ("C3-adx25",            False, cfg(adx_gate=25.0)),
    ("C4-adx_disabled",     False, cfg(adx_gate_enabled=False)),

    # ── GROUP D: Advanced exits ───────────────────────────────────────────
    ("D1-partial_tp",       False, cfg(partial_tp_enabled=True, partial_tp_atr_mult=1.5, partial_tp_pct=50.0)),
    ("D2-trailing_sl",      False, cfg(trailing_sl_enabled=True, trailing_sl_activation=1.0)),
    ("D3-partial_trailing", False, cfg(partial_tp_enabled=True, partial_tp_atr_mult=1.5, partial_tp_pct=50.0,
                                       trailing_sl_enabled=True, trailing_sl_activation=1.0)),
    ("D4-be_sl",            False, cfg(be_sl_enabled=True, be_sl_activation=1.0)),
    ("D5-lgbm_exit",        False, cfg(lgbm_exit_enabled=True, lgbm_exit_threshold=0.30,
                                       lgbm_exit_min_hold_bars=6, lgbm_exit_confirm_bars=2)),
    ("D6-max_hold_48",      False, cfg(max_hold_bars_enabled=True, max_hold_bars=48)),

    # ── GROUP E: Best combos (baseline-derived) ───────────────────────────
    # Combine B2 entry filter + A3 RR + D2 trailing (hypothesis: quality entries + wide TP + trailing)
    ("E1-quality_wide_trailing", False, cfg(
        directional_threshold=0.59, confluence_gate=50,
        sl_atr_mult=1.5, tp_atr_mult=4.5,
        trailing_sl_enabled=True, trailing_sl_activation=1.0,
    )),
    # B1 permissive + D1 partial TP (more trades + protect gains)
    ("E2-permissive_partial", False, cfg(
        directional_threshold=0.57, confluence_gate=45,
        partial_tp_enabled=True, partial_tp_atr_mult=1.5, partial_tp_pct=50.0,
    )),
    # B2 + wide TP + lgbm exit (quality + run winners + cut losers early)
    ("E3-quality_widetp_lgbm", False, cfg(
        directional_threshold=0.59, confluence_gate=50,
        sl_atr_mult=1.5, tp_atr_mult=5.0,
        lgbm_exit_enabled=True, lgbm_exit_threshold=0.30,
        lgbm_exit_min_hold_bars=4, lgbm_exit_confirm_bars=2,
    )),
    # Tight SL + high TP + partial (protect downside, let winners run partially)
    ("E4-best_rr_partial_be", False, cfg(
        sl_atr_mult=1.5, tp_atr_mult=4.5,
        partial_tp_enabled=True, partial_tp_atr_mult=1.5, partial_tp_pct=40.0,
        be_sl_enabled=True, be_sl_activation=1.0,
    )),

    # ── GROUP F: Chronos enabled (slow, ~9min each) ───────────────────────
    ("F1-chronos_default",  True,  cfg(chronos_enabled=True, chronos_weight=0.40)),
    ("F2-chronos_light",    True,  cfg(chronos_enabled=True, chronos_weight=0.20)),
    ("F3-chronos_cont_gate",True,  cfg(chronos_enabled=True, chronos_weight=0.40,
                                       c2_cont_prob_gate_enabled=True, c2_cont_prob_threshold=0.25)),
]


def run_backtest(name, use_chronos, config):
    payload = {
        "symbol": "BTC",
        "from_date": FROM_DATE,
        "to_date":   TO_DATE,
        "initial_capital": CAPITAL,
        "use_chronos": use_chronos,
        "config": config,
    }
    r = requests.post(f"{API}/backtest", json=payload, timeout=30)
    r.raise_for_status()
    job_id = r.json()["job_id"]

    # Poll until done
    start = time.time()
    while True:
        time.sleep(3)
        r = requests.get(f"{API}/backtest/{job_id}", timeout=10)
        data = r.json()
        if data["status"] == "done":
            elapsed = time.time() - start
            return data["result"], elapsed
        if time.time() - start > 900:   # 15-min hard timeout
            return {"error": "timeout"}, 900


def fmt_result(name, result, elapsed):
    if "error" in result:
        return f"  {'ERROR':>8}  {name}  → {result['error']}"
    s = result.get("stats", {})
    trades      = s.get("total_trades", 0)
    win_rate    = s.get("win_rate", 0.0)
    pnl_pct     = s.get("total_pnl_pct", 0.0)
    pf          = s.get("profit_factor", 0.0)
    sharpe      = s.get("sharpe", 0.0)
    max_dd      = s.get("max_drawdown_pct", 0.0)
    avg_hold    = s.get("avg_holding_h", 0.0)
    pf_str = f"{pf:.2f}" if pf < 90 else "∞"
    return (f"  trades={trades:>3}  wr={win_rate:>5.1f}%  pnl={pnl_pct:>+6.2f}%  "
            f"pf={pf_str:>5}  sharpe={sharpe:>5.2f}  dd={max_dd:>5.2f}%  "
            f"hold={avg_hold:>5.1f}h  [{elapsed:.0f}s]  {name}")


def score(result):
    """Composite score for ranking: Sharpe × PF × (1 - DD/100), floor 0."""
    if "error" in result or not result.get("stats"):
        return -999
    s = result["stats"]
    trades = s.get("total_trades", 0)
    if trades < 3:          # too few trades — statistically meaningless
        return -998
    sharpe = s.get("sharpe", 0.0)
    pf     = s.get("profit_factor", 0.0)
    if pf >= 90: pf = 5.0   # cap ∞ PF so it doesn't dominate
    dd     = s.get("max_drawdown_pct", 0.0)
    pnl    = s.get("total_pnl_pct", 0.0)
    wr     = s.get("win_rate", 0.0)
    # score = pnl_pct × win_rate × profit_factor, penalised by drawdown
    return (pnl * (wr / 100) * min(pf, 5.0)) / max(dd, 0.5)


# ── Run ──────────────────────────────────────────────────────────────────────
print(f"\n{'='*90}")
print(f"  QUANTUM TRADE — BACKTEST STUDY   BTC  {FROM_DATE} → {TO_DATE}")
print(f"  Capital: ${CAPITAL:,.0f}    {len(TESTS)} configurations")
print(f"{'='*90}\n")

all_results = []
non_chronos = [(n, c, cfg) for (n, c, cfg) in TESTS if not c]
chronos     = [(n, c, cfg) for (n, c, cfg) in TESTS if c]

print(f"► Phase 1: {len(non_chronos)} non-Chronos configs (fast)\n")
for name, use_chronos, config in non_chronos:
    print(f"  Running {name}...", end=" ", flush=True)
    result, elapsed = run_backtest(name, use_chronos, config)
    line = fmt_result(name, result, elapsed)
    print(line)
    all_results.append((name, use_chronos, config, result, elapsed))

print(f"\n► Phase 2: {len(chronos)} Chronos configs (slow ~9min each)\n")
for name, use_chronos, config in chronos:
    print(f"  Running {name}...", end=" ", flush=True)
    result, elapsed = run_backtest(name, use_chronos, config)
    line = fmt_result(name, result, elapsed)
    print(line)
    all_results.append((name, use_chronos, config, result, elapsed))

# ── Rankings ─────────────────────────────────────────────────────────────────
print(f"\n{'='*90}")
print("  RANKING (min 3 trades, scored: pnl × win_rate × profit_factor / drawdown)")
print(f"{'='*90}\n")

ranked = sorted(all_results, key=lambda x: score(x[3]), reverse=True)
for rank, (name, use_chronos, config, result, elapsed) in enumerate(ranked, 1):
    sc = score(result)
    tag = "[CHRONOS]" if use_chronos else ""
    if "error" in result or not result.get("stats"):
        print(f"  #{rank:>2}  score=  N/A  {tag} {name}")
        continue
    s = result["stats"]
    trades = s.get("total_trades", 0)
    win_rate = s.get("win_rate", 0.0)
    pnl_pct = s.get("total_pnl_pct", 0.0)
    pf = s.get("profit_factor", 0.0)
    pf_str = f"{pf:.2f}" if pf < 90 else "∞"
    sharpe = s.get("sharpe", 0.0)
    max_dd = s.get("max_drawdown_pct", 0.0)
    print(f"  #{rank:>2}  score={sc:>7.3f}  trades={trades:>3}  wr={win_rate:>5.1f}%  "
          f"pnl={pnl_pct:>+6.2f}%  pf={pf_str:>5}  sharpe={sharpe:>5.2f}  "
          f"dd={max_dd:>5.2f}%  {tag} {name}")

# ── Save raw results ──────────────────────────────────────────────────────────
out_path = f"/Users/fabiowild/Desktop/Quantum Trade/backtest_results_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
save_data = [{"name": n, "chronos": c, "result": r} for (n, c, _, r, _) in all_results]
with open(out_path, "w") as f:
    json.dump(save_data, f, indent=2)
print(f"\n  Raw results saved → {out_path}")
print(f"\n{'='*90}\n")
