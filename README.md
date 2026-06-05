# CardGames

Playable card games with a shared theme, reusable card rendering, and responsive layouts.

- `index.html` - card games launcher with category tabs.
- `FTheDealer.html` - dealer/player card tracker with shuffle reset and mobile-ready UI.
- `Games/31/` - multiplayer 31 / Blitz client that connects to the realtime server.
- `card-renderer.js` and `card-renderer.css` - reusable 2D playing card renderer for number cards, card backs, and image-backed face cards.
- `Games/31/server/` - Raspberry Pi Node.js WebSocket server for the 31 / Blitz multiplayer room.

## 31 / Blitz Raspberry Pi Server

```sh
cd /home/rayden/CardGames/Games/31/server
npm install --omit=dev
npm start
```

LAN client override:

```text
Games/31/?server=ws://192.168.0.32:8787/ws
```

DuckDNS endpoint:

```text
wss://cardgames.duckdns.org/ws
```
