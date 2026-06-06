(function () {
  const STORAGE = {
    playerId: "thirtyOnePlayerId",
    playerName: "thirtyOnePlayerName",
    roomCode: "thirtyOneRoomCode",
    serverUrl: "thirtyOneServerUrl"
  };
  const MAX_PLAYERS = 10;
  const NUDGE_COOLDOWN_MS = 10000;
  const RED_SUITS = new Set(["\u2665", "\u2666"]);
  const CARD_RENDER_OPTIONS = { assetBasePath: "../../assets/courts/white" };

  const dom = {
    stage: document.querySelector(".game-stage"),
    roomCode: document.getElementById("roomCode"),
    copyRoomBtn: document.getElementById("copyRoomBtn"),
    turnCard: document.querySelector(".turn-card"),
    connectionStatus: document.getElementById("connectionStatus"),
    currentPlayer: document.getElementById("currentPlayer"),
    nextPlayer: document.getElementById("nextPlayer"),
    playerCount: document.getElementById("playerCount"),
    avatarRing: document.getElementById("avatarRing"),
    feltTable: document.querySelector(".felt-table"),
    stockPile: document.getElementById("stockPile"),
    stockCard: document.getElementById("stockCard"),
    stockCount: document.getElementById("stockCount"),
    discardPile: document.getElementById("discardPile"),
    discardCard: document.getElementById("discardCard"),
    discardCount: document.getElementById("discardCount"),
    bestScore: document.getElementById("bestScore"),
    turnHint: document.getElementById("turnHint"),
    hostControls: document.getElementById("hostControls"),
    nudgeControls: document.getElementById("nudgeControls"),
    startBtn: document.getElementById("startBtn"),
    skipBtn: document.getElementById("skipBtn"),
    stopBtn: document.getElementById("stopBtn"),
    endSessionBtn: document.getElementById("endSessionBtn"),
    leaveSeatBtn: document.getElementById("leaveSeatBtn"),
    nudgeBtn: document.getElementById("nudgeBtn"),
    sortBtn: document.getElementById("sortBtn"),
    checkBtn: document.getElementById("checkBtn"),
    handPrevBtn: document.getElementById("handPrevBtn"),
    handNextBtn: document.getElementById("handNextBtn"),
    handArea: document.querySelector(".hand-area"),
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
    resultsPanel: document.getElementById("resultsPanel"),
    closeResultsBtn: document.getElementById("closeResultsBtn"),
    resultsTitle: document.getElementById("resultsTitle"),
    resultsReason: document.getElementById("resultsReason"),
    resultsList: document.getElementById("resultsList"),
    resultsActions: document.getElementById("resultsActions"),
    playAgainBtn: document.getElementById("playAgainBtn"),
    endSessionResultsBtn: document.getElementById("endSessionResultsBtn"),
    leaveConfirmPanel: document.getElementById("leaveConfirmPanel"),
    cancelLeaveBtn: document.getElementById("cancelLeaveBtn"),
    confirmLeaveBtn: document.getElementById("confirmLeaveBtn"),
    nudgeBanner: document.getElementById("nudgeBanner"),
    nudgeBannerMessage: document.getElementById("nudgeBannerMessage"),
    toast: document.getElementById("toast")
  };

  let socket = null;
  let socketGeneration = 0;
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
  let nudgeBannerTimer = null;
  let nudgeShakeTimer = null;
  let autoJoinTimer = null;
  let autoJoinFallbackTimer = null;
  let autoJoinPending = false;
  let autoJoinBlocked = false;
  let joinAttemptPending = false;
  let joinedThisSession = false;
  let leftRoomThisSession = false;
  let nudgeTimer = null;
  let joinPanelRevealTimer = null;
  let handSpreadFrame = 0;
  let handOffset = 0;
  let handMaxOffset = 0;
  let dragFrame = 0;
  let pointerState = null;
  let suppressClickCardId = "";

  const playerId = ensurePlayerId();
  const serverUrl = resolveServerUrl();

  hydrateSavedInputs();
  bindEvents();
  primeJoinPanel();
  updateStageMetrics();
  connect();
  render();

  function bindEvents() {
    dom.createRoomBtn.addEventListener("click", () => {
      const name = readName();
      if (!name) return;
      autoJoinBlocked = false;
      leftRoomThisSession = false;
      autoJoinPending = false;
      setStored(STORAGE.playerName, name);
      setStored(STORAGE.playerId, playerId);
      joinAttemptPending = true;
      hideJoinPanel();
      send("createRoom", { playerId, name });
    });

    dom.joinForm.addEventListener("submit", event => {
      event.preventDefault();
      const name = readName();
      const roomCode = readRoomCode();
      if (!name || !roomCode) return;
      autoJoinBlocked = false;
      leftRoomThisSession = false;
      autoJoinPending = false;
      setStored(STORAGE.playerName, name);
      setStored(STORAGE.playerId, playerId);
      setStored(STORAGE.roomCode, roomCode);
      joinAttemptPending = true;
      hideJoinPanel();
      send("joinRoom", { playerId, name, roomCode });
    });

    dom.stockPile.addEventListener("click", () => {
      if (canDraw()) send("drawStock");
    });

    dom.discardPile.addEventListener("click", () => {
      if (canDraw()) send("drawDiscard");
    });

    dom.startBtn.addEventListener("click", handleStartButton);
    dom.skipBtn.addEventListener("click", () => send("skipPlayer"));
    dom.stopBtn.addEventListener("click", () => send("stopGame"));
    dom.endSessionBtn.addEventListener("click", () => send("endSession"));
    dom.leaveSeatBtn.addEventListener("click", openLeaveConfirm);
    dom.nudgeBtn.addEventListener("click", requestNudge);
    dom.checkBtn.addEventListener("click", () => {
      if (canCheck()) send("check");
    });

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

    dom.closeResultsBtn.addEventListener("click", () => {
      dom.resultsPanel.hidden = true;
    });
    dom.playAgainBtn.addEventListener("click", resetToLobby);
    dom.endSessionResultsBtn.addEventListener("click", () => send("endSession"));
    dom.cancelLeaveBtn.addEventListener("click", closeLeaveConfirm);
    dom.confirmLeaveBtn.addEventListener("click", confirmLeaveSeat);
    dom.leaveConfirmPanel.addEventListener("click", event => {
      if (event.target === dom.leaveConfirmPanel) {
        closeLeaveConfirm();
      }
    });

    window.addEventListener("resize", handleViewportChange);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleViewportChange);
    }
    dom.handScroller.addEventListener("scroll", applyHandOffset, { passive: true });
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  }

  function handleViewportChange() {
    updateStageMetrics();
    scheduleHandSpread();
  }

  function handleDocumentPointerDown(event) {
    if (!selectedCardId || pointerState || event.target.closest(".hand-area")) {
      return;
    }
    selectedCardId = "";
    renderHand();
  }

  function handleStartButton() {
    if (roomState && roomState.status === "finished") {
      resetToLobby();
      return;
    }
    send("startGame");
  }

  function resetToLobby() {
    send("stopGame");
  }

  function primeJoinPanel() {
    if (getStored(STORAGE.playerName) && getStored(STORAGE.roomCode)) {
      hideJoinPanel();
    }
  }

  function updateStageMetrics() {
    const viewport = window.visualViewport || {};
    const width = Math.max(320, viewport.width || window.innerWidth || document.documentElement.clientWidth || 320);
    const height = Math.max(320, viewport.height || window.innerHeight || document.documentElement.clientHeight || 320);
    const aspect = width / height;
    const isSlim = aspect < 0.78;
    const isCompact = width <= 860 || aspect < 0.96;
    const tableBounds = dom.feltTable ? dom.feltTable.getBoundingClientRect() : null;
    const tableBottom = tableBounds && tableBounds.height > 0
      ? tableBounds.bottom
      : height * (isSlim ? 0.47 : 0.58);

    const hudScale = clampNumber(0.34, 1, Math.min((width - 28) / 850, height / 520));
    const utilityScale = clampNumber(0.58, 1, Math.min(width / 760, height / 620));
    const handBottom = isSlim
      ? clampNumber(58, 94, height * 0.044)
      : clampNumber(12, 38, height * 0.022);
    const targetHandTop = Math.min(height - 220, tableBottom + (isSlim ? 8 : 24));
    const availableHandHeight = Math.max(180, height - handBottom - targetHandTop);
    const cardHeightBase = 245 * 1.42;
    const heightFit = availableHandHeight / cardHeightBase;
    const slimMax = clampNumber(0.96, 1.56, width / 392);
    const slimSize = clampNumber(0.78, slimMax, Math.min(heightFit * 0.98, width / 390));
    const compactMax = clampNumber(0.98, 1.42, width / 500);
    const compactSize = clampNumber(0.82, compactMax, Math.min(heightFit * 1.02, width / 430));
    const wideBase = Math.min(width / 980, height / 760) * 0.72;
    const wideSize = clampNumber(0.42, 0.70, Math.min(wideBase, heightFit * 0.96));
    const handSize = isSlim ? slimSize : (isCompact ? compactSize : wideSize);

    dom.stage.style.setProperty("--hud-scale", hudScale.toFixed(3));
    dom.stage.style.setProperty("--host-offset", `${Math.round(126 * hudScale)}px`);
    dom.stage.style.setProperty("--utility-scale", utilityScale.toFixed(3));
    dom.handArea.style.setProperty("--hand-card-size", handSize.toFixed(3));
    dom.handArea.style.setProperty("--hand-bottom", `${Math.round(handBottom)}px`);
  }

  function connect() {
    clearTimeout(reconnectTimer);
    setConnectionStatus("Connecting...");
    const generation = socketGeneration + 1;
    socketGeneration = generation;

    try {
      socket = new WebSocket(serverUrl);
    } catch (error) {
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      if (generation !== socketGeneration) return;
      reconnectAttempts = 0;
      setConnectionStatus("Connected");
      if (leftRoomThisSession) {
        showJoinPanelNow();
      } else {
        send("sync", { playerId, roomCode: getStored(STORAGE.roomCode) });
        scheduleAutoJoin();
      }
    });

    socket.addEventListener("message", event => {
      if (generation !== socketGeneration) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(message);
    });

    socket.addEventListener("close", () => {
      if (generation !== socketGeneration) return;
      setConnectionStatus("Reconnecting...");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (generation !== socketGeneration) return;
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
    clearTimeout(autoJoinFallbackTimer);
    const savedName = getStored(STORAGE.playerName);
    const savedRoomCode = getStored(STORAGE.roomCode);
    if (leftRoomThisSession || autoJoinBlocked || hasConfirmedSeat() || !savedName || !savedRoomCode) {
      autoJoinPending = false;
      return;
    }

    autoJoinPending = true;
    joinAttemptPending = true;
    if (dom.joinPanel.hidden) {
      hideJoinPanel();
    }
    autoJoinTimer = setTimeout(() => {
      if (!hasConfirmedSeat()) {
        send("joinRoom", { playerId, name: savedName, roomCode: savedRoomCode });
      }
    }, 350);
    autoJoinFallbackTimer = setTimeout(() => {
      if (autoJoinPending && !hasConfirmedSeat()) {
        autoJoinPending = false;
        joinAttemptPending = false;
        autoJoinBlocked = true;
        joinedThisSession = false;
        showJoinPanelNow();
      }
    }, 5000);
  }

  function hideJoinPanel() {
    clearTimeout(joinPanelRevealTimer);
    dom.joinPanel.hidden = true;
  }

  function showJoinPanelNow() {
    clearTimeout(joinPanelRevealTimer);
    if (!shouldShowJoinPanel()) {
      dom.joinPanel.hidden = true;
      return;
    }
    dom.joinPanel.hidden = false;
  }

  function requestJoinPanel() {
    if (!shouldShowJoinPanel()) {
      dom.joinPanel.hidden = true;
      return;
    }
    clearTimeout(joinPanelRevealTimer);
    joinPanelRevealTimer = setTimeout(() => {
      if (shouldShowJoinPanel()) {
        dom.joinPanel.hidden = false;
      } else {
        dom.joinPanel.hidden = true;
      }
    }, 450);
  }

  function shouldShowJoinPanel() {
    return !autoJoinPending && !joinAttemptPending && !joinedThisSession && !hasConfirmedSeat();
  }

  function hasConfirmedSeat() {
    return Boolean(
      isSelfSeated() ||
      (
        privateState.playerId === playerId &&
        (
          privateState.hand.length > 0 ||
          privateState.isTurn ||
          privateState.mustDiscard
        )
      )
    );
  }

  function handleServerMessage(message) {
    const data = message.data || {};
    if (message.type === "roomState") {
      if (leftRoomThisSession) {
        resetLeftRoomView();
        return;
      }
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
        if (autoJoinPending || joinAttemptPending) {
          hideJoinPanel();
        } else {
          joinedThisSession = false;
          requestJoinPanel();
        }
      } else if (!leftRoomThisSession && roomState.players.some(player => player.id === playerId)) {
        joinedThisSession = true;
        autoJoinPending = false;
        joinAttemptPending = false;
        autoJoinBlocked = false;
        clearTimeout(autoJoinFallbackTimer);
        hideJoinPanel();
        setStored(STORAGE.roomCode, roomState.code);
      } else if (autoJoinPending || joinAttemptPending) {
        if (!autoJoinPending || dom.joinPanel.hidden) {
          hideJoinPanel();
        }
      } else if (joinedThisSession) {
        hideJoinPanel();
      } else {
        requestJoinPanel();
      }
      render();
      return;
    }

    if (message.type === "privateHand") {
      if (leftRoomThisSession) {
        return;
      }
      privateState = {
        playerId: data.playerId || playerId,
        hand: Array.isArray(data.hand) ? data.hand : [],
        best: data.best || { total: 0, suit: "" },
        mustDiscard: Boolean(data.mustDiscard),
        isTurn: Boolean(data.isTurn)
      };
      if (privateState.playerId === playerId) {
        joinedThisSession = true;
        autoJoinPending = false;
        joinAttemptPending = false;
        autoJoinBlocked = false;
        clearTimeout(autoJoinTimer);
        clearTimeout(autoJoinFallbackTimer);
        hideJoinPanel();
      }
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

    if (message.type === "nudgeAlert") {
      showNudgeAlert(data.message || "GO IT IS YOUR TURN!!- Sent with love from Player");
      return;
    }

    if (message.type === "sessionEnded") {
      handleSessionEnded(data.message || "The room ended.");
      return;
    }

    if (message.type === "leftSeat") {
      handleSeatLeft(data.message || "You left the room.");
      return;
    }

    if (message.type === "error") {
      if (leftRoomThisSession) {
        leftRoomThisSession = false;
        autoJoinBlocked = false;
        dom.leaveSeatBtn.disabled = false;
        dom.confirmLeaveBtn.disabled = false;
      }
      if (joinAttemptPending) {
        clearTimeout(autoJoinTimer);
        clearTimeout(autoJoinFallbackTimer);
        autoJoinPending = false;
        autoJoinBlocked = true;
        joinAttemptPending = false;
        joinedThisSession = false;
        showJoinPanelNow();
      }
      showError(data.message || "Action failed.");
    }
  }

  function render() {
    renderHud();
    renderTable();
    renderAvatars();
    renderHand();
    renderControls();
    renderResults();
  }

  function renderHud() {
    dom.roomCode.textContent = roomState ? roomState.code : "----";
    dom.playerCount.textContent = `${displayPlayerCount()}/${MAX_PLAYERS}`;
    dom.turnCard.classList.toggle(
      "current-turn",
      Boolean(roomState && roomState.status === "playing" && roomState.currentTurnPlayerId === playerId)
    );
    if (roomState && roomState.status === "finished") {
      dom.currentPlayer.textContent = "Game over";
    } else if (roomState && roomState.currentPlayerName) {
      dom.currentPlayer.textContent = `${roomState.currentPlayerName}'s turn`;
    } else {
      dom.currentPlayer.textContent = roomState ? "Waiting for start" : "Waiting for host";
    }
    dom.nextPlayer.textContent = roomState && roomState.nextPlayerName ? roomState.nextPlayerName : "--";
  }

  function renderTable() {
    const stockCount = roomState ? roomState.stockCount : 0;
    const discardCount = roomState ? roomState.discardCount : 0;
    const discardTop = roomState ? roomState.discardTop : null;

    dom.stockCount.textContent = String(stockCount);
    dom.discardCount.textContent = String(discardCount);
    renderPile(dom.stockCard, {
      type: "stock",
      count: stockCount,
      topCard: stockCount > 0 ? CardRenderer.renderCard(null, { back: true }) : emptyPile("Empty")
    });
    renderPile(dom.discardCard, {
      type: "discard",
      count: discardCount,
      topCard: discardTop ? CardRenderer.renderCard(discardTop, CARD_RENDER_OPTIONS) : emptyPile("Empty")
    });

    const canDrawNow = canDraw();
    dom.stockPile.disabled = !canDrawNow || stockCount < 1;
    dom.discardPile.disabled = !canDrawNow || !discardTop;
    dom.stockPile.classList.toggle("pile--ready", canDrawNow && stockCount > 0);
    dom.discardPile.classList.toggle("pile--ready", canDrawNow && Boolean(discardTop));
  }

  function renderAvatars() {
    dom.avatarRing.innerHTML = "";
    const seats = avatarSeatPlan();

    for (const { player, seatIndex, anchor } of seats) {
      const seat = document.createElement("div");
      const anchorClass = anchor ? ` opponent-${anchor}` : "";
      seat.className = `avatar-seat opponent-${seatIndex}${anchorClass}${!player.connected ? " inactive" : ""}${player.id === roomState.currentTurnPlayerId ? " current-turn" : ""}`;
      seat.style.setProperty("--avatar-hue", String(playerAvatarHue(player.seat)));

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
      name.textContent = player.name;

      const meta = document.createElement("div");
      meta.className = "avatar-meta";
      meta.textContent = `${player.handCount || 0} cards${player.isHost ? " | Host" : ""}`;

      seat.append(avatar, name, meta);
      dom.avatarRing.appendChild(seat);
    }
  }

  function avatarSeatPlan() {
    if (!roomState) {
      return [];
    }

    const players = activePlayersInTurnOrder();
    const opponents = players.filter(player => player.id !== playerId);
    if (!opponents.length) {
      return [];
    }

    if (opponents.length === 1) {
      return [{ player: opponents[0], seatIndex: 0, anchor: "top" }];
    }

    const left = nextTurnPlayer(players, playerId, candidate => candidate.id !== playerId);
    const right = previousTurnPlayer(players, playerId, candidate => (
      candidate.id !== playerId &&
      candidate.id !== (left && left.id)
    ));
    const used = new Set([playerId, left && left.id, right && right.id].filter(Boolean));
    const current = players.find(player => player.id === roomState.currentTurnPlayerId) || null;

    let center = null;
    if (current && current.id !== playerId && !used.has(current.id)) {
      center = current;
    }
    if (!center) {
      const centerReferenceId = left ? left.id : playerId;
      center = nextTurnPlayer(players, centerReferenceId, candidate => !used.has(candidate.id));
    }
    if (!center) {
      center = opponents.find(player => !used.has(player.id)) || null;
    }

    return [
      { player: center, seatIndex: 0, anchor: "top" },
      { player: left, seatIndex: 1, anchor: "left" },
      { player: right, seatIndex: 2, anchor: "right" }
    ].filter(seat => seat.player);
  }

  function activePlayersInTurnOrder() {
    if (!roomState) {
      return [];
    }
    return roomState.players
      .filter(player => player.connected)
      .sort((a, b) => a.seat - b.seat);
  }

  function nextTurnPlayer(players, startPlayerId, predicate) {
    return adjacentTurnPlayer(players, startPlayerId, 1, predicate);
  }

  function previousTurnPlayer(players, startPlayerId, predicate) {
    return adjacentTurnPlayer(players, startPlayerId, -1, predicate);
  }

  function adjacentTurnPlayer(players, startPlayerId, direction, predicate) {
    if (!players.length) {
      return null;
    }

    const startIndex = players.findIndex(player => player.id === startPlayerId);
    let index = startIndex >= 0 ? startIndex : direction > 0 ? -1 : 0;
    for (let checked = 0; checked < players.length; checked++) {
      index = (index + direction + players.length) % players.length;
      const candidate = players[index];
      if (!predicate || predicate(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  function renderHand() {
    const hand = privateState.hand || [];
    dom.handTrack.innerHTML = "";
    dom.handTrack.classList.remove("hand-track--overflowing", "hand-track--edge-fill");

    hand.forEach((card, index) => {
      const cardButton = document.createElement("button");
      cardButton.type = "button";
      const isSelected = card.id === selectedCardId;
      const canDiscardSelected = isSelected && privateState.mustDiscard && privateState.isTurn;
      cardButton.className = `hand-card${isSelected ? " selected" : ""}${canDiscardSelected ? " can-discard" : ""}`;
      cardButton.style.zIndex = card.id === selectedCardId ? "50" : String(index + 1);
      cardButton.style.setProperty("--hand-index", String(index + 1));
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
        unbindActivePointerListeners();
        pointerState = {
          cardId: card.id,
          element: cardButton,
          startX: event.clientX,
          startY: event.clientY,
          pointerId: event.pointerId,
          lastTransform: "",
          moved: false
        };
        bindActivePointerListeners();
        if (!isMobileViewport() && typeof cardButton.setPointerCapture === "function") {
          try {
            cardButton.setPointerCapture(event.pointerId);
          } catch {
            // Window-level tracking below keeps the drag alive if capture is unavailable.
          }
        }
      });

      cardButton.addEventListener("pointermove", handleHandPointerMove);

      cardButton.addEventListener("pointerup", handleHandPointerEnd);

      cardButton.addEventListener("pointercancel", handleHandPointerCancel);

      dom.handTrack.appendChild(cardButton);
    });

    dom.handPrevBtn.disabled = hand.length < 4;
    dom.handNextBtn.disabled = hand.length < 4;
    scheduleHandSpread();
  }

  function renderControls() {
    const self = getSelf();
    const isHost = Boolean(roomState && self && roomState.hostId === playerId);
    const isPlaying = Boolean(roomState && roomState.status === "playing");
    const isFinished = Boolean(roomState && roomState.status === "finished");
    const readyCount = readyPlayerCount();
    const best = privateState.best || { total: 0, suit: "" };

    dom.hostControls.hidden = !self;
    dom.startBtn.textContent = isFinished ? "Play Again" : "Start";
    dom.startBtn.hidden = !isHost || isPlaying;
    dom.skipBtn.hidden = !isHost || !isPlaying;
    dom.stopBtn.hidden = !isHost;
    dom.endSessionBtn.hidden = !isHost;
    dom.leaveSeatBtn.hidden = isHost;
    const nudgeInfo = getNudgeInfo();
    dom.nudgeControls.hidden = !nudgeInfo.visible;
    dom.startBtn.disabled = !roomState || isPlaying || readyCount < 2;
    dom.skipBtn.disabled = !isHost || !isPlaying;
    dom.stopBtn.disabled = !roomState;
    dom.endSessionBtn.disabled = !roomState;
    dom.leaveSeatBtn.disabled = !roomState || !self;
    dom.nudgeBtn.disabled = !nudgeInfo.ready;
    dom.nudgeBtn.classList.toggle("nudge-ready", nudgeInfo.ready);
    dom.nudgeBtn.title = nudgeInfo.title;
    scheduleNudgeRefresh(nudgeInfo);
    const checkReady = canCheck();
    dom.checkBtn.hidden = !roomState || roomState.status !== "playing" || !self;
    dom.checkBtn.disabled = !checkReady;
    dom.checkBtn.classList.toggle("check-ready", checkReady);

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
    if (roomState.status === "finished") {
      return "Game over. Review final scores.";
    }
    if (roomState.status !== "playing") {
      return roomState.hostId === playerId ? "Start when everyone is ready." : "Waiting for the host to start.";
    }
    if (roomState.checkingPlayerId && privateState.isTurn) {
      return "Final turn. Draw, then discard.";
    }
    if (roomState.checkingPlayerId) {
      const checker = roomState.players.find(player => player.id === roomState.checkingPlayerId);
      return `${checker ? checker.name : "A player"} checked. Final turns are underway.`;
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

  function requestNudge() {
    const nudgeInfo = getNudgeInfo();
    if (!nudgeInfo.visible) {
      showToast("There is nobody to nudge right now.");
      return;
    }
    if (!nudgeInfo.ready) {
      showToast(`Nudge is ready in ${Math.ceil(nudgeInfo.remainingMs / 1000)}s.`);
      return;
    }
    send("nudge");
  }

  function getNudgeInfo() {
    if (!roomState || !getSelf()) {
      return { visible: false, ready: false, remainingMs: 0, title: "" };
    }

    let targetId = "";
    let targetName = "";
    let title = "";
    if (roomState.status === "playing") {
      targetId = roomState.currentTurnPlayerId || "";
      targetName = roomState.currentPlayerName || "the current player";
      title = `Nudge ${targetName} to take their turn`;
    } else if (roomState.status === "lobby") {
      targetId = roomState.hostId || "";
      const host = roomState.players.find(player => player.id === roomState.hostId);
      targetName = host ? host.name : "the host";
      title = `Nudge ${targetName} to start`;
    } else {
      return { visible: false, ready: false, remainingMs: 0, title: "" };
    }

    if (!targetId || targetId === playerId) {
      return { visible: false, ready: false, remainingMs: 0, title: "" };
    }

    const readyAt = Number(roomState.nudgeReadyAt) || (Date.now() + NUDGE_COOLDOWN_MS);
    const remainingMs = Math.max(0, readyAt - Date.now());
    const ready = remainingMs <= 0;
    return {
      visible: true,
      ready,
      remainingMs,
      readyAt,
      title: ready ? title : `${title} in ${Math.ceil(remainingMs / 1000)}s`
    };
  }

  function scheduleNudgeRefresh(nudgeInfo) {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
    if (!nudgeInfo || !nudgeInfo.visible || nudgeInfo.ready) {
      return;
    }
    const delay = Math.max(250, Math.min(nudgeInfo.remainingMs + 40, NUDGE_COOLDOWN_MS));
    nudgeTimer = window.setTimeout(() => {
      nudgeTimer = null;
      renderControls();
    }, delay);
  }

  function openLeaveConfirm() {
    if (!roomState || !getSelf()) {
      showToast("Join a room first.");
      return;
    }
    dom.leaveConfirmPanel.hidden = false;
    dom.cancelLeaveBtn.focus();
  }

  function closeLeaveConfirm() {
    dom.leaveConfirmPanel.hidden = true;
  }

  function confirmLeaveSeat() {
    closeLeaveConfirm();
    rememberCurrentJoinDetails();
    autoJoinBlocked = true;
    leftRoomThisSession = true;
    joinedThisSession = false;
    dom.leaveSeatBtn.disabled = true;
    dom.confirmLeaveBtn.disabled = true;
    if (!send("leaveSeat")) {
      leftRoomThisSession = false;
      autoJoinBlocked = false;
      dom.leaveSeatBtn.disabled = false;
      dom.confirmLeaveBtn.disabled = false;
      return;
    }
    resetLeftRoomView();
    showToast("Leaving room...");
  }

  function resetLeftRoomView() {
    clearTimeout(autoJoinTimer);
    clearTimeout(autoJoinFallbackTimer);
    clearTimeout(joinPanelRevealTimer);
    autoJoinPending = false;
    joinAttemptPending = false;
    joinedThisSession = false;
    roomState = null;
    privateState = {
      playerId,
      hand: [],
      best: { total: 0, suit: "" },
      mustDiscard: false,
      isTurn: false
    };
    selectedCardId = "";
    closeLeaveConfirm();
    dom.confirmLeaveBtn.disabled = false;
    render();
    dom.joinPanel.hidden = false;
  }

  function sortHandForDisplay() {
    const suitOrder = { "\u2663": 0, "\u2666": 1, "\u2665": 2, "\u2660": 3 };
    const valueOrder = { J: 11, Q: 12, K: 13, A: 14 };
    privateState.hand = privateState.hand.slice().sort((a, b) => {
      const valueDiff = (valueOrder[a.value] || Number(a.value) || 0) - (valueOrder[b.value] || Number(b.value) || 0);
      if (valueDiff) return valueDiff;
      return (suitOrder[a.suit] ?? 9) - (suitOrder[b.suit] ?? 9);
    });
    renderHand();
  }

  function renderResults() {
    if (!roomState || roomState.status !== "finished") {
      dom.resultsPanel.hidden = true;
      return;
    }

    const results = Array.isArray(roomState.results) ? roomState.results : [];
    const winners = results.filter(row => row.isWinner);
    const isHost = Boolean(roomState.hostId === playerId);
    dom.resultsTitle.textContent = winners.length > 1
      ? "Tie Game"
      : winners[0]
        ? `${winners[0].name} Wins`
        : "Game Over";
    dom.resultsReason.textContent = resultsReasonText();
    dom.resultsList.innerHTML = "";

    if (!results.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No final scores are available.";
      dom.resultsList.appendChild(empty);
    }

    results.forEach(row => {
      const item = document.createElement("article");
      item.className = `result-row${row.isWinner ? " result-row--winner" : ""}${row.id === playerId ? " result-row--self" : ""}`;

      const rank = document.createElement("span");
      rank.className = "result-rank";
      rank.textContent = `#${row.rank}`;

      const identity = document.createElement("div");
      identity.className = "result-identity";
      const name = document.createElement("strong");
      name.textContent = row.name;
      const meta = document.createElement("span");
      meta.textContent = row.isWinner ? "Winner" : "Final hand";
      identity.append(name, meta);

      const hand = document.createElement("div");
      hand.className = "result-hand";
      (Array.isArray(row.hand) ? row.hand : []).forEach(card => {
        const mini = CardRenderer.renderCard(card, { ...CARD_RENDER_OPTIONS, size: "mini" });
        hand.appendChild(mini);
      });

      const score = document.createElement("div");
      score.className = "result-score";
      const total = document.createElement("strong");
      total.textContent = row.suit ? `${row.total} ${row.suit}` : String(row.total || 0);
      const diff = document.createElement("span");
      diff.textContent = `${row.difference}`;
      score.append(total, diff);

      item.append(rank, identity, hand, score, renderResultAvatar(row));
      dom.resultsList.appendChild(item);
    });

    dom.resultsActions.hidden = !isHost;
    dom.resultsActions.style.display = isHost ? "flex" : "none";
    dom.playAgainBtn.hidden = !isHost;
    dom.endSessionResultsBtn.hidden = !isHost;
    dom.resultsPanel.hidden = false;
  }

  function renderResultAvatar(row) {
    const avatar = document.createElement("div");
    avatar.className = `result-avatar ${row.isWinner ? "result-avatar--winner" : "result-avatar--loser"}`;
    avatar.style.setProperty("--avatar-hue", String(playerAvatarHue(row.seat)));
    avatar.setAttribute("aria-label", row.isWinner ? `${row.name} celebrating` : `${row.name} sad`);
    avatar.innerHTML = `
      <span class="result-avatar__crown"></span>
      <span class="result-avatar__arm result-avatar__arm--left"></span>
      <span class="result-avatar__arm result-avatar__arm--right"></span>
      <span class="result-avatar__body"></span>
      <span class="result-avatar__head">
        <span class="result-avatar__eye result-avatar__eye--left"></span>
        <span class="result-avatar__eye result-avatar__eye--right"></span>
      </span>
    `;
    return avatar;
  }

  function playerAvatarHue(seat) {
    return (((Number(seat) || 0) * 71) + 205) % 360;
  }

  function resultsReasonText() {
    if (!roomState) return "";
    if (roomState.finishReason === "deck") {
      return "The deck ran out.";
    }
    if (roomState.finishReason === "check") {
      const checker = roomState.players.find(player => player.id === roomState.checkingPlayerId);
      return `${checker ? checker.name : "A player"} checked. Everyone else took one final turn.`;
    }
    if (roomState.finishReason === "leave") {
      return "A player left and not enough players remained.";
    }
    return "Final scores.";
  }

  function scrollHand(direction) {
    if (isMobileViewport()) {
      const distance = Math.max(150, dom.handScroller.clientWidth * 0.72);
      dom.handScroller.scrollBy({ left: distance * direction, behavior: "smooth" });
      return;
    }
    const distance = Math.max(150, dom.handArea.clientWidth * 0.34);
    handOffset = clampNumber(0, handMaxOffset, handOffset + distance * direction);
    applyHandOffset();
  }

  function clampNumber(min, max, value) {
    return Math.min(max, Math.max(min, value));
  }

  function scheduleHandSpread() {
    cancelAnimationFrame(handSpreadFrame);
    handSpreadFrame = requestAnimationFrame(updateHandSpread);
  }

  function updateHandSpread() {
    const cards = Array.from(dom.handTrack.querySelectorAll(".hand-card"));
    if (cards.length <= 1) {
      dom.handTrack.style.setProperty("--hand-overlap", "0px");
      dom.handTrack.style.removeProperty("--hand-spread-width");
      dom.handTrack.classList.remove("hand-track--overflowing", "hand-track--edge-fill");
      handOffset = 0;
      handMaxOffset = 0;
      applyHandOffset();
      return;
    }

    if (isMobileViewport()) {
      dom.handTrack.style.setProperty("--hand-overlap", "0px");
      dom.handTrack.style.removeProperty("--hand-spread-width");
      dom.handTrack.classList.add("hand-track--overflowing", "hand-track--edge-fill");
      handOffset = 0;
      handMaxOffset = Math.max(0, dom.handScroller.scrollWidth - dom.handScroller.clientWidth);
      applyHandOffset();
      return;
    }

    const firstRealCard = cards.find(card => !card.classList.contains("hand-card-placeholder"));
    const firstCard = firstRealCard ? firstRealCard.querySelector(".playing-card") : null;
    const cardWidth = firstCard ? firstCard.getBoundingClientRect().width : 150;
    const available = Math.max(cardWidth, dom.handArea.clientWidth - 8);
    const minStep = Math.min(cardWidth - 2, Math.max(64, cardWidth * (cards.length <= 4 ? 0.42 : 0.34)));
    const maxStep = cardWidth * (cards.length <= 3 ? 0.88 : 0.78);
    const fitStep = (available - cardWidth) / (cards.length - 1);
    const step = Math.max(minStep, Math.min(maxStep, fitStep));
    const overlap = Math.max(0, Math.round(cardWidth - step));
    const spreadWidth = cardWidth + (cards.length - 1) * (cardWidth - overlap);
    const isOverflowing = spreadWidth > available + 2;
    const fillsEdges = isOverflowing || available < 900;
    const renderWidth = fillsEdges ? Math.max(spreadWidth, available) : spreadWidth;

    dom.handTrack.style.setProperty("--hand-overlap", `${overlap}px`);
    dom.handTrack.style.setProperty("--hand-spread-width", `${Math.ceil(renderWidth)}px`);
    dom.handTrack.classList.toggle("hand-track--overflowing", isOverflowing);
    dom.handTrack.classList.toggle("hand-track--edge-fill", fillsEdges);
    handMaxOffset = isOverflowing ? Math.max(0, spreadWidth - available + 16) : 0;
    handOffset = clampNumber(0, handMaxOffset, handOffset);
    applyHandOffset();
  }

  function applyHandOffset() {
    if (isMobileViewport()) {
      dom.handTrack.style.setProperty("--hand-shift", "0px");
      const maxScroll = Math.max(0, dom.handScroller.scrollWidth - dom.handScroller.clientWidth);
      dom.handPrevBtn.disabled = maxScroll <= 0 || dom.handScroller.scrollLeft <= 1;
      dom.handNextBtn.disabled = maxScroll <= 0 || dom.handScroller.scrollLeft >= maxScroll - 1;
      return;
    }
    dom.handTrack.style.setProperty("--hand-shift", `${Math.round(-handOffset)}px`);
    dom.handPrevBtn.disabled = handMaxOffset <= 0 || handOffset <= 1;
    dom.handNextBtn.disabled = handMaxOffset <= 0 || handOffset >= handMaxOffset - 1;
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

  function canCheck() {
    return Boolean(
      roomState &&
      roomState.status === "playing" &&
      !roomState.checkingPlayerId &&
      privateState.isTurn &&
      !privateState.mustDiscard &&
      privateState.hand.length === 3
    );
  }

  function displayPlayerCount() {
    if (!roomState) {
      return 0;
    }
    if (Number.isFinite(roomState.activeCount)) {
      return Math.max(roomState.activeCount, localDisplayPlayerCount());
    }

    return localDisplayPlayerCount();
  }

  function localDisplayPlayerCount() {
    if (!roomState) {
      return 0;
    }

    const counted = new Set();
    for (const player of roomState.players) {
      if (player.connected || player.id === roomState.hostId || player.id === playerId) {
        counted.add(player.id);
      }
    }
    return counted.size;
  }

  function readyPlayerCount() {
    if (!roomState) {
      return 0;
    }
    if (Number.isFinite(roomState.connectedCount)) {
      return Math.max(roomState.connectedCount, localReadyPlayerCount());
    }
    return localReadyPlayerCount();
  }

  function localReadyPlayerCount() {
    if (!roomState) {
      return 0;
    }
    return roomState.players.filter(player => player.connected || player.id === playerId).length;
  }

  function getSelf() {
    return roomState ? roomState.players.find(player => player.id === playerId) : null;
  }

  function isSelfSeated() {
    return Boolean(getSelf());
  }

  function renderPile(target, options) {
    const count = Math.max(0, Number(options.count) || 0);
    const visibleLayers = Math.min(Math.max(0, count - 1), 12);
    const maxDepth = options.type === "stock" ? 24 : 12;
    const physicalDepth = Math.min(maxDepth, Math.max(0, count - 1) * 0.72);
    const layerStepY = visibleLayers > 0 ? Math.max(1.10, physicalDepth / visibleLayers) : 0;
    const layerStepX = layerStepY * 0.30;

    target.innerHTML = "";
    target.className = `pile-card pile-card--${options.type}${count === 0 ? " pile-card--empty" : ""}`;
    target.style.setProperty("--pile-depth", `${physicalDepth.toFixed(1)}px`);
    target.style.setProperty("--visible-layers", String(visibleLayers));
    target.style.setProperty("--layer-step-x", `${layerStepX.toFixed(2)}px`);
    target.style.setProperty("--layer-step-y", `${layerStepY.toFixed(2)}px`);

    const stack = document.createElement("span");
    stack.className = `pile-stack pile-stack--${options.type}`;

    for (let layerNumber = visibleLayers; layerNumber >= 1; layerNumber--) {
      const layer = document.createElement("span");
      layer.className = `pile-under-card pile-under-card--${options.type}`;
      layer.style.setProperty("--layer", String(layerNumber));
      layer.style.setProperty("--z", String(visibleLayers - layerNumber + 1));
      layer.style.setProperty("--tilt", `${layerNumber % 2 === 0 ? -0.12 : 0.10}deg`);
      stack.appendChild(layer);
    }

    const top = document.createElement("span");
    top.className = "pile-top-card";
    top.appendChild(options.topCard);
    stack.appendChild(top);
    target.appendChild(stack);
  }

  function emptyPile(text) {
    const element = document.createElement("span");
    element.className = "empty-card";
    element.textContent = text;
    return element;
  }

  function queueDragTransform(cardButton, transform) {
    if (!pointerState) {
      return;
    }
    pointerState.lastTransform = transform;
    if (dragFrame) {
      return;
    }
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (pointerState && pointerState.element === cardButton) {
        cardButton.style.transform = pointerState.lastTransform;
      }
    });
  }

  function bindActivePointerListeners() {
    window.addEventListener("pointermove", handleHandPointerMove, { passive: false });
    window.addEventListener("pointerup", handleHandPointerEnd);
    window.addEventListener("pointercancel", handleHandPointerCancel);
  }

  function unbindActivePointerListeners() {
    window.removeEventListener("pointermove", handleHandPointerMove);
    window.removeEventListener("pointerup", handleHandPointerEnd);
    window.removeEventListener("pointercancel", handleHandPointerCancel);
  }

  function handleHandPointerMove(event) {
    if (
      !pointerState ||
      event.pointerId !== pointerState.pointerId ||
      !privateState.mustDiscard ||
      !privateState.isTurn
    ) {
      return;
    }

    const cardButton = pointerState.element;
    const deltaY = event.clientY - pointerState.startY;
    const deltaX = event.clientX - pointerState.startX;
    if (deltaY < -6 && Math.abs(deltaY) > Math.abs(deltaX) * 0.72) {
      event.preventDefault();
      selectedCardId = pointerState.cardId;
      pointerState.moved = true;
      dom.handTrack.querySelectorAll(".hand-card.selected, .hand-card.can-discard").forEach(card => {
        if (card !== cardButton) {
          card.classList.remove("selected", "can-discard");
        }
      });
      cardButton.classList.add("dragging", "selected", "can-discard");
      liftCardForDrag(cardButton);
      queueDragTransform(
        cardButton,
        `translate3d(${Math.max(Math.min(deltaX * 0.25, 38), -38)}px, ${Math.max(deltaY - 18, -460)}px, 0) scale(1.04) rotate(0deg)`
      );
    }
  }

  function handleHandPointerEnd(event) {
    if (!pointerState || event.pointerId !== pointerState.pointerId) {
      return;
    }

    const cardButton = pointerState.element;
    const cardId = pointerState.cardId;
    const deltaY = event.clientY - pointerState.startY;
    const shouldDiscard = privateState.mustDiscard && privateState.isTurn && pointerState.moved && deltaY < -58;
    unbindActivePointerListeners();

    if (shouldDiscard) {
      releasePointerCard(cardButton);
      suppressClickCardId = cardId;
      selectedCardId = cardId;
      animateDiscardToPile(cardButton);
      return;
    }

    if (pointerState.moved) {
      suppressClickCardId = cardId;
      selectedCardId = cardId;
    }
    cleanupPointerCard(cardButton);
    pointerState = null;
  }

  function handleHandPointerCancel(event) {
    if (!pointerState || event.pointerId !== pointerState.pointerId) {
      return;
    }

    const cardButton = pointerState.element;
    unbindActivePointerListeners();
    cleanupPointerCard(cardButton);
    pointerState = null;
  }

  function liftCardForDrag(cardButton) {
    if (!pointerState || pointerState.floating) {
      return;
    }

    const cardBounds = cardButton.getBoundingClientRect();
    const cardSize = getComputedStyle(cardButton).getPropertyValue("--hand-card-size").trim()
      || getComputedStyle(dom.handArea).getPropertyValue("--hand-card-size").trim()
      || "1";
    pointerState.originParent = cardButton.parentNode;
    pointerState.originNext = cardButton.nextSibling;
    pointerState.hadInlineCardSize = cardButton.style.getPropertyValue("--hand-card-size") !== "";
    pointerState.renderedCard = cardButton.querySelector(".playing-card");
    pointerState.hadInlineRenderedSize = Boolean(pointerState.renderedCard && pointerState.renderedCard.style.getPropertyValue("--card-size"));
    pointerState.floating = true;

    const placeholder = document.createElement("span");
    placeholder.className = "hand-card hand-card-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.style.width = `${cardBounds.width}px`;
    placeholder.style.height = `${cardBounds.height}px`;
    placeholder.style.setProperty("--hand-index", cardButton.style.getPropertyValue("--hand-index") || "1");
    pointerState.placeholder = placeholder;
    pointerState.originParent.insertBefore(placeholder, cardButton);

    cardButton.classList.add("floating-hand-card");
    cardButton.style.setProperty("--hand-card-size", cardSize);
    cardButton.style.setProperty("--card-size", cardSize);
    if (pointerState.renderedCard) {
      pointerState.renderedCard.style.setProperty("--card-size", cardSize);
    }
    cardButton.style.left = `${cardBounds.left}px`;
    cardButton.style.top = `${cardBounds.top}px`;
    cardButton.style.width = `${cardBounds.width}px`;
    cardButton.style.height = `${cardBounds.height}px`;
    cardButton.style.transform = "";
    document.body.appendChild(cardButton);
  }

  function restoreFloatingCard(cardButton) {
    if (!pointerState || !pointerState.floating || !pointerState.originParent) {
      return;
    }

    cardButton.classList.remove("floating-hand-card");
    cardButton.style.left = "";
    cardButton.style.top = "";
    cardButton.style.width = "";
    cardButton.style.height = "";
    cardButton.style.opacity = "";
    if (!pointerState.hadInlineCardSize) {
      cardButton.style.removeProperty("--hand-card-size");
      cardButton.style.removeProperty("--card-size");
    }
    if (pointerState.renderedCard && !pointerState.hadInlineRenderedSize) {
      pointerState.renderedCard.style.removeProperty("--card-size");
    }

    const placeholder = pointerState.placeholder;
    if (placeholder && placeholder.parentNode === pointerState.originParent) {
      pointerState.originParent.insertBefore(cardButton, placeholder);
      placeholder.remove();
      return;
    }
    pointerState.originParent.insertBefore(cardButton, pointerState.originNext);
  }

  function animateDiscardToPile(cardButton) {
    const from = cardButton.getBoundingClientRect();
    const to = dom.discardPile.getBoundingClientRect();
    const deltaX = to.left + to.width / 2 - (from.left + from.width / 2);
    const deltaY = to.top + to.height / 2 - (from.top + from.height / 2);
    const placeholder = pointerState ? pointerState.placeholder : null;

    if (dragFrame) {
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
    cardButton.classList.remove("dragging");
    cardButton.classList.add("discarding");
    requestAnimationFrame(() => {
      cardButton.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) scale(.42) rotate(-6deg)`;
      cardButton.style.opacity = ".08";
    });
    pointerState = null;
    window.setTimeout(() => {
      if (placeholder) {
        placeholder.remove();
      }
      cardButton.remove();
      discardSelected();
    }, 190);
  }

  function releasePointerCard(cardButton) {
    if (pointerState && typeof cardButton.releasePointerCapture === "function") {
      try {
        if (cardButton.hasPointerCapture(pointerState.pointerId)) {
          cardButton.releasePointerCapture(pointerState.pointerId);
        }
      } catch {
        // Pointer capture may already be released by the browser.
      }
    }
  }

  function cleanupPointerCard(cardButton) {
    releasePointerCard(cardButton);
    if (dragFrame) {
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
    cardButton.classList.remove("dragging");
    restoreFloatingCard(cardButton);
    cardButton.style.transform = "";
  }

  function send(type, data = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (joinAttemptPending) {
        clearTimeout(autoJoinTimer);
        clearTimeout(autoJoinFallbackTimer);
        autoJoinPending = false;
        joinAttemptPending = false;
        showJoinPanelNow();
      }
      showError("The game server is not connected yet.");
      return false;
    }
    socket.send(JSON.stringify({ type, data }));
    return true;
  }

  function handleSessionEnded(message) {
    clearTimeout(autoJoinTimer);
    clearTimeout(autoJoinFallbackTimer);
    clearTimeout(joinPanelRevealTimer);
    autoJoinPending = false;
    autoJoinBlocked = true;
    joinAttemptPending = false;
    joinedThisSession = false;
    roomState = null;
    privateState = {
      playerId,
      hand: [],
      best: { total: 0, suit: "" },
      mustDiscard: false,
      isTurn: false
    };
    selectedCardId = "";
    clearSavedSession();
    dom.playerNameInput.value = "";
    dom.roomCodeInput.value = "";
    render();
    dom.joinPanel.hidden = false;
    showToast(message);
    window.setTimeout(() => {
      window.location.reload();
    }, 650);
  }

  function handleSeatLeft(message) {
    clearTimeout(autoJoinTimer);
    clearTimeout(autoJoinFallbackTimer);
    clearTimeout(joinPanelRevealTimer);
    rememberCurrentJoinDetails();
    autoJoinPending = false;
    autoJoinBlocked = true;
    joinAttemptPending = false;
    joinedThisSession = false;
    clearSavedSeat();
    resetLeftRoomView();
    showToast(message);
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

  function showNudgeAlert(message) {
    if (!message) {
      return;
    }
    clearTimeout(nudgeBannerTimer);
    clearTimeout(nudgeShakeTimer);
    triggerNudgeVibration();
    renderNudgeMessage(message);
    dom.nudgeBanner.hidden = false;
    dom.nudgeBanner.classList.remove("show");
    dom.stage.classList.remove("nudge-impact");
    void dom.nudgeBanner.offsetWidth;
    void dom.stage.offsetWidth;
    dom.nudgeBanner.classList.add("show");
    dom.stage.classList.add("nudge-impact");
    nudgeShakeTimer = window.setTimeout(() => {
      dom.stage.classList.remove("nudge-impact");
    }, 760);
    nudgeBannerTimer = window.setTimeout(() => {
      dom.nudgeBanner.classList.remove("show");
      window.setTimeout(() => {
        dom.nudgeBanner.hidden = true;
      }, 240);
    }, 3600);
  }

  function renderNudgeMessage(message) {
    const text = String(message || "");
    const signatureMarker = "- Sent with love from ";
    const signatureIndex = text.indexOf(signatureMarker);
    dom.nudgeBannerMessage.innerHTML = "";
    const main = document.createElement("span");
    main.className = "nudge-banner-message__main";
    const signature = document.createElement("span");
    signature.className = "nudge-banner-message__signature";
    if (signatureIndex >= 0) {
      main.textContent = text.slice(0, signatureIndex).trim();
      signature.textContent = text.slice(signatureIndex + 2).trim();
    } else {
      main.textContent = text;
      signature.textContent = "";
    }
    dom.nudgeBannerMessage.append(main);
    if (signature.textContent) {
      dom.nudgeBannerMessage.append(signature);
    }
  }

  function triggerNudgeVibration() {
    if (!isMobileViewport() || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      return;
    }
    try {
      navigator.vibrate([160, 70, 160, 70, 240]);
    } catch {
      // Some browsers expose vibrate but block it; the visual nudge still runs.
    }
  }

  function isMobileViewport() {
    return Boolean(window.matchMedia && window.matchMedia("(max-width: 700px)").matches);
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

  function rememberCurrentJoinDetails() {
    const self = getSelf();
    const name = self && self.name ? self.name : dom.playerNameInput.value.trim();
    const roomCode = roomState && roomState.code ? roomState.code : dom.roomCodeInput.value.trim().toUpperCase();
    if (name) {
      setStored(STORAGE.playerName, name);
      dom.playerNameInput.value = name;
    }
    if (roomCode) {
      setStored(STORAGE.roomCode, roomCode);
      dom.roomCodeInput.value = roomCode;
    }
  }

  function resolveServerUrl() {
    const params = new URLSearchParams(window.location.search);
    const override = params.get("server");
    if (override && !isLoopbackServerUrl(override)) {
      return override;
    }

    const saved = getStored(STORAGE.serverUrl);
    if (saved && !isLoopbackServerUrl(saved)) {
      return saved;
    }

    const frontendLocalHostnames = new Set(["", "localhost", "127.0.0.1"]);
    if (window.location.protocol === "file:" || frontendLocalHostnames.has(window.location.hostname)) {
      return "ws://192.168.0.32:8787/ws";
    }
    return "wss://raydencardgames.duckdns.org/ws";
  }

  function isLoopbackServerUrl(value) {
    try {
      const url = new URL(value);
      return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    } catch {
      return false;
    }
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

  function clearSavedSession() {
    try {
      for (const key of Object.values(STORAGE)) {
        window.localStorage.removeItem(key);
      }
      window.sessionStorage.clear();
    } catch {
      // Ignore storage failures in private browsing.
    }
    for (const key of Object.values(STORAGE)) {
      clearCookie(key);
    }
    if (window.caches && window.caches.keys) {
      window.caches.keys()
        .then(keys => Promise.all(keys.map(key => window.caches.delete(key))))
        .catch(() => {});
    }
  }

  function clearSavedSeat() {
    removeStored(STORAGE.playerId);
  }

  function removeStored(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage failures in private browsing.
    }
    clearCookie(key);
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

  function clearCookie(key) {
    document.cookie = `${encodeURIComponent(key)}=; max-age=0; path=/; SameSite=Lax`;
  }
})();
