# Guida Deploy VPS — Quantum Trade

Riferimento operativo per deploy, sincronizzazione e accesso al server di produzione.
Aggiornato ogni volta che si scopre un errore o una nuova configurazione.

---

## Dati di accesso

| Parametro | Valore |
|-----------|--------|
| Dominio | `quantumtrade.me` (HTTPS, Let's Encrypt) |
| IP VPS | `77.42.84.8` (Hetzner) |
| IPv6 | `2a01:4f9:c013:62be::/64` |
| Utente SSH | `root` |
| Chiave SSH | `~/.ssh/id_ed25519` |
| Porta SSH | `22` |

> **Nota:** L'IP `45.76.131.253` era errato — non usarlo. La voce `VPS_HOST` in `apps/api/.env` ora contiene il dominio `quantumtrade.me` (che risolve su `77.42.84.8`). Per SSH si può usare indifferentemente il dominio o l'IP.

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
rsync -avz --exclude='.venv' --exclude='models/' --exclude='.env' \
  -e "ssh -i ~/.ssh/id_ed25519" \
  "/Users/fabiowild/Desktop/Quantum Trade/apps/api/" \
  root@77.42.84.8:/opt/quantum-trade/apps/api/
```

> **IMPORTANTE:** escludere sempre `.venv`, `models/` E `.env` dall'rsync.
> - `.venv` contiene binari macOS incompatibili con Linux.
> - `models/` contiene i modelli LightGBM addestrati sul VPS — sovrascriverli con quelli locali degraderebbe silenziosamente le performance.
> - **`.env` è la fonte autoritativa di PRODUZIONE** (SECRET_KEY, ENCRYPTION_KEY, chiavi Supabase, HL_AGENT_PRIVATE_KEY). Sovrascriverlo col `.env` locale invaliderebbe le sessioni JWT, romperebbe la decrittazione del wallet o azzererebbe segreti live. **Mai deployare il `.env`.** Per aggiungere/aggiornare una singola chiave sul VPS, modificarla chirurgicamente:
> ```bash
> # Esempio: aggiungere ANTHROPIC_API_KEY senza toccare il resto
> KEY=$(grep '^ANTHROPIC_API_KEY=' apps/api/.env | cut -d= -f2-)
> printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" | ssh -i ~/.ssh/id_ed25519 root@77.42.84.8 \
>   "grep -q '^ANTHROPIC_API_KEY=' /opt/quantum-trade/apps/api/.env || cat >> /opt/quantum-trade/apps/api/.env"
> ```
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

## Configurazione Nginx — SPA Routing, SSL e Dominio

Con il dominio `quantumtrade.me` attivo, Nginx gestisce la build statica del frontend (con fallback SPA per React Router), il proxy verso il backend FastAPI, il certificato SSL Let's Encrypt e gli header di sicurezza HTTP.

La guida passo-passo completa per la configurazione del dominio, Certbot e CORS è disponibile in [guida_dominio_quantumtrade.md](file:///Users/fabiowild/.gemini/antigravity-ide/brain/5d4580f1-18bb-411d-8162-d3926db2a7e6/guida_dominio_quantumtrade.md).

### Configurazione Nginx Attiva (/etc/nginx/sites-available/quantum-trade)

```nginx
server {
    server_name quantumtrade.me www.quantumtrade.me;

    # ── Security Headers ──
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }

    location / {
        root /opt/quantum-trade/dist;
        try_files $uri $uri/ /index.html;

        # HTML: always revalidate — prevents stale index.html with old JS hashes
        location ~* \.html$ {
            add_header Cache-Control "no-cache, must-revalidate";
            add_header Pragma "no-cache";
            expires 0;

            # Security Headers (explicitly duplicated due to Nginx add_header inheritance rules)
            add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
            add_header X-Frame-Options "SAMEORIGIN" always;
            add_header X-Content-Type-Options "nosniff" always;
            add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        }

        # JS/CSS assets: Vite fingerprints filenames → safe to cache indefinitely
        location ~* \.(js|css)$ {
            add_header Cache-Control "public, max-age=31536000, immutable";
            expires 1y;

            # Security Headers (explicitly duplicated due to Nginx add_header inheritance rules)
            add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
            add_header X-Frame-Options "SAMEORIGIN" always;
            add_header X-Content-Type-Options "nosniff" always;
            add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        }
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/quantumtrade.me/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/quantumtrade.me/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = www.quantumtrade.me) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    if ($host = quantumtrade.me) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    server_name quantumtrade.me www.quantumtrade.me;
    return 404; # managed by Certbot
}
```

### Comandi Utili per Nginx

```bash
# Verificare la sintassi della configurazione
ssh -i ~/.ssh/id_ed25519 root@77.42.84.8 "nginx -t"

# Ricaricare la configurazione senza downtime
ssh -i ~/.ssh/id_ed25519 root@77.42.84.8 "systemctl reload nginx"
```

> **Nota:** questa modifica va applicata **una sola volta** prima o dopo il primo deploy con React Router. Non è necessario riapplicarla nei deploy successivi.

---

## Checklist pre-deploy

- [ ] Build frontend completato senza errori TypeScript
- [ ] Controllare che la cartella di output sia `dist/` nella root del progetto (non `apps/web/dist/`)
- [ ] Usare sempre l'IP `77.42.84.8` (verificare in `apps/api/.env → VPS_HOST` in caso di dubbio)
- [ ] Usare sempre il percorso remoto `/opt/quantum-trade/dist/` per il frontend
- [ ] **[Solo primo deploy con React Router]** Verificare che Nginx abbia `try_files $uri $uri/ /index.html` — vedi sezione sopra
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
