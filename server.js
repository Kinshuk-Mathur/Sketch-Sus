const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MATCHES_PER_ROUND = 3;
const DRAW_SECONDS = 80;
const JUDGEMENT_SECONDS = 40;
const GAME_INTRO_SECONDS = 11;
const ROLE_REVEAL_SECONDS = 5;
const RECONNECT_GRACE_MS = 60_000;

const ROLE = {
  INKSTER: "inkster",
  CHAMELEON: "chameleon",
  CATCHER: "catcher",
};

const WORDS = [
  "rocket",
  "pizza",
  "detective",
  "haunted house",
  "waterfall",
  "roller coaster",
  "crown",
  "robot",
  "hot air balloon",
  "treasure map",
  "tornado",
  "sneaker",
  "birthday cake",
  "submarine",
  "magician",
  "volcano",
  "campfire",
  "skateboard",
  "astronaut",
  "dragon",
  "movie camera",
  "pirate ship",
  "microscope",
  "snowman",
  "thunderstorm",
  "jellyfish",
  "castle",
  "time machine",
  "ice cream truck",
  "guitar",
  "basketball hoop",
  "alien",
  "lighthouse",
  "superhero",
  "washing machine",
  "trophy",
  "circus tent",
  "mountain bike",
  "chess board",
  "sushi",
];

const SUCCESS_TAGLINES = [
  "Get exposed, lizard 🔍",
  "Nowhere to hide bestie",
  "Caught lackin. Caught lackin.",
  "The jig is UP 💅",
  "Pack it up chameleon",
  "Blending skills: skill issue",
  "Catcher ate and left no crumbs",
  "You tried. Adorable tho.",
];

const CHAMELEON_TAGLINES = [
  "Y'all got bamboozled 💀",
  "Clowns. All of you.",
  "Certified sheep behavior",
  "The audacity. It worked.",
  "Bro was hiding in plain sight",
  "You call that catching?",
  "Chameleon said ez ggs",
  "Fooled by a lizard 🦎",
];

const PLAYER_COLORS = [
  "#0f65b7",
  "#f4a60d",
  "#e83f99",
  "#b24023",
  "#11b3e1",
  "#90930f",
  "#1e356b",
  "#a1b4bc",
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const rooms = new Map();
const clientsByPlayerId = new Map();

function secureUnit() {
  return crypto.randomInt(1, 1_000_000_000) / 1_000_000_000;
}

function gaussianNoise() {
  const u1 = secureUnit();
  const u2 = secureUnit();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function normalizeName(name) {
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 22);
  return clean || `Player ${crypto.randomInt(10, 99)}`;
}

function normalizeToken(token) {
  const clean = String(token || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
  return clean || makeId("token");
}

function randomChoice(items) {
  return items[crypto.randomInt(0, items.length)];
}

function totalMatches(room) {
  return room.settings.rounds * MATCHES_PER_ROUND;
}

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: new Map(),
    settings: {
      rounds: 5,
      drawSeconds: DRAW_SECONDS,
      judgementSeconds: JUDGEMENT_SECONDS,
      matchesPerRound: MATCHES_PER_ROUND,
    },
    phase: "lobby",
    phaseEndsAt: null,
    timer: null,
    round: 0,
    match: 0,
    matchIndex: 0,
    word: null,
    catcherId: null,
    chameleonId: null,
    canvases: new Map(),
    result: null,
    usedWords: [],
  };
  rooms.set(code, room);
  return room;
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((player) => player.connected);
}

function activeDrawingPlayers(room) {
  return [...room.players.values()].filter((player) => player.role && player.role !== ROLE.CATCHER);
}

function findPlayerByToken(room, token) {
  return [...room.players.values()].find((player) => player.token === token) || null;
}

function ensureHost(room) {
  if (room.hostId && room.players.get(room.hostId)?.connected) return;
  room.hostId = connectedPlayers(room)[0]?.id || null;
}

function bindClientToPlayer(room, client, player) {
  const oldClient = clientsByPlayerId.get(player.id);
  if (oldClient && oldClient !== client && oldClient.ws.readyState === oldClient.ws.OPEN) {
    oldClient.replaced = true;
    oldClient.ws.close(1000, "Reconnected elsewhere");
  }

  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
  player.connected = true;
  client.roomCode = room.code;
  client.playerId = player.id;
  clientsByPlayerId.set(player.id, client);
  ensureHost(room);
}

function detachClient(client) {
  if (!client.roomCode || !client.playerId) return;
  const room = rooms.get(client.roomCode);
  if (!room) return;
  const player = room.players.get(client.playerId);

  if (player && clientsByPlayerId.get(player.id) === client) {
    clientsByPlayerId.delete(player.id);
    player.connected = false;
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = setTimeout(() => {
      if (!player.connected && (room.phase === "lobby" || room.phase === "gameOver")) {
        room.players.delete(player.id);
      }
      ensureHost(room);
      if ([...room.players.values()].every((roomPlayer) => !roomPlayer.connected)) {
        clearTimeout(room.timer);
        rooms.delete(room.code);
        return;
      }
      broadcastState(room);
    }, RECONNECT_GRACE_MS);
    player.disconnectTimer.unref?.();
  }

  client.roomCode = null;
  client.playerId = null;
  ensureHost(room);
  broadcastState(room);
}

function removePlayerFromRoom(client) {
  if (!client.roomCode || !client.playerId) return;
  const room = rooms.get(client.roomCode);
  if (!room) return;
  const player = room.players.get(client.playerId);
  if (!player) return;

  clearTimeout(player.disconnectTimer);
  clientsByPlayerId.delete(player.id);
  room.players.delete(player.id);
  client.roomCode = null;
  client.playerId = null;
  send(client, "leftRoom", {});

  if (room.players.size === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }

  ensureHost(room);
  if (room.phase !== "lobby" && room.phase !== "gameOver") {
    resetToLobby(room, `${player.name} left. Room reset.`);
    return;
  }

  broadcastState(room, `${player.name} left the room.`);
}

function dumpRoom(room, message = "Host deleted the room.") {
  clearTimeout(room.timer);

  for (const player of room.players.values()) {
    clearTimeout(player.disconnectTimer);
    const client = clientsByPlayerId.get(player.id);
    if (!client) continue;
    clientsByPlayerId.delete(player.id);
    client.roomCode = null;
    client.playerId = null;
    send(client, "roomClosed", { message });
  }

  rooms.delete(room.code);
}

function addPlayerToRoom(room, client, name, token) {
  detachClient(client);
  const cleanToken = normalizeToken(token);
  let player = findPlayerByToken(room, cleanToken);

  if (player) {
    player.name = normalizeName(name || player.name);
    bindClientToPlayer(room, client, player);
    broadcastState(room);
    return player;
  }

  player = {
    id: makeId("player"),
    token: cleanToken,
    name: normalizeName(name),
    score: 0,
    connected: true,
    role: null,
    lastRole: null,
    roleCounts: {
      [ROLE.INKSTER]: 0,
      [ROLE.CHAMELEON]: 0,
      [ROLE.CATCHER]: 0,
    },
    lastSpecialMatch: 0,
    color: PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
    disconnectTimer: null,
  };

  if (room.players.size === 0) room.hostId = player.id;
  room.players.set(player.id, player);
  bindClientToPlayer(room, client, player);
  broadcastState(room);
  return player;
}

function resumePlayer(room, client, name, token) {
  detachClient(client);
  const player = findPlayerByToken(room, normalizeToken(token));
  if (!player) return null;
  player.name = normalizeName(name || player.name);
  bindClientToPlayer(room, client, player);
  broadcastState(room);
  return player;
}

function resetPlayerRoundState(player) {
  player.role = null;
}

function resetPlayerGameState(player) {
  player.score = 0;
  player.lastRole = null;
  player.lastSpecialMatch = 0;
  player.roleCounts = {
    [ROLE.INKSTER]: 0,
    [ROLE.CHAMELEON]: 0,
    [ROLE.CATCHER]: 0,
  };
  resetPlayerRoundState(player);
}

function getClientPlayer(client) {
  const room = rooms.get(client.roomCode);
  if (!room) return null;
  const player = room.players.get(client.playerId);
  if (!player || !player.connected) return null;
  return { room, player };
}

function pickWord(room) {
  if (room.usedWords.length >= WORDS.length) room.usedWords = [];
  const remaining = WORDS.filter((word) => !room.usedWords.includes(word));
  const word = randomChoice(remaining);
  room.usedWords.push(word);
  return word;
}

function roleExpectedShare(role, playerCount) {
  if (role === ROLE.CATCHER || role === ROLE.CHAMELEON) return 1 / playerCount;
  return Math.max(0, playerCount - 2) / playerCount;
}

function roleWeight(player, role, matchNumber, playerCount) {
  const expected = (matchNumber - 1) * roleExpectedShare(role, playerCount);
  const actual = player.roleCounts[role] || 0;
  const fairness = Math.exp((expected - actual) * 0.85);
  const cooldown = player.lastRole === role ? (role === ROLE.INKSTER ? 0.42 : 0.035) : 1;
  const specialDrought = role === ROLE.INKSTER ? 1 : clamp(1 + (matchNumber - 1 - player.lastSpecialMatch) * 0.08, 1, 2.4);
  return clamp(fairness * cooldown * specialDrought, 0.001, 40);
}

function sampleRoleLayout(players, matchNumber) {
  let best = null;

  for (const catcher of players) {
    for (const chameleon of players) {
      if (catcher.id === chameleon.id) continue;

      let logWeight = 0;
      const assignments = new Map();

      for (const player of players) {
        const role = player.id === catcher.id ? ROLE.CATCHER : player.id === chameleon.id ? ROLE.CHAMELEON : ROLE.INKSTER;
        assignments.set(player.id, role);
        logWeight += Math.log(roleWeight(player, role, matchNumber, players.length));
      }

      const noisyWeight = Math.exp(clamp(logWeight + gaussianNoise() * 0.32, -35, 35));
      const key = Math.log(secureUnit()) / noisyWeight;
      if (!best || key > best.key) best = { key, assignments };
    }
  }

  return best.assignments;
}

function assignRoles(room, players) {
  const assignments = sampleRoleLayout(players, room.matchIndex);
  room.catcherId = null;
  room.chameleonId = null;

  for (const player of players) {
    const role = assignments.get(player.id);
    player.role = role;
    player.roleCounts[role] = (player.roleCounts[role] || 0) + 1;
    if (role === ROLE.CATCHER) room.catcherId = player.id;
    if (role === ROLE.CHAMELEON) room.chameleonId = player.id;
  }

  for (const player of players) {
    player.lastRole = player.role;
    if (player.role === ROLE.CATCHER || player.role === ROLE.CHAMELEON) {
      player.lastSpecialMatch = room.matchIndex;
    }
  }
}

function startGame(room) {
  clearTimeout(room.timer);
  room.round = 0;
  room.match = 0;
  room.matchIndex = 0;
  room.word = null;
  room.result = null;
  room.usedWords = [];

  for (const player of room.players.values()) {
    if (player.connected) resetPlayerGameState(player);
  }
  transitionTo(room, "gameIntro", GAME_INTRO_SECONDS);
}

function startNextMatch(room) {
  ensureHost(room);
  const players = connectedPlayers(room);
  if (players.length < 3) {
    resetToLobby(room, "Need at least 3 players to play.");
    return;
  }

  if (room.matchIndex >= totalMatches(room)) {
    transitionToGameOver(room);
    return;
  }

  room.matchIndex += 1;
  room.round = Math.floor((room.matchIndex - 1) / MATCHES_PER_ROUND) + 1;
  room.match = ((room.matchIndex - 1) % MATCHES_PER_ROUND) + 1;
  room.word = pickWord(room);
  room.result = null;
  room.canvases = new Map();

  for (const player of room.players.values()) resetPlayerRoundState(player);
  assignRoles(room, players);

  for (const player of players) {
    if (player.role !== ROLE.CATCHER) {
      room.canvases.set(player.id, { playerId: player.id, strokes: [] });
    }
  }

  transitionTo(room, "roleReveal", ROLE_REVEAL_SECONDS);
}

function transitionToGameOver(room) {
  clearTimeout(room.timer);
  room.phase = "gameOver";
  room.phaseEndsAt = null;
  room.result = null;
  for (const player of room.players.values()) resetPlayerRoundState(player);
  broadcastState(room);
}

function resetToLobby(room, notice) {
  clearTimeout(room.timer);
  room.phase = "lobby";
  room.phaseEndsAt = null;
  room.round = 0;
  room.match = 0;
  room.matchIndex = 0;
  room.word = null;
  room.catcherId = null;
  room.chameleonId = null;
  room.canvases = new Map();
  room.result = null;
  room.usedWords = [];
  for (const player of room.players.values()) resetPlayerRoundState(player);
  broadcastState(room, notice);
}

function transitionTo(room, phase, seconds) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.phaseEndsAt = seconds ? Date.now() + seconds * 1000 : null;
  room.timer = seconds ? setTimeout(() => onPhaseTimeout(room.code, phase), seconds * 1000) : null;
  if (room.timer) room.timer.unref?.();
  broadcastState(room);
}

function onPhaseTimeout(code, phase) {
  const room = rooms.get(code);
  if (!room || room.phase !== phase) return;

  if (phase === "gameIntro") {
    startNextMatch(room);
    return;
  }

  if (phase === "roleReveal") {
    transitionTo(room, "drawing", DRAW_SECONDS);
    return;
  }

  if (phase === "drawing") {
    transitionTo(room, "judgement", JUDGEMENT_SECONDS);
    return;
  }

  if (phase === "judgement") {
    finalizeGuess(room, pickAutomaticGuess(room), true);
  }
}

function sanitizeSettings(input, existing) {
  return {
    ...existing,
    rounds: clamp(Math.round(Number(input.rounds ?? existing.rounds)), 1, 10),
    drawSeconds: DRAW_SECONDS,
    judgementSeconds: JUDGEMENT_SECONDS,
    matchesPerRound: MATCHES_PER_ROUND,
  };
}

function sanitizeStroke(input) {
  const points = Array.isArray(input.points)
    ? input.points
        .slice(0, 700)
        .map((point) => ({
          x: clamp(Number(point.x), 0, 1),
          y: clamp(Number(point.y), 0, 1),
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    : [];

  if (points.length < 2) return null;

  const color = /^#[0-9a-f]{6}$/i.test(String(input.color || "")) ? input.color : "#1a0b2b";
  const width = clamp(Number(input.width || 8), 2, 44);
  const tool = input.tool === "eraser" ? "eraser" : "brush";
  return {
    id: makeId("stroke"),
    points,
    color,
    width,
    tool,
    sentAt: Date.now(),
  };
}

function canDraw(room, player) {
  return room.phase === "drawing" && (player.role === ROLE.INKSTER || player.role === ROLE.CHAMELEON);
}

function pickAutomaticGuess(room) {
  const drawingIds = activeDrawingPlayers(room).map((player) => player.id);
  return drawingIds.length ? randomChoice(drawingIds) : room.chameleonId;
}

function scoreRound(room, caught) {
  const deltas = {};
  const add = (id, points) => {
    const player = room.players.get(id);
    if (!player) return;
    player.score += points;
    deltas[id] = (deltas[id] || 0) + points;
  };

  if (caught) {
    add(room.catcherId, 500);
    add(room.chameleonId, -200);
    for (const player of room.players.values()) {
      if (player.role === ROLE.INKSTER) add(player.id, 200);
    }
  } else {
    add(room.catcherId, -150);
    add(room.chameleonId, 600);
  }

  for (const player of room.players.values()) {
    if (!(player.id in deltas)) deltas[player.id] = 0;
  }

  return deltas;
}

function snapshotScores(room) {
  const scores = {};
  for (const player of room.players.values()) scores[player.id] = player.score;
  return scores;
}

function finalizeGuess(room, targetId, automatic = false) {
  if (room.phase !== "judgement") return;
  const target = room.players.get(targetId);
  if (!target || target.role === ROLE.CATCHER) return;

  const catcher = room.players.get(room.catcherId);
  const chameleon = room.players.get(room.chameleonId);
  const caught = targetId === room.chameleonId;
  const scoreBefore = snapshotScores(room);
  const deltas = scoreRound(room, caught);
  const scoreAfter = snapshotScores(room);

  room.result = {
    automatic,
    caught,
    guessId: targetId,
    catcherId: room.catcherId,
    chameleonId: room.chameleonId,
    catcherName: catcher?.name || "Catcher",
    chameleonName: chameleon?.name || "Chameleon",
    guessedName: target?.name || "Someone",
    headline: caught ? "SUCCESS" : "FOOLS",
    verdictLine: caught
      ? `Catcher ${catcher?.name || "Catcher"} caught the Chameleon ${chameleon?.name || "Chameleon"}`
      : `Catcher ${catcher?.name || "Catcher"} picked ${target?.name || "someone"}, but ${chameleon?.name || "Chameleon"} was the Chameleon`,
    tagline: caught ? randomChoice(SUCCESS_TAGLINES) : randomChoice(CHAMELEON_TAGLINES),
    deltas,
    scoreBefore,
    scoreAfter,
    revealDelayMs: 5000,
    resolvedAt: Date.now(),
  };

  transitionTo(room, "verdict", null);
}

function visibleRoleFor(room, viewer, player) {
  if (!player.role) return null;
  if (viewer.id === player.id) return player.role;
  if (player.role === ROLE.CATCHER) return ROLE.CATCHER;
  if (room.phase === "verdict" || room.phase === "gameOver") return player.role;
  return null;
}

function visibleWordFor(room, player) {
  if (!room.word) return null;
  if (room.phase === "roleReveal" || room.phase === "drawing") {
    return player.role === ROLE.INKSTER ? room.word : null;
  }
  if (room.phase === "judgement" || room.phase === "verdict") return room.word;
  return null;
}

function serializeCanvases(room, viewer) {
  let canvases = [...room.canvases.values()];

  if (room.phase === "drawing") {
    if (viewer.role === ROLE.CATCHER) canvases = [];
    if (viewer.role === ROLE.INKSTER) canvases = canvases.filter((canvas) => canvas.playerId === viewer.id);
  }

  if (room.phase === "roleReveal") {
    canvases = canvases.filter((canvas) => canvas.playerId === viewer.id);
  }

  if (room.phase === "judgement" && viewer.role !== ROLE.CATCHER) {
    canvases = canvases.filter((canvas) => canvas.playerId === viewer.id);
  }

  return canvases.map((canvas) => ({
    playerId: canvas.playerId,
    strokes: canvas.strokes,
  }));
}

function stateFor(room, viewer, notice) {
  return {
    roomCode: room.code,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    round: room.round,
    match: room.match,
    matchIndex: room.matchIndex,
    totalMatches: totalMatches(room),
    matchesPerRound: MATCHES_PER_ROUND,
    settings: room.settings,
    hostId: room.hostId,
    catcherId: room.catcherId,
    chameleonId: room.phase === "verdict" || room.phase === "gameOver" ? room.chameleonId : null,
    word: visibleWordFor(room, viewer),
    notice: notice || null,
    me: {
      id: viewer.id,
      token: viewer.token,
      name: viewer.name,
      role: viewer.role,
      isHost: viewer.id === room.hostId,
    },
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      color: player.color,
      connected: player.connected,
      isHost: player.id === room.hostId,
      role: visibleRoleFor(room, viewer, player),
      roleCounts: player.id === viewer.id || room.phase === "gameOver" ? player.roleCounts : null,
    })),
    canvases: serializeCanvases(room, viewer),
    result: room.result,
  };
}

function broadcastState(room, notice) {
  ensureHost(room);
  for (const player of room.players.values()) {
    if (!player.connected) continue;
    const client = clientsByPlayerId.get(player.id);
    if (client) send(client, "state", stateFor(room, player, notice));
  }
}

function canReceiveCanvasEvent(room, viewer, ownerId) {
  if (viewer.id === ownerId) return true;
  if (room.phase === "drawing") return viewer.role === ROLE.CHAMELEON;
  return true;
}

function broadcastCanvasEvent(room, ownerId, type, payload) {
  for (const player of room.players.values()) {
    if (!player.connected || !canReceiveCanvasEvent(room, player, ownerId)) continue;
    const client = clientsByPlayerId.get(player.id);
    if (client) send(client, type, payload);
  }
}

function handleMessage(client, message) {
  const { type, payload = {} } = message || {};

  if (type === "createRoom") {
    const room = createRoom();
    addPlayerToRoom(room, client, payload.name, payload.token);
    return;
  }

  if (type === "joinRoom") {
    const code = String(payload.roomCode || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      send(client, "error", { message: "That room code does not exist yet." });
      return;
    }
    if (room.phase !== "lobby" && room.phase !== "gameOver") {
      const resumed = resumePlayer(room, client, payload.name, payload.token);
      if (!resumed) send(client, "error", { message: "That round is already running. Join the next lobby." });
      return;
    }
    if (room.players.size >= 12 && !findPlayerByToken(room, normalizeToken(payload.token))) {
      send(client, "error", { message: "Room is full." });
      return;
    }
    if (room.phase === "gameOver") resetToLobby(room);
    addPlayerToRoom(room, client, payload.name, payload.token);
    return;
  }

  if (type === "resume") {
    const code = String(payload.roomCode || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const room = rooms.get(code);
    if (!room || !resumePlayer(room, client, payload.name, payload.token)) {
      send(client, "resumeFailed", {});
    }
    return;
  }

  const context = getClientPlayer(client);
  if (!context) {
    send(client, "error", { message: "Create or join a room first." });
    return;
  }

  const { room, player } = context;

  if (type === "leaveRoom") {
    removePlayerFromRoom(client);
    return;
  }

  if (type === "dumpRoom") {
    if (player.id !== room.hostId) return;
    dumpRoom(room);
    return;
  }

  if (type === "updateSettings") {
    if (player.id !== room.hostId || room.phase !== "lobby") return;
    room.settings = sanitizeSettings(payload, room.settings);
    broadcastState(room);
    return;
  }

  if (type === "startGame") {
    if (player.id !== room.hostId || (room.phase !== "lobby" && room.phase !== "gameOver")) return;
    if (connectedPlayers(room).length < 3) {
      send(client, "error", { message: "Need at least 3 players: Inkster, Chameleon, Catcher." });
      return;
    }
    startGame(room);
    return;
  }

  if (type === "stroke") {
    if (!canDraw(room, player)) return;
    const canvas = room.canvases.get(player.id);
    const stroke = sanitizeStroke(payload);
    if (!canvas || !stroke) return;
    canvas.strokes.push(stroke);
    if (canvas.strokes.length > 8000) canvas.strokes.splice(0, canvas.strokes.length - 8000);
    broadcastCanvasEvent(room, player.id, "stroke", { playerId: player.id, stroke });
    return;
  }

  if (type === "clearCanvas") {
    if (!canDraw(room, player)) return;
    const canvas = room.canvases.get(player.id);
    if (!canvas) return;
    canvas.strokes = [];
    broadcastCanvasEvent(room, player.id, "canvasClear", { playerId: player.id });
    return;
  }

  if (type === "undoStroke") {
    if (!canDraw(room, player)) return;
    const canvas = room.canvases.get(player.id);
    if (!canvas || canvas.strokes.length === 0) return;
    const stroke = canvas.strokes.pop();
    broadcastCanvasEvent(room, player.id, "canvasUndo", { playerId: player.id, strokeId: stroke.id });
    return;
  }

  if (type === "finalGuess") {
    if (room.phase !== "judgement" || player.id !== room.catcherId) return;
    finalizeGuess(room, payload.targetId, false);
    return;
  }

  if (type === "nextMatch") {
    if (player.id !== room.hostId || room.phase !== "verdict") return;
    if (room.matchIndex >= totalMatches(room)) transitionToGameOver(room);
    else startNextMatch(room);
    return;
  }

  if (type === "backToLobby") {
    if (player.id !== room.hostId) return;
    resetToLobby(room);
  }
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  const pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

function send(client, type, payload = {}) {
  if (!client.ws || client.ws.readyState !== client.ws.OPEN) return;
  client.ws.send(JSON.stringify({ type, payload }));
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client = {
    id: makeId("conn"),
    ws,
    roomCode: null,
    playerId: null,
    replaced: false,
  };

  send(client, "hello", { id: client.id });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    try {
      handleMessage(client, JSON.parse(data.toString("utf8")));
    } catch (error) {
      console.error("Socket message failed:", error);
      send(client, "error", { message: "Socket message failed." });
    }
  });

  ws.on("close", () => {
    if (!client.replaced) detachClient(client);
  });

  ws.on("error", () => {
    if (!client.replaced) detachClient(client);
  });
});

server.listen(PORT, () => {
  console.log(`Sketch & Sus is live on http://localhost:${PORT}`);
});
