const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = 10;
const MAX_ROOMS = 3;
const NUDGE_COOLDOWN_MS = 10000;
const DISCONNECT_FORFEIT_MS = 30 * 1000;
const ROOM_IDLE_MS = 10 * 60 * 1000;
const ROOM_CLEANUP_MS = 60 * 1000;
const SNAPSHOT_PATH = path.join(__dirname, "data", "state.json");
const HEARTBEAT_MS = 30000;
const SUITS = [
  { suit: "\u2660", color: "black" },
  { suit: "\u2665", color: "red" },
  { suit: "\u2666", color: "red" },
  { suit: "\u2663", color: "black" }
];
const VALUES = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

let rooms = loadSnapshot();
let room = null;
const sockets = new Map();
const disconnectForfeitTimers = new Map();

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => {
  cleanupInactiveRooms();
  const roomList = Array.from(rooms.values());
  const counts = roomList.reduce((total, activeRoom) => {
    const roomCount = roomCounts(activeRoom.players, activeRoom);
    total.activeCount += roomCount.activeCount;
    total.connectedCount += roomCount.connectedCount;
    total.seatedCount += roomCount.seatedCount;
    return total;
  }, { activeCount: 0, connectedCount: 0, seatedCount: 0 });
  res.json({
    ok: true,
    game: "thirty-one",
    roomCode: roomList[0] ? roomList[0].code : null,
    rooms: roomList.map(activeRoom => ({
      code: activeRoom.code,
      status: activeRoom.status,
      players: roomCounts(activeRoom.players, activeRoom).activeCount,
      connectedPlayers: roomCounts(activeRoom.players, activeRoom).connectedCount,
      lastActivityAt: activeRoom.lastActivityAt || activeRoom.createdAt || null
    })),
    roomCount: roomList.length,
    maxRooms: MAX_ROOMS,
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
    if (ws.playerId && ws.roomCode) {
      const playerId = ws.playerId;
      const roomCode = ws.roomCode;
      const targetRoom = rooms.get(roomCode);
      removeSocket(ws);
      if (targetRoom && !hasOpenSocket(roomCode, playerId)) {
        room = targetRoom;
        const player = markDisconnected(playerId);
        const pendingForfeit = Boolean(player && room.pendingDisconnectForfeit && room.pendingDisconnectForfeit.playerId === player.id);
        broadcast(player
          ? pendingForfeit
            ? `${player.name} disconnected. Waiting 30 seconds for them to reconnect.`
            : `${player.name} disconnected.`
          : undefined);
        room = null;
      }
    }
  });

  send(ws, "roomState", publicRoomForSocket(ws));
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

setInterval(cleanupInactiveRooms, ROOM_CLEANUP_MS);

server.listen(PORT, () => {
  console.log(`Thirty One server listening on port ${PORT}`);
});

function handleMessage(ws, message) {
  const type = message.type;
  const data = message.data || {};

  try {
    cleanupInactiveRooms();
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
  } finally {
    room = null;
  }
}

function createRoom(ws, data) {
  const playerId = normalizeId(data.playerId) || newId("p");
  const name = normalizeName(data.name);

  if (rooms.size >= MAX_ROOMS) {
    throw new Error("The server already has 3 active rooms. Wait for one to clear or ask a host to end a room.");
  }

  const now = Date.now();
  room = {
    code: generateRoomCode(),
    status: "lobby",
    hostId: playerId,
    createdAt: now,
    lastActivityAt: now,
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
      joinedAt: now,
      lastSeen: now,
      hand: []
    }]
  };
  while (rooms.has(room.code)) {
    room.code = generateRoomCode();
  }
  rooms.set(room.code, room);

  bindSocket(ws, playerId);
  touchRoom();
  saveSnapshot();
  send(ws, "toast", { message: `Room ${room.code} created.` });
  broadcast();
  room = null;
}

function joinRoom(ws, data) {
  const code = String(data.roomCode || "").trim().toUpperCase();
  room = rooms.get(code) || null;
  if (!room) {
    throw new Error("Room code not found.");
  }
  touchRoom();
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
  cancelDisconnectForfeitForPlayer(player.id);
  touchRoom();
  saveSnapshot();
  broadcast(wasReconnect
    ? `${player.name} rejoined.`
    : joinedNewPlayer
      ? `${player.name} joined the room.`
      : undefined);
  room = null;
}

function syncPlayer(ws, data) {
  room = roomForSync(ws, data);
  if (!room) {
    send(ws, "roomState", { room: null });
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
  cancelDisconnectForfeitForPlayer(player.id);
  touchRoom();
  saveSnapshot();
  broadcast(wasReconnect ? `${player.name} rejoined.` : undefined);
  room = null;
}

function startGame(player) {
  requireHost(player);
  clearDisconnectForfeit(room);
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
  clearDisconnectForfeit(room);
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
  closeRoom(room, message);
  saveSnapshot();
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
      if (scheduleDisconnectForfeit(player)) {
        saveSnapshot();
        broadcast(`${playerName} left. Waiting 30 seconds for them to reconnect.`);
      } else {
        finishGame("leave", `${playerName} left. Not enough players remain.`);
      }
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
  touchRoom();
  scheduleDisconnectForfeit(player);
  saveSnapshot();
  return player;
}

function scheduleDisconnectForfeit(player) {
  if (!room || !player || room.status !== "playing") {
    return false;
  }
  if (connectedPlayersInSeatOrder().length >= 2) {
    clearDisconnectForfeit(room);
    return false;
  }

  const deadlineAt = Date.now() + DISCONNECT_FORFEIT_MS;
  room.pendingDisconnectForfeit = {
    playerId: player.id,
    playerName: player.name,
    deadlineAt
  };
  clearTimeout(disconnectForfeitTimers.get(room.code));
  disconnectForfeitTimers.set(room.code, setTimeout(() => {
    resolveDisconnectForfeit(room.code, player.id);
  }, DISCONNECT_FORFEIT_MS));
  return true;
}

function resolveDisconnectForfeit(roomCode, playerId) {
  const targetRoom = rooms.get(roomCode);
  if (!targetRoom) {
    disconnectForfeitTimers.delete(roomCode);
    return;
  }

  room = targetRoom;
  const pending = room.pendingDisconnectForfeit || null;
  const player = room.players.find(p => p.id === playerId);
  if (
    room.status !== "playing" ||
    !pending ||
    pending.playerId !== playerId ||
    !player ||
    player.connected ||
    connectedPlayersInSeatOrder().length >= 2
  ) {
    clearDisconnectForfeit(room);
    saveSnapshot();
    broadcast();
    room = null;
    return;
  }

  const playerName = pending.playerName || player.name || "A player";
  clearDisconnectForfeit(room);
  finishGame("forfeit", `${playerName} forfeited and is a sore loser.`);
  room = null;
}

function cancelDisconnectForfeitForPlayer(playerId) {
  if (!room || !room.pendingDisconnectForfeit || room.pendingDisconnectForfeit.playerId !== playerId) {
    return false;
  }
  clearDisconnectForfeit(room);
  return true;
}

function clearDisconnectForfeit(targetRoom = room) {
  if (!targetRoom) {
    return;
  }
  const timer = disconnectForfeitTimers.get(targetRoom.code);
  if (timer) {
    clearTimeout(timer);
    disconnectForfeitTimers.delete(targetRoom.code);
  }
  delete targetRoom.pendingDisconnectForfeit;
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
  if ((ws.playerId && ws.playerId !== playerId) || (ws.roomCode && room && ws.roomCode !== room.code)) {
    removeSocket(ws);
  }
  ws.playerId = playerId;
  ws.roomCode = room.code;
  const key = socketKey(room.code, playerId);
  if (!sockets.has(key)) {
    sockets.set(key, new Set());
  }
  sockets.get(key).add(ws);
}

function removeSocket(ws) {
  if (!ws.playerId || !ws.roomCode) {
    return;
  }
  const playerSockets = sockets.get(socketKey(ws.roomCode, ws.playerId));
  if (!playerSockets) {
    return;
  }
  playerSockets.delete(ws);
  if (!playerSockets.size) {
    sockets.delete(socketKey(ws.roomCode, ws.playerId));
  }
}

function hasOpenSocket(roomCode, playerId) {
  const playerSockets = sockets.get(socketKey(roomCode, playerId));
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
  const playerSockets = sockets.get(socketKey(room.code, playerId));
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
      ws.roomCode = null;
    }
  }
  sockets.delete(socketKey(room.code, playerId));
}

function requirePlayer(ws) {
  room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room || !ws.playerId) {
    throw new Error("Join a room first.");
  }
  const player = room.players.find(p => p.id === ws.playerId);
  if (!player) {
    throw new Error("Seat not found.");
  }
  player.connected = true;
  player.lastSeen = Date.now();
  touchRoom();
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
  clearDisconnectForfeit(room);
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

function publicRoomForSocket(ws) {
  const targetRoom = ws && ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!targetRoom) {
    return { room: null };
  }
  room = targetRoom;
  const state = publicRoom();
  room = null;
  return state;
}

function roomCounts(players = room ? room.players : [], targetRoom = room) {
  const counted = Array.isArray(players) ? players : [];
  return {
    connectedCount: counted.filter(p => p.connected).length,
    activeCount: counted.filter(p => p.connected || (targetRoom && p.id === targetRoom.hostId)).length,
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
    if (ws.readyState !== WebSocket.OPEN || ws.roomCode !== room.code) {
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
  const playerSockets = sockets.get(socketKey(room.code, playerId));
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
  const playerSockets = sockets.get(socketKey(room.code, playerId));
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

function socketKey(roomCode, playerId) {
  return `${roomCode}:${playerId}`;
}

function touchRoom(targetRoom = room) {
  if (targetRoom) {
    targetRoom.lastActivityAt = Date.now();
  }
}

function roomForSync(ws, data) {
  const code = String(data.roomCode || ws.roomCode || "").trim().toUpperCase();
  if (code && rooms.has(code)) {
    return rooms.get(code);
  }
  const playerId = normalizeId(data.playerId || ws.playerId);
  if (!playerId) {
    return null;
  }
  for (const candidate of rooms.values()) {
    if (candidate.players.some(p => p.id === playerId)) {
      return candidate;
    }
  }
  return null;
}

function closeRoom(targetRoom, message) {
  if (!targetRoom) {
    return;
  }
  clearDisconnectForfeit(targetRoom);
  rooms.delete(targetRoom.code);
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.roomCode !== targetRoom.code) {
      continue;
    }
    ws.playerId = null;
    ws.roomCode = null;
    send(ws, "sessionEnded", { message });
    send(ws, "roomState", { room: null });
    send(ws, "toast", { message });
  }
  for (const key of Array.from(sockets.keys())) {
    if (key.startsWith(`${targetRoom.code}:`)) {
      sockets.delete(key);
    }
  }
}

function cleanupInactiveRooms() {
  const now = Date.now();
  let changed = false;
  for (const candidate of Array.from(rooms.values())) {
    const lastActivityAt = Number(candidate.lastActivityAt || candidate.createdAt || now);
    if (now - lastActivityAt > ROOM_IDLE_MS) {
      closeRoom(candidate, "Room closed after 10 minutes with no activity.");
      changed = true;
    }
  }
  if (changed) {
    saveSnapshot();
  }
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
      return new Map();
    }
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    const list = Array.isArray(parsed.rooms) ? parsed.rooms : (parsed && parsed.code ? [parsed] : []);
    const restored = new Map();
    for (const candidate of list.slice(0, MAX_ROOMS)) {
      if (!candidate || !candidate.code) {
        continue;
      }
      for (const player of candidate.players || []) {
        player.connected = false;
      }
      candidate.turnOrderPlayerIds = Array.isArray(candidate.turnOrderPlayerIds) ? candidate.turnOrderPlayerIds : [];
      candidate.nudgeReadyAt = Number(candidate.nudgeReadyAt) || (Date.now() + NUDGE_COOLDOWN_MS);
      candidate.createdAt = Number(candidate.createdAt) || Date.now();
      candidate.lastActivityAt = Number(candidate.lastActivityAt) || candidate.createdAt;
      delete candidate.pendingDisconnectForfeit;
      restored.set(candidate.code, candidate);
    }
    return restored;
  } catch (error) {
    console.error("Failed to load snapshot:", error);
    return new Map();
  }
}

function saveSnapshot() {
  if (!rooms.size) {
    deleteSnapshot();
    return;
  }
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const snapshot = { rooms: Array.from(rooms.values()).map(activeRoom => {
      const snapshotRoom = JSON.parse(JSON.stringify(activeRoom));
      delete snapshotRoom.pendingDisconnectForfeit;
      return snapshotRoom;
    }) };
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
