# CardGames

Playable card games with a shared theme, reusable card rendering, and responsive layouts.

- `index.html` - card games launcher with category tabs.
- `FTheDealer.html` - dealer/player card tracker with shuffle reset and mobile-ready UI.
- `Games/31/` - multiplayer 31 / Blitz client that connects to the realtime server.
- `card-renderer.js` and `card-renderer.css` - reusable 2D playing card renderer for number cards, card backs, and image-backed face cards.
- `Games/31/server/` - Node.js WebSocket server for the 31 / Blitz multiplayer room.

## 31 / Blitz Server

```sh
cd Games/31/server
npm install
npm start
```

Local client override:

```text
Games/31/?server=ws://localhost:8787/ws
```

Production expects:

```text
wss://cardgames.duckdns.org/ws
```
