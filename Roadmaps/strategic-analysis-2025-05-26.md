# 🔬 Analisi Strategica — AI Trading Hub

**Data:** 26 Maggio 2025
**Oggetto:** Valutazione del vantaggio competitivo, dati mancanti, e roadmap di miglioramento

---

## Il quadro completo

Il problema non è la qualità dell'implementazione, ma la natura del segnale che stai cercando di catturare.

---

## 🎯 Dov'è il vero edge istituzionale?

I grandi fondi quantitativi non guadagnano perché hanno "modelli migliori" sugli stessi dati. Guadagnano perché hanno **dati che tu non hai** e **esecuzione che tu non puoi replicare**.

### 1. Dati che ti mancano completamente

| Categoria | Cosa usano gli istituzionali | Tu cosa hai |
|-----------|------------------------------|-------------|
| **Order book** | L2/L3 depth, bid-ask spread, order flow imbalance, iceberg detection | Solo CVD approssimato da OHLCV |
| **On-chain** | Whale wallet tracking, exchange inflow/outflow, stablecoin mint/burn, miner reserves, DeFi TVL | Nulla |
| **Options market** | Max pain, put/call ratio, gamma exposure per strike, term structure, skew | Nulla |
| **Sentiment** | NLP su news, Twitter, Reddit, Telegram, forum | Nulla (F&G è fetchato ma mai usato nelle decisioni) |
| **Cross-exchange** | Funding rate arbitrage, spot-futures basis, cross-venue order book | Solo Hyperliquid |
| **ETF flows** | Bitcoin ETF inflow/outflow giornalieri | Nulla |
| **Macro** | DXY, TLT, SPX, VIX, gold correlation in tempo reale | Solo eventi macro discreti (FOMC/CPI/NFP) |

### 2. Fear & Greed — fetchato ma ignorato

In `apps/api/services/execution.py` linea 747-748:

```python
await update_covariates()        # fetcha F&G + BTC dominance
covars = get_latest_covariates() # li legge dal DB
```

`covars` viene passato **solo** a `_log_inference()` per essere scritto nel JSON su Supabase. **Non arriva mai al `DecisionEngine`.** Non viene mai usato come feature per LightGBM. Non modifica nessuna soglia. Hai un indicatore di sentiment che fetchi ogni 4 ore e poi ignori completamente.

### 3. Esecuzione — il problema ignorato

Il bot decide **cosa** fare (long/short/nothing) ma non **come** farlo. Nei sistemi professionali, l'esecuzione è importante quanto il segnale: TWAP/VWAP, smart order routing, slippage measurement, market impact modeling. Il bot piazza un IOC a 50bps di slippage e spera. Non misura nemmeno il fill effettivo.

---

## 🧠 Il problema fondamentale: da dove viene l'edge?

Cosa sta effettivamente facendo il bot?

1. Prende 512 candele OHLCV a 4h
2. Calcola 64 feature tecniche (RSI, ADX, MACD, FVG, CVD, OB, MTF...)
3. Le dà in pasto a Chronos-2 (modello general-purpose Amazon) per avere 8 feature probabilistiche
4. Le stesse 64 feature + Chronos le dà a LightGBM per avere P(up)
5. Fa la media pesata tra Chronos e LightGBM
6. Applica 10+ gate per filtrare i falsi segnali
7. Se tutto passa, apre long o short

Tradotto: stai usando **due modelli AI per fare ciò che un analista tecnico umano farebbe guardando i grafici.** Solo che lo fai in automatico e con più indicatori.

**L'analisi tecnica classica non genera alpha persistente.** È un fatto ben documentato nella letteratura accademica. I pattern tecnici funzionano finché non vengono scoperti, poi vengono arbitrati via. E tu stai cercando pattern su dati che **tutti** hanno (OHLCV è pubblico e gratuito).

---

## 📊 Cosa manca per un vantaggio reale

### Tier 1 — Dati unici (il 90% dell'edge)

| Dato | Impatto sull'edge |
|------|-------------------|
| Order book L2 (depth) | 95% |
| On-chain whale tracking | 85% |
| Options gamma exposure | 80% |
| Exchange inflow/outflow | 75% |
| ETF flow giornaliero | 70% |
| NLP sentiment (Twitter) | 65% |
| Cross-exchange funding | 60% |
| Stablecoin mint/burn | 50% |
| Fear & Greed (già hai!) | 45% |
| BTC dominance (già hai!) | 40% |

### Tier 2 — Esecuzione professionale

- TWAP su 15-30 minuti invece di IOC istantaneo
- Misurare lo slippage e aggiustare i parametri
- Dynamic spread basato sulla volatilità del momento
- Order book imbalance per decidere se eseguire subito o aspettare

### Tier 3 — Robustezza statistica

- Monte Carlo simulation sui backtest (1000 permutazioni dei trade)
- Walk-forward ottimizzato con validation set cieco
- Concept drift detection: il modello si sta degradando?
- Model ensemble diversity: XGBoost, CatBoost, TabNet, LSTM oltre a Chronos+LightGBM
- Regime-specific models: un modello per trending, uno per ranging, uno per volatile

### Tier 4 — Risk management istituzionale

- Kelly criterion / optimal f per position sizing dinamico
- CVaR (Conditional Value at Risk) invece di stop loss fisso
- Volatility targeting: size inversamente proporzionale alla volatilità
- Max drawdown a livello di portafoglio, non solo di singolo trade
- Stress testing contro scenari storici (crollo FTX, COVID crash, ecc.)

---

## 🎲 La domanda scomoda

**Questo progetto, nella sua forma attuale, può generare un vantaggio competitivo reale e persistente sul mercato crypto?**

Risposta sincera: **probabilmente no, nella forma attuale.** Non perché sia fatto male — anzi, è tecnicamente solido. Ma perché:

1. **Stai giocando allo stesso gioco di tutti gli altri retail trader**, solo con strumenti più sofisticati. Ma il gioco è lo stesso: estrarre segnale da OHLCV.

2. **Non hai un'informazione asimmetrica.** Tutti vedono le stesse candele che vedi tu. I tuoi 64 indicatori sono funzioni deterministiche di dati pubblici. Se funzionassero davvero, lo farebbero già tutti e smetterebbero di funzionare.

3. **Il mercato crypto è sempre più istituzionale.** Market maker come Jump, Wintermute, GSR operano con infrastrutture che tu non puoi replicare. Loro fanno il prezzo. Tu lo subisci.

4. **Chronos-2 non è un edge.** È un modello general-purpose addestrato su serie storiche generiche. Non sa cosa sia Bitcoin. Non capisce le dinamiche crypto (halving, narrativa, regolamentazione, hack, listing).

---

## 💬 Giudizio finale

Il progetto è **un ottimo lavoro di ingegneria software applicata al trading.** La qualità del codice, l'architettura, la gestione degli stati, la persistenza, le notifiche — tutto è a livello professionale.

Ma **non è un sistema di trading istituzionale.** È un sistema retail molto sofisticato. La differenza non sta nella complessità del codice, ma nella **natura e unicità dei dati** che alimentano le decisioni.

La buona notizia è che hai già l'80% dell'infrastruttura necessaria. Il salto di qualità non richiede di riscrivere tutto — richiede di **aggiungere le fonti dati giuste** e **usarle nelle decisioni**, non solo loggarle.

Priorità assoluta: **on-chain data + order book + usa F&G che già hai.** Con questi tre, il bot passa da "bel progetto tecnico" a "potenziale vantaggio informativo reale."
