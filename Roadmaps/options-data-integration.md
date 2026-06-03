# Options Data Integration — Strategic Roadmap

## Overview

This document defines the integration of **options market data** into the Quantum Trade bot as a new feature group and decision-modulation layer. Options data is a high-value missing data source for this system: it provides **volatility regime awareness** that improves position sizing, and it reveals **institutional sentiment** through skew and flow data that complements the existing feature set.

> **Important caveat**: Options data is not purely "forward-looking" in the way that might be implied. Much of it is coincident (reflecting current market consensus and hedging activity, not future price). The genuine value comes from (1) IV as a superior volatility proxy over ATR, and (2) skew/flow signals as institutional sentiment indicators. Claims of dramatic predictive power should be validated with historical backtesting before going live — see Section 4.5 for why this is the critical prerequisite.

This document is written to be sufficient for another AI or developer to understand the rationale, the data sources, the integration architecture, and the cross-asset applicability without needing to reverse-engineer the existing codebase.

---

## 1. Why Options Data Adds Value

### 1.1 The Current System's Blind Spot

The bot currently ingests these data categories (see `apps/api/services/smc.py` → `FEATURE_GROUPS`):

| Group | Nature | Look Direction |
|---|---|---|
| `base` | Technical indicators (RSI, ADX, ATR, MACD, returns, vol) | Backward |
| `cvd` | Cumulative Volume Delta, absorption | Coincident |
| `ob` | Order Blocks (SMC) | Backward |
| `mtf` | Multi-timeframe (daily regime, alignment) | Backward |
| `smc` | FVG, liquidity sweeps | Backward |
| `funding` | Funding rates, premium | Coincident |
| `oi` | Open Interest | Coincident |
| `liq` | Liquidations | Backward |
| `c2` | Chronos-2 probabilistic forecasts | Forward (3-bar, price/volume/OI based) |

Every group is backward-looking or coincident. Chronos-2 provides a 3-bar statistical forecast based on historical price/volume/OI patterns — it cannot see volatility expectations or options flow.

### 1.2 What Options Data Genuinely Adds

| Options Metric | Nature | Genuine Value |
|---|---|---|
| ATM Implied Volatility (7-day) | Coincident | Superior volatility proxy vs. ATR — enables dynamic position sizing |
| 25-Delta Risk Reversal | Coincident/Leading | Institutional directional sentiment — more sophisticated than Fear & Greed |
| Put/Call Volume Ratio | Coincident | Regime indicator of options flow direction — useful as ML feature, not as a hard block |
| Max Pain Distance | Coincident | Soft gravity filter near weekly/monthly expiry — weak effect on BTC vs SPX |
| Gamma Exposure (GEX) | Coincident | Volatility regime indicator — dealer flow effect is much weaker on BTC than on SPX |

### 1.3 Asset-Specific Limitations (BTC)

For a BTC 4H trend-following system specifically:

- **IV sizing** has the strongest and most replicable evidence. Sizing down in high-IV regimes reduces drawdown even if it reduces total return slightly — the Sharpe improvement is robust.
- **Risk reversal** is moderately useful as a feature for LightGBM. As a hard deterministic rule it is fragile — the signal-to-noise in crypto options skew is higher than in FX or equity skew.
- **PCR** has a known contrarian interpretation problem: extreme put buying (PCR > 1.5) frequently coincides with local price bottoms, not tops, because retail panic-buys puts at fear peaks. Using PCR as a hard directional block risks cutting longs exactly when capitulation recoveries begin.
- **Max Pain** gravity is well-documented for SPX weekly options where dealer books are massive. On Deribit, the spot BTC volume is a large multiple of options volume, so the gravity effect is statistically weaker.
- **GEX** is highly effective for SPX/NDX where dealer structured-product books are comparable in size to the spot market. On BTC, this size ratio is much smaller and the effect is noisier.

---

## 2. Metrics to Extract

### 2.1 ATM Implied Volatility (IV)

**What**: The implied volatility of at-the-money options, typically the strike closest to the current spot price.

**Timeframes to track**:
- `iv_7d`: 7-day expiry ATM IV — short-term volatility expectation
- `iv_30d`: 30-day expiry ATM IV — medium-term volatility expectation

**Usage in the bot**:
- Compute rolling percentile of `iv_7d` over a 90-day lookback.
- When IV > 80th percentile: multiply `position_size_pct` by 0.7, widen SL by 1.3×.
- When IV < 20th percentile: full size, standard SL.
- Add `iv_7d`, `iv_30d`, and `iv_7d_percentile` as raw features to the LightGBM training matrix.

**Evidence strength**: High. This is the most robust and implementable signal in this list. The principle — trade smaller when realized volatility will likely be higher — is supported by both academic literature and practitioner experience across crypto and equities.

### 2.2 25-Delta Risk Reversal (Skew)

**What**: The difference between the implied volatility of a 25-delta put and a 25-delta call.

```
risk_reversal_25d = IV(25-delta put) - IV(25-delta call)
```

- **Positive skew** (puts more expensive than calls): market is paying a premium for downside protection → bearish sentiment.
- **Negative skew** (calls more expensive than puts): market is paying a premium for upside exposure → bullish sentiment.
- **Neutral skew** (near zero): no directional bias from options market.

**Usage in the bot**:

**Recommended approach — LightGBM feature (primary)**: Add `risk_reversal_25d` directly to the feature matrix. The model will learn whether a relationship exists with future returns without imposing a fixed rule. This is the safer approach given that crypto skew is noisier than FX skew.

**Optional approach — soft threshold modulation**: If backtesting confirms signal validity, modulate `directional_threshold` asymmetrically:
- Positive skew > 5 vol points: `threshold_long += 0.02`, `threshold_short -= 0.02`
- Negative skew < -5 vol points: `threshold_long -= 0.02`, `threshold_short += 0.02`

Do NOT implement the deterministic rule before validating it with historical backtesting (Section 4.5).

**Evidence strength**: Moderate for BTC. Strong for FX (where it is the standard institutional sentiment metric). The crypto skew signal has higher noise than equity or FX equivalents.

### 2.3 Put/Call Volume Ratio (PCR)

**What**: Ratio of total put option volume to total call option volume over a rolling window (24h recommended).

```
pcr_volume = sum(put_volume_24h) / sum(call_volume_24h)
```

**Usage in the bot — feature only, no hard block**:

Add `pcr_volume` as a raw feature to the LightGBM training matrix. Do NOT implement PCR as a hard directional block.

**Why no hard block**: The PCR contrarian problem is well-documented. High PCR (> 1.5) frequently signals peak fear and corresponds to local price bottoms in crypto, not tops. Retail traders massively buy puts during panic selloffs — exactly when long entries have the best risk/reward. A hard rule blocking longs at PCR > 1.5 would cut entries during capitulation recoveries, which are among the highest-probability long opportunities.

The correct use of PCR is as a regime context feature that the ML model can combine with other signals — not as a standalone binary block.

**Evidence strength**: Low as a deterministic rule, moderate as an ML feature in the correct regime context.

### 2.4 Max Pain

**What**: The strike price at which the total open interest across all puts and calls (weighted by option value at expiry) is minimized. At expiry, this is where the maximum number of options expire worthless, benefiting option sellers (market makers).

**Usage in the bot**:
- Compute `max_pain_dist_pct = (current_price - max_pain) / current_price`.
- If `|max_pain_dist_pct| > 3%` and expiry is within 48 hours: reduce `position_size_pct` by 0.3× (soft gravity filter, not a directional signal).
- Add `max_pain_dist_pct` as a feature to LightGBM.

**BTC-specific caveat**: The max pain gravity effect is weaker on BTC than on SPX weekly options. On SPX, dealer books are large enough that their hedging activity materially influences the spot market. On BTC, the Deribit options market is a fraction of Binance/Bybit spot+perp volume. The size reduction is a conservative soft filter, not a high-confidence signal. Validate effectiveness with historical data before relying on it.

**Evidence strength**: Low-moderate for BTC. High for SPX weekly options.

### 2.5 Gamma Exposure (GEX)

**What**: The total gamma of all outstanding options, multiplied by the spot price. Positive GEX means dealers are net long gamma (they buy low, sell high → dampening volatility). Negative GEX means dealers are net short gamma (they buy high, sell low → amplifying volatility).

**Key levels**:
- **GEX flip point**: the price level where aggregate GEX switches from positive to negative — a volatility inflection point.
- **GEX walls**: price levels with concentrated positive gamma → dealer hedging creates support/resistance.

**Usage in the bot**:
- Add `gex_net` and `gex_flip_distance` as features to LightGBM.
- Do NOT hardcode GEX-based entry/exit rules without backtesting validation.
- If historical backtesting shows signal validity: when price is below GEX flip point, add a soft size reduction of 0.8× (volatility amplification zone).

**BTC-specific caveat**: GEX is the most powerful signal for SPX/NDX where structured-product dealer books are enormous. On BTC/Deribit, the effect exists but is significantly attenuated by the much larger spot/perp market. Treat as a low-weight ML feature until validated.

**Evidence strength**: Low-moderate for BTC. Very high for SPX/NDX.

---

## 3. Data Sources by Asset Class

### 3.1 Crypto (BTC, ETH, SOL)

**Primary source: Deribit**
- Dominant crypto options exchange (~90% of open interest).
- Free public API, no authentication required for market data.
- Endpoints needed:
  - `GET /public/get_book_summary_by_currency?currency=BTC&kind=option` — returns IV, Greeks, open interest, volume per instrument.
  - `GET /public/get_index_price?index_name=btc_usd` — spot reference price.
- Rate limit: 20 requests/second (far more than needed for 4H candles).
- Documentation: `https://docs.deribit.com/`

**Historical data: Tardis.dev (preferred)**
- Pay-per-use pricing — most cost-effective for a one-shot historical pull for backtesting.
- Tick-level raw options data — can recompute IV, skew, PCR, GEX from scratch.
- Preferred over Amberdata for backtesting because raw data allows exact reproduction of live logic.

**Historical data: Amberdata**
- Subscription service (~$500/month).
- Provides pre-computed analytics: IV term structure, skew, GEX, max pain history.
- Better if ongoing historical access is needed, but expensive for occasional use.

### 3.2 Equity Indices (S&P 500, Nasdaq-100)

**Primary source: CBOE (Chicago Board Options Exchange)**
- SPX options (S&P 500) and NDX options (Nasdaq-100) are the most liquid options markets in the world.
- Data available through multiple vendors (see below).

**Recommended vendors for index options data:**

| Vendor | Type | Cost | Notes |
|---|---|---|---|
| **CBOE DataShop** | Direct from exchange | ~$100-300/month | Official SPX/NDX/VIX options data. Highest quality. |
| **Polygon.io** | Aggregator API | ~$79-199/month | Real-time + historical options chain data. Simple REST API. |
| **ThetaData** | Options-specific | ~$50-100/month | Specialized in options data. Pre-computed Greeks, IV, GEX. |
| **Databento** | Raw exchange data | Pay-per-use | Most cost-effective for historical backtesting. Tick-level. |
| **IBKR (Interactive Brokers)** | Broker API | Free with account | Options chain + Greeks via TWS API. Good for live trading, limited history. |

**Key difference from crypto**: For SPX/NDX, you also get **VIX** (the volatility index itself), which is a powerful macro volatility regime indicator. VIX > 25 = high vol regime, VIX > 35 = extreme vol regime. This can replace or complement the ATM IV percentile logic. GEX and max pain are also significantly stronger signals for SPX than for BTC.

### 3.3 Gold (GC Futures)

**Primary source: CME (Chicago Mercantile Exchange)**
- Gold futures options (OG) are highly liquid.
- Data available through the same vendors as equity indices.

**Recommended vendors:**

| Vendor | Notes |
|---|---|
| **CME Data** | Direct from exchange. Most authoritative. |
| **Polygon.io** | Covers CME futures options. |
| **Databento** | CME futures + options tick data. |
| **IBKR** | Free with account, sufficient for live trading. |

**Gold-specific considerations**:
- Gold options are heavily influenced by **real yields** (TIPS) and **DXY**. Consider adding these as macro covariates alongside options data.
- Gold IV tends to spike during geopolitical events — the IV percentile logic is especially valuable here.
- The GEX profile on gold is less studied than equities; use with caution.

### 3.4 Forex Futures (EUR/USD, JPY/USD)

**Primary source: CME**
- FX futures options (6E for EUR/USD, 6J for JPY/USD) are liquid but less so than equity indices.
- Data available through the same CME vendors.

**Forex-specific considerations**:
- FX options are also traded OTC (over-the-counter) in much larger size than exchange-listed futures options. The CME futures options data captures only a fraction of total FX options flow.
- **25-delta risk reversal is the standard FX sentiment indicator** — it is quoted directly by banks and is the most important metric to extract. The signal-to-noise ratio for risk reversal is highest in FX (stronger than crypto, comparable to equity).
- FX implied volatility is strongly mean-reverting — the IV percentile logic works very well here.

---

## 4. Integration Architecture

### 4.1 New Feature Group

Add to `FEATURE_GROUPS` in `apps/api/services/smc.py`:

```python
"options": [
    "iv_7d",              # ATM IV for 7-day expiry
    "iv_30d",             # ATM IV for 30-day expiry
    "iv_7d_percentile",   # Rolling 90-day percentile of iv_7d
    "risk_reversal_25d",  # 25-delta put IV - call IV (institutional skew)
    "pcr_volume",         # 24h put/call volume ratio (ML feature only — no hard block)
    "max_pain_dist_pct",  # (price - max_pain) / price
    "gex_net",            # Net gamma exposure
    "gex_flip_distance",  # Distance to GEX flip point in ATR units
]
```

These features must be added to `ALL_FEATURES` so they flow into LightGBM training.

**Phase 1 minimum viable set** (implement first, validate independently):
```python
"options_phase1": [
    "iv_7d",
    "iv_7d_percentile",
]
```

### 4.2 Data Fetching Strategy

Options data does NOT need to be fetched every 4H candle. The metrics change slowly:

- **IV, skew, GEX**: fetch every 4 hours (aligned with candle close). These move intraday but the 4H resolution is sufficient for a 4H trend-following system.
- **PCR volume**: fetch every 4 hours, use 24h rolling window.
- **Max pain**: fetch once per day (it only changes meaningfully when new expiries are listed or large positions roll).

The fetch should happen in `build_all_features()` or in a separate `build_options_features()` function called from the main pipeline. The fetched values are forward-filled onto the 4H candle index (same pattern as funding rates and daily MTF features).

On fetch failure (API timeout, rate limit): forward-fill the last known value and log a warning. Do not block candle processing.

### 4.3 Decision Engine Integration

Add a new `OptionsBias` block in `DecisionEngine.decide()`, placed after `FundingBias` and `FNGBias` in `decision.py`. The block should:

1. Read options features from the `features` dict.
2. Apply IV-based position size modulation (the only rule active by default).
3. Apply skew-based threshold adjustments (only if `options_skew_enabled` and validated by backtesting).
4. Apply max pain gravity soft reduction near expiry (soft only, not a directional block).
5. Log all adjustments to the `reasoning` audit trail.

**PCR is not applied as a hard block** — it feeds only into the LightGBM feature matrix.

New constructor parameters for `DecisionEngine`:
- `options_bias_enabled: bool = False`
- `iv_high_percentile: float = 80.0`
- `iv_low_percentile: float = 20.0`
- `iv_size_factor: float = 0.7`
- `options_skew_enabled: bool = False` (off by default, enable only after backtesting)
- `skew_threshold: float = 5.0`
- `skew_delta: float = 0.02`
- `max_pain_enabled: bool = False` (off by default)
- `max_pain_gravity_threshold: float = 3.0`
- `max_pain_size_factor: float = 0.3`

### 4.4 Configuration & UI

Add to `BotConfig` interface in `apps/web/components/trading-hub/BotConfig.tsx`:
- `options_bias_enabled: boolean` (default: `false`)
- `iv_high_percentile: number` (default: `80`)
- `iv_size_factor: number` (default: `0.7`)
- `options_skew_enabled: boolean` (default: `false`)
- `skew_threshold: number` (default: `5.0`)
- `skew_delta: number` (default: `0.02`)
- `max_pain_enabled: boolean` (default: `false`)

Add a new `Section` in the UI under a collapsible "Options Data" category, with toggles and sliders for each parameter.

### 4.5 Backtesting Considerations — Critical Prerequisite

> **This is the most important constraint for this entire integration.**

No options signal — except IV-based position sizing — should go live without historical backtesting validation. The risk is adding noise (or worse, anti-predictive rules) to a system that already works.

**The backtesting blocker**: historical options data for BTC is not free.
- **Tardis.dev** (pay-per-use, recommended): pull 2 years of Deribit options snapshots, recompute IV/skew/PCR/GEX, align to 4H candle index, run the backtesting engine. One-time cost is far lower than a monthly Amberdata subscription.
- **Amberdata** (~$500/month): only worth it if ongoing historical access is needed.
- **Alternative**: start Phase 1 (IV sizing only, live) and accumulate live options data. After 3-6 months, retrain with options features included. This avoids the historical data cost but delays validation.

The backtesting engine (`apps/api/services/backtesting.py`) already passes a `features` dict to `DecisionEngine.decide()`. If options features are present in the historical feature matrix, they will be used automatically. If not, `options_bias_enabled` must be forced to `false` to avoid key-not-found errors.

---

## 5. Cross-Asset Applicability Summary

| Asset | Options Venue | Data Vendor (Live) | Data Vendor (Historical) | Key Metric | Signal Strength |
|---|---|---|---|---|---|
| BTC/ETH | Deribit | Deribit API (free) | Tardis.dev (pay-per-use) | IV percentile ★★★, Risk Reversal ★★, PCR as ML feature ★★, GEX ★ | Good for IV, moderate for rest |
| S&P 500 (ES) | CBOE | Polygon.io, ThetaData | Databento, CBOE DataShop | VIX ★★★, GEX ★★★, Skew ★★★, Max Pain ★★★ | Excellent — strongest options signals |
| Nasdaq-100 (NQ) | CBOE | Polygon.io, ThetaData | Databento, CBOE DataShop | VIX ★★★, GEX ★★★, Skew ★★★ | Excellent — similar to SPX |
| Gold (GC) | CME | Polygon.io, IBKR | Databento, CME Data | IV percentile ★★★, Risk Reversal ★★ | Good for IV, lower for GEX |
| Crude Oil (CL) | CME | Polygon.io, IBKR | Databento, CME Data | IV percentile ★★★, Skew ★★ | Good — strong IV seasonality |
| EUR/USD (6E) | CME + OTC | Polygon.io, IBKR | Databento, CME Data | Risk Reversal ★★★ | Best-in-class FX skew signal |
| JPY/USD (6J) | CME + OTC | Polygon.io, IBKR | Databento, CME Data | Risk Reversal ★★★ | Same as EUR/USD |

---

## 6. Implementation Priority

The order below reflects evidence strength and implementation risk, not the order in the original document.

1. **Phase 1 — IV-based position sizing only (BTC, live)**: Implement `iv_7d` fetch from Deribit, rolling 90-day percentile, and position size modulation (`iv_size_factor`). This is the single highest-confidence signal. No historical data required, no LightGBM retraining needed for the initial version. Implement behind `options_bias_enabled` flag (default off). Test for 2-4 weeks live, then enable.

2. **Phase 2 — Historical backtesting for remaining signals**: Purchase historical Deribit options data from Tardis.dev. Run the full backtesting pipeline with all options features. Measure actual impact of each signal on this specific system. Only proceed to Phase 3 if backtesting confirms value.

3. **Phase 3 — LightGBM retraining with options features**: Add `risk_reversal_25d`, `pcr_volume`, `max_pain_dist_pct`, `gex_net`, `gex_flip_distance` to the feature matrix. Retrain with historical options data included. Let the model discover predictive relationships rather than imposing hard rules.

4. **Phase 4 — ETH expansion**: Add ETH options from Deribit (same API, `currency=ETH` parameter).

5. **Phase 5 — Traditional futures**: Add SPX/ES options via Polygon.io or ThetaData. GEX and max pain signals are significantly stronger here than on BTC — this phase may deliver the largest incremental improvement.

6. **Phase 6 — Gold and FX**: Extend to GC, 6E, 6J using the same CME data pipeline.

---

## 7. Realistic Expected Impact

The table below gives realistic ranges based on published literature calibrated for crypto 4H trend-following systems. The academic best-case numbers (which tend to use equity data and optimized parameters) are noted separately.

| Signal | Realistic Impact (BTC 4H) | Academic Best-Case | Condition |
|---|---|---|---|
| IV-based position sizing | Max drawdown –8–12%, Sharpe +0.2–0.4 | DD –15–25% | Applies across regimes; most robust estimate |
| Risk reversal (as ML feature) | WR +0–2pp if signal is real | WR +3–5pp | Depends on backtesting confirming relationship |
| PCR (as ML feature) | Marginal if any | "–10–15% losing trades" (unreliable metric) | Hard block version is counterproductive |
| Max pain gravity | Negligible on BTC | "20% exit improvement" (SPX-based) | Effect much weaker on BTC than SPX weekly |
| GEX | Marginal on BTC | Strong on SPX | Dealer book size ratio BTC/Deribit << SPX/CBOE |

**Combined realistic outcome** (Phase 1-3 fully implemented and validated):
- Max drawdown: –8–15% vs. current system
- Sharpe ratio: +0.2–0.5 improvement
- Win rate: unchanged to +1–2pp (options signals improve sizing, not entry prediction directly)
- Total return: approximately equal to slightly lower (trading smaller in high-vol periods reduces both losses and gains)

**The primary benefit is a smoother equity curve, not higher absolute returns.** This is the correct framing for why options integration is worth doing.
