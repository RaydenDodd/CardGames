const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = 10;
const NUDGE_COOLDOWN_MS = 10000;
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
        const player = markDisconnected(playerId);
        broadcast(player ? `${player.name} disconnected.` : undefined);
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
    if (type === "nudge") return nudgePlayer(player);

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
    turnOrderPlayerIds: [],
    pendingDiscardPlayerId: null,
    checkingPlayerId: null,
    finalTurnPlayerIds: [],
    nudgeReadyAt: Date.now() + NUDGE_COOLDOWN_MS,
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
  if (room.status !== "playing") {
    pruneInactiveLobbyPlayers();
  }

  const requestedId = normalizeId(data.playerId);
  const name = normalizeName(data.name);
  const nameKey = name.toLowerCase();
  let player = requestedId ? room.players.find(p => p.id === requestedId) : null;
  let matchedByName = false;

  if (!player) {
    player = room.players.find(p => (
      !p.connected &&
      p.name.toLowerCase() === nameKey &&
      (room.status !== "playing" || p.hand.length > 0)
    )) || null;
    matchedByName = Boolean(player);
  }

  if (room.status === "playing" && (!player || player.hand.length === 0)) {
    throw new Error("This game already started. Rejoin with the exact same name and room code to reclaim your hand.");
  }

  if (room.status === "playing" && player && player.hand.length && player.name.toLowerCase() !== nameKey) {
    throw new Error("Use the same name you had when the hand started.");
  }

  const wasReconnect = Boolean(player && !player.connected);
  let joinedNewPlayer = false;
  if (!player) {
    if (room.players.some(p => p.connected && p.name.toLowerCase() === nameKey)) {
      throw new Error("That name is already seated. Use that same name only after the player leaves or disconnects.");
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
    joinedNewPlayer = true;
  } else if (matchedByName && requestedId && player.id !== requestedId) {
    reassignPlayerId(player, requestedId);
  }

  player.name = name;
  player.connected = true;
  player.lastSeen = Date.now();
  bindSocket(ws, player.id);
  saveSnapshot();
  broadcast(wasReconnect
    ? `${player.name} rejoined.`
    : joinedNewPlayer
      ? `${player.name} joined the room.`
      : undefined);
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
  const wasReconnect = !player.connected;
  player.connected = true;
  player.lastSeen = Date.now();
  bindSocket(ws, player.id);
  saveSnapshot();
  broadcast(wasReconnect ? `${player.name} rejoined.` : undefined);
}

function startGame(player) {
  requireHost(player);
  if (room.status === "finished") {
    resetRoomToLobby("Game reset. Players can join before the host starts.");
    return;
  }
  if (room.status === "playing") {
    throw new Error("The game already started.");
  }

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
  const randomizedPlayers = shuffle(activePlayers.slice());
  room.turnOrderPlayerIds = randomizedPlayers.map(p => p.id);
  room.currentTurnPlayerId = randomizedPlayers[0].id;
  resetNudgeTimer();
  saveSnapshot();
  broadcast("Game started.");
}

function stopGame(player) {
  requireHost(player);
  resetRoomToLobby("Game reset. Players can join before the host starts.");
}

function resetRoomToLobby(toastMessage) {
  for (const p of room.players) {
    p.hand = [];
  }
  room.status = "lobby";
  room.currentTurnPlayerId = null;
  room.turnOrderPlayerIds = [];
  room.pendingDiscardPlayerId = null;
  room.checkingPlayerId = null;
  room.finalTurnPlayerIds = [];
  room.finishReason = "";
  room.finishedAt = null;
  room.stock = [];
  room.discard = [];
  resetNudgeTimer();
  pruneInactiveLobbyPlayers();
  saveSnapshot();
  broadcast(toastMessage || "Game reset.");
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
  resetNudgeTimer();
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
  if (player.id === room.hostId) {
    throw new Error("The host can use End Room instead of Leave.");
  }

  const playerName = player.name;
  const wasPlaying = room.status === "playing";
  const wasCurrent = room.currentTurnPlayerId === player.id;
  const previousTurnPlayerId = room.currentTurnPlayerId;
  const wasFinalTurnPlayer = (room.finalTurnPlayerIds || []).includes(player.id);
  const next = wasCurrent ? nextPlayerAfter(player.id) : null;

  detachPlayerSockets(player.id, "leftSeat", {
    message: "You left the table. Rejoin with the same name and room code to reclaim your hand."
  });
  player.connected = false;
  player.lastSeen = Date.now();
  room.turnOrderPlayerIds = (room.turnOrderPlayerIds || []).filter(id => id !== player.id);
  room.finalTurnPlayerIds = (room.finalTurnPlayerIds || []).filter(id => id !== player.id);
  if (room.pendingDiscardPlayerId === player.id) {
    if (player.hand.length > 3) {
      room.discard.push(player.hand.pop());
    }
    room.pendingDiscardPlayerId = null;
  }

  if (wasPlaying) {
    const activePlayers = activePlayersInTurnOrder();
    if (activePlayers.length < 2) {
      finishGame("leave", `${playerName} left. Not enough players remain.`);
      return;
    }
    if (room.checkingPlayerId && wasFinalTurnPlayer && !room.finalTurnPlayerIds.length) {
      finishGame("check", `${playerName} left. Final turns are complete.`);
      return;
    }
    if (wasCurrent) {
      if (room.checkingPlayerId && room.finalTurnPlayerIds.length) {
        room.currentTurnPlayerId = room.finalTurnPlayerIds[0];
      } else {
        const nextStillActive = next && activePlayers.some(p => p.id === next.id) ? next : activePlayers[0];
        room.currentTurnPlayerId = nextStillActive.id;
      }
    } else if (!activePlayers.some(p => p.id === room.currentTurnPlayerId)) {
      room.currentTurnPlayerId = activePlayers[0].id;
    }
    if (room.currentTurnPlayerId !== previousTurnPlayerId) {
      resetNudgeTimer();
    }
  }

  saveSnapshot();
  broadcast(`${playerName} left the table.`);
}

function nudgePlayer(player) {
  const target = currentNudgeTarget();
  if (!target) {
    throw new Error(room && room.status === "playing"
      ? "There is no connected current player to nudge."
      : "There is no connected host to nudge.");
  }
  if (target.id === player.id) {
    throw new Error(room.status === "playing" ? "It is already your turn." : "You are the host.");
  }

  const now = Date.now();
  const readyAt = Number(room.nudgeReadyAt) || (now + NUDGE_COOLDOWN_MS);
  if (now < readyAt) {
    const seconds = Math.ceil((readyAt - now) / 1000);
    throw new Error(`Nudge is ready in ${seconds}s.`);
  }

  room.nudgeReadyAt = now + NUDGE_COOLDOWN_MS;
  saveSnapshot();
  broadcast();

  const targetMessage = `GO IT IS YOUR TURN!!- Sent with love from ${player.name}`;
  const sent = sendNudgeAlertToPlayer(target.id, targetMessage);
  sendToastToPlayer(player.id, sent ? `Nudge sent to ${target.name}.` : `${target.name} is not connected right now.`);
}

function markDisconnected(playerId) {
  if (!room) {
    return null;
  }
  const player = room.players.find(p => p.id === playerId);
  if (!player || !player.connected) {
    return null;
  }
  player.connected = false;
  player.lastSeen = Date.now();
  saveSnapshot();
  return player;
}

function reassignPlayerId(player, nextId) {
  if (!nextId || player.id === nextId) {
    return;
  }
  if (room.players.some(p => p !== player && p.id === nextId)) {
    throw new Error("That saved player id is already seated.");
  }

  const previousId = player.id;
  player.id = nextId;
  if (room.hostId === previousId) {
    room.hostId = nextId;
  }
  if (room.currentTurnPlayerId === previousId) {
    room.currentTurnPlayerId = nextId;
  }
  if (room.pendingDiscardPlayerId === previousId) {
    room.pendingDiscardPlayerId = nextId;
  }
  if (room.checkingPlayerId === previousId) {
    room.checkingPlayerId = nextId;
  }
  room.turnOrderPlayerIds = (room.turnOrderPlayerIds || []).map(id => id === previousId ? nextId : id);
  room.finalTurnPlayerIds = (room.finalTurnPlayerIds || []).map(id => id === previousId ? nextId : id);
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

function detachPlayerSockets(playerId, type, data) {
  const playerSockets = sockets.get(playerId);
  if (!playerSockets) {
    return;
  }
  for (const ws of playerSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      if (type) {
        send(ws, type, data);
        ws.suppressNextToast = true;
      }
      ws.playerId = null;
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
  const players = activePlayersInTurnOrder();
  if (!players.length) {
    room.currentTurnPlayerId = null;
    resetNudgeTimer();
    return;
  }
  const currentIndex = players.findIndex(p => p.id === room.currentTurnPlayerId);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % players.length;
  room.currentTurnPlayerId = players[nextIndex].id;
  resetNudgeTimer();
}

function completeTurn(player) {
  if (player && Array.isArray(room.finalTurnPlayerIds) && room.finalTurnPlayerIds.length) {
    room.finalTurnPlayerIds = room.finalTurnPlayerIds.filter(id => id !== player.id);
    if (!room.finalTurnPlayerIds.length) {
      finishGame("check", "Final turns are complete.");
      return true;
    }
    room.currentTurnPlayerId = room.finalTurnPlayerIds[0];
    resetNudgeTimer();
    return false;
  }
  advanceTurn();
  return false;
}

function activePlayersInSeatOrder() {
  return room.players
    .filter(p => p.connected)
    .sort((a, b) => a.seat - b.seat);
}

function activePlayersInTurnOrder() {
  const active = room.players.filter(p => p.connected);
  const byId = new Map(active.map(p => [p.id, p]));
  const order = Array.isArray(room.turnOrderPlayerIds) && room.turnOrderPlayerIds.length
    ? room.turnOrderPlayerIds
    : active.slice().sort((a, b) => a.seat - b.seat).map(p => p.id);
  const ordered = order.map(id => byId.get(id)).filter(Boolean);
  const orderedIds = new Set(ordered.map(p => p.id));
  const missing = active
    .filter(p => !orderedIds.has(p.id))
    .sort((a, b) => a.seat - b.seat);
  return ordered.concat(missing);
}

function connectedPlayersInSeatOrder() {
  return room.players
    .filter(p => p.connected)
    .sort((a, b) => a.seat - b.seat);
}

function playersAfter(playerId) {
  const players = activePlayersInTurnOrder();
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
  room.turnOrderPlayerIds = [];
  room.pendingDiscardPlayerId = null;
  room.finalTurnPlayerIds = [];
  room.nudgeReadyAt = 0;
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
      nudgeReadyAt: Number(room.nudgeReadyAt) || 0,
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
    activeCount: counted.filter(p => p.connected || (room && p.id === room.hostId)).length,
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
    .sort((a, b) => {
      if (b.total !== a.total) {
        return b.total - a.total;
      }
      return compareHandTieBreaker(a, b);
    });

  const leaderTotal = rows.length ? rows[0].total : 0;
  const leader = rows[0] || null;
  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
    isWinner: Boolean(leader && row.total === leaderTotal && compareHandTieBreaker(leader, row) === 0),
    difference: row.total - leaderTotal
  }));
}

function compareHandTieBreaker(playerA, playerB) {
  const sortedA = tieBreakerCards(playerA.hand);
  const sortedB = tieBreakerCards(playerB.hand);
  const minLength = Math.min(sortedA.length, sortedB.length);
  for (let i = 0; i < minLength; i++) {
    const rankDiff = tieBreakerRank(sortedB[i].value) - tieBreakerRank(sortedA[i].value);
    if (rankDiff) {
      return rankDiff;
    }
  }
  if (sortedA.length !== sortedB.length) {
    return sortedB.length - sortedA.length;
  }
  for (let i = 0; i < sortedA.length; i++) {
    const suitDiff = suitTieBreakerRank(sortedB[i].suit) - suitTieBreakerRank(sortedA[i].suit);
    if (suitDiff) {
      return suitDiff;
    }
  }
  return playerA.seat - playerB.seat;
}

function tieBreakerCards(hand) {
  return (Array.isArray(hand) ? hand : []).slice().sort((a, b) => {
    const rankDiff = tieBreakerRank(b.value) - tieBreakerRank(a.value);
    if (rankDiff) {
      return rankDiff;
    }
    return suitTieBreakerRank(b.suit) - suitTieBreakerRank(a.suit);
  });
}

function tieBreakerRank(value) {
  const order = { A: 14, K: 13, Q: 12, J: 11 };
  return order[value] || Number(value) || 0;
}

function suitTieBreakerRank(suit) {
  const order = { "\u2663": 1, "\u2666": 2, "\u2665": 3, "\u2660": 4 };
  return order[suit] || 0;
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
      if (ws.suppressNextToast) {
        ws.suppressNextToast = false;
      } else {
        send(ws, "toast", { message: toastMessage });
      }
    }
  }
}

function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function sendToastToPlayer(playerId, message) {
  const playerSockets = sockets.get(playerId);
  if (!playerSockets) {
    return false;
  }
  let sent = false;
  for (const ws of playerSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, "toast", { message });
      sent = true;
    }
  }
  return sent;
}

function sendNudgeAlertToPlayer(playerId, message) {
  const playerSockets = sockets.get(playerId);
  if (!playerSockets) {
    return false;
  }
  let sent = false;
  for (const ws of playerSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, "nudgeAlert", { message });
      sent = true;
    }
  }
  return sent;
}

function currentNudgeTarget() {
  if (!room) {
    return null;
  }
  if (room.status === "playing") {
    const target = currentPlayer();
    return target && target.connected ? target : null;
  }
  if (room.status === "lobby") {
    return room.players.find(p => p.id === room.hostId && p.connected) || null;
  }
  return null;
}

function resetNudgeTimer() {
  if (room) {
    room.nudgeReadyAt = Date.now() + NUDGE_COOLDOWN_MS;
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
  const players = activePlayersInTurnOrder();
  if (!players.length) return null;
  const index = players.findIndex(p => p.id === playerId);
  if (index < 0) return players[0];
  return players[(index + 1) % players.length];
}

function pruneInactiveLobbyPlayers() {
  if (!room || room.status === "playing") {
    return;
  }
  room.players = room.players.filter(p => p.connected || p.hand.length || p.id === room.hostId);
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
    parsed.turnOrderPlayerIds = Array.isArray(parsed.turnOrderPlayerIds) ? parsed.turnOrderPlayerIds : [];
    parsed.nudgeReadyAt = Number(parsed.nudgeReadyAt) || (Date.now() + NUDGE_COOLDOWN_MS);
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
