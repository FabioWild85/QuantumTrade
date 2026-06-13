# AI Decision Layer — Piano di Implementazione

> **Data:** 2026-06-13
> **Stato:** Spec approvata, pronta per implementazione
> **Tipo:** Feature additiva, toggle-based, default OFF (zero regressione quando spenta)
> **Scope v1:** Solo valutazione in **entrata** (gestione/uscita rimandata a v2)

---

## 0. Obiettivo e caso d'uso ancora

Aggiungere un secondo cervello — un modello AI (LLM) — che **giudica** la decisione del modello quantitativo (LGBM) prima di aprire un trade, usando **contesto che il modello non vede**, e che **modula la soglia** d'ingresso (facilita / ostacola / blocca).

### Il problema concreto da risolvere (priorità #1)

Il bot entra in situazioni ambigue di questo tipo:

> Il prezzo scende da giorni, ha appena fatto un **nuovo minimo**, l'**ADX è crollato** (trend esausto), e il modello **insiste a shortare sui nuovi minimi** mentre il prezzo sta già **rimbalzando**.

Questo è uno **short tardivo in esaurimento / contro-struttura**: l'LGBM vede la probabilità direzionale ma non vede che (a) il movimento è geometricamente esteso, (b) la struttura sta invertendo (CHoCH/rimbalzo), (c) sta entrando proprio dove il rischio rendimento è peggiore (vendere il minimo).

**Se l'AI Layer evitasse anche solo questo, sarebbe già un grande traguardo.** L'obiettivo non è che faccia tutto, ma che agisca da **filtro di buon senso strutturale** sulle situazioni ambigue che il modello non sa leggere.

### Principi architetturali (non negoziabili)

1. **Additivo**: con toggle OFF il sistema è **byte-identico** a oggi. Nessuna riga del path esistente cambia comportamento.
2. **Fail-open**: se l'AI non risponde, va in timeout, dà errore o JSON malformato → il bot opera **normalmente col solo LGBM** (comportamento attuale validato).
3. **Forward-only**: NON è backtestabile (lookahead bias + non-determinismo). Si valida in **shadow mode** e via log forward. Nessuna pretesa di backtest.
4. **Influenza limitata e configurabile**: l'AI può spostare la soglia solo entro un **clamp** deciso dall'utente. Non può mai stravolgere il modello.
5. **Asimmetria iniziale**: in v1 l'AI può solo **frenare/vetare** (alzare soglia, bloccare), mai **facilitare** (abbassare soglia). Il potere di facilitare si sblocca con un parametro, da attivare solo dopo validazione forward.
6. **Dossier curato, non agentico**: il server assembla i dati e li passa all'AI. L'AI **non naviga** il web e non chiama API da sola (più affidabile, veloce, auditabile, riproducibile).

---

## 1. Flusso end-to-end (esatto)

Aggancio: dentro `ExecutionEngine._cycle`, **subito dopo** `result = decision_engine.decide(...)` ([execution.py:1769](../apps/api/services/execution.py#L1769)) e **prima/intorno** al Gate LGBM 1H ([execution.py:1783](../apps/api/services/execution.py#L1783)). Mirroring esatto del pattern del Gate 1H.

```
Ciclo 4H (alla chiusura barra)
  │
  ├─ 1. LGBM + Chronos + feature pipeline  → lgbm_prob, c2_out, features   [INVARIATO]
  ├─ 2. decision_engine.decide(...)        → DecisionResult (action, thresholds, reasoning) [INVARIATO]
  │
  ├─ 3. ┌─ SE ai_layer_enabled AND (result.action ∈ {long, short}
  │     │                            OR ai_layer_evaluate_no_trade):   ← valuta ANCHE i no-trade
  │     │   a. ai_context.build_dossier(features, df_4h, df_1h, df_d, covars, result)
  │     │      → dossier strutturato (struttura + macro + verdetto modello)
  │     │   b. ai_analyst.evaluate(dossier, provider, model, params)
  │     │      → AIVerdict {agreement, conviction, threshold_adjustment, report_it, flags, invalidation}
  │     │      (con timeout duro; qualsiasi errore → fail-open, verdict=None)
  │     │   c. SE verdict is None (errore/timeout):
  │     │         → log "AI Layer: fail-open (LGBM-only)", nessuna modifica   [come oggi]
  │     │      ALTRIMENTI:
  │     │         → applica il verdetto alla decisione (§7): modula soglia / veto / size
  │     │   d. persisti la decisione AI su Supabase (tabella ai_decisions) — SEMPRE (anche shadow)
  │     └─
  │
  ├─ 4. Gate LGBM 1H (esistente)            [INVARIATO]
  ├─ 5. Inference logging                    [arricchito con campi AI]
  └─ 6. Esecuzione / open_position           [INVARIATO]
```

### Shadow mode

Parametro `ai_layer_shadow_mode`: se `True`, l'AI viene chiamata, valutata e **loggata**, ma il suo verdetto **NON modifica** la decisione. Serve per accumulare settimane di dati ("avrebbe vetato questo trade? sarebbe stato giusto?") senza rischiare capitale. È il sostituto del backtest.

### Il caso NO TRADE — l'AI elabora SEMPRE un giudizio

**Sì, l'AI produce un giudizio anche quando il modello dice NO TRADE** (soglia non raggiunta, oppure gate hard tipo ADX/weekend). Controllato da `ai_layer_evaluate_no_trade` (default `True`).

Perché conta:
- **UX**: ogni 4h vedi comunque il ragionamento dell'AI — *perché* non si è tradato e se l'AI è d'accordo a stare fuori. Niente "buchi" nel log.
- **Funzionale (futuro)**: se un giorno abiliti `ai_layer_allow_easing`, un giudizio AI forte su un no-trade potrebbe far scattare un trade che il modello ha mancato. Ma **solo se tu attivi l'easing**.

Comportamento per scenario (v1, veto-only):

| Azione modello | AI gira? | Effetto sulla decisione | UX |
|---|---|---|---|
| `long`/`short` | sì | può **vetare/frenare** (no_trade) | report + eventuale blocco |
| `no_trade` (soglia non raggiunta) | sì (se `evaluate_no_trade`) | **nessuno in v1** (l'AI non può creare trade con easing OFF) → puramente **informativo/loggato** | report: "il modello sta fuori, l'AI concorda / vede setup X" |
| `no_trade` (gate hard: ADX, weekend) | sì (se `evaluate_no_trade`) | nessuno | report: "mercato compresso/chiuso, correttamente fuori" |

> In v1 il giudizio sul no-trade è **informativo**: lo vedi e lo logghi, ma non apre trade (l'AI può solo frenare, non facilitare). Diventa *azionabile* solo con `ai_layer_allow_easing=True` in futuro. Costo: comunque ~6 chiamate/giorno, trascurabile. Chi vuole risparmiare può mettere `ai_layer_evaluate_no_trade=False` e far girare l'AI solo sui trade proposti.

---

## 2. Il dossier (cosa vede l'AI)

**Solo testo/JSON.** Niente immagini (decisione presa: più preciso, veloce, economico — l'AI ragiona meglio su struttura calcolata che su un PNG letto a occhio). Tre strati + il verdetto del modello.

### Strato 1 — Struttura calcolata (ciò che il modello NON vede)

Calcolata in modo deterministico in Python (nuovo modulo `ai_context.py`). Per ogni timeframe (Daily / 4H / 1H):

| Campo | Descrizione |
|---|---|
| `swings` | Ultimi 5-6 swing point (prezzo + barre fa) → l'AI legge la sequenza HH/HL/LH/LL |
| `structure_label` | Etichetta sintetica: `uptrend` / `downtrend` / `range` / `transition` |
| `last_structural_event` | Ultimo `BOS` (continuazione) o `CHoCH` (possibile inversione) + prezzo + barre fa |
| `key_levels` | Supporti/resistenze più vicini sopra/sotto, con n° tocchi |
| `liquidity` | Equal highs/lows, massimi/minimi recenti **non presi** (dove il prezzo "vuole" andare) |
| `range_position` | Posizione % del prezzo nel range corrente (0 = minimo, 100 = massimo) |
| `dist_from_recent_extreme` | Distanza % dal minimo/massimo swing più recente (cattura "nuovo minimo") |
| `bars_since_extreme` | Da quante barre dura il movimento corrente (cattura "esteso da giorni") |

### Strato 2 — Contesto macro esterno (fuori dal grafico prezzi)

Tutto già disponibile o facilmente fetchabile dal server:

| Campo | Fonte | Stato |
|---|---|---|
| `fear_greed` + `fear_greed_class` | `covariates.py:_fetch_fear_greed` | ✅ già fetchato |
| `btc_dominance` | `covariates.py:_fetch_btc_dominance` | ✅ già fetchato |
| `funding_8h_bps` | `avg_funding` nel ciclo (`get_funding_history`) | ✅ già disponibile |
| `open_interest` + trend | **Coinglass / Coinalyze** (`COINGLASS_API_KEY`, `COINALYZE_API_KEY` già in `.env`) | ✅ chiavi già presenti |
| `news_headlines` (opzionale) | News API esterna (`FMP_API_KEY` già in `.env`) | 🔲 v1.1 opzionale |

### Strato 3 — Verdetto del modello (per giudicare in contesto)

| Campo | Sorgente |
|---|---|
| `proposed_action` | `result.action` (`long`/`short`) |
| `lgbm_prob` | `lgbm_prob` |
| `c2_dir_prob` | `c2_out["c2_dir_prob"]` |
| `entry`, `stop_loss`, `take_profit` | `result.stop_loss`, `result.take_profit`, `current_price` |
| `risk_reward` | calcolato |
| `threshold_long`, `threshold_short` | dal reasoning di `decide` |
| `regime_state`, `adx`, `rsi_14`, `atr_pct` | da `features` |
| `model_reasoning` | `result.reasoning` (audit trail testuale del modello) |

> **Nota ortogonalità (punto chiave):** il dossier enfatizza ciò che il modello NON usa già nelle sue feature. ADX/RSI/regime sono inclusi solo come *contesto di lettura* per l'AI, non come fattore da ri-pesare. Il valore aggiunto vero è Strato 1 (struttura/liquidità) + Strato 2 (macro).

---

## 3. Nuovo modulo: `apps/api/services/ai_context.py`

Responsabilità: trasformare OHLCV + feature + covariate in un **dossier JSON** pronto per il prompt.

```python
# apps/api/services/ai_context.py  (nuovo file)

from dataclasses import dataclass, asdict
import pandas as pd

def _detect_swings(df: pd.DataFrame, left: int = 2, right: int = 2) -> list[dict]:
    """Pivot high/low fractali: un pivot high ha `left` barre più basse a sx e
    `right` a dx (idem inverso per i low). Ritorna gli ultimi N swing ordinati."""
    ...

def _label_structure(swings: list[dict]) -> str:
    """uptrend se HH+HL, downtrend se LH+LL, range/transition altrimenti."""
    ...

def _last_structural_event(swings, last_close) -> dict:
    """BOS se rompe l'ultimo swing nella direzione del trend; CHoCH se rompe
    contro il trend (primo segnale di inversione). Ritorna {type, price, bars_ago}."""
    ...

def _key_levels(df, last_close, max_levels=4) -> dict:
    """Cluster di massimi/minimi storici → S/R sopra e sotto, con n° tocchi."""
    ...

def _liquidity(df) -> dict:
    """Equal highs/lows (entro tolleranza ATR) + estremi recenti non ancora presi."""
    ...

def build_dossier(
    *,
    features: dict,
    df_4h: pd.DataFrame,
    df_1h: pd.DataFrame,
    df_d: pd.DataFrame,
    covariates: dict,
    avg_funding: float,
    decision_result,          # DecisionResult
    current_price: float,
    c2_output: dict,
    lgbm_prob: float,
) -> dict:
    """Assembla il dossier completo a 3 strati. Funzione PURA e deterministica."""
    return {
        "timestamp": ...,
        "symbol": "BTC",
        "structure": {
            "daily": _tf_block(df_d),
            "4h":    _tf_block(df_4h),
            "1h":    _tf_block(df_1h),
        },
        "macro": {
            "fear_greed": covariates.get("fear_greed"),
            "fear_greed_class": covariates.get("fear_greed_class"),
            "btc_dominance": covariates.get("btc_dominance"),
            "funding_8h_bps": avg_funding * 8 * 10000,
            "open_interest": ...,   # se disponibile
        },
        "model_verdict": {
            "proposed_action": decision_result.action,
            "lgbm_prob": lgbm_prob,
            "c2_dir_prob": c2_output.get("c2_dir_prob"),
            "entry": current_price,
            "stop_loss": decision_result.stop_loss,
            "take_profit": decision_result.take_profit,
            "risk_reward": ...,
            "regime_state": features.get("regime_state"),
            "adx": features.get("adx_14"),
            "rsi_14": features.get("rsi_14"),
            "atr_pct": ...,
            "model_reasoning": decision_result.reasoning,
        },
    }
```

> `_tf_block(df)` = `{swings, structure_label, last_structural_event, key_levels, liquidity, range_position, dist_from_recent_extreme, bars_since_extreme}`.

---

## 4. Nuovo modulo: `apps/api/services/ai_analyst.py`

Responsabilità: astrazione multi-provider + chiamata + parsing robusto del verdetto.

### Provider supportati

| Provider | SDK / endpoint | Env key | Stato chiave |
|---|---|---|---|
| **Anthropic** (default) | `anthropic` SDK | `ANTHROPIC_API_KEY` | ❌ da aggiungere (console.anthropic.com) |
| **Google Gemini** | `google-genai` SDK | `GEMINI_API_KEY` | ✅ già in `.env` |
| **OpenAI** | `openai` SDK | `OPENAI_API_KEY` | 🔲 placeholder |
| **DeepSeek** | endpoint OpenAI-compatible | `DEEPSEEK_API_KEY` | 🔲 placeholder |

### Selettore a due livelli: Provider → Sotto-modello/versione

L'utente sceglie **prima il provider, poi il modello specifico** (Opus/Sonnet/Haiku ecc.). Il backend mantiene un **catalogo** per provider, esposto via `GET /ai-layer/providers`, che alimenta i due dropdown dipendenti nella UI.

```python
# ai_analyst.py — catalogo (aggiornabile senza toccare la logica)
MODEL_CATALOG = {
    "anthropic": [
        {"id": "claude-opus-4-8",      "label": "Claude Opus 4.8 (max qualità)"},
        {"id": "claude-sonnet-4-6",    "label": "Claude Sonnet 4.6 (bilanciato)"},
        {"id": "claude-haiku-4-5-20251001", "label": "Claude Haiku 4.5 (veloce/economico)"},
    ],
    "gemini": [
        {"id": "gemini-2.5-pro",   "label": "Gemini 2.5 Pro"},
        {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
        # popolabile/aggiornabile; idealmente verificato via models.list()
    ],
    "openai": [   # placeholder finché manca la chiave
        {"id": "gpt-4o",      "label": "GPT-4o"},
        {"id": "gpt-4o-mini", "label": "GPT-4o mini"},
    ],
    "deepseek": [ # placeholder finché manca la chiave
        {"id": "deepseek-chat",     "label": "DeepSeek Chat (V3)"},
        {"id": "deepseek-reasoner", "label": "DeepSeek Reasoner (R1)"},
    ],
}
```

- `GET /ai-layer/providers` ritorna il catalogo **filtrato** per chiavi presenti in env: ogni provider ha un flag `available` (true se la sua key c'è). I provider senza key appaiono in UI ma **disabilitati** con tooltip "chiave API mancante".
- Per Anthropic/OpenAI/Gemini, dove l'SDK espone `models.list()`, il catalogo può essere **verificato/aggiornato a runtime** (best-effort, con fallback al catalogo statico se la chiamata fallisce).
- Config: `ai_layer_provider` + `ai_layer_model` (l'`id` specifico). La UI garantisce che `ai_layer_model` appartenga al provider scelto.

> Astrazione: una funzione `evaluate()` con `match provider`. Ogni provider è un thin wrapper che: costruisce il payload (system + user dossier), forza `temperature=0` e output JSON, applica un **timeout duro**, e ritorna `AIVerdict`. Se la chiave del provider non è in env → provider non disponibile (UI lo mostra disabilitato), fallback su LGBM-only.

```python
# apps/api/services/ai_analyst.py  (nuovo file)

from dataclasses import dataclass
import json, asyncio

@dataclass
class AIVerdict:
    agreement: str            # "confirm" | "neutral" | "veto"
    conviction: int           # 0-100
    threshold_adjustment: float  # delta grezzo proposto (verrà clampato a valle)
    bias: str                 # "long" | "short" | "neutral"
    invalidation_level: float | None
    flags: list[str]          # es. ["counter_structure","chasing_extended","selling_the_low"]
    report_it: str            # report sintetico in ITALIANO per la UX
    raw: dict                 # risposta grezza, per audit

async def evaluate(
    *,
    dossier: dict,
    provider: str,
    model: str,
    timeout_s: float,
    system_prompt: str,
) -> AIVerdict | None:
    """Ritorna AIVerdict, oppure None su qualsiasi errore/timeout (fail-open).
    temperature=0, output forzato in JSON, parsing difensivo."""
    try:
        payload_user = json.dumps(dossier, ensure_ascii=False, default=str)
        raw_text = await asyncio.wait_for(
            _call_provider(provider, model, system_prompt, payload_user),
            timeout=timeout_s,
        )
        data = _extract_json(raw_text)        # parsing robusto (strip ```json ecc.)
        return _validate_verdict(data)        # schema + range check; se invalido → None
    except Exception as exc:
        log.warning("AI Layer evaluate fail-open: %s", exc)
        return None
```

---

## 5. Schema JSON del verdetto AI (output forzato)

L'AI **deve** restituire esattamente questo schema (validato a valle; se non valido → fail-open):

```json
{
  "agreement": "confirm | neutral | veto",
  "conviction": 0,
  "bias": "long | short | neutral",
  "threshold_adjustment": 0.00,
  "invalidation_level": 0,
  "flags": ["counter_structure", "chasing_extended", "selling_the_low", "into_resistance", "exhaustion", "clean_trend", "with_structure"],
  "report_it": "Spiegazione sintetica in italiano (2-4 frasi) leggibile dall'utente."
}
```

- `agreement`: `confirm` = il trade ha senso strutturale; `neutral` = nessuna obiezione forte; `veto` = il trade è strutturalmente sbagliato (es. lo short tardivo sul minimo).
- `conviction`: quanto è forte il giudizio (0-100). Pesa l'effetto.
- `threshold_adjustment`: delta **grezzo** proposto (positivo = rende più difficile, negativo = facilita). **Verrà sempre clampato** a valle (§7). L'AI lo propone, il sistema lo limita.
- `flags`: tag machine-readable per analytics/filtri nel log.
- `report_it`: il testo per la tua UX (in italiano).

---

## 6. Prompt di sistema dell'analista (testo definitivo v1)

> Salvato come costante `AI_ANALYST_SYSTEM_PROMPT` in `ai_analyst.py`. Inglese per robustezza del modello; il `report_it` richiesto in italiano per la UX.

```
You are a senior market-structure analyst auditing a single proposed trade from
a quantitative trading bot on BTC/USD (4-hour timeframe). The bot uses a LightGBM
model that outputs a directional probability but is STRUCTURALLY BLIND: it does
not perceive market geometry (swing highs/lows), where price sits inside the
broader range, liquidity pools, or whether a move is already exhausted.

YOUR JOB: judge whether the proposed trade makes structural sense, using ONLY the
dossier provided. You are a SANITY FILTER, not the trader. The model already
decided; you confirm, dampen, or veto.

THE #1 FAILURE MODE YOU MUST CATCH:
A late entry AGAINST an exhausted move — e.g. the model proposes a SHORT after
price has been falling for days, just printed a NEW LOW, ADX has collapsed
(trend exhausted), and price is already bouncing. That is "selling the low":
structurally wrong, terrible risk/reward, high reversal risk. VETO these.
The symmetric case (buying the high after an exhausted rally) applies equally.

IF THE PROPOSED ACTION IS "no_trade":
The model decided to stand aside (threshold not met, or a hard gate fired).
Still produce a full judgment: do you AGREE with standing aside, or do you see a
high-quality structural setup the model is missing? Use "agreement":
- "confirm"  = standing aside is correct (no clean setup, choppy, mid-range).
- "neutral"  = no strong opinion.
- "veto"     = (here it means) you see a genuinely strong setup the model missed;
               set "bias" to the direction. NOTE: in v1 this is informational only
               and will NOT open a trade unless easing is explicitly enabled.
Be conservative: prefer "confirm" on no_trade unless the setup is clearly strong.

HARD RULES:
1. Use ONLY the data in the dossier. NEVER invent price levels, news, or facts
   not present. If a field is missing, reason without it — do not fabricate.
2. Do NOT re-judge the model's edge from its probability. Judge STRUCTURE and
   CONTEXT only — the things the model cannot see.
3. Be conservative. Default to "neutral" unless the structure clearly supports
   (confirm) or clearly contradicts (veto) the trade.
4. A trade WITH the higher-timeframe structure and toward liquidity is good.
   A trade AGAINST structure, chasing an extended move, or into a strong opposing
   level is bad.
5. Output STRICT JSON matching the schema. No prose outside JSON. temperature is 0.

EVALUATE, in order:
- Higher-timeframe structure (Daily/4H): is the trade with or against it?
- Is the move already extended? (bars_since_extreme, dist_from_recent_extreme)
  Is the bot entering right at a fresh extreme it helped create?
- Last structural event: BOS (continuation, supports trade) vs CHoCH (reversal,
  warns against continuation trades).
- Range position: is the trade selling the bottom / buying the top of the range?
- Liquidity: is price heading toward unswept liquidity (good) or away from it?
- Key levels: is the stop behind a valid level or in the void? Is the target
  before a wall? Is entry right into strong opposing S/R?
- Macro: funding extremes (over-crowded side), Fear & Greed extremes (contrarian).

OUTPUT (strict JSON):
{
  "agreement": "confirm | neutral | veto",
  "conviction": <int 0-100>,
  "bias": "long | short | neutral",
  "threshold_adjustment": <float, + = harder, - = easier, your raw proposal>,
  "invalidation_level": <price or null>,
  "flags": [<machine tags>],
  "report_it": "<2-4 sentences in ITALIAN explaining your call for the human>"
}

Tag vocabulary for flags: counter_structure, with_structure, chasing_extended,
selling_the_low, buying_the_high, into_resistance, into_support, exhaustion,
clean_trend, toward_liquidity, away_from_liquidity, funding_extreme, sentiment_extreme.
```

---

## 7. Aggancio alla decisione: come il verdetto modula il trade

In `execution.py`, subito dopo `decide()` (e prima del Gate 1H), nuovo blocco speculare al Gate 1H:

```python
# ── 7a-bis. AI Decision Layer ────────────────────────────────────────────
ai_verdict = None
_ai_should_run = cfg.ai_layer_enabled and (
    result.action in ("long", "short") or cfg.ai_layer_evaluate_no_trade
)
if _ai_should_run:
    dossier = None
    try:
        dossier = build_dossier(...)
        ai_verdict = await ai_analyst.evaluate(
            dossier=dossier,
            provider=cfg.ai_layer_provider,
            model=cfg.ai_layer_model,
            timeout_s=cfg.ai_layer_timeout_s,
            system_prompt=AI_ANALYST_SYSTEM_PROMPT,
        )
    except Exception as exc:
        log.warning("AI Layer skipped (error): %s", exc)
        ai_verdict = None

    _orig_action = result.action

    # Verdetto ignorato se sotto la conviction minima (rumore) → solo log informativo
    if ai_verdict is not None and ai_verdict.conviction < cfg.ai_layer_min_conviction:
        result.reasoning.append(
            f"AI Layer: conv={ai_verdict.conviction} < min "
            f"{cfg.ai_layer_min_conviction} → ignorato (informativo)"
        )
    elif ai_verdict is not None:
        # 1) clamp del delta proposto dall'AI
        clamp = cfg.ai_layer_clamp_max          # es. 0.08
        adj   = max(-clamp, min(clamp, ai_verdict.threshold_adjustment))
        # 2) asimmetria v1: se NON è abilitato il "facilita", azzera i delta negativi
        if not cfg.ai_layer_allow_easing and adj < 0:
            adj = 0.0
        # 3) pesa per conviction e per il peso globale impostato dall'utente
        adj *= (ai_verdict.conviction / 100.0) * cfg.ai_layer_weight

        if cfg.ai_layer_shadow_mode:
            # SHADOW: valuta e logga, nessun effetto
            result.reasoning.append(
                f"AI Layer [SHADOW {cfg.ai_layer_provider}/{cfg.ai_layer_model}]: "
                f"would be {ai_verdict.agreement} conv={ai_verdict.conviction} "
                f"adj={adj:+.3f} (no effect)"
            )
        elif _orig_action in ("long", "short"):
            # LIVE su trade proposto: l'AI può frenare/vetare
            _needed = (result.threshold_long if _orig_action == "long"
                       else result.threshold_short) + adj
            _side_prob = lgbm_prob if _orig_action == "long" else (1.0 - lgbm_prob)
            if ai_verdict.agreement == "veto" and cfg.ai_layer_hard_veto:
                result.action = "no_trade"                  # ← caso d'uso #1
            elif _side_prob < _needed:
                result.action = "no_trade"
            result.reasoning.append(
                f"AI Layer [{cfg.ai_layer_provider}/{cfg.ai_layer_model}]: "
                f"{ai_verdict.agreement} conv={ai_verdict.conviction} adj={adj:+.3f} "
                f"flags={','.join(ai_verdict.flags)} → action={result.action}"
            )
        else:
            # LIVE su NO TRADE: informativo in v1; azionabile solo con allow_easing
            if cfg.ai_layer_allow_easing and ai_verdict.agreement == "veto":
                # 'veto' su no_trade = "vedo un setup mancato" → potrebbe aprire
                _needed = (result.threshold_long if ai_verdict.bias == "long"
                           else result.threshold_short) + adj
                _side_prob = lgbm_prob if ai_verdict.bias == "long" else (1.0 - lgbm_prob)
                if _side_prob >= _needed and ai_verdict.bias in ("long", "short"):
                    result.action = ai_verdict.bias
            result.reasoning.append(
                f"AI Layer [no-trade · {cfg.ai_layer_provider}/{cfg.ai_layer_model}]: "
                f"{ai_verdict.agreement} conv={ai_verdict.conviction} "
                f"bias={ai_verdict.bias} → action={result.action} "
                f"({'informativo' if not cfg.ai_layer_allow_easing else 'easing'})"
            )

    # persisti SEMPRE (anche shadow / fail-open / no-trade) per la validazione forward
    await persist_ai_decision(
        ai_verdict, dossier, result,
        orig_action=_orig_action,
        shadow=cfg.ai_layer_shadow_mode,
    )
```

> **Nota:** la soglia effettiva (`threshold_long`/`threshold_short`) calcolata dentro `decide()` va esposta nel `DecisionResult` (aggiungere due campi) così `execution.py` può ri-applicare il delta. In alternativa, `agreement=="veto"` con `ai_layer_hard_veto=True` basta da solo a coprire il caso d'uso #1 senza toccare le soglie — **è il percorso minimo consigliato per la v1**.

### Percorso minimo v1 (consigliato per partire)

Per risolvere SUBITO il problema #1 senza complessità: **veto duro**.
- `ai_layer_hard_veto = True`, `ai_layer_allow_easing = False`.
- Se `agreement == "veto"` → `result.action = "no_trade"` + reasoning + log.
- Il `threshold_adjustment` graduale resta implementato ma si attiva dopo, quando ti fidi.

---

## 8. Parametri di configurazione

Da aggiungere in **tre** punti coerenti col pattern esistente:
1. `apps/api/main.py` → `class BotConfig` (Pydantic `Field`).
2. `apps/api/services/execution.py` → letti via `getattr(cfg, "...", default)`.
3. `apps/web/components/trading-hub/BotConfig.tsx` → interface + DEFAULT_CONFIG + UI (oppure solo nella nuova pagina dedicata — vedi §11).

| Parametro | Tipo | Default | Descrizione |
|---|---|---|---|
| `ai_layer_enabled` | bool | `False` | Master toggle. OFF = sistema identico a oggi. |
| `ai_layer_shadow_mode` | bool | `True` | Logga ma non modifica le decisioni. Default ON per validazione forward. |
| `ai_layer_evaluate_no_trade` | bool | `True` | L'AI elabora un giudizio anche quando il modello dice NO TRADE (informativo in v1). |
| `ai_layer_provider` | str | `"anthropic"` | `anthropic` \| `openai` \| `gemini` \| `deepseek`. |
| `ai_layer_model` | str | `"claude-opus-4-8"` | Modello specifico del provider. |
| `ai_layer_timeout_s` | float | `30.0` | Timeout duro; oltre → fail-open. |
| `ai_layer_weight` | float | `1.0` | Peso globale dell'influenza (0 = nullo, 1 = pieno). |
| `ai_layer_clamp_max` | float | `0.08` | Spostamento massimo della soglia per ciclo. |
| `ai_layer_hard_veto` | bool | `True` | Se `agreement==veto` → blocca il trade. |
| `ai_layer_allow_easing` | bool | `False` | Permette all'AI di **facilitare** (delta negativi). v1: OFF. |
| `ai_layer_min_conviction` | int | `60` | Sotto questa conviction il verdetto è ignorato (rumore). |
| `ai_layer_include_news` | bool | `False` | Include headline news nel dossier (richiede news API). |

> Tutti `getattr(cfg, "...", default)` → retro-compatibili con le config Supabase esistenti senza migrazione.

---

## 9. Persistenza e log (Supabase)

Nuova tabella `ai_decisions` (una riga per ciclo in cui l'AI è stata chiamata):

```sql
create table ai_decisions (
  id              bigint generated always as identity primary key,
  created_at      timestamptz default now(),
  bar_time        timestamptz,
  symbol          text,
  provider        text,
  model           text,
  shadow_mode     boolean,
  -- input
  proposed_action text,           -- long/short del modello
  lgbm_prob       float,
  current_price   float,
  dossier         jsonb,          -- snapshot completo del dossier (audit + replay)
  -- output AI
  agreement       text,           -- confirm/neutral/veto
  conviction      int,
  threshold_adjustment float,     -- grezzo
  applied_adjustment   float,     -- dopo clamp/weight/asimmetria
  flags           text[],
  invalidation_level float,
  report_it       text,
  -- esito
  final_action    text,           -- azione dopo l'AI Layer
  changed_decision boolean,       -- l'AI ha cambiato l'esito?
  latency_ms      int,
  error           text            -- popolato se fail-open
);
```

> Questa tabella **è la validazione forward**: permette di rispondere a "quante volte l'AI ha vetato? quei trade vetati sarebbero stati perdenti? l'AI sta aiutando o danneggiando?".

---

## 10. Endpoint API (FastAPI, `main.py`)

| Metodo | Path | Scopo |
|---|---|---|
| `GET` | `/ai-layer/status` | Stato corrente: enabled, shadow, provider, modello, chiavi disponibili. |
| `GET` | `/ai-layer/decisions?limit=50` | Ultime decisioni AI (per il log nella pagina). |
| `GET` | `/ai-layer/decisions/{id}` | Dettaglio singola decisione (dossier completo + report). |
| `GET` | `/ai-layer/providers` | Provider disponibili (in base alle env key presenti) + modelli selezionabili. |
| `POST` | `/ai-layer/test` | Esegue una valutazione di prova sull'ultimo ciclo (dry-run, non esegue trade). |
| `GET` | `/ai-layer/stats` | Aggregati: % veto, % confirm, decisioni cambiate, impatto stimato. |

> I parametri `ai_layer_*` si salvano/leggono attraverso l'endpoint config esistente del bot (stessa pipeline di `BotConfig`), così sono già persistiti su `bot_configs`.

---

## 11. Pagina frontend dedicata — "Modello AI"

### Registrazione (pattern hub, NON App.tsx)

La pagina è una **sub-page del Trading Hub**. In [TradingHubTab.tsx](../apps/web/components/trading-hub/TradingHubTab.tsx):
1. Aggiungere `'aimodel'` a `VALID_PAGES` e al tipo `HubPage`.
2. Aggiungere la voce in `navItems` (label "Modello AI", icona dedicata).
3. Aggiungere nello switch: `{page === 'aimodel' && <AILayerPanel apiBase={API_BASE} />}`.
4. Nuovo file `apps/web/components/trading-hub/AILayerPanel.tsx`.

> La route `/hub/:page` esiste già ([App.tsx:430](../apps/web/App.tsx#L430)) → `/hub/aimodel` funziona automaticamente. Nessuna modifica ad App.tsx.

### Struttura della pagina `AILayerPanel.tsx`

**Sezione A — Controllo**
- Toggle master **Attiva valutazione AI** (`ai_layer_enabled`).
- Toggle **Shadow mode** (con spiegazione: "logga senza influenzare — consigliato per le prime settimane").
- Badge stato live: ATTIVO / SHADOW / SPENTO.

**Sezione B — Modello AI**
- Selettore **Provider** (Anthropic / OpenAI / Gemini / DeepSeek) — i provider senza chiave in env appaiono disabilitati con tooltip "chiave API mancante".
- Selettore **Modello** (popolato in base al provider).
- Pulsante **Test ora** → chiama `POST /ai-layer/test`, mostra il verdetto sull'ultimo ciclo senza eseguire.

**Sezione C — Parametri d'influenza**
- Slider **Peso** (`ai_layer_weight` 0→1).
- Slider **Clamp massimo soglia** (`ai_layer_clamp_max`).
- Slider **Conviction minima** (`ai_layer_min_conviction`).
- Toggle **Veto duro** (`ai_layer_hard_veto`).
- Toggle **Permetti di facilitare** (`ai_layer_allow_easing`) — con warning "abilita solo dopo validazione forward".
- Input **Timeout** (`ai_layer_timeout_s`).
- Toggle **Includi news** (`ai_layer_include_news`).

**Sezione D — Log decisioni (il cuore UX)**
- Lista delle ultime decisioni (`GET /ai-layer/decisions`), **una card per OGNI ciclo 4H** — inclusi i cicli in cui il modello è rimasto fuori (no-trade), così non ci sono buchi nel log:
  - Header: data/ora · azione proposta dal modello (long/short/**no-trade**) · esito finale · badge `agreement` colorato (verde confirm / grigio neutral / rosso veto).
  - **Report scritto in italiano** (`report_it`) — leggibile a colpo d'occhio.
  - Riga metriche: conviction, adj applicato, flags (chip), livello di invalidazione, latenza.
  - Indicatore "🔵 ha cambiato la decisione" se `changed_decision`.
  - Espandibile → dossier completo (struttura, livelli, macro) per chi vuole il dettaglio.

**Sezione E — Statistiche**
- `GET /ai-layer/stats`: % veto, % confirm, n° decisioni cambiate, distribuzione flags. Per capire forward se l'AI sta aiutando.

### UX del report (esempio reale, problema #1)

> **05 giu, 16:00 · Modello: SHORT @ 60.419 → Esito: ⛔ NO TRADE (veto AI)**
> 🔴 **VETO** · conviction 82 · adj +0.08
> *"Il prezzo scende da 6 giorni e ha appena segnato un nuovo minimo a 60.1k con ADX crollato a 14 (trend esausto). La struttura 4H ha appena fatto un CHoCH rialzista e il prezzo sta rimbalzando dal minimo. Shortare qui significa vendere il minimo contro un'inversione in corso: rischio/rendimento pessimo. Invalidazione sotto 59.4k."*
> Flags: `selling_the_low` `exhaustion` `counter_structure`

---

## 12. Variabili d'ambiente (VPS `.env`)

Stato reale verificato nei `.env` del progetto (`.env.local` + `apps/api/.env`):

```bash
GEMINI_API_KEY=...         # ✅ GIÀ PRESENTE (aistudio.google.com)
COINGLASS_API_KEY=...      # ✅ già presente → usabile per Open Interest nel dossier
COINALYZE_API_KEY=...      # ✅ già presente → derivati / OI alternativi
FMP_API_KEY=...            # ✅ già presente → news (dossier opzionale v1.1)

ANTHROPIC_API_KEY=...      # ❌ DA AGGIUNGERE → console.anthropic.com → Settings → API Keys → Create Key
OPENAI_API_KEY=...         # 🔲 placeholder (platform.openai.com) — quando fornirai la chiave
DEEPSEEK_API_KEY=...       # 🔲 placeholder (platform.deepseek.com) — quando fornirai la chiave
```

> La chiave va messa in **entrambi** i `.env` (locale per i test + VPS per il live). Senza una chiave, il provider corrispondente è disabilitato in UI e selezionarlo non è possibile. Il default (`anthropic`) richiede `ANTHROPIC_API_KEY` → è l'unica che devi procurarti per partire. **Gemini è già pronto**, quindi in alternativa puoi avviare M1 direttamente con Gemini senza procurarti nulla.

---

## 13. Fallback e gestione errori (dettaglio)

| Scenario | Comportamento |
|---|---|
| Chiave provider mancante | Provider non selezionabile; se selezionato in config → fail-open, log warning. |
| Timeout (> `ai_layer_timeout_s`) | `asyncio.wait_for` solleva → verdict `None` → fail-open (LGBM-only). |
| HTTP error / rate limit | catch → verdict `None` → fail-open. |
| JSON malformato | `_extract_json` + `_validate_verdict` falliscono → verdict `None` → fail-open. |
| Verdetto fuori schema/range | scartato → fail-open. |
| `conviction < ai_layer_min_conviction` | verdetto ignorato (nessun effetto), ma loggato. |
| Eccezione in `build_dossier` | catch → fail-open. |

> **Regola d'oro:** l'AI Layer non può MAI bloccare, rallentare oltre il timeout, o far crashare il ciclo. Nel dubbio, il bot fa quello che fa oggi.

---

## 14. Validazione forward (sostituto del backtest)

1. **Fase Shadow (2-4 settimane):** `ai_layer_enabled=True`, `ai_layer_shadow_mode=True`. L'AI gira e logga su `ai_decisions` ma non tocca i trade. Si raccolgono i verdetti.
2. **Analisi:** dalla tabella `ai_decisions` incrociata con `trades` — i trade che l'AI avrebbe vetato sarebbero stati perdenti? Il veto ha un edge statistico? I `report_it` sono sensati rivedendoli a posteriori?
3. **Fase Live veto-only:** se l'analisi conferma valore → `ai_layer_shadow_mode=False` con `ai_layer_hard_veto=True`, `ai_layer_allow_easing=False`. L'AI può solo bloccare.
4. **Fase Live completa (opzionale, futura):** se anche il veto live dà valore → si valuta `ai_layer_allow_easing=True` per dare all'AI anche il potere di facilitare/modulare gradualmente.

---

## 15. Fasi di rollout (milestone implementative)

- **M1 — Backend core (no UI):** `ai_context.py` + `ai_analyst.py` (solo provider Anthropic) + aggancio in `execution.py` in **shadow mode** + tabella `ai_decisions` + log. Deploy. → si comincia a raccogliere dati.
- **M2 — Config & parametri:** parametri `ai_layer_*` in `main.py` + `getattr` in execution + endpoint `/ai-layer/*`.
- **M3 — Multi-provider:** OpenAI + Gemini + DeepSeek nell'astrazione `ai_analyst.py`.
- **M4 — Pagina frontend:** `AILayerPanel.tsx` completa (controllo, parametri, log, report, stats) + registrazione hub.
- **M5 — Attivazione veto live:** dopo validazione forward, `shadow_mode=False`.
- **M6 (futuro) — v2:** estensione alla **gestione/uscita** posizione + eventuale `allow_easing`.

---

## 16. Checklist file-by-file

**Backend (nuovi):**
- [ ] `apps/api/services/ai_context.py` — costruzione dossier (struttura + macro + verdetto).
- [ ] `apps/api/services/ai_analyst.py` — astrazione multi-provider + `evaluate()` + system prompt + parsing.
- [ ] `apps/api/services/ai_persistence.py` (o dentro un service esistente) — `persist_ai_decision()`.

**Backend (modifiche):**
- [ ] `apps/api/services/execution.py` — blocco AI Layer dopo `decide()` (~riga 1769); fail-open; persistenza.
- [ ] `apps/api/services/decision.py` — esporre `threshold_long`/`threshold_short` nel `DecisionResult` (per il percorso graduale; non serve per il veto-only).
- [ ] `apps/api/main.py` — `class BotConfig`: 11 nuovi `Field` `ai_layer_*`; nuovi endpoint `/ai-layer/*`.
- [ ] (se serve OI) HL client — `get_open_interest()`.
- [ ] Supabase — tabella `ai_decisions`.

**Frontend (nuovi):**
- [ ] `apps/web/components/trading-hub/AILayerPanel.tsx` — pagina completa.

**Frontend (modifiche):**
- [ ] `apps/web/components/trading-hub/TradingHubTab.tsx` — `VALID_PAGES` + `navItems` + switch render.
- [ ] (opzionale) `BotConfig.tsx` — se si vuole una scorciatoia ai parametri principali anche lì.

**Deploy:**
- [ ] `.env` VPS — chiavi API provider.
- [ ] `requirements.txt` — SDK provider (`anthropic`, `openai`, `google-genai`; DeepSeek usa `openai`).
- [ ] Deploy backend + frontend + restart servizio (guida `deploy-vps-guide.md`).

---

## 17. Riepilogo decisioni chiave (congelate)

| Tema | Decisione |
|---|---|
| Backtest | Non applicabile. Validazione **forward/shadow**. |
| Input AI | **Solo testo** (struttura calcolata + macro + verdetto). Niente immagini. |
| Accesso dati | **Dossier curato dal server**, non agentico. L'AI non naviga. |
| Influenza | Configurabile, **clampata**. v1 **solo veto/freno**, facilitazione disattivata. |
| Provider | Anthropic (default), OpenAI, Gemini, DeepSeek — selezionabili. |
| Fallback | **Fail-open**: errore/timeout → solo LGBM (comportamento attuale). |
| Caso d'uso #1 | Evitare lo **short tardivo in esaurimento / vendere il minimo** (e simmetrico). |
| NO Trade | L'AI **elabora sempre un giudizio** (`ai_layer_evaluate_no_trade=True`), anche quando il modello sta fuori. In v1 è **informativo** (non apre trade); diventa azionabile solo con `allow_easing`. |
| Sotto-modello | Selettore **a due livelli**: provider → modello specifico (Opus/Sonnet/Haiku, ecc.) da catalogo per provider. |
| Chiavi | Gemini ✅ già in `.env` · Anthropic da aggiungere · GPT/DeepSeek placeholder. OI già disponibile via Coinglass/Coinalyze. |
| Pagina | Sub-page hub `/hub/aimodel`, con log + report scritto in italiano (anche sui no-trade). |
| Scope v1 | Solo **entrata**. Gestione/uscita → v2. |
| Default | Tutto OFF / shadow → zero regressione finché non lo attivi tu. |
```
