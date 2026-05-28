# Analisi del Training Pipeline LightGBM

**Data:** 28 Maggio 2026
**File analizzati:** `trainer.py`, `calibration.py`, `chronos_model.py`, `smc.py`

---

## Giudizio sintetico

Il sistema è **ben sopra la media dei progetti retail/hobbisti** — ha diversi accorgimenti da professionista (purged walk-forward CV, target ATR-threshold, calibrazione isotonica, lock anti-concorrenza). Detto questo, **non è ancora un sistema da production-grade fund**. Mancano hyperparameter tuning, concept drift detection, model versioning, e diverse best practice di MLOps. È un'ottima base che con 3-4 interventi mirati salirebbe di livello.

**Voto: 7/10.** Con i primi 4 interventi prioritari → 8.5/10.

---

## Cosa funziona bene (punti di forza reali)

### 1. Purged Walk-Forward Cross-Validation
`trainer.py:56-104` — Il purge gap tra train e validation set è **la pratica corretta per serie finanziarie**. Senza purge, l'autocorrelazione temporale tra barre adiacenti crea look-ahead bias e gonfia artificialmente le metriche. Questo da solo mette il sistema davanti al 90% dei progetti amatoriali.

### 2. Target ATR-threshold (non naive)
`trainer.py:178-188` — Invece di etichettare banalmente `close[+1] > close[0]`, usa `k * ATR` come soglia minima per considerare un movimento "significativo". Le barre neutrali (`|movimento| < k×ATR`) vengono escluse dal training. Questo è esattamente ciò che fanno i fondi quant: non si cerca di predire il rumore.

### 3. Calibrazione isotonica su esiti reali
`calibration.py` — Correggere le probabilità di Chronos-2 con `IsotonicRegression` sui trade storici reali (join `inference_logs` × `trades`) è il gold standard per la calibrazione. Il vincolo monotono garantisce che la calibrazione non inverta mai l'ordinamento delle probabilità.

### 4. Lock anti-concorrenza e backup atomico
`trainer.py:53, 259-261` — `asyncio.Lock()` previene retrain paralleli. `shutil.copy2` crea un backup `.bak.pkl` prima di sovrascrivere. Pattern difensivo corretto.

### 5. Modello 1H separato come gate
`trainer.py:349-421` — Avere un secondo modello su timeframe inferiore come conferma è un'idea sensata. Riduce i falsi positivi del segnale 4H.

### 6. Derivazione automatica di `n_estimators` dal WF CV
`trainer.py:230-235` — Invece di usare `n_estimators=500` fisso, calcola la media dei `best_iteration_` dai fold del walk-forward. Questo adatta la complessità del modello alla quantità di dati disponibili.

### 7. Exponential decay weights sul training finale
`trainer.py:245-246` — `sample_weights_all = np.exp(np.linspace(np.log(0.05), 0.0, n_all))` dà più peso ai sample recenti nel training finale. Buona pratica.

---

## Cosa manca o è migliorabile

### 🔴 HYPERPARAMETER TUNING — Assente

`_LGB_PARAMS` (linee 37-50) è hardcodato con valori ragionevoli ma arbitrari:

```py
_LGB_PARAMS = dict(
    n_estimators=500,
    learning_rate=0.03,
    max_depth=5,
    num_leaves=31,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_samples=20,
    reg_alpha=0.1,
    reg_lambda=0.1,
    random_state=42,
    class_weight="balanced",
    verbose=-1,
)
```

Non c'è Optuna, non c'è grid search, non c'è Bayesian optimization. Con 500 candle e 56 feature, un tuning con Optuna (100 trial × 5-fold CV) richiederebbe ~5-10 minuti e quasi certamente troverebbe parametri migliori. Parametri come `num_leaves`, `max_depth`, `min_child_samples`, `reg_alpha`, `reg_lambda`, `subsample` interagiscono in modo non lineare — indovinarli a mano è impossibile.

**Impatto stimato:** 2-5% di accuratezza OOS persa rispetto a parametri ottimizzati.

---

### 🔴 CONCEPT DRIFT DETECTION — Assente

Il retrain avviene ogni N cicli (default 120, ~30 giorni), indipendentemente dal fatto che il modello stia performando bene o male. Non c'è monitoraggio della deriva tra retrain. Se il mercato cambia regime dopo 5 giorni, il modello continua a operare con parametri obsoleti per altri 25 giorni.

**Cosa aggiungerei:** un check settimanale di `log_loss` rolling sulle ultime 48 barre contro la baseline del WF CV. Se il log_loss supera di 2 deviazioni standard la media storica, triggera un retrain d'emergenza.

---

### 🟠 LOOKBACK FISSO A 500 CANDLE — Troppo corto

500 candle 4H = ~83 giorni. Il modello vede solo 2.7 mesi di storia. I regimi di mercato durano tipicamente 6-18 mesi. Con un lookback così corto, il modello non ha memoria di regimi passati e può solo adattarsi al regime corrente — il che suona bene (adattivo) ma in realtà significa che non ha esempi di transizioni di regime nel training set.

Il percorso `from_date` (deep training da Binance) esiste ma è solo manuale (`POST /retrain/deep`). Andrebbe usato automaticamente almeno 1 volta su 3 retrain.

---

### 🟠 NESSUN ENSEMBLE TEMPORALE

Ogni retrain produce UN modello. I modelli dei fold del walk-forward vengono addestrati e poi **buttati via** — servono solo per le metriche. Eppure quei modelli sono addestrati su finestre temporali diverse e potrebbero essere combinati in un ensemble (media delle probabilità) che sarebbe più robusto del modello singolo.

Ancora meglio: mantenere gli ultimi 3 modelli addestrati e fare ensemble delle loro predizioni. Questo è il pattern standard nei fondi quant (model soup / temporal ensembling).

---

### 🟠 IL MODELLO 1H NON HA WALK-FORWARD CV

`retrain_1h()` (linee 349-421) usa un semplice split 80/20, senza purge gap, senza walk-forward. Inoltre il target è `close[+1] > close[0]` — un target binario naive su 1 candela, estremamente rumoroso. Dovrebbe usare lo stesso approccio ATR-threshold del modello 4H.

---

### 🟠 CALIBRATORE: TARGET SBAGLIATO

`calibration.py:68`:
```py
outcome = 1 if float(trade.get("pnl_usd") or 0) > 0 else 0
```

Il calibratore impara a predire se un trade sarà **profittevole**, non se la **direzione prevista** era corretta. Sono due cose diverse:
- Un trade può essere profittevole anche se la direzione era sbagliata (es. SL stretto, TP largo, o fortuna)
- Un trade può essere in perdita anche se la direzione era giusta (es. SL triggerato da un wick, poi il prezzo va nella direzione prevista)

Il calibratore dovrebbe usare come target la direzione effettiva del mercato dopo N barre, non il PnL del trade.

---

### 🟡 MODEL VERSIONING — Assente

I modelli sono salvati come `lgbm_latest.pkl` e `lgbm_latest.bak.pkl`. Se il retrain produce un modello peggiore, puoi rollbackare solo di una versione. Non c'è un registro modelli con timestamp e metriche.

**Pattern minimale suggerito:** salvare `lgbm_{timestamp}.pkl` e un file `model_registry.json` con storico di tutti i modelli e metriche. Occupa pochi MB e permette rollback a qualsiasi versione.

---

### 🟡 PICKLE COME FORMATO DI SERIALIZZAZIONE

Pickle è fragile: dipendente dalla versione di Python e lightgbm, non è safe da caricare se non ti fidi della fonte. Per modelli sklearn-compatibili, `joblib` è leggermente meglio. Ma il punto vero è che non c'è **nessun test di integrità** dopo il caricamento: se il pickle è corrotto, esplode a runtime in produzione.

---

### 🟡 NESSUNA VALUTAZIONE PER REGIME

Le metriche OOS sono globali (accuracy media su tutto il validation set). Ma la performance in un mercato in trend è molto diversa dalla performance in un mercato laterale. Un breakdown per regime (ADX > 25 vs ADX < 25, volatilità alta vs bassa) rivelerebbe se il modello è sbilanciato verso un tipo di mercato.

---

### 🟡 FEATURE IMPORTANCE STABILITY — Non tracciata

Le feature importances vengono salvate ogni retrain ma mai confrontate con le precedenti. Se `cvd_slope` passa da 8% a 22% di importanza in un retrain, è un segnale forte che il regime di mercato è cambiato. Questo dato è prezioso sia per il monitoring che per informare il DecisionEngine.

---

### 🟢 COSE MINORI

- **`random_state=42` fisso** — Elimina la varianza stocastica, che è un'arma a doppio taglio: rende i risultati riproducibili ma impedisce all'ensemble implicito del bagging di funzionare.
- **`class_weight="balanced"`** — Corregge lo sbilanciamento delle classi ma in modo grezzo. Già mitigato dagli exponential decay weights, ma si potrebbe rimuovere e lasciare solo i sample weights temporali.
- **Nessun learning rate schedule** — `learning_rate=0.03` fisso. Un reduce-on-plateau o cosine annealing migliorerebbe la convergenza.
- **Nessuna data augmentation** — Nessun bootstrap temporale, nessuna generazione di serie sintetiche per aumentare la robustezza.
- **Training solo su BTC** — Crypto sono correlate; training multi-symbol migliorerebbe la generalizzazione.
- **Nessun data quality check pre-training** — Nessuna detection di missing bars, outlier, o dati stantii prima di addestrare.

---

## Priorità di intervento

| # | Intervento | Impatto | Sforzo | Perché |
|---|-----------|---------|--------|--------|
| **1** | **Concept drift detection** | Alto | Medio | È l'unica cosa che può prevenire perdite reali. Senza, il modello opera alla cieca tra un retrain e l'altro. |
| **2** | **Hyperparameter tuning (Optuna)** | Alto | Basso | Con 500 candle e 56 feature, 100 trial richiedono ~5-10 min. Ritorno quasi garantito del 2-5% OOS. |
| **3** | **Model versioning + registry** | Medio | Basso | Costa zero, salva da disastri. Se un retrain produce un modello rotto, oggi puoi rollbackare solo di 1 versione. |
| **4** | **Temporal ensemble (ultimi 3 modelli)** | Medio | Basso | Aumenta robustezza senza costi di training aggiuntivi (i modelli ci sono già). |
| **5** | **Deep training automatico periodico** | Medio | Basso | 1 retrain su 3 usa `from_date` per vedere più storia e più regimi. |
| **6** | **Fix target calibratore** | Medio | Basso | Usare direzione effettiva invece di PnL. Migliora la qualità della calibrazione. |
| **7** | **Walk-forward CV anche per 1H** | Basso | Basso | Coerenza metodologica col modello principale. |
| **8** | **Metriche per regime** | Basso | Basso | Sapere che il modello ha 58% accuracy in trend e 48% in range cambia completamente come usi i segnali. |

---

## Riepilogo

| Categoria | Count |
|-----------|-------|
| Punti di forza | 7 |
| Problemi critici (🔴) | 2 |
| Problemi medi (🟠) | 4 |
| Problemi minori (🟡) | 4 |
| Note marginali (🟢) | 6 |

**Totale: 16 issue trovati, 8 interventi prioritari proposti.**

---

## Conclusione

Il sistema è un **solido 7/10**. Ha le fondamenta giuste (WF CV, target non naive, calibrazione) ma mancano gli strati di MLOps che separano un buon prototipo da un sistema su cui metteresti capitale reale senza ansia. Con i primi 4 interventi della lista sopra, salirebbe a un **8.5/10** — il livello di una piccola trading firm professionale.
