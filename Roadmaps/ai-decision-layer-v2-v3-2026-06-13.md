# AI Decision Layer — Roadmap v2 / v3

> **Data:** 2026-06-13
> **Prerequisito:** AI Decision Layer v1 (entrata) live in shadow — vedi
> [ai-decision-layer-2026-06-13.md](ai-decision-layer-2026-06-13.md).
> **Stato:** Piano, non implementato. Priorità: **v2** (gestione/uscita) ≫ v3.
> **Principi ereditati da v1 (non negoziabili):** additivo, toggle OFF = identico,
> fail-open, non backtestabile → validazione **forward/shadow**, influenza clampata
> e configurabile, l'AID è un **giudice**, non un operatore autonomo.

---

## Indice
- [v2 — AI Position Management (gestione/uscita)](#v2) ← **priorità**
- [v3 — SL/TP strutturale AI + allow_easing](#v3)

---

<a name="v2"></a>
# v2 — AI Position Management (gestione/uscita) 🎯

## 0. Obiettivo

Estendere l'AI da **filtro d'ingresso** a **revisore della posizione aperta**: ad
ogni ciclo 4H in cui c'è una posizione, l'AI valuta se la tesi d'ingresso **regge
ancora** o se la struttura si sta girando contro, e propone un'azione difensiva.

### Il problema che risolve

Il modello apre bene ma **tiene troppo a lungo**: una posizione long resta aperta
mentre il 4H stampa un CHoCH ribassista, l'ADX crolla e il prezzo perde i supporti.
Il sistema attuale reagisce solo con SL/TP fissi, trailing e max-hold — meccanismi
*meccanici*, ciechi alla struttura. L'AI vede la struttura e può dire "esci, la tesi
è invalidata" **prima** che lo SL venga colpito.

## 1. Aggancio architetturale — NON parte da zero

Il sistema ha **già** l'**Adverse Evidence Monitor** (parametri `adverse_*` in
`BotConfig`): monitora il punteggio del reversal detector contro la direzione della
posizione e agisce dopo N cicli avversi, con azioni **già definite**:
`shadow | tighten_sl | partial_close | close`, e parametri
`adverse_score_threshold`, `adverse_confirm_cycles`, `adverse_min_hold_bars`,
`adverse_partial_pct`.

> **v2 = una versione "intelligente" dell'Adverse Evidence Monitor.** Stessa
> tassonomia di azioni, stesso scopo difensivo, ma il segnale avverso viene da un
> **giudizio strutturale dell'AI** invece che da un punteggio meccanico. Riusa
> l'infrastruttura di azioni esistente → integrazione naturale, non un sistema
> parallelo. v2 può **complementare** (l'AI conferma/raffina il monitor) o, a
> validazione avvenuta, **sostituire** la sorgente del segnale avverso.

### Punto d'innesto nel ciclo

Nel loop di gestione posizione di `execution.py` (dove oggi si controllano
SL/TP/trailing/liquidazione/max-hold), **dopo** i controlli deterministici (che
restano il pavimento e NON vengono mai scavalcati), si inserisce la valutazione AI:

```
Ciclo 4H con posizione aperta:
  ├─ Controlli deterministici (SL / TP / liquidazione / trailing / max-hold)  [INVARIATI, pavimento]
  │     se uno scatta → esegui e termina (l'AI non può impedire uno stop)
  ├─ SE ai_mgmt_enabled AND posizione aperta AND bars_held ≥ ai_mgmt_min_hold:
  │     a. build_position_dossier(posizione, struttura, order-flow, P&L corrente)
  │     b. ai_analyst.evaluate_position(...) → AIPositionVerdict
  │     c. fail-open: errore/timeout → nessuna azione (gestione attuale)
  │     d. se NON shadow: applica l'azione clampata (hold/tighten/partial/close)
  │     e. persisti SEMPRE (ai_position_decisions)
  └─ ...
```

## 2. Il "position dossier" (cosa vede l'AI)

Estende il dossier d'ingresso con lo **stato della posizione**:

| Blocco | Campi aggiuntivi vs dossier d'ingresso |
|---|---|
| `position` | side, entry_price, bars_held, current_pnl_pct, current_pnl_R (in multipli di rischio), distanza % da SL e TP, MAE/MFE correnti |
| `thesis_drift` | l'evento strutturale all'ingresso vs ora: la struttura che giustificava il trade è ancora valida? (BOS confermato vs CHoCH contrario) |
| `structure` | identico a v1 (Daily completo + 4H + livelli + liquidità + candele) |
| `orderflow` | identico a v1 (CVD, OI, L/S, volume) — divergenze contro la posizione |
| `macro` | identico a v1 |

> Domanda guida per l'AI: *"data la posizione aperta e la struttura attuale, la
> tesi regge (hold), si sta indebolendo (tighten/partial) o è invalidata (close)?"*

## 3. Schema del verdetto (output JSON)

```json
{
  "action": "hold | tighten_sl | partial_close | close",
  "conviction": 0,
  "thesis_status": "intact | weakening | invalidated",
  "suggested_sl": null,
  "partial_pct": 0.0,
  "flags": ["choch_against", "momentum_fading", "into_hostile_level", "thesis_intact"],
  "report_it": "Spiegazione sintetica in italiano."
}
```

- `action` riusa la tassonomia dell'Adverse Monitor.
- `tighten_sl`/`suggested_sl`: vincolato (vedi §5) — può solo **stringere**, mai
  allargare lo SL (non si aumenta mai il rischio).
- `partial_pct`: clampato a `ai_mgmt_partial_max`.

## 4. Parametri di configurazione

| Parametro | Default | Descrizione |
|---|---|---|
| `ai_mgmt_enabled` | `False` | Master toggle gestione AI. |
| `ai_mgmt_shadow_mode` | `True` | Logga senza agire. |
| `ai_mgmt_min_hold_bars` | `3` | Non interviene prima di N barre (evita panico precoce). |
| `ai_mgmt_max_action` | `tighten_sl` | Azione **massima** consentita: `hold` < `tighten_sl` < `partial_close` < `close`. Limita quanto può "osare" l'AI. |
| `ai_mgmt_min_conviction` | `70` | Soglia di conviction più alta che in entrata (un'uscita è più impattante). |
| `ai_mgmt_partial_max` | `0.50` | Frazione massima di chiusura parziale. |
| `ai_mgmt_sl_tighten_max_pct` | `0.5` | Quanto può stringere lo SL per ciclo (% del rischio). |
| `ai_mgmt_provider` / `ai_mgmt_model` | erediti da v1 | Provider/modello (può differire dall'entrata). |

## 5. Vincoli di sicurezza (il cuore di v2)

1. **I controlli deterministici sono il pavimento.** SL/TP/liquidazione scattano
   sempre per primi; l'AI **non può mai impedire uno stop** né allargare lo SL.
2. **Asimmetria difensiva.** L'AI può solo **ridurre il rischio** (stringere SL,
   chiudere parziale/totale). Non può aggiungere size, allargare SL, spostare TP
   più lontano.
3. **Azione massima limitata** da `ai_mgmt_max_action`: in partenza `tighten_sl`
   (la più conservativa che agisce). Il potere di `close` si sblocca solo dopo
   validazione forward.
4. **Conviction minima alta** (default 70): un'uscita sbagliata su una conviction
   debole costa più di un veto sbagliato.
5. **min_hold_bars**: niente interventi nelle prime barre (evita di chiudere per
   rumore intra-trade).
6. **Fail-open**: errore/timeout → gestione deterministica attuale, invariata.
7. **Shadow-first obbligatorio**: settimane di log "cosa avrebbe fatto" prima di
   dare poteri reali, incrociando con l'esito effettivo dei trade.

## 6. Persistenza & frontend

- Tabella `ai_position_decisions` (o estensione di `ai_decisions` con `kind =
  entry | management`): posizione, P&L al momento, verdetto, azione applicata,
  esito successivo.
- Pagina "Modello AI": nuova sezione **"Gestione posizione"** con toggle, parametri,
  e un log dedicato delle azioni difensive con report in italiano.

## 7. Rischi & mitigazioni

| Rischio | Mitigazione |
|---|---|
| L'AI chiude per panico buoni trade (taglia i vincenti) | `max_action=tighten_sl` iniziale, conviction 70+, min_hold, shadow-first, misura il "rimpianto" (avrebbe chiuso trade poi tornati in profitto?) |
| Controllo non-deterministico del P&L | Asimmetria difensiva (solo riduzione rischio) + pavimento deterministico |
| Non backtestabile | Validazione forward/shadow, come v1 |
| Latenza intra-gestione | Stesso budget timeout di v1 (~secondi su barre 4H); fail-open oltre |
| Conflitto con Adverse Monitor / trailing | Una sola sorgente attiva per volta; v2 integra/sostituisce il monitor, non si somma |

## 8. Milestone v2

- **v2-M1**: `build_position_dossier` + `evaluate_position` + system prompt gestione. Hook in shadow. Tabella di log.
- **v2-M2**: parametri `ai_mgmt_*` + sezione frontend + log.
- **v2-M3**: attivazione live `tighten_sl` dopo validazione forward.
- **v2-M4**: sblocco graduale `partial_close` → `close` se i dati confermano edge.
- **v2-M5**: decisione se l'AI **sostituisce** la sorgente dell'Adverse Monitor.

---

<a name="v3"></a>
# v3 — SL/TP strutturale AI + allow_easing

Due funzioni indipendenti, entrambe a rischio più alto → **dopo** v2 e solo con
validazione forte.

## v3a — SL/TP strutturale suggerito dall'AI

**Cosa**: in entrata, l'AI suggerisce di **agganciare lo SL a un livello
strutturale** che identifica (es. "dietro il minimo swing a X"), invece del puro
ATR. Il sistema **snappa** a un livello reale, **clampa** entro un range e
**valida** con regole di sanità.

| Pro | Contro / Rischi |
|---|---|
| SL posizionato dietro struttura reale → meno stop-out su rumore, R:R migliore | Controllo diretto di un parametro di rischio; non-determinismo dove fa più male |
| Sfrutta la lettura strutturale che l'AI già fa | Il sistema ha **già** SL strutturale deterministico (`apply_structural_sl`/`apply_fvg_sl`/`apply_swing_sl`) — sovrapposizione |

**Vincoli**: solo **suggerimento** (mai prezzo grezzo applicato direttamente);
snap obbligatorio a un livello presente nel dossier; clamp `±X%` dall'SL base;
mai più largo dell'SL ATR (non aumenta il rischio); opt-in; shadow-first.

**Verdetto**: utile ma marginale finché lo SL strutturale deterministico funziona.
Bassa priorità.

## v3b — allow_easing (l'AI può facilitare, non solo frenare)

**Cosa**: il parametro `ai_layer_allow_easing` (già presente, default OFF) viene
attivato: l'AI può **abbassare** la soglia o **aprire** un trade che il modello ha
scartato (quando vede un setup forte mancato dal modello).

| Pro | Contro / Rischi |
|---|---|
| Cattura buoni setup che il modello non vede | Molto più rischioso del veto: l'AI **forza** trade reali |
| Sfrutta il giudizio AI in positivo, non solo difensivo | Un falso positivo apre una perdita; il veto sbagliato costa solo un'occasione |

**Vincoli**: attivabile **solo** dopo che mesi di shadow dimostrano che i "veto su
no-trade" (= setup mancati segnalati) avrebbero avuto edge positivo; clamp stretto;
conviction molto alta; mai su contro-struttura HTF.

**Verdetto**: da considerare **solo** con prove forward solide. È il passo più
rischioso dell'intero progetto.

## Milestone v3

- **v3-M1**: analisi forward dei "veto su no-trade" loggati in v1 → hanno edge?
- **v3-M2** (se sì): v3b allow_easing in shadow → live clampato.
- **v3-M3**: v3a SL strutturale suggerito, in shadow.

---

## Riepilogo priorità

| Versione | Cosa | Priorità | Rischio | Prerequisito |
|---|---|---|---|---|
| **v2** | Gestione/uscita posizione (difensiva) | **Alta** | Medio (mitigato da asimmetria difensiva + pavimento deterministico) | v1 in shadow validato |
| v3a | SL strutturale suggerito | Bassa | Medio | v2 |
| v3b | allow_easing (apre trade) | Bassa | **Alto** | mesi di forward su v1 |

> Filo conduttore: ogni passo sposta l'AI da *giudice* a *operatore*. v2 lo fa in
> modo **solo difensivo** (riduce rischio) → accettabile presto. v3b lo fa in modo
> **offensivo** (apre/forza trade) → solo con prove forti. Mai saltare lo shadow.
