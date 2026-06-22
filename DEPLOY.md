# Deployment Guide — WhatsApp Escalation Analyst

Production deployment on a single Linux VM (Ubuntu/Debian) behind **nginx + HTTPS**, kept alive
with **PM2**. No Docker. Hand this file to your system administrator.

- **VM:** `206.1.25.27`
- **Domain:** `YOUR_DOMAIN` (replace everywhere below, e.g. `wa.bigship.in`)
- **App path:** `/opt/whatsapp-ai`
- **Runs as:** a dedicated `deploy` user (not root)

> The app is a single Node process that talks to WhatsApp via `whatsapp-web.js` (a headless
> Chromium under the hood) and serves a dashboard on `127.0.0.1:8080`. nginx terminates HTTPS on
> the domain and proxies to it. All reports live in SQLite (`data/messages.db`) and are shown in the
> dashboard independently of WhatsApp connectivity.

---

## 1. DNS

Create one **A record**: `YOUR_DOMAIN  →  206.1.25.27`. Wait for it to resolve (`dig +short YOUR_DOMAIN`).

## 2. System packages (run as root / sudo)

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Build toolchain for the native better-sqlite3 module
apt-get install -y build-essential python3 git

# Shared libraries the bundled Chromium (puppeteer / whatsapp-web.js) needs
apt-get install -y \
  ca-certificates fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0 libxshmfence1

# Web server + TLS + process manager
apt-get install -y nginx
apt-get install -y certbot python3-certbot-nginx
npm install -g pm2
```

## 3. Get the code

```bash
adduser --system --group --home /opt/whatsapp-ai deploy   # or use an existing deploy user
cd /opt
sudo -u deploy git clone https://github.com/utkarshbigship/whatsapp-ai.git
cd /opt/whatsapp-ai
sudo -u deploy npm ci          # builds better-sqlite3 + downloads Chromium
```

## 4. Configure environment

```bash
sudo -u deploy cp .env.example .env
sudo -u deploy nano .env
```

Set at minimum:

| Variable | Value |
|---|---|
| `GEMINI_API_KEY` | your Google Gemini API key |
| `DASH_USER` | dashboard username (e.g. `founder`) |
| `DASH_PASS` | a **strong** password (this is what you share) |
| `DASH_SECRET` | `openssl rand -hex 32` |
| `RECIPIENT_NUMBER` | `91XXXXXXXXXX@c.us` (for `!analyse` replies; optional) |
| `DASHBOARD_HOST` | `127.0.0.1` (leave as-is) |
| `COOKIE_SECURE` | `false` **for now** — flip to `true` after step 8 |

## 5. First-run WhatsApp pairing (one time, interactive)

The bot's WhatsApp account must scan a QR **once**. The session is then saved to `.wwebjs_auth/`
and survives all future restarts.

```bash
cd /opt/whatsapp-ai
sudo -u deploy node src/index.js
```

- An ASCII **QR code** prints in the terminal. On the bot's phone: WhatsApp → **Linked Devices →
  Link a device** → scan it.
- Wait for the log line `WhatsApp client is READY.`
- Press **Ctrl-C** to stop. (You'll start it under PM2 next.)

## 6. Run under PM2 (auto-restart + start on boot)

```bash
cd /opt/whatsapp-ai
sudo -u deploy pm2 start ecosystem.config.js
sudo -u deploy pm2 save
sudo -u deploy pm2 startup     # run the command it prints (sets up the boot service)
sudo -u deploy pm2 logs wa-summarizer   # confirm "WhatsApp client is READY."
```

PM2 is configured for a single instance (the WhatsApp session can't be shared across workers) and
restarts the app on crash or VM reboot.

## 7. nginx reverse proxy

Create `/etc/nginx/sites-available/whatsapp-ai`:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN;

    client_max_body_size 25m;   # allows large media/spreadsheet uploads from WhatsApp

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/whatsapp-ai /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 8. HTTPS (Let's Encrypt)

```bash
certbot --nginx -d YOUR_DOMAIN     # obtains the cert and rewrites the nginx block to 443
```

Certbot auto-renews via its systemd timer. Now enable secure cookies:

```bash
cd /opt/whatsapp-ai
sudo -u deploy sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' .env
sudo -u deploy pm2 reload wa-summarizer
```

## 9. Firewall

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
```

Do **not** open `8080` — the app binds to `127.0.0.1` and is only reachable through nginx.
(To test the dashboard before DNS/HTTPS is ready, tunnel from your laptop:
`ssh -L 8080:127.0.0.1:8080 deploy@206.1.25.27`, then open `http://localhost:8080`.)

## 10. Give the founder access

- URL: **`https://YOUR_DOMAIN`**
- Username / password: the `DASH_USER` / `DASH_PASS` you set in step 4.
- Share these via a password manager (1Password/Bitwarden) — not plain WhatsApp or email.
- Sessions last 12 hours. There is a single shared login (multi-user accounts are not supported yet).

---

## Updating the app (no message loss, no re-pairing)

```bash
cd /opt/whatsapp-ai
sudo -u deploy git pull
sudo -u deploy npm ci
sudo -u deploy pm2 reload wa-summarizer
```

What happens: the process restarts to load new code (~15s). The WhatsApp session in `.wwebjs_auth/`
persists, so **no QR re-scan**. On reconnect, the app **backfills** recent messages per group
(`WA_BACKFILL_LIMIT`, default 50) so anything that arrived during the restart is captured — nothing
is lost. A single Node/whatsapp-web.js process can't hot-swap code without this brief restart, but it
is transparent and lossless.

**Disconnect / re-pair behaviour:** if WhatsApp drops, the app auto-reconnects every 30s and backfills.
Previous **reports stay visible** in the dashboard the entire time (they're read from the database).
Reports map to groups by the permanent group id (`123…@g.us`), which never changes for the same
WhatsApp account — so after any reconnect the correct reports show under the correct group
automatically. (Only re-pairing a *different* WhatsApp account would change group ids.)

## Backups

Back up nightly (cron) — these two are all you need to restore without re-pairing:

```bash
# reports + messages (the durable artifact) and the WhatsApp session
tar czf /var/backups/wa-$(date +%F).tgz -C /opt/whatsapp-ai data/messages.db .wwebjs_auth
```

`data/messages.db` holds every group and master report permanently (raw messages auto-purge after
30 days; reports are kept forever).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pm2 logs wa-summarizer` shows a QR or `auth_failure` | `rm -rf .wwebjs_auth`, then redo step 5 (re-pair). |
| Chromium fails to launch (`error while loading shared libraries`) | install the missing `lib*` package from step 2. |
| Login keeps bouncing back to the sign-in page | HTTPS not actually serving yet — ensure step 8 done before `COOKIE_SECURE=true`. |
| `better-sqlite3` build error on `npm ci` | ensure `build-essential` + `python3` installed (step 2), Node is v20+. |
| Dashboard unreachable | `systemctl status nginx`, `pm2 status`, and confirm DNS resolves to 206.1.25.27. |

## Quick reference

- App: `/opt/whatsapp-ai` · DB: `data/messages.db` · WA session: `.wwebjs_auth/` · logs: `pm2 logs wa-summarizer`
- Restart: `pm2 reload wa-summarizer` · Status: `pm2 status` · Boot: `pm2 startup` + `pm2 save`
