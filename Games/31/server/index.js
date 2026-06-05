const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = 10;
const SNAPSHOT_PATH = path.join(__dirname, "data", "state.json");
const HEARTBEAT_MS = 30000;
const SUITS = [
  { suit: "\u2660", color: "black" },
  { suit: "\u2665", color: "red" },
  { suit: "\u2666", color: "red" },
  { suit: "\u2663", color: "black" }
];
const VALUES = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

let room = loadSnapshot();
const sockets = new Map();

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => {
  const counts = roomCounts();
  res.json({
    ok: true,
    game: "thirty-one",
    roomCode: room ? room.code : null,
    players: counts.activeCount,
    connectedPlayers: counts.connectedCount,
    seatedPlayers: counts.seatedCount
  });
});
app.get("/", (_req, res) => {
  res.type("text/plain").send("CardGames 31 / Blitz realtime server is running.");
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, "error", { message: "Invalid message." });
      return;
    }

    handleMessage(ws, message);
  });

  ws.on("close", () => {
    if (ws.playerId) {
      const playerId = ws.playerId;
      removeSocket(ws);
      if (!hasOpenSocket(playerId)) {
        markDisconnected(playerId);
        broadcast();
      }
    }
  });

  send(ws, "roomState", publicRoom());
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`Thirty One server listening on port ${PORT}`);
});

function handleMessage(ws, message) {
  const type = message.type;
  const data = message.data || {};

  try {
    if (type === "createRoom") return createRoom(ws, data);
    if (type === "joinRoom") return joinRoom(ws, data);
    if (type === "sync") return syncPlayer(ws, data);

    const player = requirePlayer(ws);
    if (type === "startGame") return startGame(player);
    if (type === "stopGame") return stopGame(player);
    if (type === "endSession") return endSession(player);
    if (type === "skipPlayer") return skipPlayer(player);
    if (type === "check") return checkRound(player);
    if (type === "drawStock") return drawStock(player);
    if (type === "drawDiscard") return drawDiscard(player);
    if (type === "discard") return discardCard(player, data);
    if (type === "leaveSeat") return leaveSeat(player);

    send(ws, "error", { message: "Unknown action." });
  } catch (error) {
    send(ws, "error", { message: error.message || "Action failed." });
  }
}

function createRoom(ws, data) {
  const playerId = normalizeId(data.playerId) || newId("p");
  const name = normalizeName(data.name);

  if (room && hasConnectedPlayers(room)) {
    throw new Error("A room is already active. Join that room or ask the host to stop it.");
  }

  room = {
    code: generateRoomCode(),
    status: "lobby",
    hostId: playerId,
    currentTurnPlayerId: null,
    pendingDiscardPlayerId: null,
    checkingPlayerId: null,
    finalTurnPlayerIds: [],
    finishReason: "",
    finishedAt: null,
    stock: [],
    discard: [],
    players: [{
      id: playerId,
      name,
      connected: true,
      seat: 0,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      hand: []
    }]
  };

  bindSocket(ws, playerId);
  saveSnapshot();
  send(ws, "toast", { message: `Room ${room.code} created.` });
  broadcast();
}

function joinRoom(ws, data) {
  if (!room) {
    throw new Error("No room exists yet. Create a room first.");
  }

  const code = String(data.roomCode || "").trim().toUpperCase();
  if (code !== room.code) {
    throw new Error("Room code not found.");
  }

  const requestedId = normalizeId(data.playerId);
  const name = normalizeName(data.name);
  let player = requestedId ? room.players.find(p => p.id === requestedId) : null;

  if (!player) {
    player = room.players.find(p => !p.connected && p.name.toLowerCase() === name.toLowerCase());
  }

  if (room.status === "playing" && (!player || player.hand.length === 0)) {
    throw new Error("This game already started. Wait for the host to reset before joining.");
  }

  if (!player) {
    if (room.players.some(p => p.connected && p.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("That name is already seated. Use your same device to rejoin or choose another name.");
    }
    if (room.players.length >= MAX_PLAYERS) {
      throw new Error("This room is full.");
    }
    player = {
      id: requestedId || newId("p"),
      name,
      connected: true,
      seat: nextSeat(),
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      hand: []
    };
    room.players.push(player);
  }

  player.name = name;
  player.connected = true;
  player.lastSeen = Date.now();
  bindSocket(ws, player.id);
  saveSnapshot();
  broadcast();
}

function syncPlayer(ws, data) {
  if (!room) {
    send(ws, "roomState", publicRoom());
    return;
  }

  const player = room.players.find(p => p.id === normalizeId(data.playerId));
  if (!player) {
    send(ws, "roomState", publicRoom());
    return;
  }

  if (room.status === "playing" && player.hand.length === 0) {
    send(ws, "roomState", publicRoom());
    send(ws, "error", { message: "This game already started. Wait for the host to reset before joining." });
    return;
  }
  player.connected = true;
  player.lastSeen = Date.now();
  bindSocket(ws, player.id);
  saveSnapshot();
  broadcast();
}

function startGame(player) {
  requireHost(player);
  const deck = buildDeck();
  const activePlayers = connectedPlayersInSeatOrder();
  if (activePlayers.length < 2) {
    throw new Error("At least 2 connected players are needed to start.");
  }

  for (const p of room.players) {
    p.hand = [];
  }
  for (let round = 0; round < 3; round++) {
    for (const p of activePlayers) {
      p.hand.push(deck.pop());
    }
  }

  room.stock = deck;
  room.discard = [room.stock.pop()];
  room.status = "playing";
  room.pendingDiscardPlayerId = null;
  room.checkingPlayerId = null;
  room.finalTurnPlayerIds = [];
  room.finishReason = "";
  room.finishedAt = null;
  room.currentTurnPlayerId = activePlayers[0].id;
  saveSnapshot();
  broadcast("Game started.");
}

function stopGame(player) {
  requireHost(player);
  for (const p of room.players) {
    p.hand = [];
  }
  room.status = "lobby";
  room.currentTurnPlayerId = null;
  room.pendingDiscardPlayerId = null;
  room.checkingPlayerId = null;
  room.finalTurnPlayerIds = [];
  room.finishReason = "";
  room.finishedAt = null;
  room.stock = [];
  room.discard = [];
  saveSnapshot();
  broadcast("Game reset.");
}

function endSession(player) {
  requireHost(player);
  const message = "The host ended the room.";
  room = null;
  sockets.clear();
  deleteSnapshot();

  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) {
      continue;
    }
    ws.playerId = null;
    send(ws, "sessionEnded", { message });
    send(ws, "roomState", publicRoom());
    send(ws, "toast", { message });
  }
}

function skipPlayer(player) {
  requireHost(player);
  requirePlaying();

  const skipped = currentPlayer();
  if (skipped && room.pendingDiscardPlayerId === skipped.id && skipped.hand.length > 3) {
    room.discard.push(skipped.hand.pop());
  }
  room.pendingDiscardPlayerId = null;
  if (!room.stock.length) {
    finishGame("deck", "The deck ran out.");
    return;
  }
  if (completeTurn(skipped)) {
    return;
  }
  saveSnapshot();
  broadcast(skipped ? `${skipped.name} was skipped.` : "Player skipped.");
}

function checkRound(player) {
  requireTurn(player);
  requireNoPendingDiscard(player);
  if (room.checkingPlayerId) {
    throw new Error("Someone has already checked.");
  }
  if (player.hand.length !== 3) {
    throw new Error("You can only check with 3 cards.");
  }

  const finalPlayers = playersAfter(player.id).filter(p => p.id !== player.id);
  room.checkingPlayerId = player.id;
  room.finalTurnPlayerIds = finalPlayers.map(p => p.id);
  room.pendingDiscardPlayerId = null;

  if (!room.finalTurnPlayerIds.length) {
    finishGame("check", `${player.name} checked.`);
    return;
  }

  room.currentTurnPlayerId = room.finalTurnPlayerIds[0];
  saveSnapshot();
  broadcast(`${player.name} checked. Everyone else gets one more turn.`);
}

function drawStock(player) {
  requireTurn(player);
  requireNoPendingDiscard(player);
  if (!room.stock.length) {
    finishGame("deck", "The deck ran out.");
    return;
  }
  player.hand.push(room.stock.pop());
  room.pendingDiscardPlayerId = player.id;
  saveSnapshot();
  broadcast(`${player.name} drew from the deck.`);
}

function drawDiscard(player) {
  requireTurn(player);
  requireNoPendingDiscard(player);
  if (!room.discard.length) {
    throw new Error("No discard card is available.");
  }
  player.hand.push(room.discard.pop());
  room.pendingDiscardPlayerId = player.id;
  saveSnapshot();
  broadcast(`${player.name} drew from the discard pile.`);
}

function discardCard(player, data) {
  requireTurn(player);
  if (room.pendingDiscardPlayerId !== player.id) {
    throw new Error("Draw a card before discarding.");
  }

  const cardId = String(data.cardId || "");
  const index = player.hand.findIndex(card => card.id === cardId);
  if (index < 0) {
    throw new Error("Card is not in your hand.");
  }
  if (player.hand.length <= 3) {
    throw new Error("You must draw before discarding.");
  }

  const [card] = player.hand.splice(index, 1);
  room.discard.push(card);
  room.pendingDiscardPlayerId = null;
  if (!room.stock.length) {
    finishGame("deck", "The deck ran out.");
    return;
  }
  if (completeTurn(player)) {
    return;
  }
  saveSnapshot();
  broadcast(`${player.name} discarded.`);
}

function leaveSeat(player) {
  player.connected = false;
  player.lastSeen = Date.now();
  closePlayerSockets(player.id);
  saveSnapshot();
  broadcast();
}

function markDisconnected(playerId) {
  if (!room) {
    return;
  }
  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    return;
  }
  player.connected = false;
  player.lastSeen = Date.now();
  saveSnapshot();
}

function bindSocket(ws, playerId) {
  if (ws.playerId && ws.playerId !== playerId) {
    removeSocket(ws);
  }
  ws.playerId = playerId;
  if (!sockets.has(playerId)) {
    sockets.set(playerId, new Set());
  }
  sockets.get(playerId).add(ws);
}

function removeSocket(ws) {
  if (!ws.playerId) {
    return;
  }
  const playerSockets = sockets.get(ws.playerId);
  if (!playerSockets) {
    return;
  }
  playerSockets.delete(ws);
  if (!playerSockets.size) {
    sockets.delete(ws.playerId);
  }
}

function hasOpenSocket(playerId) {
  const playerSockets = sockets.get(playerId);
  if (!playerSockets) {
    return false;
  }
  for (const ws of playerSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      return true;
    }
  }
  return false;
}

function closePlayerSockets(playerId) {
  const playerSockets = sockets.get(playerId);
  if (!playerSockets) {
    return;
  }
  for (const ws of playerSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "Seat left.");
    }
  }
  sockets.delete(playerId);
}

function requirePlayer(ws) {
  if (!room || !ws.playerId) {
    throw new Error("Join a room first.");
  }
  const player = room.players.find(p => p.id === ws.playerId);
  if (!player) {
    throw new Error("Seat not found.");
  }
  player.connected = true;
  player.lastSeen = Date.now();
  return player;
}

function requireHost(player) {
  if (!room || room.hostId !== player.id) {
    throw new Error("Only the host can do that.");
  }
}

function requirePlaying() {
  if (!room || room.status !== "playing") {
    throw new Error("The game has not started.");
  }
}

function requireTurn(player) {
  requirePlaying();
  if (room.currentTurnPlayerId !== player.id) {
    throw new Error("It is not your turn.");
  }
}

function requireNoPendingDiscard(player) {
  if (room.pendingDiscardPlayerId === player.id) {
    throw new Error("Discard a card before drawing again.");
  }
}

function currentPlayer() {
  return room.players.find(p => p.id === room.currentTurnPlayerId) || null;
}

function advanceTurn() {
  const players = activePlayersInSeatOrder();
  if (!players.length) {
    room.currentTurnPlayerId = null;
    return;
  }
  const currentIndex = players.findIndex(p => p.id === room.currentTurnPlayerId);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % players.length;
  room.currentTurnPlayerId = players[nextIndex].id;
}

function completeTurn(player) {
  if (player && Array.isArray(room.finalTurnPlayerIds) && room.finalTurnPlayerIds.length) {
    room.finalTurnPlayerIds = room.finalTurnPlayerIds.filter(id => id !== player.id);
    if (!room.finalTurnPlayerIds.length) {
      finishGame("check", "Final turns are complete.");
      return true;
    }
    room.currentTurnPlayerId = room.finalTurnPlayerIds[0];
    return false;
  }
  advanceTurn();
  return false;
}

function activePlayersInSeatOrder() {
  return room.players
    .filter(p => p.connected || p.hand.length)
    .sort((a, b) => a.seat - b.seat);
}

function connectedPlayersInSeatOrder() {
  return room.players
    .filter(p => p.connected)
    .sort((a, b) => a.seat - b.seat);
}

function playersAfter(playerId) {
  const players = activePlayersInSeatOrder();
  if (!players.length) {
    return [];
  }
  const index = players.findIndex(p => p.id === playerId);
  if (index < 0) {
    return players;
  }
  return players.slice(index + 1).concat(players.slice(0, index));
}

function finishGame(reason, toastMessage) {
  room.status = "finished";
  room.currentTurnPlayerId = null;
  room.pendingDiscardPlayerId = null;
  room.finalTurnPlayerIds = [];
  room.finishReason = reason;
  room.finishedAt = Date.now();
  saveSnapshot();
  broadcast(toastMessage || "Game over.");
}

function publicRoom() {
  if (!room) {
    return { room: null };
  }

  const ordered = room.players.slice().sort((a, b) => a.seat - b.seat);
  const counts = roomCounts(ordered);
  const current = room.status === "playing"
    ? room.players.find(p => p.id === room.currentTurnPlayerId) || null
    : null;
  const next = room.status === "playing" ? nextPlayerAfter(room.currentTurnPlayerId) : null;

  return {
    room: {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      currentTurnPlayerId: room.currentTurnPlayerId,
      pendingDiscardPlayerId: room.pendingDiscardPlayerId,
      checkingPlayerId: room.checkingPlayerId || null,
      finalTurnPlayerIds: room.finalTurnPlayerIds || [],
      finishReason: room.finishReason || "",
      finishedAt: room.finishedAt || null,
      connectedCount: counts.connectedCount,
      activeCount: counts.activeCount,
      seatedCount: counts.seatedCount,
      stockCount: room.stock.length,
      discardTop: topCard(room.discard),
      discardCount: room.discard.length,
      currentPlayerName: current ? current.name : "",
      nextPlayerName: next ? next.name : "",
      results: room.status === "finished" ? finalResults() : [],
      players: ordered.map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        seat: p.seat,
        isHost: p.id === room.hostId,
        handCount: p.hand.length
      }))
    }
  };
}

function roomCounts(players = room ? room.players : []) {
  const counted = Array.isArray(players) ? players : [];
  return {
    connectedCount: counted.filter(p => p.connected).length,
    activeCount: counted.filter(p => p.connected || p.hand.length || (room && p.id === room.hostId)).length,
    seatedCount: counted.length
  };
}

function finalResults() {
  const rows = room.players
    .filter(p => p.hand.length)
    .sort((a, b) => a.seat - b.seat)
    .map(p => {
      const best = bestScore(p.hand);
      return {
        id: p.id,
        name: p.name,
        seat: p.seat,
        connected: p.connected,
        isHost: p.id === room.hostId,
        hand: p.hand,
        best,
        total: best.total,
        suit: best.suit,
        difference: 0
      };
    })
    .sort((a, b) => b.total - a.total || a.seat - b.seat);

  const leaderTotal = rows.length ? rows[0].total : 0;
  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
    isWinner: row.total === leaderTotal,
    difference: row.total - leaderTotal
  }));
}

function privateHand(player) {
  return {
    playerId: player.id,
    hand: player.hand,
    best: bestScore(player.hand),
    mustDiscard: room && room.pendingDiscardPlayerId === player.id,
    isTurn: room && room.currentTurnPlayerId === player.id
  };
}

function broadcast(toastMessage) {
  const state = publicRoom();
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) {
      continue;
    }
    send(ws, "roomState", state);
    if (room && ws.playerId) {
      const player = room.players.find(p => p.id === ws.playerId);
      if (player) {
        send(ws, "privateHand", privateHand(player));
      }
    }
    if (toastMessage) {
      send(ws, "toast", { message: toastMessage });
    }
  }
}

function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function buildDeck() {
  const cards = [];
  for (const { suit, color } of SUITS) {
    for (const value of VALUES) {
      cards.push({
        id: `${value}-${suit}-${cards.length}-${Date.now()}`,
        value,
        suit,
        color
      });
    }
  }
  return shuffle(cards);
}

function shuffle(cards) {
  const array = cards.slice();
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function bestScore(hand) {
  const totals = {};
  for (const { suit, value } of hand) {
    totals[suit] = (totals[suit] || 0) + cardValue(value);
  }
  const entries = Object.entries(totals);
  if (!entries.length) {
    return { total: 0, suit: "" };
  }
  entries.sort((a, b) => b[1] - a[1]);
  return { suit: entries[0][0], total: entries[0][1] };
}

function cardValue(value) {
  if (value === "A") return 11;
  if (["J", "Q", "K"].includes(value)) return 10;
  return Number(value) || 0;
}

function topCard(cards) {
  return cards.length ? cards[cards.length - 1] : null;
}

function nextPlayerAfter(playerId) {
  const players = activePlayersInSeatOrder();
  if (!players.length) return null;
  const index = players.findIndex(p => p.id === playerId);
  if (index < 0) return players[0];
  return players[(index + 1) % players.length];
}

function nextSeat() {
  const used = new Set(room.players.map(p => p.seat));
  for (let seat = 0; seat < MAX_PLAYERS; seat++) {
    if (!used.has(seat)) return seat;
  }
  return room.players.length;
}

function hasConnectedPlayers(targetRoom) {
  return targetRoom.players.some(p => p.connected);
}

function normalizeName(name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (!clean) {
    throw new Error("Enter a name.");
  }
  return clean;
}

function normalizeId(id) {
  const clean = String(id || "").trim();
  return /^[a-zA-Z0-9_-]{6,80}$/.test(clean) ? clean : "";
}

function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    for (const player of parsed.players || []) {
      player.connected = false;
    }
    return parsed;
  } catch (error) {
    console.error("Failed to load snapshot:", error);
    return null;
  }
}

function saveSnapshot() {
  if (!room) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const snapshot = JSON.parse(JSON.stringify(room));
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error("Failed to save snapshot:", error);
  }
}

function deleteSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      fs.unlinkSync(SNAPSHOT_PATH);
    }
  } catch (error) {
    console.error("Failed to delete snapshot:", error);
  }
}
