





import { Sentiment } from '../types';

export const getMacroExplanation = (assetName: string, trend: string): string => {
  const t = trend.toLowerCase();
  // Is the signal BULLISH FOR the base asset (Bitcoin/ETH)?
  const isBullishForCrypto = t.includes('bull') || t.includes('up') || t.includes('pos');

  switch (assetName) {
    case 'S&P 500':
      return isBullishForCrypto 
        ? "L'S&P 500 è in trend positivo. Questo indica un sentiment globale 'Risk-On', dove gli investitori sono propensi al rischio. Storicamente, gli asset crypto seguono la direzione dei mercati azionari americani."
        : "L'S&P 500 mostra debolezza. Questo segnala paura sui mercati (Risk-Off), portando spesso a vendite di liquidazione anche sugli asset crypto.";
    
    case 'DXY Index':
      return isBullishForCrypto 
        ? "Segnale Bullish per Bitcoin: Il Dollaro (DXY) si sta indebolendo o sta scendendo. Un dollaro debole aumenta il potere d'acquisto globale e favorisce gli asset a rischio come le crypto."
        : "Segnale Bearish per Bitcoin: Il Dollaro (DXY) si sta rafforzando. Quando il dollaro sale, il capitale tende a uscire dagli asset speculativi per rifugiarsi nel contante.";

    case 'Russell 2000':
      return isBullishForCrypto
        ? "L'indice Russell 2000 (small-cap) è in rialzo. Questo indica un forte appetito per il rischio (Risk-On) e una ricerca di asset ad alto rendimento. Ethereum mostra spesso una forte correlazione con questo indice."
        : "Le small-cap sono in sofferenza, segnalando una fuga dal rischio (Risk-Off). Gli investitori preferiscono la sicurezza di asset a bassa volatilità, penalizzando asset speculativi come ETH.";

    case 'Oil (WTI)':
      return isBullishForCrypto 
        ? "Segnale Bullish per Crypto: Il prezzo del Petrolio sta SCENDENDO (o è stabile). Un petrolio più economico riduce l'inflazione, aumentando drasticamente le probabilità che le Banche Centrali taglino i tassi e iniettino liquidità (QE)."
        : "Segnale Bearish per Crypto: Il prezzo del Petrolio sta SALENDO. L'aumento dei costi energetici riaccende l'inflazione, costringendo le Banche Centrali a mantenere i tassi alti e drenare liquidità dai mercati.";

    case 'Inflation (CPI)':
    case 'Inflation':
      return isBullishForCrypto 
        ? "Segnale Bullish per Bitcoin: L'inflazione sta scendendo. Questo avvicina la fine delle politiche restrittive della FED (Pivot), favorendo il ritorno dei capitali sugli asset crypto."
        : "Segnale Bearish per Bitcoin: L'inflazione è persistente o in aumento. Le banche centrali saranno costrette a mantenere i tassi alti, rendendo il denaro costoso e danneggiando gli asset di rischio.";

    case 'Unemployment':
      return isBullishForCrypto 
        ? "Segnale Bullish per Bitcoin (Bad news is good news): Un aumento della disoccupazione costringe la FED a intervenire tagliando i tassi per stimolare l'economia, iniettando liquidità che spesso finisce in Bitcoin."
        : "Segnale Bearish per Bitcoin: Il mercato del lavoro è troppo forte. Questo dà alla FED lo spazio per mantenere i tassi alti più a lungo per combattere l'inflazione, senza paura di rompere l'economia.";
        
    case 'M2 Supply':
      return isBullishForCrypto
        ? "L'offerta di moneta M2 è in espansione. C'è più liquidità nel sistema finanziario, e storicamente una parte di questa liquidità in eccesso fluisce direttamente in Bitcoin."
        : "L'offerta di moneta M2 si sta contraendo. C'è meno denaro in circolazione, il che rende difficile per il mercato sostenere rally duraturi.";

    case 'GDP':
    case 'US GDP':
       return isBullishForCrypto
        ? "La crescita economica è solida (Scenario Goldilocks), favorendo investimenti in asset di crescita senza i timori di una recessione imminente."
        : "L'economia mostra segni di recessione o stagnazione, portando incertezza e potenziale liquidazione di asset per coprire perdite altrove.";

    default:
      return `L'asset ${assetName} mostra un trend ${trend}. L'algoritmo ha identificato questo movimento come ${isBullishForCrypto ? 'favorevole' : 'sfavorevole'} per la price action di Bitcoin/Ethereum.`;
  }
};

export const getFearGreedExplanation = (value: number): { sentiment: string, text: string } => {
  if (value < 25) {
    return {
      sentiment: 'BULLISH (Extreme Fear)',
      text: "Il mercato è in 'Extreme Fear'. Storicamente, quando la folla è terrorizzata, si formano i migliori bottom di prezzo. È spesso un segnale 'Contrarian' di acquisto (Buy the Fear)."
    };
  } else if (value > 75) {
    return {
      sentiment: 'BEARISH (Extreme Greed)',
      text: "Il mercato è in 'Extreme Greed'. L'euforia è eccessiva e il rischio di una correzione violenta è alto. Storicamente è un segnale di cautela o presa di profitto."
    };
  } else {
    return {
      sentiment: 'NEUTRAL',
      text: "Il sentiment è neutrale. Non ci sono eccessi emotivi significativi che possano fungere da segnali contrarian affidabili in questo momento."
    };
  }
};

export const getRsiDivergenceExplanation = (divergenceType: string): string => {
  if (divergenceType.includes('Bull')) {
    return "Rilevata una DIVERGENZA RIALZISTA (Bullish Divergence). Mentre il prezzo ha segnato minimi decrescenti, l'RSI ha registrato minimi crescenti. Questo indica che la pressione di vendita si sta esaurendo e i 'bears' stanno perdendo momentum. È un forte segnale tecnico di potenziale inversione al rialzo.";
  }
  if (divergenceType.includes('Bear')) {
    return "Rilevata una DIVERGENZA RIBASSISTA (Bearish Divergence). Mentre il prezzo ha segnato nuovi massimi, l'RSI ha registrato massimi decrescenti. Questo indica che il trend rialzista sta perdendo forza (momentum) e l'interesse dei compratori sta calando. È un forte segnale di potenziale correzione.";
  }
  return "Nessuna divergenza significativa.";
};

export const getEthBtcExplanation = (trend: 'Bullish' | 'Bearish' | 'Neutral', asset: 'BTC' | 'ETH'): string => {
    const isEthBullish = trend === 'Bullish';
    
    if (isEthBullish) {
        return asset === 'ETH' 
          ? "Il rapporto ETH/BTC è in salita. Questo significa che Ethereum sta sovraperformando Bitcoin. È un classico segnale di 'Altseason' o propensione al rischio (Risk-On), dove i capitali fluiscono da BTC verso le Altcoins."
          : "Il rapporto ETH/BTC è in salita. Questo significa che Bitcoin sta sottoperformando rispetto a Ethereum. Sebbene il mercato sia generalmente positivo (Risk-On), la Dominance di Bitcoin potrebbe scendere a favore delle Altcoins.";
    } else {
        return asset === 'BTC'
          ? "Il rapporto ETH/BTC è in discesa. Questo significa che Bitcoin sta mostrando forza relativa rispetto al resto del mercato. È un segnale di 'Bitcoin Season' o di 'Flight to Safety', dove i capitali escono dalle Altcoin per rifugiarsi in BTC."
          : "Il rapporto ETH/BTC è in discesa. Questo è un segnale negativo per Ethereum, che sta perdendo valore rispetto a Bitcoin. Indica che il mercato preferisce la sicurezza di BTC rispetto al rischio delle Altcoins.";
    }
};

export const getEthDataExplanation = (metric: 'Gas' | 'Staking' | 'Burn'): string => {
  switch (metric) {
    case 'Gas':
      return "Le Gas Fees (misurate in Gwei) rappresentano il costo per eseguire transazioni sulla rete Ethereum. Gas basse indicano poca congestione (Bullish per l'usabilità). Gas alte indicano forte domanda di blockspace (Bullish per la domanda, ma Bearish per l'usabilità a breve termine).";
    case 'Staking':
      return "Lo Staking APY è il rendimento annuale per chi mette in staking i propri ETH per securizzare la rete. Un APY alto incentiva a togliere ETH dalla circolazione, riducendo l'offerta disponibile e creando una pressione d'acquisto (Bullish).";
    case 'Burn':
      return "L'ETH Burned si riferisce alla quantità di ETH rimossa permanentemente dalla circolazione grazie all'EIP-1559. Un alto tasso di burn rende ETH un asset deflazionistico o disinflazionistico, il che è strutturalmente Bullish a lungo termine.";
    default:
      return "Questo dato riflette la salute e l'attività dell'ecosistema Ethereum.";
  }
};

export const getIndicatorExplanation = (name: string, signal: Sentiment): string => {
  if (name.includes('RSI')) {
    return signal === Sentiment.BULLISH || signal.toString().includes('Oversold')
      ? "L'RSI è in zona di Ipervenduto (<30) o mostra divergenze rialziste. I venditori sono esausti, aumentando la probabilità di un rimbalzo tecnico."
      : "L'RSI è alto (>70) o in divergenza negativa. Il prezzo è 'tirato' e potrebbe ritracciare per scaricare l'ipercomprato.";
  }
  
  if (name.includes('Bollinger')) {
     return signal === Sentiment.BULLISH
      ? "Il prezzo ha toccato la banda inferiore o la volatilità è estremamente compressa (Squeeze). Questo prepara il mercato a un movimento esplosivo."
      : "Il prezzo ha toccato la banda superiore in una condizione di estensione, suggerendo un possibile ritracciamento verso la media.";
  }

  if (name.includes('Order Book')) {
      return signal === Sentiment.BULLISH
       ? "C'è una forte pressione in acquisto (Bid walls) nel book. I compratori stanno posizionando ordini limite aggressivi per sostenere il prezzo."
       : "C'è una forte pressione in vendita (Ask walls) nel book. I venditori stanno creando barriere di liquidità che impediscono la salita del prezzo.";
  }
  
  if (name.includes('EMA') || name.includes('SMA')) {
    return signal === Sentiment.BULLISH
      ? "Il prezzo è stabile sopra questa media mobile chiave. Questo conferma che il trend sottostante è solido e la media funge da supporto."
      : "Il prezzo è sceso sotto questa media mobile. Questo è un segnale di debolezza strutturale e la media ora agirà come resistenza (tetto) per il prezzo.";
  }

  if (name.includes('MACD')) {
    return signal === Sentiment.BULLISH
      ? "Golden Cross: Il momentum di breve termine ha incrociato al rialzo quello di medio termine. È un classico segnale di accelerazione rialzista."
      : "Death Cross: Il momentum si sta spegnendo e ha incrociato al ribasso. I venditori stanno prendendo il controllo della price action.";
  }

  return "Questo indicatore tecnico suggerisce la direzione probabile del prezzo basandosi su volumi, volatilità e azione dei prezzi passata.";
};

export const getOnChainExplanation = (metric: string, value: any): string => {
    if (metric === 'MVRV') {
        return "Il MVRV Z-Score valuta se Bitcoin è sopra o sottovalutato rispetto al suo 'Fair Value' (Realized Price). Un valore basso (< 0) indica che l'asset è sottovalutato (Buy Zone). Un valore alto (> 4-7) indica bolla speculativa (Sell Zone).";
    }
    if (metric === 'NUPL') {
        return "Il NUPL (Net Unrealized Profit/Loss) misura la psicologia del mercato. Valori > 0.5 indicano 'Belief/Euphoria' (rischio di vendita). Valori < 0 indicano 'Capitulation' (massima paura e opportunità di acquisto).";
    }
    if (metric === 'Cycle') {
        return "Questo indicatore traccia la posizione temporale nel Ciclo quadriennale basato sull'Halving. Storicamente, il picco del ciclo (Top) si verifica circa 500-550 giorni dopo l'Halving.";
    }
    return "Metric on-chain che analizza il comportamento della blockchain.";
};
