const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

const ROLE_LABEL = {
  inkster: "Inkster",
  chameleon: "Chameleon",
  catcher: "Catcher",
};

const ROLE_ICON = {
  inkster: "✏️",
  chameleon: "🦎",
  catcher: "🔍",
};

const ROLE_ASSET = {
  inkster: "/assets/inkster.png",
  chameleon: "/assets/chameleon.png",
  catcher: "/assets/catcher.png",
};

const PALETTE = [
  "#1a0b2b",
  "#ffffff",
  "#ff1744",
  "#ffea00",
  "#ff2fb3",
  "#7c3cff",
  "#1e88ff",
  "#00c2ff",
  "#00d084",
  "#ff8a00",
  "#0f65b7",
  "#f4a60d",
  "#e83f99",
  "#e9d4b3",
  "#b24023",
  "#a1b4bc",
  "#90930f",
  "#11b3e1",
];

const STREAM_INTERVAL_MS = 45;
const STREAM_POINT_THRESHOLD = 8;

let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let state = null;
let uiTicker = null;
let selectedTarget = null;
let brushColor = PALETTE[0];
let brushWidth = 10;
let tool = "brush";
let activeStroke = null;
let lastVerdictTone = null;
let lastVerdictKey = null;
let verdictEffectPlayed = false;

const savedName = localStorage.getItem("sketchSus:name") || "";
const urlRoom = new URLSearchParams(window.location.search).get("room") || "";
let entryName = savedName;
let entryRoom = urlRoom.toUpperCase();
let currentRoomCode = localStorage.getItem("sketchSus:room") || "";
const playerToken = getOrCreatePlayerToken();

const sfx = createSfx();

function getOrCreatePlayerToken() {
  const saved = localStorage.getItem("sketchSus:token");
  if (saved) return saved;
  const token = window.crypto?.randomUUID?.() || `token_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  localStorage.setItem("sketchSus:token", token);
  return token;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sendRaw(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type, payload }));
  return true;
}

function send(type, payload = {}) {
  const sent = sendRaw(type, payload);
  if (!sent) showToast("Connecting. Try again in a second.");
  return sent;
}

function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const serverUrl = new URL(window.SKETCH_SUS_SERVER || window.location.origin);
  serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(serverUrl.toString());

  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    if (currentRoomCode) {
      sendRaw("resume", { roomCode: currentRoomCode, token: playerToken, name: entryName });
    } else {
      render();
    }
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "state") {
      const previousPhase = state?.phase;
      state = message.payload;
      currentRoomCode = state.roomCode;
      localStorage.setItem("sketchSus:room", state.roomCode);
      if (state.me?.token) localStorage.setItem("sketchSus:token", state.me.token);
      if (previousPhase !== state.phase) handlePhaseSound(previousPhase, state.phase);
      selectedTarget = state.phase === "judgement" ? selectedTarget : null;
      resetVerdictMarkersIfNeeded();
      render();
      return;
    }

    if (message.type === "stroke") {
      applyStroke(message.payload);
      if (message.payload.playerId !== state?.me?.id) sfx.play("remoteStroke");
      return;
    }

    if (message.type === "canvasClear") {
      replaceCanvas(message.payload.playerId, []);
      sfx.play("clear");
      return;
    }

    if (message.type === "canvasUndo") {
      undoCanvasStroke(message.payload.playerId);
      sfx.play("undo");
      return;
    }

    if (message.type === "resumeFailed") {
      currentRoomCode = "";
      localStorage.removeItem("sketchSus:room");
      state = null;
      renderEntry("Ready");
      return;
    }

    if (message.type === "error") {
      showToast(message.payload.message || "Something went sideways.");
      sfx.play("fail");
    }
  });

  socket.addEventListener("close", () => scheduleReconnect());
  socket.addEventListener("error", () => scheduleReconnect());
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(5000, 600 + reconnectAttempts * 700);
  reconnectAttempts += 1;
  showToast("Reconnecting...");
  reconnectTimer = setTimeout(connect, delay);
}

function resetVerdictMarkersIfNeeded() {
  const key = state?.result ? `${state.result.resolvedAt}:${state.result.guessId}` : "";
  if (key !== lastVerdictKey) {
    lastVerdictKey = key;
    lastVerdictTone = null;
    verdictEffectPlayed = false;
  }
}

function handlePhaseSound(previous, next) {
  if (!previous) return;
  if (next === "roleReveal") sfx.play("start");
  if (next === "drawing") sfx.play("drawStart");
  if (next === "judgement") sfx.play("lock");
  if (next === "gameOver") sfx.play("success");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

function secondsLeft() {
  if (!state?.phaseEndsAt) return null;
  return Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000));
}

function formatTimer() {
  const left = secondsLeft();
  if (left === null) return "--";
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function roleName(role) {
  return role ? `${ROLE_ICON[role] || ""} ${ROLE_LABEL[role] || role}` : "Mystery";
}

function roleAsset(role) {
  return ROLE_ASSET[role] || ROLE_ASSET.inkster;
}

function playerById(id) {
  return state?.players.find((player) => player.id === id);
}

function drawingPlayers() {
  return state?.players.filter((player) => player.id !== state.catcherId && player.role !== "catcher") || [];
}

function canvasFor(playerId) {
  let canvas = state?.canvases.find((item) => item.playerId === playerId);
  if (!canvas && state) {
    canvas = { playerId, strokes: [] };
    state.canvases.push(canvas);
  }
  return canvas;
}

function inviteLink() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", state.roomCode);
  return url.toString();
}

function matchText() {
  if (!state || state.phase === "lobby") return `${state?.settings.rounds || 0} rounds · 3 matches each`;
  if (state.phase === "gameOver") return `Completed ${state.totalMatches || 0} matches`;
  return `Round ${state.round}/${state.settings.rounds} · Match ${state.match}/${state.matchesPerRound}`;
}

function displayScore(player) {
  const result = state?.result;
  if (state?.phase === "verdict" && result) {
    const revealed = Date.now() - result.resolvedAt >= result.revealDelayMs;
    const scores = revealed ? result.scoreAfter : result.scoreBefore;
    return scores?.[player.id] ?? player.score;
  }
  return player.score;
}

function render() {
  if (!state) {
    renderEntry();
    return;
  }

  const content = {
    lobby: renderLobby,
    roleReveal: renderRoleReveal,
    drawing: renderDrawing,
    judgement: renderJudgement,
    verdict: renderVerdict,
    gameOver: renderGameOver,
  }[state.phase]?.() || renderLobby();

  app.innerHTML = `
    ${renderTopbar()}
    ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ""}
    <main class="screen game-shell">
      ${renderScoreboard()}
      <section class="screen-content">${content}</section>
    </main>
  `;

  afterRender();
}

function renderEntry(label = "Ready") {
  clearUiTicker();
  app.innerHTML = `
    <main class="entry-screen">
      <section class="entry-panel">
        <div class="entry-logo-wrap">
          <img class="entry-logo" src="/assets/logo.jpeg" alt="Sketch & Sus logo" />
        </div>
        <div class="entry-copy">
          <p class="eyebrow">${escapeHtml(label)}</p>
          <h1>Sketch & Sus</h1>
          <p class="entry-line">Draw clean, copy sneaky, catch loud.</p>
        </div>
        <form class="entry-form" data-entry-form>
          <label>
            <span>Name</span>
            <input id="entryName" autocomplete="name" maxlength="22" value="${escapeHtml(entryName)}" placeholder="Your name" />
          </label>
          <label>
            <span>Room code</span>
            <input id="entryRoom" autocomplete="off" maxlength="5" value="${escapeHtml(entryRoom)}" placeholder="ABCDE" />
          </label>
          <div class="entry-actions">
            <button class="primary-btn" type="button" data-action="createRoom">Create room</button>
            <button class="secondary-btn" type="button" data-action="joinRoom">Join room</button>
          </div>
        </form>
      </section>
    </main>
  `;
}

function renderTopbar() {
  const phaseLabel = state.phase.replace(/([A-Z])/g, " $1").toUpperCase();
  return `
    <header class="topbar">
      <div class="brand-lockup">
        <img src="/assets/logo.jpeg" alt="Sketch & Sus" />
        <div>
          <strong>Sketch & Sus</strong>
          <span>${escapeHtml(matchText())}</span>
        </div>
      </div>
      <div class="status-strip" aria-label="Game status">
        <span>${phaseLabel}</span>
        <strong class="js-timer">${formatTimer()}</strong>
      </div>
      <div class="room-tools">
        <button class="icon-btn room-code" data-action="copyLink" title="Copy invite link">${state.roomCode}</button>
        <button class="icon-btn" data-action="toggleSound" title="Toggle sound">${sfx.enabled ? "Sound on" : "Muted"}</button>
      </div>
    </header>
  `;
}

function renderScoreboard() {
  return `
    <aside class="scoreboard" aria-label="Points table">
      <div class="scoreboard-head">
        <strong>Points</strong>
        <span>${escapeHtml(matchText())}</span>
      </div>
      <div class="score-list">
        ${[...state.players]
          .sort((a, b) => displayScore(b) - displayScore(a))
          .map(renderScoreRow)
          .join("")}
      </div>
    </aside>
  `;
}

function renderScoreRow(player) {
  const delta = state.result?.deltas?.[player.id] ?? 0;
  const sign = delta > 0 ? "+" : "";
  return `
    <div class="score-row ${player.connected ? "" : "is-offline"}" data-score-row="${player.id}">
      <i style="background:${player.color}"></i>
      <span>${escapeHtml(player.name)}</span>
      <strong data-score-id="${player.id}">${displayScore(player)}</strong>
      <em data-delta-id="${player.id}" class="${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">${sign}${delta}</em>
    </div>
  `;
}

function renderLobby() {
  const isHost = state.me.isHost;
  return `
    <section class="lobby-grid">
      <div class="lobby-hero dark-panel">
        <div class="palette-ribbon" aria-hidden="true">${PALETTE.slice(0, 10).map((color) => `<i style="background:${color}"></i>`).join("")}</div>
        <div class="lobby-logo-frame">
          <img src="/assets/logo.jpeg" alt="Sketch & Sus logo" />
        </div>
        <div>
          <p class="eyebrow">Room ${state.roomCode}</p>
          <h1>Three matches per round. One player is faking it.</h1>
          <p class="lobby-subline">Inksters know the word. Chameleon copies from blur. Catcher chooses after timer.</p>
        </div>
        <div class="hero-actions">
          <button class="primary-btn" data-action="copyLink">Copy invite</button>
          <button class="secondary-btn" data-action="startGame" ${isHost ? "" : "disabled"}>Start game</button>
        </div>
      </div>
      <section class="players-panel">
        <div class="panel-heading">
          <h2>Players</h2>
          <strong>${state.players.length}/12</strong>
        </div>
        <div class="player-list">
          ${state.players.map(renderPlayerRow).join("")}
        </div>
      </section>
      <section class="settings-panel">
        <div class="panel-heading">
          <h2>Round setup</h2>
          <span>${isHost ? "Host controls" : "Waiting on host"}</span>
        </div>
        ${renderSetting("rounds", "Rounds", state.settings.rounds, 1, 10, isHost)}
        <div class="math-lock">
          <strong>Fixed match rules</strong>
          <span>3 matches per round · 80s draw · 40s catcher decision</span>
        </div>
      </section>
    </section>
  `;
}

function renderSetting(key, label, value, min, max, enabled) {
  return `
    <label class="setting-row">
      <span>${label}</span>
      <input data-setting="${key}" type="number" min="${min}" max="${max}" value="${value}" ${enabled ? "" : "disabled"} />
    </label>
  `;
}

function renderPlayerRow(player) {
  const role = player.role ? roleName(player.role) : player.isHost ? "Host" : "Ready";
  return `
    <div class="player-row ${player.connected ? "" : "is-offline"}">
      <i style="background:${player.color}"></i>
      <span>${escapeHtml(player.name)}</span>
      <strong>${displayScore(player)}</strong>
      <small>${escapeHtml(role)}</small>
    </div>
  `;
}

function renderRoleReveal() {
  const role = state.me.role;
  const catcher = playerById(state.catcherId);
  return `
    <section class="reveal-stage dark-panel role-${role}">
      <img class="role-character" src="${roleAsset(role)}" alt="${ROLE_LABEL[role]} character" />
      <p class="eyebrow">${escapeHtml(matchText())}</p>
      <h1>${roleName(role)}</h1>
      <div class="role-chip-line">
        <span>Catcher: ${escapeHtml(catcher?.name || "Unknown")}</span>
        <span>Timer: <b class="js-timer">${formatTimer()}</b></span>
      </div>
      ${
        state.word
          ? `<div class="word-slab"><span>Word</span><strong>${escapeHtml(state.word)}</strong></div>`
          : `<div class="word-slab is-secret"><span>Word</span><strong>Hidden from you</strong></div>`
      }
    </section>
  `;
}

function renderDrawing() {
  if (state.me.role === "catcher") return renderCatcherLive();
  return renderDrawerStage();
}

function renderDrawerStage() {
  const isChameleon = state.me.role === "chameleon";
  return `
    <section class="draw-layout ${isChameleon ? "" : "is-solo"}">
      <div class="draw-main dark-panel">
        <div class="draw-head">
          <div>
            <p class="eyebrow">${roleName(state.me.role)} · ${escapeHtml(matchText())}</p>
            <h1>${state.word ? escapeHtml(state.word) : "Blend from the blur"}</h1>
          </div>
          <div class="timer-badge"><span class="js-timer">${formatTimer()}</span></div>
        </div>
        ${renderToolbar()}
        <canvas id="drawingCanvas" class="drawing-canvas" width="1400" height="875" aria-label="Your drawing canvas"></canvas>
      </div>
      ${
        isChameleon
          ? `<aside class="watch-panel">
              <div class="panel-heading">
                <h2>Blur feed</h2>
                <span>Live hints</span>
              </div>
              <div class="mini-grid is-blurred">
                ${drawingPlayers()
                  .filter((player) => player.id !== state.me.id)
                  .map((player) => renderMiniCanvas(player))
                  .join("")}
              </div>
            </aside>`
          : ""
      }
    </section>
  `;
}

function renderToolbar() {
  return `
    <div class="toolbar" aria-label="Drawing tools">
      <div class="tool-group">
        <button class="tool-btn ${tool === "brush" ? "is-active" : ""}" data-action="setTool" data-tool="brush" title="Brush">Brush</button>
        <button class="tool-btn ${tool === "eraser" ? "is-active" : ""}" data-action="setTool" data-tool="eraser" title="Eraser">Eraser</button>
      </div>
      <div class="swatches" aria-label="Colors">
        ${PALETTE.map((color) => `<button class="swatch ${brushColor === color ? "is-active" : ""}" style="background:${color}" data-action="setColor" data-color="${color}" title="${color}"></button>`).join("")}
      </div>
      <label class="brush-size">
        <span>Size</span>
        <input data-action="brushSize" type="range" min="2" max="34" value="${brushWidth}" />
      </label>
      <div class="tool-group">
        <button class="tool-btn" data-action="undoStroke" title="Undo">Undo</button>
        <button class="tool-btn danger" data-action="clearCanvas" title="Clear">Clear</button>
      </div>
    </div>
  `;
}

function renderCatcherLive() {
  return `
    <section class="catcher-timer-stage dark-panel">
      <img class="catcher-timer-character" src="${roleAsset("catcher")}" alt="Catcher character" />
      <p class="eyebrow">${roleName("catcher")} · ${escapeHtml(matchText())}</p>
      <h1 class="mega-timer js-timer">${formatTimer()}</h1>
      <strong>Drawings unlock after the timer.</strong>
    </section>
  `;
}

function renderMiniCanvas(player) {
  return `
    <article class="mini-canvas">
      <canvas data-preview-id="${player.id}" width="420" height="260"></canvas>
      <strong>${escapeHtml(player.name)}</strong>
    </article>
  `;
}

function renderJudgement() {
  const isCatcher = state.me.id === state.catcherId;
  if (!isCatcher) return renderWaitingJudgement();

  return `
    <section class="judgement-stage dark-panel">
      <div class="draw-head">
        <div>
          <p class="eyebrow">Final decision · ${escapeHtml(matchText())}</p>
          <h1>Catcher, lock the Chameleon</h1>
        </div>
        <div class="timer-badge"><span class="js-timer">${formatTimer()}</span></div>
      </div>
      <div class="suspect-grid">
        ${drawingPlayers().map((player) => renderDrawingTile(player, { judgement: true })).join("")}
      </div>
      <div class="judgement-bar"><button class="primary-btn" data-action="finalGuess" ${selectedTarget ? "" : "disabled"}>Check drawing</button></div>
    </section>
  `;
}

function renderWaitingJudgement() {
  return `
    <section class="catcher-timer-stage dark-panel wait-stage">
      <img class="catcher-timer-character" src="${roleAsset(state.me.role)}" alt="${ROLE_LABEL[state.me.role]} character" />
      <p class="eyebrow">Final decision · ${escapeHtml(matchText())}</p>
      <h1 class="mega-timer js-timer">${formatTimer()}</h1>
      <strong>Catcher is choosing the Chameleon.</strong>
    </section>
  `;
}

function renderDrawingTile(player, mode = {}) {
  const isSelected = selectedTarget === player.id;
  const canClick = mode.judgement;
  const roleBadge = player.role && state.phase === "verdict" ? roleName(player.role) : "";
  const meta = roleBadge || (canClick ? "Click to accuse" : "Drawing");

  return `
    <article class="drawing-tile ${canClick ? "is-clickable" : ""} ${isSelected ? "is-selected" : ""}" data-action="${canClick ? "pickTarget" : ""}" data-target="${player.id}">
      <canvas data-preview-id="${player.id}" width="700" height="438"></canvas>
      <div class="tile-meta">
        <strong>${escapeHtml(player.name)}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
    </article>
  `;
}

function verdictLineForMe(result) {
  if (result.caught) {
    if (state.me.role === "catcher") return "You win as Catcher";
    if (state.me.role === "chameleon") return "You lose, Catcher wins";
    return `${result.catcherName} wins as Catcher`;
  }

  if (state.me.role === "chameleon") return "You win as Chameleon";
  if (state.me.role === "catcher") return "You lose, Chameleon wins";
  return `${result.chameleonName} wins as Chameleon`;
}

function renderVerdict() {
  const result = state.result;
  const nextText = state.matchIndex >= state.totalMatches ? "Final leaderboard" : "Next match";
  return `
    <section class="verdict-stage dark-panel ${result?.caught ? "is-success" : "is-chameleon"}">
      <div id="verdictFx" class="verdict-fx" aria-hidden="true"></div>
      <div class="verdict-copy">
        <img id="verdictCharacter" class="verdict-character is-hidden" src="${roleAsset(result?.caught ? "catcher" : "chameleon")}" alt="${result?.caught ? "Catcher" : "Chameleon"} winner character" />
        <p class="eyebrow">${escapeHtml(result?.verdictLine || "")}</p>
        <h1 id="verdictPulse">5</h1>
        <strong id="verdictRoleLine" class="is-hidden">${escapeHtml(result ? verdictLineForMe(result) : "")}</strong>
        <strong id="verdictTagline" class="is-hidden">${escapeHtml(result?.tagline || "")}</strong>
      </div>
      <div class="suspect-grid reveal">
        ${drawingPlayers().map((player) => renderDrawingTile(player, { locked: true })).join("")}
      </div>
      <div class="delta-strip">
        ${state.players.map(renderDelta).join("")}
      </div>
      <div class="judgement-bar">
        ${
          state.me.isHost
            ? `<button class="primary-btn" data-action="nextMatch">${nextText}</button>`
            : `<span>Waiting for host to continue.</span>`
        }
      </div>
    </section>
  `;
}

function renderDelta(player) {
  const delta = state.result?.deltas?.[player.id] || 0;
  const sign = delta > 0 ? "+" : "";
  return `
    <span>
      <b>${escapeHtml(player.name)}</b>
      <strong class="${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">${sign}${delta}</strong>
    </span>
  `;
}

function renderGameOver() {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  return `
    <section class="gameover-grid">
      <div class="dark-panel final-board">
        <p class="eyebrow">Leaderboard</p>
        <h1>${escapeHtml(sorted[0]?.name || "Winner")} takes the crown</h1>
        <div class="leaderboard">
          ${sorted
            .map(
              (player, index) => `
                <div class="leader-row">
                  <span>${index + 1}</span>
                  <strong>${escapeHtml(player.name)}</strong>
                  <em>${player.score}</em>
                </div>
              `,
            )
            .join("")}
        </div>
        <button class="primary-btn" data-action="backToLobby" ${state.me.isHost ? "" : "disabled"}>Back to lobby</button>
      </div>
      <section class="players-panel">
        <div class="panel-heading">
          <h2>Role balance</h2>
          <span>Final counts</span>
        </div>
        <div class="balance-list">
          ${sorted.map(renderBalanceRow).join("")}
        </div>
      </section>
    </section>
  `;
}

function renderBalanceRow(player) {
  const counts = player.roleCounts || {};
  return `
    <div class="balance-row">
      <strong>${escapeHtml(player.name)}</strong>
      <span>I ${counts.inkster || 0}</span>
      <span>C ${counts.chameleon || 0}</span>
      <span>Catch ${counts.catcher || 0}</span>
    </div>
  `;
}

function afterRender() {
  renderPreviewCanvases();
  mountDrawingCanvas();
  startUiTicker();
  updateVerdictVisual();
  updateScoreboard();
}

function clearUiTicker() {
  if (uiTicker) clearInterval(uiTicker);
  uiTicker = null;
}

function startUiTicker() {
  clearUiTicker();
  if (!state) return;
  uiTicker = setInterval(() => {
    document.querySelectorAll(".js-timer").forEach((element) => {
      element.textContent = formatTimer();
    });
    updateVerdictVisual();
    updateScoreboard();
  }, 200);
}

function updateScoreboard() {
  if (!state) return;
  for (const player of state.players) {
    const score = document.querySelector(`[data-score-id="${player.id}"]`);
    if (score) score.textContent = displayScore(player);

    const delta = document.querySelector(`[data-delta-id="${player.id}"]`);
    if (delta) {
      const revealed = state.phase === "verdict" && state.result && Date.now() - state.result.resolvedAt >= state.result.revealDelayMs;
      delta.classList.toggle("is-visible", Boolean(revealed));
    }
  }
}

function updateVerdictVisual() {
  if (!state || state.phase !== "verdict" || !state.result) return;
  const pulse = document.querySelector("#verdictPulse");
  const roleLine = document.querySelector("#verdictRoleLine");
  const tagline = document.querySelector("#verdictTagline");
  const character = document.querySelector("#verdictCharacter");
  const stage = document.querySelector(".verdict-stage");
  if (!pulse || !roleLine || !tagline || !character || !stage) return;

  const elapsed = Date.now() - state.result.resolvedAt;
  const revealDelay = state.result.revealDelayMs || 5000;
  const remaining = Math.max(1, Math.ceil((revealDelay - elapsed) / 1000));

  if (elapsed < revealDelay) {
    pulse.textContent = String(remaining);
    stage.classList.remove("is-revealed");
    roleLine.classList.add("is-hidden");
    tagline.classList.add("is-hidden");
    character.classList.add("is-hidden");
  } else {
    pulse.textContent = state.result.headline;
    pulse.classList.add("is-final");
    stage.classList.add("is-revealed");
    roleLine.textContent = verdictLineForMe(state.result);
    roleLine.classList.remove("is-hidden");
    tagline.classList.remove("is-hidden");
    character.classList.remove("is-hidden");
    if (!verdictEffectPlayed) {
      verdictEffectPlayed = true;
      spawnVerdictEffect(state.result.caught);
    }
  }

  const tone = elapsed < revealDelay ? String(remaining) : state.result.headline;
  if (lastVerdictTone !== tone) {
    lastVerdictTone = tone;
    if (elapsed < revealDelay) sfx.play("countdown");
    else sfx.play(state.result.caught ? "success" : "fail");
  }
}

function spawnVerdictEffect(caught) {
  const fx = document.querySelector("#verdictFx");
  if (!fx) return;
  const emojis = caught ? ["🎉", "🎊", "✨", "🏆"] : ["😭", "💀", "🤡", "🫠"];
  fx.innerHTML = Array.from({ length: 38 }, (_, index) => {
    const left = Math.round(Math.random() * 100);
    const delay = (Math.random() * 0.7).toFixed(2);
    const drift = Math.round(Math.random() * 160 - 80);
    const emoji = emojis[index % emojis.length];
    return `<span style="left:${left}%; --delay:${delay}s; --drift:${drift}px">${emoji}</span>`;
  }).join("");
}

function mountDrawingCanvas() {
  const canvas = document.querySelector("#drawingCanvas");
  if (!canvas || !state || state.me.role === "catcher" || state.phase !== "drawing") return;

  redrawMainCanvas();

  canvas.onpointerdown = (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(canvas, event);
    activeStroke = {
      color: brushColor,
      width: brushWidth,
      tool,
      points: [point],
      unsent: [],
      lastSentPoint: point,
      lastFlushAt: performance.now(),
    };
    sfx.play("brush");
  };

  canvas.onpointermove = (event) => {
    if (!activeStroke) return;
    const events = event.getCoalescedEvents?.() || [event];
    for (const pointerEvent of events) {
      const point = canvasPoint(canvas, pointerEvent);
      const previous = activeStroke.points[activeStroke.points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0014) continue;
      activeStroke.points.push(point);
      activeStroke.unsent.push(point);
      drawSegment(canvas, previous, point, activeStroke);
    }
    flushActiveStroke(false);
  };

  canvas.onpointerup = endStroke;
  canvas.onpointercancel = endStroke;
  canvas.onpointerleave = (event) => {
    if (event.buttons === 0) endStroke(event);
  };
}

function flushActiveStroke(force) {
  if (!activeStroke || activeStroke.unsent.length === 0) return;
  const now = performance.now();
  if (!force && activeStroke.unsent.length < STREAM_POINT_THRESHOLD && now - activeStroke.lastFlushAt < STREAM_INTERVAL_MS) return;

  const points = [activeStroke.lastSentPoint, ...activeStroke.unsent];
  send("stroke", {
    color: activeStroke.color,
    width: activeStroke.width,
    tool: activeStroke.tool,
    points,
  });

  activeStroke.lastSentPoint = activeStroke.unsent[activeStroke.unsent.length - 1];
  activeStroke.unsent = [];
  activeStroke.lastFlushAt = now;
}

function endStroke() {
  if (!activeStroke) return;
  flushActiveStroke(true);
  activeStroke = null;
}

function canvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function applyStroke(payload) {
  if (!state) return;
  const canvas = canvasFor(payload.playerId);
  if (!canvas) return;
  canvas.strokes.push(payload.stroke);

  if (!(payload.playerId === state.me.id && state.phase === "drawing")) {
    paintStrokeOnVisibleCanvases(payload.playerId, payload.stroke);
  }
}

function paintStrokeOnVisibleCanvases(playerId, stroke) {
  document.querySelectorAll(`canvas[data-preview-id="${playerId}"]`).forEach((canvas) => {
    const context = canvas.getContext("2d");
    drawStroke(context, stroke, canvas.width, canvas.height);
  });
}

function replaceCanvas(playerId, strokes) {
  if (!state) return;
  const canvas = canvasFor(playerId);
  if (!canvas) return;
  canvas.strokes = strokes;
  if (playerId === state.me.id) redrawMainCanvas();
  renderPreviewCanvases();
}

function undoCanvasStroke(playerId) {
  const canvas = canvasFor(playerId);
  if (!canvas) return;
  canvas.strokes.pop();
  if (playerId === state.me.id) redrawMainCanvas();
  renderPreviewCanvases();
}

function renderPreviewCanvases() {
  if (!state) return;
  document.querySelectorAll("canvas[data-preview-id]").forEach((canvas) => {
    drawPlayerCanvas(canvas, canvas.dataset.previewId);
  });
}

function redrawMainCanvas() {
  const canvas = document.querySelector("#drawingCanvas");
  if (!canvas || !state) return;
  drawPlayerCanvas(canvas, state.me.id);
}

function drawPlayerCanvas(canvas, playerId) {
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.lineJoin = "round";
  context.lineCap = "round";
  const strokes = canvasFor(playerId)?.strokes || [];
  for (const stroke of strokes) drawStroke(context, stroke, canvas.width, canvas.height);
}

function drawStroke(context, stroke, width, height) {
  if (!stroke.points || stroke.points.length < 2) return;
  context.save();
  context.lineJoin = "round";
  context.lineCap = "round";
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.beginPath();
  context.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
  for (let index = 1; index < stroke.points.length - 1; index += 1) {
    const current = stroke.points[index];
    const next = stroke.points[index + 1];
    const midX = ((current.x + next.x) / 2) * width;
    const midY = ((current.y + next.y) / 2) * height;
    context.quadraticCurveTo(current.x * width, current.y * height, midX, midY);
  }
  const last = stroke.points[stroke.points.length - 1];
  context.lineTo(last.x * width, last.y * height);
  context.stroke();
  context.restore();
}

function drawSegment(canvas, from, to, stroke) {
  const context = canvas.getContext("2d");
  context.save();
  context.lineJoin = "round";
  context.lineCap = "round";
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.beginPath();
  context.moveTo(from.x * canvas.width, from.y * canvas.height);
  context.lineTo(to.x * canvas.width, to.y * canvas.height);
  context.stroke();
  context.restore();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function collectEntry() {
  entryName = document.querySelector("#entryName")?.value.trim() || "";
  entryRoom = document.querySelector("#entryRoom")?.value.trim().toUpperCase() || "";
  localStorage.setItem("sketchSus:name", entryName);
}

function collectSettings() {
  const settings = {};
  document.querySelectorAll("[data-setting]").forEach((input) => {
    settings[input.dataset.setting] = Number(input.value);
  });
  return settings;
}

app.addEventListener("submit", (event) => event.preventDefault());

app.addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "entryName") entryName = target.value;
  if (target.id === "entryRoom") entryRoom = target.value.toUpperCase();
  if (target.dataset.action === "brushSize") brushWidth = Number(target.value);
  if (target.dataset.setting && state?.me.isHost) send("updateSettings", collectSettings());
});

app.addEventListener("click", async (event) => {
  sfx.unlock();
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;

  const action = actionTarget.dataset.action;

  if (action === "createRoom") {
    collectEntry();
    send("createRoom", { name: entryName, token: playerToken });
    sfx.play("join");
    return;
  }

  if (action === "joinRoom") {
    collectEntry();
    send("joinRoom", { name: entryName, roomCode: entryRoom, token: playerToken });
    sfx.play("join");
    return;
  }

  if (action === "copyLink") {
    await navigator.clipboard?.writeText(state ? inviteLink() : window.location.href);
    showToast("Invite link copied.");
    sfx.play("click");
    return;
  }

  if (action === "toggleSound") {
    sfx.setEnabled(!sfx.enabled);
    localStorage.setItem("sketchSus:sound", sfx.enabled ? "on" : "off");
    render();
    return;
  }

  if (action === "startGame") {
    send("startGame");
    sfx.play("start");
    return;
  }

  if (action === "setTool") {
    tool = actionTarget.dataset.tool;
    sfx.play("click");
    render();
    return;
  }

  if (action === "setColor") {
    brushColor = actionTarget.dataset.color;
    tool = "brush";
    sfx.play("click");
    render();
    return;
  }

  if (action === "undoStroke") {
    send("undoStroke");
    return;
  }

  if (action === "clearCanvas") {
    send("clearCanvas");
    return;
  }

  if (action === "pickTarget") {
    const targetId = actionTarget.dataset.target;
    if (state.phase === "judgement" && state.me.id === state.catcherId) {
      selectedTarget = targetId;
      sfx.play("click");
      render();
    }
    return;
  }

  if (action === "finalGuess") {
    if (!selectedTarget) return;
    send("finalGuess", { targetId: selectedTarget });
    sfx.play("lock");
    return;
  }

  if (action === "nextMatch") {
    send("nextMatch");
    sfx.play("start");
    return;
  }

  if (action === "backToLobby") {
    currentRoomCode = "";
    localStorage.removeItem("sketchSus:room");
    send("backToLobby");
    sfx.play("click");
  }
});

function createSfx() {
  let context = null;
  const sfxState = {
    enabled: localStorage.getItem("sketchSus:sound") !== "off",
    unlock,
    setEnabled(value) {
      this.enabled = value;
      if (value) unlock();
    },
    play(name) {
      if (!this.enabled) return;
      unlock();
      if (!context) return;

      const patterns = {
        click: [[420, 0.035, "triangle", 0]],
        join: [
          [320, 0.07, "sine", 0],
          [520, 0.08, "sine", 0.055],
        ],
        start: [
          [220, 0.08, "triangle", 0],
          [330, 0.08, "triangle", 0.07],
          [550, 0.12, "triangle", 0.14],
        ],
        drawStart: [
          [500, 0.06, "square", 0],
          [740, 0.07, "square", 0.06],
        ],
        brush: [[260, 0.025, "sine", 0]],
        remoteStroke: [[180, 0.018, "sine", 0]],
        clear: [[120, 0.09, "sawtooth", 0]],
        undo: [[260, 0.05, "triangle", 0]],
        lock: [
          [160, 0.12, "square", 0],
          [90, 0.16, "sine", 0.08],
        ],
        countdown: [[780, 0.08, "square", 0]],
        success: [
          [523, 0.12, "triangle", 0],
          [659, 0.14, "triangle", 0.04],
          [784, 0.18, "triangle", 0.08],
        ],
        fail: [
          [330, 0.1, "sawtooth", 0],
          [220, 0.12, "sawtooth", 0.08],
          [146, 0.18, "sawtooth", 0.16],
        ],
      };

      for (const [frequency, duration, type, delay] of patterns[name] || patterns.click) {
        tone(frequency, duration, type, delay);
      }
    },
  };

  function unlock() {
    if (!context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      context = new AudioContext();
    }
    if (context.state === "suspended") context.resume();
  }

  function tone(frequency, duration, type, delay) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.05, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
  }

  return sfxState;
}

document.addEventListener(
  "pointerdown",
  () => {
    sfx.unlock();
  },
  { once: true },
);

connect();
render();
