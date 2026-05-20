# Guida Deploy VPS — Quantum Trade

Riferimento operativo per deploy, sincronizzazione e accesso al server di produzione.
Aggiornato ogni volta che si scopre un errore o una nuova configurazione.

---

## Dati di accesso

| Parametro | Valore |
|-----------|--------|
| IP VPS | `77.42.84.8` (Hetzner) |
| IPv6 | `2a01:4f9:c013:62be::/64` |
| Utente SSH | `root` |
| Chiave SSH | `~/.ssh/id_ed25519` |
| Porta SSH | `22` |

> **Nota:** L'IP `45.76.131.253` era errato — non usarlo. L'IP corretto è sempre nel file `apps/api/.env` alla voce `VPS_HOST`.

---

## Percorsi sul server

| Cosa | Percorso |
|------|----------|
| Frontend (nginx root) | `/opt/quantum-trade/dist/` |
| Backend API | `/opt/quantum-trade/apps/api/` |
| Config nginx | `/etc/nginx/sites-enabled/` |

> **Errore comune:** il percorso `/var/www/quantum-trade/dist/` NON esiste (o non è servito da nginx). Usare sempre `/opt/quantum-trade/dist/`.

---

## Comandi deploy

### Frontend (build + sync)

```bash
# 1. Build locale
cd "/Users/fabiowild/Desktop/Quantum Trade/apps/web"
npm run build
# Output: /Users/fabiowild/Desktop/Quantum Trade/dist/

# 2. Deploy sul VPS
rsync -avz --delete \
  -e "ssh -i ~/.ssh/id_ed25519" \
  "/Users/fabiowild/Desktop/Quantum Trade/dist/" \
  root@77.42.84.8:/opt/quantum-trade/dist/
```

### Backend (sync file Python)

```bash
rsync -avz --exclude='.venv' \
  -e "ssh -i ~/.ssh/id_ed25519" \
  "/Users/fabiowild/Desktop/Quantum Trade/apps/api/" \
  root@77.42.84.8:/opt/quantum-trade/apps/api/
```

> **IMPORTANTE:** escludere sempre `.venv` dall'rsync — contiene binari macOS incompatibili con Linux.
> Il venv sul VPS è gestito separatamente. Se si aggiungono nuove dipendenze al `requirements.txt`,
> installarle sul VPS manualmente:
> ```bash
> ssh -i ~/.ssh/id_ed25519 root@77.42.84.8 \
>   "cd /opt/quantum-trade/apps/api && .venv/bin/pip install -r requirements.txt"
> ```

### Riavvio servizi sul VPS

```bash
ssh -i ~/.ssh/id_ed25519 root@77.42.84.8 "systemctl restart quantum-trade"
```

> **Nota:** il servizio si chiama `quantum-trade`, NON `quantum-trade-api`.

---

## Checklist pre-deploy

- [ ] Build frontend completato senza errori TypeScript
- [ ] Controllare che la cartella di output sia `dist/` nella root del progetto (non `apps/web/dist/`)
- [ ] Usare sempre l'IP `77.42.84.8` (verificare in `apps/api/.env → VPS_HOST` in caso di dubbio)
- [ ] Usare sempre il percorso remoto `/opt/quantum-trade/dist/` per il frontend
- [ ] Dopo il deploy, forzare hard refresh nel browser (`Cmd+Shift+R`) per svuotare la cache

---

## Verifica deploy riuscito

```bash
# Controlla i file presenti sul server
ssh -i ~/.ssh/id_ed25519 root@77.42.84.8 "ls -lh /opt/quantum-trade/dist/assets/"

# Controlla configurazione nginx
ssh -i ~/.ssh/id_ed25519 root@77.42.84.8 "cat /etc/nginx/sites-enabled/*"

# Controlla stato nginx
ssh -i ~/.ssh/id_ed25519 root@77.42.84.8 "systemctl status nginx"
```

---

## Errori storici e soluzioni

| Errore | Causa | Soluzione |
|--------|-------|-----------|
| `Operation timed out` su `45.76.131.253` | IP sbagliato (vecchio server) | Usare `77.42.84.8` |
| Modifiche frontend non visibili sul sito | Deploy su `/var/www/` invece di `/opt/` | Usare **sempre** `/opt/quantum-trade/dist/` — `/var/www/` NON è servito da nginx |
| Modifiche frontend non visibili dopo deploy corretto | Cache del browser | `Cmd+Shift+R` per hard refresh |
| `dist/` non trovata | Vite mette l'output in `dist/` nella root del progetto, non in `apps/web/dist/` | Rsync da `/Users/fabiowild/Desktop/Quantum Trade/dist/` |
| Backend crash `exit-code 127` dopo deploy | rsync ha copiato `.venv` macOS sul server Linux, sovrascrivendo i binari | Usare sempre `--exclude='.venv'` nell'rsync del backend. Ripristino: `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` |
