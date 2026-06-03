(function () {
  const STORAGE = {
    playerId: "thirtyOnePlayerId",
    playerName: "thirtyOnePlayerName",
    roomCode: "thirtyOneRoomCode",
    serverUrl: "thirtyOneServerUrl"
  };
  const MAX_PLAYERS = 10;
  const RED_SUITS = new Set(["\u2665", "\u2666"]);
  const CARD_RENDER_OPTIONS = { assetBasePath: "../../assets/courts/white" };
  const MINI_CARD_RENDER_OPTIONS = { size: "mini", assetBasePath: "../../assets/courts/white" };

  const dom = {
    roomCode: document.getElementById("roomCode"),
    copyRoomBtn: document.getElementById("copyRoomBtn"),
    connectionStatus: document.getElementById("connectionStatus"),
    currentPlayer: document.getElementById("currentPlayer"),
    nextPlayer: document.getElementById("nextPlayer"),
    playerCount: document.getElementById("playerCount"),
    avatarRing: document.getElementById("avatarRing"),
    stockPile: document.getElementById("stockPile"),
    stockCard: document.getElementById("stockCard"),
    stockCount: document.getElementById("stockCount"),
    discardPile: document.getElementById("discardPile"),
    discardCard: document.getElementById("discardCard"),
    discardCount: document.getElementById("discardCount"),
    bestScore: document.getElementById("bestScore"),
    turnHint: document.getElementById("turnHint"),
    hostControls: document.getElementById("hostControls"),
    startBtn: document.getElementById("startBtn"),
    skipBtn: document.getElementById("skipBtn"),
    stopBtn: document.getElementById("stopBtn"),
    handStatus: document.getElementById("handStatus"),
    sortBtn: document.getElementById("sortBtn"),
    hintBtn: document.getElementById("hintBtn"),
    handPrevBtn: document.getElementById("handPrevBtn"),
    handNextBtn: document.getElementById("handNextBtn"),
    handScroller: document.getElementById("handScroller"),
    handTrack: document.getElementById("handTrack"),
    joinPanel: document.getElementById("joinPanel"),
    joinForm: document.getElementById("joinForm"),
    playerNameInput: document.getElementById("playerNameInput"),
    roomCodeInput: document.getElementById("roomCodeInput"),
    createRoomBtn: document.getElementById("createRoomBtn"),
    joinRoomBtn: document.getElementById("joinRoomBtn"),
    joinError: document.getElementById("joinError"),
    helpBtn: document.getElementById("helpBtn"),
    helpPanel: document.getElementById("helpPanel"),
    closeHelpBtn: document.getElementById("closeHelpBtn"),
    toast: document.getElementById("toast")
  };

  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let roomState = null;
  let privateState = {
    playerId: "",
    hand: [],
    best: { total: 0, suit: "" },
    mustDiscard: false,
    isTurn: false
  };
  let selectedCardId = "";
  let toastTimer = null;
  let autoJoinTimer = null;
  let pointerState = null;
  let suppressClickCardId = "";

  const playerId = ensurePlayerId();
  const serverUrl = resolveServerUrl();

  hydrateSavedInputs();
  bindEvents();
  connect();
  render();

  function bindEvents() {
    dom.createRoomBtn.addEventListener("click", () => {
      const name = readName();
      if (!name) return;
      setStored(STORAGE.playerName, name);
      send("createRoom", { playerId, name });
    });

    dom.joinForm.addEventListener("submit", event => {
      event.preventDefault();
      const name = readName();
      const roomCode = readRoomCode();
      if (!name || !roomCode) return;
      setStored(STORAGE.playerName, name);
      setStored(STORAGE.roomCode, roomCode);
      send("joinRoom", { playerId, name, roomCode });
    });

    dom.stockPile.addEventListener("click", () => {
      if (canDraw()) send("drawStock");
    });

    dom.discardPile.addEventListener("click", () => {
      if (canDraw()) send("drawDiscard");
    });

    dom.startBtn.addEventListener("click", () => send("startGame"));
    dom.skipBtn.addEventListener("click", () => send("skipPlayer"));
    dom.stopBtn.addEventListener("click", () => send("stopGame"));

    dom.copyRoomBtn.addEventListener("click", () => {
      const code = roomState ? roomState.code : "";
      if (!code) {
        showToast("Create or join a room first.");
        return;
      }
      copyText(code);
    });

    dom.sortBtn.addEventListener("click", () => {
      sortHandForDisplay();
    });

    dom.hintBtn.addEventListener("click", () => {
      showHint();
    });

    dom.handPrevBtn.addEventListener("click", () => {
      scrollHand(-1);
    });

    dom.handNextBtn.addEventListener("click", () => {
      scrollHand(1);
    });

    dom.helpBtn.addEventListener("click", () => {
      dom.helpPanel.hidden = false;
    });

    dom.closeHelpBtn.addEventListener("click", () => {
      dom.helpPanel.hidden = true;
    });

    dom.helpPanel.addEventListener("click", event => {
      if (event.target === dom.helpPanel) {
        dom.helpPanel.hidden = true;
      }
    });
  }

  function connect() {
    clearTimeout(reconnectTimer);
    setConnectionStatus("Connecting...");

    try {
      socket = new WebSocket(serverUrl);
    } catch (error) {
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      setConnectionStatus("Connected");
      send("sync", { playerId });
      scheduleAutoJoin();
    });

    socket.addEventListener("message", event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(message);
    });

    socket.addEventListener("close", () => {
      setConnectionStatus("Reconnecting...");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      setConnectionStatus("Connection problem");
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = Math.min(1000 + reconnectAttempts * 900, 8000);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function scheduleAutoJoin() {
    clearTimeout(autoJoinTimer);
    const savedName = getStored(STORAGE.playerName);
    const savedRoomCode = getStored(STORAGE.roomCode);
    if (!savedName || !savedRoomCode) {
      return;
    }

    autoJoinTimer = setTimeout(() => {
      if (!isSelfSeated()) {
        send("joinRoom", { playerId, name: savedName, roomCode: savedRoomCode });
      }
    }, 350);
  }

  function handleServerMessage(message) {
    const data = message.data || {};
    if (message.type === "roomState") {
      roomState = data.room || null;
      if (!roomState) {
        privateState = {
          playerId,
          hand: [],
          best: { total: 0, suit: "" },
          mustDiscard: false,
          isTurn: false
        };
        selectedCardId = "";
        dom.joinPanel.hidden = false;
      } else if (roomState.players.some(player => player.id === playerId)) {
        dom.joinPanel.hidden = true;
        setStored(STORAGE.roomCode, roomState.code);
      } else {
        dom.joinPanel.hidden = false;
      }
      render();
      return;
    }

    if (message.type === "privateHand") {
      privateState = {
        playerId: data.playerId || playerId,
        hand: Array.isArray(data.hand) ? data.hand : [],
        best: data.best || { total: 0, suit: "" },
        mustDiscard: Boolean(data.mustDiscard),
        isTurn: Boolean(data.isTurn)
      };
      if (!privateState.hand.some(card => card.id === selectedCardId)) {
        selectedCardId = "";
      }
      render();
      return;
    }

    if (message.type === "toast") {
      showToast(data.message || "");
      return;
    }

    if (message.type === "error") {
      showError(data.message || "Action failed.");
    }
  }

  function render() {
    renderHud();
    renderTable();
    renderAvatars();
    renderHand();
    renderControls();
  }

  function renderHud() {
    const players = roomState ? roomState.players : [];
    const connectedCount = players.filter(player => player.connected).length;
    dom.roomCode.textContent = roomState ? roomState.code : "----";
    dom.playerCount.textContent = `${connectedCount}/${MAX_PLAYERS}`;
    dom.currentPlayer.textContent = roomState && roomState.currentPlayerName
      ? `${roomState.currentPlayerName}'s turn`
      : roomState
        ? "Waiting for start"
        : "Waiting for host";
    dom.nextPlayer.textContent = roomState && roomState.nextPlayerName ? roomState.nextPlayerName : "--";
  }

  function renderTable() {
    const stockCount = roomState ? roomState.stockCount : 0;
    const discardCount = roomState ? roomState.discardCount : 0;
    const discardTop = roomState ? roomState.discardTop : null;

    dom.stockCount.textContent = String(stockCount);
    dom.discardCount.textContent = String(discardCount);
    replaceCard(dom.stockCard, stockCount > 0 ? CardRenderer.renderCard(null, { size: "mini", back: true }) : emptyPile("Empty"));
    replaceCard(dom.discardCard, discardTop ? CardRenderer.renderCard(discardTop, MINI_CARD_RENDER_OPTIONS) : emptyPile("Empty"));

    dom.stockPile.disabled = !canDraw() || stockCount < 1;
    dom.discardPile.disabled = !canDraw() || !discardTop;
  }

  function renderAvatars() {
    dom.avatarRing.innerHTML = "";
    const opponents = roomState
      ? roomState.players
        .filter(player => player.id !== playerId)
        .sort((a, b) => a.seat - b.seat)
      : [];
    const slots = ["top", "left", "right"];

    slots.forEach((slot, index) => {
      const player = opponents[index] || null;
      const seat = document.createElement("div");
      seat.className = `avatar-seat opponent-${slot}${player ? "" : " placeholder"}${player && !player.connected ? " inactive" : ""}`;
      seat.style.setProperty("--avatar-hue", String((((player && player.seat) || index + 1) * 47) % 360));

      const avatar = document.createElement("div");
      avatar.className = "voxel-avatar";
      avatar.innerHTML = `
        <span class="voxel-head"></span>
        <span class="voxel-body"></span>
        <span class="voxel-arm left"></span>
        <span class="voxel-arm right"></span>
        <span class="opponent-cards">
          <span class="voxel-card"></span>
          <span class="voxel-card"></span>
          <span class="voxel-card"></span>
        </span>
      `;

      const name = document.createElement("div");
      name.className = "avatar-name";
      name.textContent = player ? player.name : "Open Seat";

      const meta = document.createElement("div");
      meta.className = "avatar-meta";
      meta.textContent = player ? `${player.handCount || 0} cards${player.isHost ? " | Host" : ""}` : "waiting";

      seat.append(avatar, name, meta);
      dom.avatarRing.appendChild(seat);
    });
  }

  function renderHand() {
    const hand = privateState.hand || [];
    const overlap = hand.length <= 2 ? 8 : Math.min(82, 24 + hand.length * 11);
    dom.handTrack.style.setProperty("--hand-overlap", `${overlap}px`);
    dom.handTrack.innerHTML = "";

    hand.forEach((card, index) => {
      const cardButton = document.createElement("button");
      cardButton.type = "button";
      cardButton.className = `hand-card${card.id === selectedCardId ? " selected" : ""}`;
      cardButton.style.zIndex = card.id === selectedCardId ? "50" : String(index + 1);
      cardButton.setAttribute("aria-label", `${card.value} ${card.suit}`);
      cardButton.appendChild(CardRenderer.renderCard(card, CARD_RENDER_OPTIONS));

      cardButton.addEventListener("click", () => {
        if (suppressClickCardId === card.id) {
          suppressClickCardId = "";
          return;
        }
        selectedCardId = card.id === selectedCardId ? "" : card.id;
        render();
      });

      cardButton.addEventListener("pointerdown", event => {
        pointerState = {
          cardId: card.id,
          element: cardButton,
          startX: event.clientX,
          startY: event.clientY,
          moved: false
        };
        cardButton.setPointerCapture(event.pointerId);
      });

      cardButton.addEventListener("pointermove", event => {
        if (!pointerState || pointerState.cardId !== card.id || selectedCardId !== card.id || !privateState.mustDiscard || !privateState.isTurn) {
          return;
        }
        const deltaY = event.clientY - pointerState.startY;
        const deltaX = event.clientX - pointerState.startX;
        if (deltaY < -8 && Math.abs(deltaY) > Math.abs(deltaX) * 1.1) {
          pointerState.moved = true;
          cardButton.classList.add("dragging", "selected");
          cardButton.style.transform = `translateY(${Math.max(deltaY - 28, -150)}px) scale(1.08) rotate(0deg)`;
        }
      });

      cardButton.addEventListener("pointerup", event => {
        if (!pointerState || pointerState.cardId !== card.id) {
          return;
        }
        const deltaY = event.clientY - pointerState.startY;
        cleanupPointerCard(cardButton);
        if (privateState.mustDiscard && privateState.isTurn && selectedCardId === card.id && deltaY < -72) {
          suppressClickCardId = card.id;
          selectedCardId = card.id;
          discardSelected();
          return;
        }
        pointerState = null;
      });

      cardButton.addEventListener("pointercancel", () => {
        cleanupPointerCard(cardButton);
        pointerState = null;
      });

      dom.handTrack.appendChild(cardButton);
    });

    dom.handStatus.textContent = hand.length
      ? `${hand.length} card${hand.length === 1 ? "" : "s"} in hand`
      : "Your cards appear here.";
    dom.handPrevBtn.disabled = hand.length < 4;
    dom.handNextBtn.disabled = hand.length < 4;
  }

  function renderControls() {
    const self = getSelf();
    const isHost = Boolean(roomState && self && roomState.hostId === playerId);
    const isPlaying = Boolean(roomState && roomState.status === "playing");
    const connectedCount = roomState ? roomState.players.filter(player => player.connected).length : 0;
    const best = privateState.best || { total: 0, suit: "" };

    dom.hostControls.hidden = !isHost;
    dom.startBtn.disabled = !roomState || isPlaying || connectedCount < 2;
    dom.skipBtn.disabled = !isHost || !isPlaying;
    dom.stopBtn.disabled = !roomState;

    dom.bestScore.textContent = best.suit ? `${best.total} ${best.suit}` : "0";
    dom.bestScore.classList.toggle("red-score", RED_SUITS.has(best.suit));
    dom.turnHint.textContent = turnHint();
  }

  function turnHint() {
    if (!roomState) {
      return "Create or join a room to play.";
    }
    if (!getSelf()) {
      return "Join this table to take a seat.";
    }
    if (roomState.status !== "playing") {
      return roomState.hostId === playerId ? "Start when everyone is ready." : "Waiting for the host to start.";
    }
    if (privateState.isTurn && privateState.mustDiscard) {
      return "Discard one card.";
    }
    if (privateState.isTurn) {
      return "Draw from the deck or discard pile.";
    }
    return roomState.currentPlayerName ? `Waiting for ${roomState.currentPlayerName}.` : "Waiting for the next turn.";
  }

  function discardSelected() {
    if (!selectedCardId || !privateState.mustDiscard || !privateState.isTurn) {
      return;
    }
    send("discard", { cardId: selectedCardId });
    selectedCardId = "";
    pointerState = null;
    renderControls();
  }

  function sortHandForDisplay() {
    const suitOrder = { "\u2660": 0, "\u2665": 1, "\u2666": 2, "\u2663": 3 };
    const valueOrder = { A: 1, J: 11, Q: 12, K: 13 };
    privateState.hand = privateState.hand.slice().sort((a, b) => {
      const suitDiff = (suitOrder[a.suit] ?? 9) - (suitOrder[b.suit] ?? 9);
      if (suitDiff) return suitDiff;
      return (valueOrder[a.value] || Number(a.value) || 0) - (valueOrder[b.value] || Number(b.value) || 0);
    });
    renderHand();
  }

  function showHint() {
    const best = privateState.best || { total: 0, suit: "" };
    if (!roomState) {
      showToast("Create or join a room first.");
      return;
    }
    if (privateState.isTurn && !privateState.mustDiscard) {
      showToast("Draw from New or Dead Pile.");
      return;
    }
    if (privateState.isTurn && privateState.mustDiscard) {
      showToast("Pick one card to discard back to 3 cards.");
      return;
    }
    showToast(best.suit ? `Your best suit is ${best.total} ${best.suit}.` : "Wait for your cards to be dealt.");
  }

  function scrollHand(direction) {
    const distance = Math.max(140, dom.handScroller.clientWidth * 0.45);
    dom.handScroller.scrollBy({ left: distance * direction, behavior: "smooth" });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast(`Copied room ${text}.`))
        .catch(() => showToast(`Room code: ${text}`));
      return;
    }
    showToast(`Room code: ${text}`);
  }

  function canDraw() {
    return Boolean(roomState && roomState.status === "playing" && privateState.isTurn && !privateState.mustDiscard);
  }

  function getSelf() {
    return roomState ? roomState.players.find(player => player.id === playerId) : null;
  }

  function isSelfSeated() {
    return Boolean(getSelf());
  }

  function replaceCard(target, element) {
    target.innerHTML = "";
    target.appendChild(element);
  }

  function emptyPile(text) {
    const element = document.createElement("span");
    element.className = "empty-card";
    element.textContent = text;
    return element;
  }

  function cleanupPointerCard(cardButton) {
    cardButton.classList.remove("dragging");
    cardButton.style.transform = "";
  }

  function send(type, data = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showError("The game server is not connected yet.");
      return;
    }
    socket.send(JSON.stringify({ type, data }));
  }

  function showError(message) {
    dom.joinError.textContent = message;
    showToast(message);
  }

  function showToast(message) {
    if (!message) {
      return;
    }
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.add("show");
    toastTimer = setTimeout(() => {
      dom.toast.classList.remove("show");
    }, 2600);
  }

  function setConnectionStatus(text) {
    dom.connectionStatus.textContent = text;
  }

  function readName() {
    const name = dom.playerNameInput.value.trim().replace(/\s+/g, " ").slice(0, 24);
    if (!name) {
      showError("Enter a name.");
      dom.playerNameInput.focus();
      return "";
    }
    dom.joinError.textContent = "";
    return name;
  }

  function readRoomCode() {
    const code = dom.roomCodeInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      showError("Enter the 4-character room code.");
      dom.roomCodeInput.focus();
      return "";
    }
    dom.joinError.textContent = "";
    return code;
  }

  function hydrateSavedInputs() {
    dom.playerNameInput.value = getStored(STORAGE.playerName);
    dom.roomCodeInput.value = getStored(STORAGE.roomCode);
    dom.roomCodeInput.addEventListener("input", () => {
      dom.roomCodeInput.value = dom.roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    });
  }

  function resolveServerUrl() {
    const params = new URLSearchParams(window.location.search);
    const override = params.get("server");
    if (override) {
      return override;
    }

    const saved = getStored(STORAGE.serverUrl);
    if (saved) {
      return saved;
    }

    const localHostnames = new Set(["", "localhost", "127.0.0.1"]);
    if (window.location.protocol === "file:" || localHostnames.has(window.location.hostname)) {
      return "ws://localhost:8787/ws";
    }
    return "wss://cardgames.duckdns.org/ws";
  }

  function ensurePlayerId() {
    const existing = getStored(STORAGE.playerId);
    if (/^[a-zA-Z0-9_-]{6,80}$/.test(existing)) {
      return existing;
    }
    const next = `p_${randomToken()}_${Date.now().toString(36)}`;
    setStored(STORAGE.playerId, next);
    return next;
  }

  function randomToken() {
    if (window.crypto && window.crypto.getRandomValues) {
      const bytes = new Uint32Array(2);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, value => value.toString(36)).join("");
    }
    return Math.random().toString(36).slice(2);
  }

  function getStored(key) {
    try {
      const value = window.localStorage.getItem(key);
      if (value) {
        return value;
      }
    } catch {
      // Ignore storage failures in private browsing.
    }
    return getCookie(key);
  }

  function setStored(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Ignore storage failures in private browsing.
    }
    setCookie(key, value);
  }

  function getCookie(key) {
    const prefix = `${encodeURIComponent(key)}=`;
    const match = document.cookie
      .split(";")
      .map(part => part.trim())
      .find(part => part.startsWith(prefix));
    return match ? decodeURIComponent(match.slice(prefix.length)) : "";
  }

  function setCookie(key, value) {
    const maxAge = 60 * 60 * 24 * 180;
    document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; max-age=${maxAge}; path=/; SameSite=Lax`;
  }
})();
