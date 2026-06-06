# 31 / Blitz Realtime Server

Node WebSocket server for `CardGames/Games/31/`.

## Raspberry Pi Run

```sh
cd /home/rayden/CardGames/Games/31/server
npm install --omit=dev
npm start
```

Health check:

```sh
curl http://192.168.0.32:8787/health
```

The browser client connects to the Raspberry Pi server by LAN IP when opened from a laptop during local network use, and by DuckDNS when opened from GitHub Pages.

```text
Games/31/?server=ws://192.168.0.32:8787/ws
Games/31/?server=wss://raydencardgames.duckdns.org/ws
```

## Raspberry Pi Deployment

1. Register the DuckDNS subdomain `raydencardgames.duckdns.org`.
2. Forward router ports `80` and `443` to the Raspberry Pi.
3. Install Node.js, npm, Caddy, and git on the Pi.
4. Clone or pull this repo on the Pi.
5. Install server dependencies:

```sh
cd /home/rayden/CardGames/Games/31/server
npm install --omit=dev
```

6. Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, then reload Caddy:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

7. Copy `deploy/thirty-one.service` to `/etc/systemd/system/thirty-one.service`, update paths/users if needed, then enable it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now thirty-one
sudo systemctl status thirty-one
```

8. Add a DuckDNS updater cron using `deploy/duckdns-update.sh.example`.

## Public Endpoints

- `GET https://raydencardgames.duckdns.org/health`
- `WSS wss://raydencardgames.duckdns.org/ws`

## State

The server keeps one active room in memory and writes a small snapshot to `Games/31/server/data/state.json`. That file is intentionally ignored by git.
