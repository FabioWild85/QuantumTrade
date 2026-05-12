# Liquidity Provision Passiva su Solana (JLP) — Piano di implementazione

> Documento redatto il 12 Maggio 2026.
> Scopo: definire una strategia di rendita passiva sull'ecosistema Solana (Jupiter Liquidity Pool) come **complemento** — non alternativa — al sistema AI Trading Hub su Hyperliquid descritto in `ai-trading-hub-roadmap.md`.
> **Nessun codice in questo documento**: è un blueprint di treasury management personale.

---

## PARTE 0 — TL;DR

**Cosa è:** acquistare token **JLP** (Jupiter Liquidity Provider) e detenerli. Sei automaticamente co-proprietario di un pool di liquidità che fornisce leva ai trader di Jupiter Perps. Ricevi il **75% di tutte le fees** generate dai trader leveraged.

**Cosa NON è:** non è "market making" attivo con bot 24/7. Non è scommessa direzionale. È più simile a un **conto deposito ad alto rendimento** con esposizione a un basket crypto.

**Numeri di sintesi:**
- **APY storico**: 25–55% (variabile per regime di mercato).
- **Probabilità di essere profittevoli a 12 mesi**: ~70%.
- **Capitale minimo sensato**: $1.000.
- **Tempo di gestione**: 1 giorno setup + ~5 minuti/settimana.
- **Skill richiesta**: DeFi 101 (saper usare Phantom + Ledger).

**Verdetto:** strategia adatta per parcheggiare capitale non operativo dell'AI Trading Hub. **Non sostituisce** trading attivo, lo completa.

---

## PARTE 1 — Nota su "Market Making attivo": perché NON è in questo piano

Per completezza definitoria: il **market making attivo** classico significherebbe gestire un bot 24/7 che piazza simultaneamente ordini limit di buy e sell sull'orderbook di un DEX (es. **Drift Protocol** su Solana, che offre maker rebate -0.02%), aggiustandoli in tempo reale per guadagnare dallo spread bid-ask più il rebate.

**Perché non lo includo nella roadmap:**

1. **Latenza retail inadeguata.** I competitor sono Wintermute, Flow Traders, retail-pro con RPC privati (10–30ms). Tu avresti un VPS con RPC pubblico (200–800ms). Sport diverso.
2. **Adverse selection è il killer silenzioso.** I tuoi quote vengono colpiti soprattutto quando sono sbagliati. Senza ML adversarial detection (mesi di research), perdi 5–20bps su ogni fill "cattivo".
3. **Probabilità di profittabilità retail < 20%** anche con 6 mesi di lavoro full-time.
4. **Capitale minimo sensato $50.000+** per coprire i costi fissi (infra, monitoring, slippage).
5. **Tempo speso meglio altrove**: lo stesso effort produce un AI Trading Hub con 3× la probabilità di successo.

**Conclusione:** Pure Active MM lo cito qui solo per chiudere il cerchio definitorio. **Non procedere mai con questa variante**, almeno fino a quando non hai capitale 6 cifre + esperienza quant professionale.

---

## PARTE 2 — Come funziona JLP (meccanica chiara)

### 2.1 Cos'è il pool

JLP è un token che rappresenta una quota di un **basket multi-asset** gestito dallo smart contract di Jupiter Perps. Composizione attuale tipica:

| Asset | Quota approx |
|-------|--------------|
| SOL | 45% |
| BTC (wrapped) | 25% |
| ETH (wrapped) | 10% |
| USDC | 12% |
| USDT | 8% |

Quando i trader su Jupiter Perps aprono una posizione leveraged (es. long BTC 10x), **prendono in prestito** dal pool. Il pool è la controparte di tutte le posizioni leveraged sul protocollo.

### 2.2 Come guadagni

I trader pagano al pool:
1. **Borrow rate**: ~0.01%/ora sul nominale della posizione = ~88%/anno. Pagato continuamente.
2. **Open fee**: 0.06% sul nominale all'apertura.
3. **Close fee**: 0.06% sul nominale alla chiusura.
4. **Price impact fee**: variabile, su trade grossi.

Di queste fees, **il 75% va ai detentori di JLP** (auto-reinvestito nel pool tramite aumento del prezzo unitario JLP), il 25% va al protocollo.

### 2.3 Come perdi

1. **Quando i trader vincono**: se i long che hanno preso a prestito BTC chiudono in profitto, il pool paga loro la differenza. Il pool è **short la performance dei trader leveraged**.
2. **Quando il basket scende in USD**: se SOL crolla -30%, anche se il numero di JLP che possiedi cresce per via delle fees, il **valore in USD** del tuo JLP scende.
3. **Smart contract exploit**: rischio sempre presente. Jupiter è auditato (OtterSec, Halborn) ma nessun audit è una garanzia.

### 2.4 Perché statisticamente vince il pool

Sul lungo termine, **la maggioranza dei trader retail leveraged perde**. Statistiche pubbliche (Hyperliquid, dYdX, Binance Futures) mostrano che il **70–85% dei trader retail leveraged è in perdita** dopo 6 mesi. Questa è la stessa dinamica del "house edge" di un casinò: ogni mano singola è incerta, ma sul long run la casa vince.

**Tenendo JLP, sei la casa.** Non guadagni in ogni singolo periodo, ma in expectation di lungo termine sì.

### 2.5 APY storico (numeri reali)

Da dashboard Dune Analytics su JLP, performance osservate:

| Periodo | APY medio realizzato | Note |
|---------|----------------------|------|
| 2024 H1 | +50–60% | Mercato ranging, traders perdono molto |
| 2024 H2 | +25–40% | Rally BTC ETF, alcuni long vincono |
| 2025 Q1 | +35–50% | Volatilità elevata, fees alte |
| 2025 Q2–Q3 | +30–45% | Regime misto |
| Media 18 mesi | **~38%** | Includendo periodi cattivi |

**Aspettativa futura realistica**: 20–35% APY medio. La concorrenza diluirà l'edge nel tempo.

---

## PARTE 3 — Rischi (onestamente)

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|-------------|---------|-------------|
| **Drawdown da rally unidirezionale** dei trader | 🟡 Periodica | -10/-20% NAV in settimane | Hold attraverso, è ciclico |
| **Crollo SOL** (45% del basket) | 🟡 Media | -20/-40% NAV in USD | Diversificazione del basket aiuta, ma esposizione SOL resta |
| **Exploit smart contract Jupiter** | 🟢 Bassa | Perdita totale | Cap esposizione al 25% capitale liquido / 5% net worth |
| **Phishing / wallet drainer** | 🟡 Media (rischio retail #1) | Perdita totale | Hardware wallet obbligatorio + wallet dedicato |
| **Riduzione APY per concorrenza** | 🟡 Alta nel lungo termine | APY converge verso 15–25% | Accettabile: 20% APY è comunque ottimo |
| **Cambio governance / fee structure** | 🟡 Media | Riduzione 20–40% APY | Exit pianificato se APY 90d < 15% |
| **Rischio regolatorio (Italia/UE)** | 🟡 Media | Tassazione punitiva o restrizioni | Exit pianificato se cambia framework |
| **Solana network downtime** | 🟢 Bassa (migliorata) | Impossibilità temporanea di exit | Hold attraverso, l'outage è temporaneo |

**Worst-case realistico** (rolling 12 mesi): -30/-40% NAV in USD. **Probabilità di questo scenario**: ~10%.

**Best-case realistico**: +60% NAV in USD. **Probabilità**: ~20%.

**Caso modale**: +20/+35% NAV. **Probabilità**: ~70%.

---

## PARTE 4 — Profittabilità realistica e confronto

### 4.1 Su $2.500 di capitale impegnato

| Scenario | Probabilità | NAV finale 12m |
|----------|-------------|----------------|
| Best (mercato ranging, basket stabile) | ~20% | ~$3.500–4.000 |
| Modale (regime misto) | ~50% | ~$2.900–3.300 |
| Mediocre (alcuni rally adverse) | ~20% | ~$2.500–2.800 |
| Bad (crollo SOL o exploit minore) | ~10% | ~$1.500–2.200 |

**Expected value 12 mesi**: ~$3.050. **Expected return**: ~+22% netto.

### 4.2 Confronto rapido con alternative

| Strumento | APY expected | Probabilità profitto | Capitale min |
|-----------|--------------|----------------------|--------------|
| Conto deposito EUR | 3–4% | ~100% | €1 |
| Staking ETH | 3.2% | ~99% | $50 |
| BTC HODL | -30% / +80% (incerto) | ~55% | qualunque |
| **JLP** | **+22%** | **~70%** | $1.000 |
| AI Trading Hub HL | 0/+30% (incerto) | ~35% | $1.000 |

**JLP ha il miglior rapporto APY × probabilità tra le opzioni "rendita".** Non sostituisce trading attivo (che ha valore educativo e upside), ma è il modo migliore per **far rendere il capitale non operativo**.

---

## PARTE 5 — Piano di implementazione

### Fase 0 — Pre-flight (1 giorno, ~4–6 ore)

- [ ] **Studio meccanica JLP**: leggere `station.jup.ag/docs/perpetual-exchange/jlp-overview`.
- [ ] **Verifica APY storico**: controllare `dune.com/agaperste/jlp-jupiter-liquidity-pool` (dashboard pubblica) per APY rolling 30/90 giorni ultimi 12 mesi.
- [ ] **Audit di letture**: leggere executive summary degli audit OtterSec e Halborn (link nei docs Jupiter).
- [ ] **Decisione capitale**: max 25% del capitale liquido investibile, mai oltre 5% del net worth totale. **Scrivere il numero su carta prima di andare avanti.**
- [ ] **Decisione fiscale**: consultare commercialista per inquadramento (in Italia: probabile reddito di capitale 26%, monitoraggio fiscale Form RW se NAV > €15.000).

### Fase 1 — Setup wallet sicuro (1 giorno, ~2 ore)

- [ ] **Nuovo wallet Phantom dedicato**: NON riutilizzare wallet esistenti. Installare Phantom da fonte ufficiale `phantom.app`.
- [ ] **Hardware wallet** (Ledger Nano S Plus o X): firmware aggiornato, app Solana installata.
- [ ] **Collegare hardware a Phantom**: "Add account" → "Connect hardware wallet" → seguire procedura.
- [ ] **Seed phrase del Phantom**: scritta su carta + salvata in posto sicuro fisicamente. **Mai online, mai foto, mai cloud.**
- [ ] **Test di sicurezza**: simulare la procedura di firma con hardware su una transazione piccola di prova ($5–10).

### Fase 2 — Acquisizione USDC su Solana (mezza giornata)

- [ ] **Scegli rampa di ingresso**: opzioni in ordine di preferenza:
  1. **Withdraw da CEX** (Binance, Kraken, Coinbase) direttamente su Solana — fees minime, niente bridge.
  2. **Bridge via Wormhole / DeBridge** da ETH/BSC se hai già crypto su altre chain.
  3. **On-ramp diretto** (MoonPay, Banxa via Phantom) — più costoso ma facile.
- [ ] **Trasferisci la quota decisa** in USDC sull'indirizzo del wallet Phantom.
- [ ] **Verifica**: USDC arriva su Solana, balance visibile in Phantom.

### Fase 3 — Acquisto JLP (30 minuti)

- [ ] Vai su **`jup.ag/perps-earn`** (interfaccia ufficiale — verifica sempre l'URL, attenzione a phishing).
- [ ] Click "Connect Wallet" → seleziona Phantom.
- [ ] Tab "Earn" → "Deposit USDC" → inserisci ammontare.
- [ ] Review: vedi quanto JLP riceverai al prezzo corrente.
- [ ] Conferma transazione → firma con Ledger.
- [ ] Attendi conferma on-chain (~10–20 secondi).
- [ ] **Verifica balance**: vai su `jup.ag/portfolio` → vedi i tuoi JLP token.

### Fase 4 — Tracking & monitoring (settimanale, 5 min)

**Niente bot custom, niente dashboard sviluppata.** Per uso personale serve solo:

- [ ] **Bookmark**: `jup.ag/portfolio` + tuo wallet address.
- [ ] **Google Sheet** (template colonne):
  ```
  | Data | JLP balance | JLP price USD | NAV USD | APY 30d | Note |
  ```
- [ ] **Aggiornamento**: ogni domenica alle stesso orario, 5 minuti per inserire dati. La regolarità conta più della frequenza.
- [ ] **Alert prezzo SOL**: imposta su Phantom o app dedicata (Birdeye, CoinGecko). Notifica se SOL scende > 20% dal tuo prezzo medio di acquisto. **Non è un trigger di vendita**, è un trigger di **review**.
- [ ] **Tax tracking**: registrare NAV USD a inizio anno fiscale, fine anno fiscale, ogni claim/vendita.

### Fase 5 — Strategia di uscita (definita a freddo)

**Triggers di vendita parziale o totale (decisi adesso, applicati senza emozione):**

| Trigger | Azione |
|---------|--------|
| NAV USD ≥ acquisto × 1.5 (+50%) | Vendi 25% del JLP, sposta in stablecoin |
| NAV USD ≥ acquisto × 2.0 (+100%) | Vendi altro 25% |
| JLP supera 30% del net worth | Rebalance: vendi quanto basta per tornare a 25% |
| APY rolling 90 giorni < 15% | Valuta exit graduale (50% nei mesi successivi) |
| Exploit Jupiter (anche minore) confermato | Vendi tutto immediatamente, anche a perdita |
| Cambio fiscale punitivo Italia/UE | Exit pianificato entro fine anno fiscale |
| Necessità personale di liquidità | Vendi quanto serve, mai più del necessario |

**Trigger che NON applicare** (sono trappole emotive):
- ❌ "SOL sta scendendo, vendo per non perdere altro" — il drawdown è normale, holding attraverso.
- ❌ "L'APY è esploso questo mese, compro altro JLP" — chasing.
- ❌ "Un influencer su Twitter dice che Jupiter sta morendo" — verifica solo i fatti on-chain.

---

## PARTE 6 — Costi reali

### 6.1 Costi infrastrutturali

**Zero ricorrenti.** Niente VPS, niente bot, niente subscription.

### 6.2 Costi di acquisto/uscita (round-trip)

| Voce | Costo |
|------|-------|
| Withdraw USDC da CEX → Solana | $0.50–2 |
| Mint JLP (fee Jupiter) | 0.10–0.30% del capitale |
| Burn JLP (fee Jupiter) | 0.10–0.30% del capitale |
| Solana network fees | <$0.01 totale |

**Round-trip totale**: 0.30–0.70% del capitale impegnato. Su $2.500: ~$10–17 una tantum.

### 6.3 Costi fiscali (Italia, indicativo)

- Plusvalenze: 26% sulla differenza tra vendita e acquisto in EUR equivalenti.
- IVAFE / monitoraggio fiscale: Form RW se NAV crypto totale > €15.000.
- Imposta di bollo crypto: 0.2% annuo sul saldo, applicabile.

**Non sono consigli fiscali — consulta commercialista.**

### 6.4 Capitale minimo / consigliato

| Livello | Capitale | Aspettativa |
|---------|----------|-------------|
| Test | $100–500 | Familiarizzare, fees mangiano edge |
| Sensato | $1.000–2.500 | Sweet spot per uso personale |
| Significativo | $5.000–10.000 | Rendita visibile mensilmente |
| Massimo prudente | 25% capitale liquido / 5% net worth | Cap di rischio |

---

## PARTE 7 — Definizione di successo

Il progetto JLP è un **successo** se a 12 mesi:

1. ✅ NAV USD finale ≥ NAV iniziale × 1.15 (batte uno stable yield del 5% + buffer di rischio).
2. ✅ Nessuna perdita capitale per smart contract exploit, phishing, hardware failure.
3. ✅ Tutti i record fiscali tracciati e disponibili per dichiarazione (Google Sheet impeccabile).
4. ✅ Tempo totale speso < 30 ore nel primo anno.
5. ✅ Hai applicato i trigger di exit **senza** modifiche emotive in corsa.

Il progetto è un **fallimento** se:

1. ❌ Hai perso > 20% del capitale per una decisione emotiva (vendita in panico).
2. ❌ Hai aumentato l'esposizione oltre il cap deciso (chasing APY).
3. ❌ Hai trascurato la sicurezza wallet (firme senza hardware, click su link sospetti).

---

## PARTE 8 — Integrazione con AI Trading Hub Hyperliquid

I due progetti sono **complementari**. Allocazione consigliata su capitale liquido investibile:

```
60% Cash + staking ETH       → buffer di sicurezza, 3–4% APY
25% JLP (Jupiter Solana)     → rendita passiva, ~25–35% APY expected
15% AI Trading Hub HL         → trading attivo, skill building, alta varianza
 0% Pure Active MM            → mai
```

**Esempio concreto su $10.000**: $6.000 cash, $2.500 JLP, $1.500 AI Hub.

**Perché funzionano insieme:**
- JLP rende ~$625/anno expected, senza richiedere tempo.
- AI Hub è il progetto di crescita personale (skill + portfolio + possibile upside).
- Cash è il margine di errore obbligatorio.
- I tre profili di rischio sono decorrelati: JLP soffre quando il mercato è trendy/unidirezionale, AI Hub può performare meglio in quei regimi (trend following).

---

## Appendice A — Riferimenti

- **Jupiter Perps docs**: `station.jup.ag/docs/perpetual-exchange`
- **JLP overview**: `station.jup.ag/docs/perpetual-exchange/jlp-overview`
- **Dune dashboard JLP**: `dune.com/agaperste/jlp-jupiter-liquidity-pool`
- **Audit OtterSec**: linkato nei docs ufficiali.
- **Audit Halborn**: linkato nei docs ufficiali.
- **Phantom wallet**: `phantom.app`
- **Ledger setup Solana**: `support.ledger.com/article/Solana-SOL`

---

*Fine documento. Prossimo step concreto: **Fase 0 checklist** (studio + decisione capitale). Solo dopo aver completato lo studio, passare alla Fase 1.*
