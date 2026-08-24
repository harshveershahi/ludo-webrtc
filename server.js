// ===================================================================
//  LUDO ROYALE — Authoritative Multiplayer Server (Ludo King theme)
//  Express + ws + full inline client
// ===================================================================
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

// ---------- Board geometry (15x15) ----------
const COLORS = ['red', 'green', 'yellow', 'blue'];
const TRACK = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],[8,14],
  [8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],[14,6],
  [13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],[6,0]
];
const START_POS = { red: 0, green: 13, yellow: 26, blue: 39 };
const HOME_COLUMNS = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5],[7,7]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7],[7,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,7]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7],[7,7]]
};
const SAFE_SQUARES = [0, 8, 13, 21, 26, 34, 39, 47];
const EMOJI_OK = ['😂','😎','😱','👏','🔥','❤️','👍','🎉','😭','🤣','😮','👀'];

function getAbsPos(color, rel) { return (START_POS[color] + rel - 1) % 52; }
function isSafe(color, rel) {
  if (rel === 0 || rel >= 52) return true;
  return SAFE_SQUARES.includes(getAbsPos(color, rel));
}
function tokensAtAbs(room, abs, excludeColor) {
  const out = [];
  for (const p of room.players) {
    if (excludeColor && p.color === excludeColor) continue;
    (room.tokens[p.id] || []).forEach((t, i) => {
      if (t.position >= 1 && t.position <= 51 && getAbsPos(p.color, t.position) === abs)
        out.push({ player: p, idx: i, token: t });
    });
  }
  return out;
}
function isBlockadedAt(room, abs, excludeColor) {
  for (const p of room.players) {
    if (excludeColor && p.color === excludeColor) continue;
    let c = 0;
    for (const t of (room.tokens[p.id] || []))
      if (t.position >= 1 && t.position <= 51 && getAbsPos(p.color, t.position) === abs) c++;
    if (c >= 2) return true;
  }
  return false;
}
function legalMoves(room, player) {
  const out = [], dice = room.diceValue;
  if (!dice) return out;
  const tks = room.tokens[player.id];
  for (let i = 0; i < 4; i++) {
    const t = tks[i];
    if (t.position === 57) continue;
    if (t.position === 0) {
      if (dice === 6 && !isBlockadedAt(room, START_POS[player.color], player.color)) out.push(i);
      continue;
    }
    const np = t.position + dice;
    if (np > 57) continue;
    let blocked = false;
    for (let p = t.position + 1; p <= np && p <= 51; p++)
      if (isBlockadedAt(room, getAbsPos(player.color, p), player.color)) { blocked = true; break; }
    if (!blocked) out.push(i);
  }
  return out;
}
function executeMove(room, player, idx) {
  const t = room.tokens[player.id][idx];
  const dice = room.diceValue;
  let captured = false, reachedHome = false, capColor = null;
  if (t.position === 0) t.position = 1; else t.position += dice;
  if (t.position >= 1 && t.position <= 51 && !isSafe(player.color, t.position)) {
    const here = tokensAtAbs(room, getAbsPos(player.color, t.position), player.color);
    if (here.length === 1) {
      here[0].token.position = 0;
      captured = true; capColor = here[0].player.color;
    }
  }
  if (t.position === 57) {
    reachedHome = true;
    player.completed = (player.completed || 0) + 1;
  }
  // THE rule — ONE extra roll max: 6 OR capture OR home
  const extraTurn = (dice === 6) || captured || reachedHome;
  return { captured, reachedHome, extraTurn, capColor };
}
function nextPlayer(room) {
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (room.currentPlayerIndex + i) % n;
    if ((room.players[idx].completed || 0) >= 4) continue;
    room.currentPlayerIndex = idx; return;
  }
  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % n;
}
function rollValue(room) {
  const m = room.hostMod;
  if (m.forcedValue != null) {
    if (m.mode === 'next') { const v = m.forcedValue; m.forcedValue = null; m.mode = null; return v; }
    if (m.mode === 'forever') return m.forcedValue;
    if (m.mode === 'count') { const v = m.forcedValue; m.remaining--; if (m.remaining <= 0) { m.forcedValue = null; m.mode = null; } return v; }
  }
  return 1 + Math.floor(Math.random() * 6);
}
function genRoomCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function genId() { return crypto.randomBytes(8).toString('hex'); }

// ---------- Room ----------
class Room {
  constructor(code) {
    this.code = code; this.hostId = null; this.players = []; this.tokens = {};
    this.started = false; this.currentPlayerIndex = 0;
    this.diceValue = null; this.isRolling = false; this.canMove = false; this.legalMoves = [];
    this.consecutiveSixes = 0; this.paused = false; this.winner = null;
    this.hostMod = { forcedValue: null, mode: null, remaining: 0 };
    this.lastEvent = null; this.eventSeq = 0;
    this.turnTimer = null; this.aiTimer = null; this.emptySince = null;
  }
  addPlayer(id, name, isAI) {
    if (this.players.length >= 4) return null;
    const used = this.players.map(p => p.color);
    const color = COLORS.find(c => !used.includes(c)) || COLORS[this.players.length];
    const p = {
      id, name: (name || '').toString().trim().slice(0, 14) || (color.charAt(0).toUpperCase() + color.slice(1)),
      color, isHost: false, isAI: !!isAI, connected: !isAI, completed: 0
    };
    this.players.push(p);
    this.tokens[id] = [{position:0},{position:0},{position:0},{position:0}];
    if (this.hostId === null) { this.hostId = id; p.isHost = true; }
    return p;
  }
  removePlayer(id) {
    const i = this.players.findIndex(p => p.id === id);
    if (i === -1) return;
    this.players.splice(i, 1);
    delete this.tokens[id];
    if (this.hostId === id && this.players.length > 0) {
      this.hostId = this.players[0].id;
      this.players.forEach(p => p.isHost = (p.id === this.hostId));
    } else if (this.players.length === 0) this.hostId = null;
    if (this.currentPlayerIndex >= this.players.length) this.currentPlayerIndex = 0;
  }
  state(forHost) {
    return {
      code: this.code, hostId: this.hostId,
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost,
        isAI: p.isAI, connected: p.connected, completed: p.completed || 0
      })),
      started: this.started, currentPlayerIndex: this.currentPlayerIndex,
      diceValue: this.diceValue, isRolling: this.isRolling,
      canMove: this.canMove, legalMoves: this.legalMoves,
      paused: this.paused, winner: this.winner,
      hostMod: forHost ? this.hostMod : null,
      tokens: this.tokens
    };
  }
}

// ---------- Globals ----------
const rooms = new Map();
const playerSocks = new Map();
const sockInfo = new Map();

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const p of room.players) {
    if (p.isAI) continue;
    const ws = playerSocks.get(p.id);
    if (ws && ws.readyState === 1) ws.send(msg);
  }
}
function emitState(room) {
  for (const p of room.players) {
    if (p.isAI) continue;
    const ws = playerSocks.get(p.id);
    if (ws && ws.readyState === 1)
      ws.send(JSON.stringify({ type: 'STATE', state: room.state(p.id === room.hostId) }));
  }
}
function emitEvent(room, ev) {
  ev.seq = ++room.eventSeq;
  room.lastEvent = ev;
  broadcast(room, { type: 'EVENT', event: ev });
}

// ---------- Turn-flow helpers ----------
function armSkipTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (!room.started || room.winner || room.paused) return;
  const cur = room.players[room.currentPlayerIndex];
  if (!cur || cur.isAI || cur.connected) return;
  const pid = cur.id;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    const c = room.players[room.currentPlayerIndex];
    if (!c || c.id !== pid || room.winner || room.paused) return;
    room.isRolling = false; room.diceValue = null;
    room.canMove = false; room.legalMoves = []; room.consecutiveSixes = 0;
    emitEvent(room, { kind: 'SKIP', player: pid });
    nextPlayer(room); emitState(room); maybeAITurn(room); armSkipTimer(room);
  }, 20000);
}
function maybeAITurn(room) {
  if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
  const cur = room.players[room.currentPlayerIndex];
  if (cur && cur.isAI && room.started && !room.winner && !room.paused)
    room.aiTimer = setTimeout(() => { room.aiTimer = null; doRoll(room, cur); }, 900);
}
function clearTimers(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
}

// ---------- Game flow ----------
function doRoll(room, player) {
  if (!room.started || room.paused || room.winner) return;
  if (room.isRolling || room.canMove) return;
  if (room.players[room.currentPlayerIndex].id !== player.id) return;
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.isRolling = true;
  emitState(room);
  setTimeout(() => {
    room.isRolling = false;
    if (room.paused || room.winner) { emitState(room); return; }
    const dice = rollValue(room);
    room.diceValue = dice;
    if (dice === 6) {
      room.consecutiveSixes++;
      if (room.consecutiveSixes >= 3) {
        room.consecutiveSixes = 0;
        room.diceValue = null; room.canMove = false; room.legalMoves = [];
        emitEvent(room, { kind: 'MOVE_RESULT', player: player.id, dice: 6, threeSixes: true });
        nextPlayer(room); emitState(room); maybeAITurn(room); armSkipTimer(room);
        return;
      }
    } else room.consecutiveSixes = 0;

    const lm = legalMoves(room, player);
    room.legalMoves = lm;
    if (lm.length === 0) {
      emitEvent(room, { kind: 'MOVE_RESULT', player: player.id, dice: dice, noMove: true, six: dice === 6 });
      room.diceValue = null; room.canMove = false;
      if (dice === 6) {
        emitState(room); maybeAITurn(room); armSkipTimer(room);
      } else {
        nextPlayer(room); emitState(room); maybeAITurn(room); armSkipTimer(room);
      }
      return;
    }
    room.canMove = true;
    emitState(room);
    if (player.isAI) {
      if (room.aiTimer) clearTimeout(room.aiTimer);
      room.aiTimer = setTimeout(() => {
        room.aiTimer = null;
        const idx = aiPick(room, player);
        if (idx !== null) doMove(room, player, idx);
      }, 800);
    } else armSkipTimer(room);
  }, 900);
}

function doMove(room, player, idx) {
  if (!room.started || room.paused || room.winner) return;
  if (room.players[room.currentPlayerIndex].id !== player.id) return;
  if (!room.canMove || !room.legalMoves.includes(idx)) return;
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  const dice = room.diceValue;
  const r = executeMove(room, player, idx);
  room.legalMoves = []; room.canMove = false; room.diceValue = null;
  emitEvent(room, {
    kind: 'MOVE_RESULT', player: player.id, dice: dice,
    six: dice === 6, captured: r.captured, home: r.reachedHome,
    capColor: r.capColor, extra: r.extraTurn
  });
  if ((player.completed || 0) >= 4) {
    room.winner = player.id;
    emitEvent(room, { kind: 'WIN', player: player.id });
    emitState(room);
    return;
  }
  if (!r.extraTurn) nextPlayer(room);
  emitState(room);
  maybeAITurn(room);
  armSkipTimer(room);
}

function startGame(room) {
  clearTimers(room);
  room.started = true;
  room.currentPlayerIndex = 0;
  room.diceValue = null; room.isRolling = false; room.canMove = false; room.legalMoves = [];
  room.consecutiveSixes = 0; room.paused = false; room.winner = null;
  for (const pid in room.tokens)
    room.tokens[pid] = [{position:0},{position:0},{position:0},{position:0}];
  room.players.forEach(p => p.completed = 0);
  emitEvent(room, { kind: 'START' });
  emitState(room);
  maybeAITurn(room);
  armSkipTimer(room);
}

// ---------- AI ----------
function aiPick(room, player) {
  const lm = legalMoves(room, player);
  if (!lm.length) return null;
  if (lm.length === 1) return lm[0];
  const tks = room.tokens[player.id], dice = room.diceValue;
  // 1) capture
  for (const i of lm) {
    const t = tks[i];
    const np = t.position === 0 ? 1 : t.position + dice;
    if (np >= 1 && np <= 51 && !isSafe(player.color, np)) {
      const here = tokensAtAbs(room, getAbsPos(player.color, np), player.color);
      if (here.length === 1) return i;
    }
  }
  // 2) reach home
  for (const i of lm) if (tks[i].position + dice === 57) return i;
  // 3) leave base
  if (dice === 6) for (const i of lm) if (tks[i].position === 0) return i;
  // 4) furthest token
  let best = lm[0], bestPos = -1;
  for (const i of lm) {
    const p = tks[i].position === 0 ? -1 : tks[i].position;
    if (p > bestPos) { bestPos = p; best = i; }
  }
  return best;
}

// ---------- HTTP + WS ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(CLIENT_HTML);
});
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const t = m.type;

    if (t === 'CREATE_ROOM') {
      const code = genRoomCode(), pid = genId();
      const room = new Room(code);
      room.addPlayer(pid, m.name);
      rooms.set(code, room);
      playerSocks.set(pid, ws);
      sockInfo.set(ws, { pid, code });
      ws.send(JSON.stringify({ type: 'JOINED', code, pid, state: room.state(true) }));
      return;
    }
    if (t === 'JOIN_ROOM') {
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
      if (room.started) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Game already in progress' }));
      if (room.players.length >= 4) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Room is full' }));
      const pid = genId();
      room.addPlayer(pid, m.name);
      playerSocks.set(pid, ws);
      sockInfo.set(ws, { pid, code: room.code });
      ws.send(JSON.stringify({ type: 'JOINED', code: room.code, pid, state: room.state(pid === room.hostId) }));
      emitState(room);
      return;
    }
    if (t === 'REJOIN') {
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
      const p = room.players.find(x => x.id === m.pid);
      if (!p) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Player not found' }));
      p.connected = true;
      playerSocks.set(m.pid, ws);
      sockInfo.set(ws, { pid: m.pid, code: room.code });
      ws.send(JSON.stringify({ type: 'JOINED', code: room.code, pid: m.pid, state: room.state(p.isHost) }));
      emitState(room);
      armSkipTimer(room);
      return;
    }

    const info = sockInfo.get(ws);
    if (!info) return;
    const room = rooms.get(info.code);
    if (!room) return;
    const me = room.players.find(p => p.id === info.pid);
    if (!me) return;

    switch (t) {
      case 'START_GAME':
        if (info.pid === room.hostId && room.players.length >= 2) startGame(room);
        break;
      case 'ROLL_DICE': doRoll(room, me); break;
      case 'MOVE_TOKEN': doMove(room, me, m.tokenIndex); break;
      case 'CHAT': {
        const msg = String(m.message || '').slice(0, 200).replace(/[<>&]/g, '');
        if (msg) broadcast(room, { type: 'CHAT', name: me.name, color: me.color, message: msg });
        break;
      }
      case 'EMOJI': {
        const e = String(m.emoji || '');
        if (EMOJI_OK.includes(e)) broadcast(room, { type: 'EMOJI', name: me.name, color: me.color, emoji: e });
        break;
      }
      case 'PAUSE':
        if (info.pid === room.hostId && !room.winner) { room.paused = true; clearTimers(room); emitState(room); }
        break;
      case 'RESUME':
        if (info.pid === room.hostId) { room.paused = false; emitState(room); maybeAITurn(room); armSkipTimer(room); }
        break;
      case 'RESTART':
        if (info.pid === room.hostId && room.players.length >= 2) startGame(room);
        break;
      case 'CLOSE_ROOM':
        if (info.pid === room.hostId) {
          clearTimers(room);
          broadcast(room, { type: 'CLOSED' });
          for (const p of room.players) {
            if (p.isAI) continue;
            const s = playerSocks.get(p.id);
            if (s) { try { s.close(); } catch {} }
            playerSocks.delete(p.id);
          }
          rooms.delete(room.code);
        }
        break;
      case 'ADD_AI':
        if (info.pid === room.hostId && !room.started && room.players.length < 4) {
          const names = ['Robo', 'Cyber', 'Nova', 'Pixel', 'Volt', 'Bit', 'Chip', 'Hex'];
          room.addPlayer('ai_' + genId(), names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 100), true);
          emitState(room);
        }
        break;
      case 'KICK_PLAYER':
        if (info.pid === room.hostId && m.pid !== info.pid) {
          const target = room.players.find(p => p.id === m.pid);
          if (!target) break;
          const idx = room.players.indexOf(target);
          const wasCurrent = room.started && room.players[room.currentPlayerIndex] && room.players[room.currentPlayerIndex].id === m.pid;
          const k = playerSocks.get(m.pid);
          if (k) { try { k.send(JSON.stringify({ type: 'KICKED' })); k.close(); } catch {} }
          playerSocks.delete(m.pid);
          room.removePlayer(m.pid);
          if (room.players.length === 0) { clearTimers(room); rooms.delete(room.code); break; }
          if (wasCurrent) {
            room.currentPlayerIndex = idx % room.players.length;
            room.isRolling = false; room.diceValue = null; room.canMove = false; room.legalMoves = [];
          } else if (idx < room.currentPlayerIndex) {
            room.currentPlayerIndex = Math.max(0, room.currentPlayerIndex - 1);
          }
          emitState(room); maybeAITurn(room); armSkipTimer(room);
        }
        break;
      case 'HOST_MOD':
        if (info.pid === room.hostId) {
          if (m.action === 'set') {
            const v = Math.min(6, Math.max(1, parseInt(m.value, 10) || 1));
            const mode = ['next', 'forever', 'count'].includes(m.mode) ? m.mode : 'next';
            const count = Math.min(50, Math.max(1, parseInt(m.count, 10) || 1));
            room.hostMod = { forcedValue: v, mode: mode, remaining: count };
          } else if (m.action === 'clear') {
            room.hostMod = { forcedValue: null, mode: null, remaining: 0 };
          }
          emitState(room);
        }
        break;
    }
  });

  ws.on('close', () => {
    const info = sockInfo.get(ws);
    sockInfo.delete(ws);
    if (!info) return;
    const room = rooms.get(info.code);
    if (!room) return;
    if (playerSocks.get(info.pid) !== ws) return; // superseded connection
    playerSocks.delete(info.pid);
    const p = room.players.find(x => x.id === info.pid);
    if (!p) return;
    p.connected = false;
    if (!room.started) {
      room.removePlayer(info.pid);
      if (room.players.length === 0) { clearTimers(room); rooms.delete(room.code); return; }
      emitState(room);
      return;
    }
    // Host transfer
    if (room.hostId === info.pid) {
      const nxt = room.players.find(x => x.connected && !x.isAI);
      if (nxt) { room.hostId = nxt.id; room.players.forEach(x => x.isHost = (x.id === nxt.id)); }
    }
    emitState(room);
    armSkipTimer(room);
  });
});
