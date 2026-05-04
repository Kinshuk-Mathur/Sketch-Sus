const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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
const clients = new Map();

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
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
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

function randomChoice(items) {
  return items[crypto.randomInt(0, items.length)];
}

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: new Map(),
    settings: {
      rounds: 5,
      drawSeconds: 75,
      voteSeconds: 25,
    },
    phase: "lobby",
    phaseEndsAt: null,
    timer: null,
    round: 0,
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

function ensureHost(room) {
  if (room.hostId && room.players.get(room.hostId)?.connected) return;
  room.hostId = connectedPlayers(room)[0]?.id || null;
}

function leaveCurrentRoom(client) {
  if (!client.roomCode || !client.playerId) return;
  const room = rooms.get(client.roomCode);
  if (!room) return;

  const player = room.players.get(client.playerId);
  if (player) {
    if (room.phase === "lobby" || room.phase === "gameOver") {
      room.players.delete(player.id);
    } else {
      player.connected = false;
    }
  }

  ensureHost(room);
  client.roomCode = null;
  client.playerId = null;

  if (connectedPlayers(room).length === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }

  if (room.phase !== "lobby" && room.phase !== "gameOver" && connectedPlayers(room).length < 3) {
    resetToLobby(room, "Game paused because fewer than 3 players are connected.");
    return;
  }

  broadcastState(room);
}

function addPlayerToRoom(room, client, name) {
  leaveCurrentRoom(client);

  const player = {
    id: client.id,
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
    lastSpecialRound: 0,
    vote: null,
    color: PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
  };

  if (room.players.size === 0) room.hostId = player.id;

  room.players.set(player.id, player);
  client.roomCode = room.code;
  client.playerId = player.id;
  ensureHost(room);
  broadcastState(room);
}

function resetPlayerRoundState(player) {
  player.role = null;
  player.vote = null;
}

function resetPlayerGameState(player) {
  player.score = 0;
  player.lastRole = null;
  player.lastSpecialRound = 0;
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

function roleWeight(player, role, roundNumber, playerCount) {
  const expected = (roundNumber - 1) * roleExpectedShare(role, playerCount);
  const actual = player.roleCounts[role] || 0;
  const fairness = Math.exp((expected - actual) * 0.85);
  const cooldown = player.lastRole === role ? (role === ROLE.INKSTER ? 0.42 : 0.035) : 1;
  const specialDrought = role === ROLE.INKSTER ? 1 : clamp(1 + (roundNumber - 1 - player.lastSpecialRound) * 0.08, 1, 2.4);
  return clamp(fairness * cooldown * specialDrought, 0.001, 40);
}

function sampleRoleLayout(players, roundNumber) {
  let best = null;

  for (const catcher of players) {
    for (const chameleon of players) {
      if (catcher.id === chameleon.id) continue;

      let logWeight = 0;
      const assignments = new Map();

      for (const player of players) {
        const role = player.id === catcher.id ? ROLE.CATCHER : player.id === chameleon.id ? ROLE.CHAMELEON : ROLE.INKSTER;
        assignments.set(player.id, role);
        logWeight += Math.log(roleWeight(player, role, roundNumber, players.length));
      }

      // Weighted reservoir key with Box-Muller Gaussian noise keeps the result fair but hard to predict.
      const noisyWeight = Math.exp(clamp(logWeight + gaussianNoise() * 0.32, -35, 35));
      const key = Math.log(secureUnit()) / noisyWeight;
      if (!best || key > best.key) best = { key, assignments };
    }
  }

  return best.assignments;
}

function assignRoles(room, players) {
  const assignments = sampleRoleLayout(players, room.round);
  room.catcherId = null;
  room.chameleonId = null;

  for (const player of players) {
    const role = assignments.get(player.id);
    player.role = role;
    player.vote = null;
    player.roleCounts[role] = (player.roleCounts[role] || 0) + 1;
    if (role === ROLE.CATCHER) room.catcherId = player.id;
    if (role === ROLE.CHAMELEON) room.chameleonId = player.id;
  }

  for (const player of players) {
    player.lastRole = player.role;
    if (player.role === ROLE.CATCHER || player.role === ROLE.CHAMELEON) {
      player.lastSpecialRound = room.round;
    }
  }
}

function startGame(room) {
  clearTimeout(room.timer);
  room.round = 0;
  room.word = null;
  room.result = null;
  room.usedWords = [];

  for (const [id, player] of room.players) {
    if (!player.connected) room.players.delete(id);
  }

  for (const player of connectedPlayers(room)) resetPlayerGameState(player);
  startNextRound(room);
}

function startNextRound(room) {
  for (const [id, player] of room.players) {
    if (!player.connected) room.players.delete(id);
  }

  ensureHost(room);
  const players = connectedPlayers(room);
  if (players.length < 3) {
    resetToLobby(room, "Need at least 3 players to keep playing.");
    return;
  }

  if (room.round >= room.settings.rounds) {
    room.phase = "gameOver";
    room.phaseEndsAt = null;
    room.result = null;
    clearTimeout(room.timer);
    broadcastState(room);
    return;
  }

  room.round += 1;
  room.word = pickWord(room);
  room.result = null;
  room.canvases = new Map();

  for (const player of players) resetPlayerRoundState(player);
  assignRoles(room, players);

  for (const player of players) {
    if (player.role !== ROLE.CATCHER) {
      room.canvases.set(player.id, { playerId: player.id, strokes: [] });
    }
  }

  transitionTo(room, "roleReveal", 5);
}

function resetToLobby(room, notice) {
  clearTimeout(room.timer);
  room.phase = "lobby";
  room.phaseEndsAt = null;
  room.round = 0;
  room.word = null;
  room.catcherId = null;
  room.chameleonId = null;
  room.canvases = new Map();
  room.result = null;
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

  if (phase === "roleReveal") {
    transitionTo(room, "drawing", room.settings.drawSeconds);
    return;
  }

  if (phase === "drawing") {
    transitionTo(room, "voting", room.settings.voteSeconds);
    return;
  }

  if (phase === "voting") {
    transitionTo(room, "judgement", 45);
    return;
  }

  if (phase === "judgement") {
    finalizeGuess(room, pickAutomaticGuess(room), true);
    return;
  }

  if (phase === "verdict") {
    startNextRound(room);
  }
}

function sanitizeSettings(input, existing) {
  return {
    rounds: clamp(Math.round(Number(input.rounds ?? existing.rounds)), 1, 10),
    drawSeconds: clamp(Math.round(Number(input.drawSeconds ?? existing.drawSeconds)), 30, 180),
    voteSeconds: clamp(Math.round(Number(input.voteSeconds ?? existing.voteSeconds)), 15, 60),
  };
}

function sanitizeStroke(input) {
  const points = Array.isArray(input.points)
    ? input.points
        .slice(0, 800)
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
  };
}

function canDraw(room, player) {
  return room.phase === "drawing" && (player.role === ROLE.INKSTER || player.role === ROLE.CHAMELEON);
}

function voteCounts(room) {
  const counts = {};
  for (const player of room.players.values()) {
    if (player.vote) counts[player.vote] = (counts[player.vote] || 0) + 1;
  }
  return counts;
}

function pickAutomaticGuess(room) {
  const drawingIds = activeDrawingPlayers(room).map((player) => player.id);
  const counts = voteCounts(room);
  const topScore = Math.max(0, ...drawingIds.map((id) => counts[id] || 0));
  const top = drawingIds.filter((id) => (counts[id] || 0) === topScore);
  return randomChoice(top);
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

  return deltas;
}

function finalizeGuess(room, targetId, automatic = false) {
  if (room.phase !== "judgement" && room.phase !== "voting") return;
  const target = room.players.get(targetId);
  if (!target || target.role === ROLE.CATCHER) return;

  const catcher = room.players.get(room.catcherId);
  const chameleon = room.players.get(room.chameleonId);
  const caught = targetId === room.chameleonId;
  const deltas = scoreRound(room, caught);

  room.result = {
    automatic,
    caught,
    guessId: targetId,
    catcherId: room.catcherId,
    chameleonId: room.chameleonId,
    catcherName: catcher?.name || "Catcher",
    chameleonName: chameleon?.name || "Chameleon",
    guessedName: target?.name || "Someone",
    headline: caught ? "SUCCESS" : "Chameleon WINS (fools everyone)",
    verdictLine: caught
      ? `Catcher ${catcher?.name || "Catcher"} caught the Chameleon ${chameleon?.name || "Chameleon"}`
      : `Catcher ${catcher?.name || "Catcher"} picked ${target?.name || "someone"}, but ${chameleon?.name || "Chameleon"} was the Chameleon`,
    tagline: caught ? randomChoice(SUCCESS_TAGLINES) : randomChoice(CHAMELEON_TAGLINES),
    deltas,
    resolvedAt: Date.now(),
  };

  transitionTo(room, "verdict", 10);
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
  if (room.phase === "voting" || room.phase === "judgement" || room.phase === "verdict") {
    return room.word;
  }
  return null;
}

function serializeCanvases(room) {
  return [...room.canvases.values()].map((canvas) => ({
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
    settings: room.settings,
    hostId: room.hostId,
    catcherId: room.catcherId,
    chameleonId: room.phase === "verdict" || room.phase === "gameOver" ? room.chameleonId : null,
    word: visibleWordFor(room, viewer),
    notice: notice || null,
    me: {
      id: viewer.id,
      name: viewer.name,
      role: viewer.role,
      vote: viewer.vote,
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
    canvases: serializeCanvases(room),
    votes: voteCounts(room),
    result: room.result,
  };
}

function broadcastState(room, notice) {
  ensureHost(room);
  for (const player of room.players.values()) {
    if (!player.connected) continue;
    const client = clients.get(player.id);
    if (client) send(client, "state", stateFor(room, player, notice));
  }
}

function broadcastRoom(room, type, payload) {
  for (const player of room.players.values()) {
    if (!player.connected) continue;
    const client = clients.get(player.id);
    if (client) send(client, type, payload);
  }
}

function handleMessage(client, message) {
  const { type, payload = {} } = message || {};

  if (type === "createRoom") {
    const room = createRoom();
    addPlayerToRoom(room, client, payload.name);
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
      send(client, "error", { message: "That round is already running. Join the next lobby." });
      return;
    }
    if (room.players.size >= 12) {
      send(client, "error", { message: "Room is full." });
      return;
    }
    if (room.phase === "gameOver") resetToLobby(room);
    addPlayerToRoom(room, client, payload.name);
    return;
  }

  const context = getClientPlayer(client);
  if (!context) {
    send(client, "error", { message: "Create or join a room first." });
    return;
  }

  const { room, player } = context;

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
    if (canvas.strokes.length > 700) canvas.strokes.splice(0, canvas.strokes.length - 700);
    broadcastRoom(room, "stroke", { playerId: player.id, stroke });
    return;
  }

  if (type === "clearCanvas") {
    if (!canDraw(room, player)) return;
    const canvas = room.canvases.get(player.id);
    if (!canvas) return;
    canvas.strokes = [];
    broadcastRoom(room, "canvasClear", { playerId: player.id });
    return;
  }

  if (type === "undoStroke") {
    if (!canDraw(room, player)) return;
    const canvas = room.canvases.get(player.id);
    if (!canvas || canvas.strokes.length === 0) return;
    const stroke = canvas.strokes.pop();
    broadcastRoom(room, "canvasUndo", { playerId: player.id, strokeId: stroke.id });
    return;
  }

  if (type === "vote") {
    if (room.phase !== "voting") return;
    if (player.vote) {
      send(client, "error", { message: "One vote only. The table saw that." });
      return;
    }
    const target = room.players.get(payload.targetId);
    if (!target || target.role === ROLE.CATCHER) return;
    player.vote = target.id;
    broadcastState(room);
    return;
  }

  if (type === "finalGuess") {
    if (room.phase !== "judgement" || player.id !== room.catcherId) return;
    finalizeGuess(room, payload.targetId, false);
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

function sendFrame(client, payload, opcode = 0x1) {
  if (!client.socket || client.socket.destroyed) return;
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;

  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  client.socket.write(Buffer.concat([header, data]));
}

function send(client, type, payload = {}) {
  sendFrame(client, JSON.stringify({ type, payload }));
}

function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const bigLength = client.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        client.socket.destroy();
        return;
      }
      length = Number(bigLength);
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) return;

    let mask;
    if (masked) {
      mask = client.buffer.slice(offset, offset + 4);
      offset += 4;
    }

    const payload = client.buffer.slice(offset, offset + length);
    client.buffer = client.buffer.slice(offset + length);

    if (opcode === 0x8) {
      client.socket.end();
      return;
    }

    if (opcode === 0x9) {
      sendFrame(client, payload, 0x0a);
      continue;
    }

    if (opcode !== 0x1) continue;

    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    try {
      handleMessage(client, JSON.parse(payload.toString("utf8")));
    } catch (error) {
      send(client, "error", { message: "Bad socket message." });
    }
  }
}

const server = http.createServer(serveStatic);

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );

  const client = {
    id: makeId("player"),
    socket,
    buffer: Buffer.alloc(0),
    roomCode: null,
    playerId: null,
  };

  clients.set(client.id, client);
  send(client, "hello", { id: client.id });

  socket.on("data", (chunk) => parseFrames(client, chunk));
  socket.on("close", () => {
    leaveCurrentRoom(client);
    clients.delete(client.id);
  });
  socket.on("error", () => {
    leaveCurrentRoom(client);
    clients.delete(client.id);
  });
});

server.listen(PORT, () => {
  console.log(`Sketch & Sus is live on http://localhost:${PORT}`);
});
