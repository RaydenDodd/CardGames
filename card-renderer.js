(function () {
  const RED_SUITS = new Set(["\u2665", "\u2666"]);
  const COURT_VALUES = new Set(["J", "Q", "K"]);
  const COURT_NAMES = {
    J: "jack",
    Q: "queen",
    K: "king"
  };
  const SUIT_NAMES = {
    "\u2660": "spades",
    "\u2665": "hearts",
    "\u2666": "diamonds",
    "\u2663": "clubs"
  };
  const PIP_LAYOUTS = {
    A: [[50, 50]],
    "2": [[50, 22], [50, 78]],
    "3": [[50, 20], [50, 50], [50, 80]],
    "4": [[28, 22], [72, 22], [28, 78], [72, 78]],
    "5": [[28, 22], [72, 22], [50, 50], [28, 78], [72, 78]],
    "6": [[28, 20], [72, 20], [28, 50], [72, 50], [28, 80], [72, 80]],
    "7": [[28, 18], [72, 18], [50, 34], [28, 50], [72, 50], [28, 82], [72, 82]],
    "8": [[28, 17], [72, 17], [50, 32], [28, 48], [72, 48], [50, 64], [28, 83], [72, 83]],
    "9": [[28, 16], [72, 16], [50, 29], [28, 43], [72, 43], [50, 57], [28, 84], [72, 84], [50, 71]],
    "10": [[28, 14], [72, 14], [50, 27], [28, 39], [72, 39], [28, 61], [72, 61], [50, 73], [28, 86], [72, 86]]
  };

  function make(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function renderCorner(card, bottom) {
    const corner = make("div", `playing-card__corner${bottom ? " playing-card__corner--bottom" : ""}`);
    corner.appendChild(make("div", "playing-card__rank", card.value));
    corner.appendChild(make("div", "playing-card__suit", card.suit));
    return corner;
  }

  function renderPips(card) {
    const pips = make("div", "playing-card__pips");
    const positions = PIP_LAYOUTS[card.value] || [[50, 50]];

    positions.forEach(([left, top], index) => {
      const pip = make("div", "playing-card__pip", card.suit);
      pip.style.left = `${left}%`;
      pip.style.top = `${top}%`;
      if (index >= Math.ceil(positions.length / 2)) {
        pip.classList.add("playing-card__pip--rotated");
      }
      pips.appendChild(pip);
    });

    return pips;
  }

  function renderCourtImage(card, options = {}) {
    const rankName = COURT_NAMES[card.value] || "king";
    const suitName = SUIT_NAMES[card.suit] || "spades";
    const assetBasePath = options.assetBasePath || "assets/courts/white";
    const image = make("img", "playing-card__court-image");
    image.src = `${assetBasePath}/${rankName}_of_${suitName}.png`;
    image.alt = `${rankName} of ${suitName}`;
    image.draggable = false;
    return image;
  }

  function normalizeCard(card) {
    if (!card) {
      return null;
    }

    return {
      value: String(card.value || card.rank || ""),
      suit: card.suit || card.s || "",
      color: card.color || (RED_SUITS.has(card.suit || card.s) ? "red" : "black")
    };
  }

  function renderCard(card, options = {}) {
    const normalized = normalizeCard(card);
    const size = options.size || "standard";
    const isBack = options.back || !normalized;
    const element = make("div", `playing-card playing-card--${size}`);

    if (isBack) {
      element.classList.add("playing-card--back");
      element.setAttribute("aria-label", "Card back");
      return element;
    }

    if (normalized.color === "red" || RED_SUITS.has(normalized.suit)) {
      element.classList.add("playing-card--red");
    }

    element.setAttribute("aria-label", `${normalized.value} of ${normalized.suit}`);
    if (COURT_VALUES.has(normalized.value)) {
      element.classList.add("playing-card--asset-face");
      element.appendChild(renderCourtImage(normalized, options));
      return element;
    }

    element.appendChild(renderCorner(normalized, false));
    element.appendChild(renderPips(normalized));
    element.appendChild(renderCorner(normalized, true));
    return element;
  }

  window.CardRenderer = { renderCard };
})();
