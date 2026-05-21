(function () {
  const RED_SUITS = new Set(["\u2665", "\u2666"]);
  const COURT_VALUES = new Set(["J", "Q", "K"]);
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function courtName(value) {
    return {
      J: "jack",
      Q: "queen",
      K: "king"
    }[value] || "king";
  }

  function courtTop(card) {
    const suit = escapeHtml(card.suit);

    if (card.value === "Q") {
      return `
        <path class="court-gold court-stroke" d="M48 20 C62 4 118 4 132 20 L123 39 L57 39 Z" />
        <circle class="court-black" cx="66" cy="20" r="7" />
        <circle class="court-red" cx="90" cy="15" r="7" />
        <circle class="court-black" cx="114" cy="20" r="7" />
        <path class="court-hair court-stroke" d="M52 48 C50 20 130 20 128 48 L124 87 C112 104 68 104 56 87 Z" />
        <ellipse class="court-skin court-stroke" cx="90" cy="58" rx="24" ry="29" />
        <path class="court-ink" d="M76 56 Q82 52 88 56 M96 56 Q102 52 108 56 M83 72 Q90 78 99 72" />
        <path class="court-red court-stroke" d="M36 128 L47 82 L74 73 L90 97 L106 73 L133 82 L144 128 Z" />
        <path class="court-blue court-stroke" d="M62 128 L70 83 L90 105 L110 83 L118 128 Z" />
        <path class="court-gold" d="M86 91 H94 V128 H86 Z" />
        <circle class="court-gold court-stroke" cx="90" cy="104" r="10" />
        <path class="court-white court-stroke" d="M42 92 C29 98 27 117 39 126 C50 123 55 106 42 92 Z" />
        <text class="court-suit" x="133" y="116">${suit}</text>
      `;
    }

    if (card.value === "J") {
      return `
        <path class="court-blue court-stroke" d="M45 32 C62 8 110 8 136 29 L126 47 C102 37 77 38 54 49 Z" />
        <path class="court-gold court-stroke" d="M112 13 C138 4 150 15 139 34 C131 22 124 17 112 13 Z" />
        <path class="court-hair court-stroke" d="M56 45 C61 24 119 26 124 49 L119 82 C107 96 72 96 61 82 Z" />
        <ellipse class="court-skin court-stroke" cx="88" cy="57" rx="23" ry="27" />
        <path class="court-ink" d="M73 55 Q80 51 86 55 M94 56 Q101 52 108 57 M80 71 Q89 75 99 70" />
        <path class="court-red court-stroke" d="M35 128 L48 80 L79 71 L91 94 L105 73 L133 83 L146 128 Z" />
        <path class="court-black court-stroke" d="M70 79 L111 82 L121 128 L59 128 Z" />
        <path class="court-gold" d="M52 88 L62 85 L70 128 L60 128 Z M118 85 L128 89 L119 128 L109 128 Z" />
        <path class="court-white court-stroke" d="M30 73 L140 126" />
        <circle class="court-gold court-stroke" cx="38" cy="77" r="7" />
        <text class="court-suit" x="127" y="110">${suit}</text>
      `;
    }

    return `
      <path class="court-gold court-stroke" d="M43 36 L52 11 L74 28 L90 8 L106 28 L128 11 L137 36 Z" />
      <circle class="court-black" cx="56" cy="32" r="7" />
      <circle class="court-red" cx="90" cy="23" r="7" />
      <circle class="court-black" cx="124" cy="32" r="7" />
      <path class="court-hair court-stroke" d="M51 52 C52 22 128 22 129 52 L123 89 C111 101 69 101 57 89 Z" />
      <ellipse class="court-skin court-stroke" cx="90" cy="57" rx="25" ry="29" />
      <path class="court-ink" d="M74 55 Q82 51 88 55 M96 55 Q104 51 111 55 M83 69 Q90 74 98 69" />
      <path class="court-ink" d="M78 80 C84 91 98 91 104 80" />
      <path class="court-red court-stroke" d="M34 128 L46 79 L76 70 L90 96 L104 70 L134 79 L146 128 Z" />
      <path class="court-black court-stroke" d="M63 128 L69 80 L90 105 L111 80 L117 128 Z" />
      <path class="court-gold" d="M86 94 H94 V128 H86 Z" />
      <path class="court-white court-stroke" d="M134 45 H144 V128 H134 Z" />
      <path class="court-gold court-stroke" d="M127 89 H151 V101 H127 Z" />
      <text class="court-suit" x="49" y="114">${suit}</text>
    `;
  }

  function renderCourt(card) {
    const name = courtName(card.value);
    const court = make("div", `playing-card__court playing-card__court--${name}`);
    const top = courtTop(card);
    court.innerHTML = `
      <svg class="playing-card__court-svg playing-card__court-svg--${name}" viewBox="0 0 180 260" aria-hidden="true">
        <rect class="court-paper" x="6" y="6" width="168" height="248" rx="4" />
        <path class="court-frame" d="M12 12 H168 V248 H12 Z" />
        <g class="court-half court-half--top">${top}</g>
        <path class="court-divider" d="M22 130 H158" />
        <g class="court-half court-half--bottom" transform="translate(180 260) rotate(180)">${top}</g>
      </svg>
    `;
    return court;
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
    element.appendChild(renderCorner(normalized, false));
    element.appendChild(make("div", "playing-card__inner-line"));
    element.appendChild(COURT_VALUES.has(normalized.value) ? renderCourt(normalized) : renderPips(normalized));
    element.appendChild(renderCorner(normalized, true));
    return element;
  }

  window.CardRenderer = { renderCard };
})();
