# Local Development Setup

For testing the CardGames 31 server locally:

## Start the server

```bash
cd /path/to/CardGames/Games/31/server
npm start
```

The server will start on `http://localhost:8787` by default.

## Configure client URL

The client connects to the server via WebSocket. By default it looks for:
- `ws://localhost:8787` (local development)
- `wss://cardgames.duckdns.org/ws` (production via HTTPS)

To change the server URL for testing, set it in localStorage or modify `resolveServerUrl()` in the client code.

## Systemd Deployment

For production on a Linux server:

1. Copy `cardgames-31.service` to `/etc/systemd/system/`
2. Enable the service: `sudo systemctl enable cardgames-31`
3. Start the service: `sudo systemctl start cardgames-31`
4. Monitor logs: `sudo journalctl -u cardgames-31 -f`

Ensure the `rayden` user owns the directory and has permission to access it.
