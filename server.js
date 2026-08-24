// ===================================================================
//  Ludo Royale — Authoritative Multiplayer Server
//  Single file: Express + ws + inline HTML/CSS/JS client
// ===================================================================
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

// ---------- Board Geometry (15x15 grid) ----------
const COLORS = ['red', 'green', 'yellow', 'blue'];
const COLOR_HEX = { red: '#ef4444', green: '#22c55e', yellow: '#eab308', blue: '#3b82f6' };
const COLOR_EMOJI = { red: '🔴', green: '🟢', yellow: '🟡', blue: '🔵' };

// 52-cell main track (clockwise from Red start)
const TRACK = [
  [6,1],[6,2],[6,3],[6,4],[6,5],            // 0-4
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],      // 5-10
  [0,7],[0,8],                              // 11-12
  [1,8],                                    // 13 Green start
  [2,8],[3,8],[4,8],[5,8],                  // 14-17
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14], // 18-23
  [7,14],[8,14],                            // 24-25
  [8,13],                                   // 26 Yellow start
  [8,12],[8,11],[8,10],[8,9],               // 27-30
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8], // 31-36
  [14,7],[14,6],                            // 37-38
  [13,6],                                   // 39 Blue start
  [12,6],[11,6],[10,6],[9,6],               // 40-43
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],      // 44-49
  [7,0],[6,0]                               // 50-51
];
const START_POS = { red: 0, green: 13, yellow: 26, blue: 39 };
const HOME_COLUMNS = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5],[7,7]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7],[7,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,7]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7],[7,7]]
};
const SAFE_SQUARES = [0, 8, 13, 21, 26, 34, 39, 47];
// Base slots (4 per color) inside the 6x6 base area
const BASE_SLOTS = {
  red:    [[1.5,1.5],[1.5,3.5],[3.5,1.5],[3.5,3.5]],
  green:  [[1.5,10.5],[1.5,12.5],[3.5,10.5],[3.5,12.5]],
  yellow: [[10.5,10.5],[10.5,12.5],[12.5,10.5],[12.5,12.5]],
  blue:   [[10.5,1.5],[10.5,3.5],[12.5,1.5],[12.5,3.5]]
};

function getAbsPos(color, rel) {
  if (rel < 1 || rel > 51) return -1;
  return (START_POS[color] + rel - 1) % 52;
}
function getCell(color, rel) {
  if (rel === 0) return null;
  if (rel <= 51) return TRACK[getAbsPos(color, rel)];
  if (rel <= 57) return HOME_COLUMNS[color][rel - 52];
  return null;
}
function isSafe(color, rel) {
  if (rel === 0 || rel >= 52) return true;
  return SAFE_SQUARES.includes(getAbsPos(color, rel));
}
function tokensAtAbs(room, abs, excludeColor) {
  const out = [];
  for (const p of room.players) {
    if (excludeColor && p.color === excludeColor) continue;
    const tks = room.tokens[p.id] || [];
    tks.forEach((t, i) => {
      if (t.position >= 1 && t.position <= 51 && getAbsPos(p.color, t.position) === abs) {
        out.push({ player: p, idx: i, token: t });
      }
    });
  }
  return out;
}
function isBlockadedAt(room, abs, excludeColor) {
  for (const p of room.players) {
    if (excludeColor && p.color === excludeColor) continue;
    let c = 0;
    for (const t of (room.tokens[p.id] || [])) {
      if (t.position >= 1 && t.position <= 51 && getAbsPos(p.color, t.position) === abs) c++;
    }
    if (c >= 2) return true;
  }
  return false;
}
function legalMoves(room, player) {
  const out = [];
  const dice = room.diceValue;
  if (!dice) return out;
  const tks = room.tokens[player.id];
  for (let i = 0; i < 4; i++) {
    const t = tks[i];
    if (t.position === 57) continue;
    if (t.position === 0) {
      if (dice === 6) {
        if (!isBlockadedAt(room, START_POS[player.color], player.color)) out.push(i);
      }
      continue;
    }
    const np = t.position + dice;
    if (np > 57) continue;
    let blocked = false;
    for (let p = t.position + 1; p <= np; p++) {
      if (p <= 51) {
        if (isBlockadedAt(room, getAbsPos(player.color, p), player.color)) { blocked = true; break; }
      }
    }
    if (!blocked) out.push(i);
  }
  return out;
}
function executeMove(room, player, idx) {
  const t = room.tokens[player.id][idx];
  const dice = room.diceValue;
  let captured = false, reachedHome = false, capColor = null;
  if (t.position === 0) t.position = 1;
  else t.position += dice;
  if (t.position >= 1 && t.position <= 51 && !isSafe(player.color, t.position)) {
    const abs = getAbsPos(player.color, t.position);
    const here = tokensAtAbs(room, abs, player.color);
    if (here.length === 1) {
      here[0].token.position = 0;
      captured = true;
      capColor = here[0].player.color;
    }
  }
  if (t.position === 57) {
    reachedHome = true;
    player.completed = (player.completed || 0) + 1;
  }
  // THE rule: ONE extra roll for any of the three reasons
  const extraTurn = (dice === 6) || captured || reachedHome;
  return { captured, reachedHome, extraTurn, capColor };
}
function nextPlayer(room) {
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (room.currentPlayerIndex + i) % n;
    if ((room.players[idx].completed || 0) >= 4) continue;
    room.currentPlayerIndex = idx;
    return;
  }
  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % n;
}
function rollValue(room) {
  const m = room.hostMod;
  if (m.forcedValue != null) {
    if (m.mode === 'next') { const v = m.forcedValue; m.forcedValue = null; m.mode = null; return v; }
    if (m.mode === 'forever') return m.forcedValue;
    if (m.mode === 'count') { m.remaining--; if (m.remaining <= 0) { m.forcedValue = null; m.mode = null; } return m.forcedValue; }
  }
  return 1 + Math.floor(Math.random() * 6);
}
function genRoomCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function genId() { return crypto.randomBytes(8).toString('hex'); }

// ---------- Room ----------
class Room {
  constructor(code) {
    this.code = code;
    this.hostId = null;
    this.players = [];
    this.tokens = {};
    this.started = false;
    this.currentPlayerIndex = 0;
    this.diceValue = null;
    this.isRolling = false;
    this.canMove = false;
    this.legalMoves = [];
    this.consecutiveSixes = 0;
    this.paused = false;
    this.winner = null;
    this.hostMod = { forcedValue: null, mode: null, remaining: 0 };
    this.lastEvent = null;
    this.eventSeq = 0;
  }
  addPlayer(id, name, isAI = false) {
    if (this.players.length >= 4) return null;
    const color = COLORS[this.players.length];
    const p = {
      id, name: (name && name.trim()) || color.charAt(0).toUpperCase() + color.slice(1),
      color, isHost: false, isAI, connected: !isAI, completed: 0
    };
    this.players.push(p);
    this.tokens[id] = [{position: 0},{position: 0},{position: 0},{position: 0}];
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
    } else if (this.players.length === 0) {
      this.hostId = null;
    }
    if (this.currentPlayerIndex >= this.players.length) this.currentPlayerIndex = 0;
  }
  state() {
    return {
      code: this.code, hostId: this.hostId,
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost,
        isAI: p.isAI, connected: p.connected, completed: p.completed || 0
      })),
      started: this.started,
      currentPlayerIndex: this.currentPlayerIndex,
      diceValue: this.diceValue, isRolling: this.isRolling,
      canMove: this.canMove, legalMoves: this.legalMoves,
      consecutiveSixes: this.consecutiveSixes,
      paused: this.paused, winner: this.winner,
      hostMod: this.hostMod,
      tokens: this.tokens,
      lastEvent: this.lastEvent, eventSeq: this.eventSeq
    };
  }
}

// ---------- Globals ----------
const rooms = new Map();
const playerSocks = new Map(); // pid -> ws
const sockInfo = new Map();    // ws -> {pid, code}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const p of room.players) {
    if (p.isAI) continue;
    const ws = playerSocks.get(p.id);
    if (ws && ws.readyState === 1) ws.send(msg);
  }
}
function emitState(room) { broadcast(room, { type: 'STATE', state: room.state() }); }
function emitEvent(room, ev) {
  ev.seq = ++room.eventSeq;
  room.lastEvent = ev;
  broadcast(room, { type: 'EVENT', event: ev });
}

// ---------- Game flow ----------
function doRoll(room, player) {
  if (room.paused || room.isRolling || room.canMove || room.winner) return;
  if (room.players[room.currentPlayerIndex].id !== player.id) return;
  room.isRolling = true;
  emitState(room);
  setTimeout(() => {
    const dice = rollValue(room);
    room.diceValue = dice;
    room.isRolling = false;
    if (dice === 6) {
      room.consecutiveSixes++;
      if (room.consecutiveSixes >= 3) {
        room.consecutiveSixes = 0;
        room.diceValue = null;
        room.canMove = false;
        emitEvent(room, { kind: 'THREE_SIXES', player: player.id });
        nextPlayer(room);
        emitState(room);
        maybeAITurn(room);
        return;
      }
    } else {
      room.consecutiveSixes = 0;
    }
    const lm = legalMoves(room, player);
    room.legalMoves = lm;
    if (lm.length === 0) {
      emitEvent(room, { kind: 'NO_MOVE', player: player.id });
      const extra = (dice === 6);
      room.diceValue = null;
      room.canMove = false;
      if (!extra) {
        nextPlayer(room);
        emitState(room);
        maybeAITurn(room);
      } else {
        emitState(room);
        if (player.isAI) setTimeout(() => doRoll(room, player), 900);
      }
      return;
    }
    room.canMove = true;
    emitState(room);
    if (player.isAI) {
      setTimeout(() => {
        const idx = aiPick(room, player);
        if (idx !== null) doMove(room, player, idx);
      }, 700);
    }
  }, 850);
}

function doMove(room, player, idx) {
  if (room.paused || !room.canMove || room.winner) return;
  if (room.players[room.currentPlayerIndex].id !== player.id) return;
  if (!room.legalMoves.includes(idx)) return;
  const r = executeMove(room, player, idx);
  room.legalMoves = [];
  room.canMove = false;
  room.diceValue = null;
  if (r.captured) emitEvent(room, { kind: 'CAPTURE', player: player.id, captured: r.capColor });
  if (r.reachedHome) emitEvent(room, { kind: 'HOME', player: player.id });
  if ((player.completed || 0) >= 4) {
    room.winner = player.id;
    emitEvent(room, { kind: 'WIN', player: player.id });
    emitState(room);
    return;
  }
  if (r.extraTurn) {
    let reason = 'SIX';
    if (r.captured) reason = 'CAPTURE';
    else if (r.reachedHome) reason = 'HOME';
    emitEvent(room, { kind: 'EXTRA', player: player.id, reason });
    emitState(room);
    if (player.isAI) setTimeout(() => doRoll(room, player), 900);
  } else {
    nextPlayer(room);
    emitState(room);
    maybeAITurn(room);
  }
}

function maybeAITurn(room) {
  const cur = room.players[room.currentPlayerIndex];
  if (cur && cur.isAI && !room.winner && !room.paused) {
    setTimeout(() => doRoll(room, cur), 800);
  }
}

function startGame(room) {
  room.started = true;
  room.currentPlayerIndex = 0;
  room.diceValue = null;
  room.isRolling = false;
  room.canMove = false;
  room.legalMoves = [];
  room.consecutiveSixes = 0;
  room.paused = false;
  room.winner = null;
  for (const pid in room.tokens) {
    room.tokens[pid] = [{position: 0},{position: 0},{position: 0},{position: 0}];
  }
  room.players.forEach(p => p.completed = 0);
  emitEvent(room, { kind: 'START' });
  emitState(room);
  maybeAITurn(room);
}

// ---------- AI ----------
function aiPick(room, player) {
  const lm = legalMoves(room, player);
  if (!lm.length) return null;
  if (lm.length === 1) return lm[0];
  const tks = room.tokens[player.id];
  const dice = room.diceValue;
  // 1) capture
  for (const i of lm) {
    const t = tks[i];
    const np = t.position === 0 ? 1 : t.position + dice;
    if (np >= 1 && np <= 51 && !isSafe(player.color, np)) {
      const abs = getAbsPos(player.color, np);
      const here = tokensAtAbs(room, abs, player.color);
      if (here.length === 1) return i;
    }
  }
  // 2) reach home
  for (const i of lm) if (tks[i].position + dice === 57) return i;
  // 3) leave base on 6
  if (dice === 6) for (const i of lm) if (tks[i].position === 0) return i;
  // 4) furthest along (closest to home)
  let best = lm[0], bestPos = -1;
  for (const i of lm) {
    const p = tks[i].position === 0 ? -1 : tks[i].position;
    if (p > bestPos) { bestPos = p; best = i; }
  }
  return best;
}

// ---------- WebSocket ----------
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
      const code = genRoomCode();
      const pid = genId();
      const room = new Room(code);
      room.addPlayer(pid, m.name);
      rooms.set(code, room);
      playerSocks.set(pid, ws);
      sockInfo.set(ws, { pid, code });
      ws.send(JSON.stringify({ type: 'JOINED', code, pid, state: room.state() }));
      return;
    }
    if (t === 'JOIN_ROOM') {
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
      if (room.players.length >= 4) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Room is full' }));
      const pid = genId();
      room.addPlayer(pid, m.name);
      playerSocks.set(pid, ws);
      sockInfo.set(ws, { pid, code: room.code });
      ws.send(JSON.stringify({ type: 'JOINED', code: room.code, pid, state: room.state() }));
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
      ws.send(JSON.stringify({ type: 'JOINED', code: room.code, pid: m.pid, state: room.state() }));
      emitState(room);
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
        const msg = String(m.message || '').slice(0, 200).replace(/[<>]/g, '');
        broadcast(room, { type: 'CHAT', pid: info.pid, name: me.name, color: me.color, message: msg });
        break;
      }
      case 'EMOJI': {
        const e = String(m.emoji || '').slice(0, 4);
        broadcast(room, { type: 'EMOJI', pid: info.pid, name: me.name, color: me.color, emoji: e });
        break;
      }
      case 'PAUSE': if (info.pid === room.hostId) { room.paused = true; emitState(room); } break;
      case 'RESUME': if (info.pid === room.hostId) { room.paused = false; emitState(room); maybeAITurn(room); } break;
      case 'RESTART': if (info.pid === room.hostId) startGame(room); break;
      case 'CLOSE_ROOM':
        if (info.pid === room.hostId) {
          broadcast(room, { type: 'CLOSED' });
          for (const p of room.players) {
            if (p.isAI) continue;
            const s = playerSocks.get(p.id);
            if (s) try { s.close(); } catch {}
          }
          rooms.delete(room.code);
        }
        break;
      case 'ADD_AI':
        if (info.pid === room.hostId && room.players.length < 4 && !room.started) {
          const names = ['Robo','Cyber','Hex','Nova','Pixel','Bit','Chip','Volt'];
          room.addPlayer('ai_' + genId(), names[Math.floor(Math.random()*names.length)] + Math.floor(Math.random()*100), true);
          emitState(room);
        }
        break;
      case 'KICK_PLAYER':
        if (info.pid === room.hostId && m.pid !== info.pid) {
          const k = playerSocks.get(m.pid);
          if (k) { try { k.send(JSON.stringify({ type: 'KICKED' })); k.close(); } catch {} }
          room.removePlayer(m.pid);
          playerSocks.delete(m.pid);
          emitState(room);
        }
        break;
      case 'HOST_MOD':
        if (info.pid === room.hostId) {
          if (m.action === 'set') {
            room.hostMod = { forcedValue: m.value, mode: m.mode, remaining: m.count || 0 };
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
    if (!info) return;
    const room = rooms.get(info.code);
    if (room) {
      const p = room.players.find(x => x.id === info.pid);
      if (p) {
        p.connected = false;
        if (!room.started) {
          room.removePlayer(info.pid);
          playerSocks.delete(info.pid);
        } else if (room.hostId === info.pid) {
          // Host transfer
          const next = room.players.find(x => x.connected && !x.isAI);
          if (next) {
            room.hostId = next.id;
            room.players.forEach(x => x.isHost = (x.id === next.id));
          }
        }
        emitState(room);
      }
    }
    sockInfo.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ludo Royale listening on ' + PORT));

// ===================================================================
//  CLIENT (HTML/CSS/JS inlined)
// ===================================================================
const CLIENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Ludo Royale</title>
<style>
  :root{
    --bg:#0a0b16; --surface:#14162a; --elev:#1d2040; --border:rgba(255,255,255,0.08);
    --txt:#f0f2ff; --mut:#8a8fa8; --gold:#f5b342; --gold-glow:#ffd166;
    --red:#ef4444; --green:#22c55e; --yellow:#eab308; --blue:#3b82f6;
  }
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt);overflow:hidden}
  body{
    background:
      radial-gradient(1200px 600px at 10% 0%, rgba(245,179,66,0.08), transparent 60%),
      radial-gradient(1000px 500px at 90% 100%, rgba(59,130,246,0.08), transparent 60%),
      var(--bg);
  }
  button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
  input{font-family:inherit}
  .hidden{display:none !important}
  .screen{position:fixed;inset:0;display:flex;flex-direction:column}

  /* ---------- LOBBY ---------- */
  #lobby{align-items:center;justify-content:center;padding:24px;overflow:auto}
  .lobby-card{
    width:min(440px,92vw);background:linear-gradient(180deg,var(--surface),var(--bg));
    border:1px solid var(--border);border-radius:24px;padding:36px 28px;
    box-shadow:0 30px 80px -20px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04);
  }
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:6px}
  .brand .dot{width:14px;height:14px;border-radius:50%;background:var(--gold);box-shadow:0 0 18px var(--gold-glow)}
  .brand h1{font-size:30px;font-weight:900;letter-spacing:-0.5px}
  .tag{color:var(--mut);font-size:14px;margin-bottom:24px}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--mut);margin-bottom:6px}
  .field input{
    width:100%;padding:14px 16px;background:var(--bg);border:1px solid var(--border);
    border-radius:12px;color:var(--txt);font-size:15px;outline:none;transition:border .15s;
  }
  .field input:focus{border-color:var(--gold)}
  .btn{
    width:100%;padding:15px;border-radius:12px;font-size:15px;font-weight:700;
    background:linear-gradient(180deg,var(--gold),#d9921f);color:#1a1100;
    box-shadow:0 8px 24px -6px rgba(245,179,66,0.5);transition:transform .1s;
  }
  .btn:hover{transform:translateY(-1px)}
  .btn:active{transform:translateY(0)}
  .btn.secondary{background:var(--elev);color:var(--txt);box-shadow:none;border:1px solid var(--border)}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
  .divider{display:flex;align-items:center;gap:12px;color:var(--mut);font-size:12px;margin:20px 0}
  .divider:before,.divider:after{content:'';height:1px;background:var(--border);flex:1}
  .err{color:#ff6b6b;font-size:13px;margin-top:10px;min-height:18px}

  /* ---------- GAME ---------- */
  #game{display:grid;grid-template-rows:auto 1fr auto;height:100vh;height:100dvh}
  .topbar{
    display:flex;align-items:center;justify-content:space-between;padding:10px 14px;
    background:linear-gradient(180deg,rgba(0,0,0,0.4),transparent);border-bottom:1px solid var(--border);
    gap:8px;flex-wrap:wrap
  }
  .topbar .left,.topbar .right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .code-chip{
    display:flex;align-items:center;gap:6px;padding:7px 12px;background:var(--elev);
    border:1px solid var(--border);border-radius:10px;font-weight:700;letter-spacing:2px;font-size:13px
  }
  .icon-btn{
    width:38px;height:38px;border-radius:10px;background:var(--elev);border:1px solid var(--border);
    display:grid;place-items:center;font-size:16px;transition:background .15s
  }
  .icon-btn:hover{background:#2a2e55}
  .icon-btn.on{color:var(--gold)}

  .stage{position:relative;display:grid;place-items:center;padding:8px;overflow:hidden}
  .stage-inner{
    position:relative;width:min(94vh,94vw,680px);aspect-ratio:1;
    display:grid;grid-template-columns:repeat(15,1fr);grid-template-rows:repeat(15,1fr);
    background:linear-gradient(135deg,#0e0f1c,#181a30);
    border-radius:16px;border:1px solid var(--border);
    box-shadow:0 30px 80px -20px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.02);
  }
  .cell{position:relative;border:0.5px solid rgba(255,255,255,0.025)}
  .cell.track{background:rgba(255,255,255,0.04)}
  .cell.safe::after{content:'★';position:absolute;inset:0;display:grid;place-items:center;color:rgba(255,255,255,0.32);font-size:14px}
  .cell.red-start{background:rgba(239,68,68,0.35)}
  .cell.green-start{background:rgba(34,197,94,0.35)}
  .cell.yellow-start{background:rgba(234,179,8,0.35)}
  .cell.blue-start{background:rgba(59,130,246,0.35)}
  .cell.home-red{background:linear-gradient(90deg,rgba(239,68,68,0.55),rgba(239,68,68,0.25))}
  .cell.home-green{background:linear-gradient(180deg,rgba(34,197,94,0.55),rgba(34,197,94,0.25))}
  .cell.home-yellow{background:linear-gradient(90deg,rgba(234,179,8,0.25),rgba(234,179,8,0.55))}
  .cell.home-blue{background:linear-gradient(0deg,rgba(59,130,246,0.25),rgba(59,130,246,0.55))}
  .base-red{background:linear-gradient(135deg,rgba(239,68,68,0.18),rgba(239,68,68,0.05));border-radius:8px 0 0 0}
  .base-green{background:linear-gradient(225deg,rgba(34,197,94,0.18),rgba(34,197,94,0.05));border-radius:0 8px 0 0}
  .base-yellow{background:linear-gradient(315deg,rgba(234,179,8,0.18),rgba(234,179,8,0.05));border-radius:0 0 8px 0}
  .base-blue{background:linear-gradient(45deg,rgba(59,130,246,0.18),rgba(59,130,246,0.05));border-radius:0 0 0 8px}
  .base-slot{
    position:absolute;width:5.5%;height:5.5%;border-radius:50%;
    border:2px solid rgba(255,255,255,0.5);
    transform:translate(-50%,-50%);pointer-events:none
  }
  .center-tri{
    grid-row:7/10;grid-column:7/10;
    background:
      conic-gradient(from 0deg,
        rgba(239,68,68,0.6) 0deg 90deg,
        rgba(34,197,94,0.6) 90deg 180deg,
        rgba(234,179,8,0.6) 180deg 270deg,
        rgba(59,130,246,0.6) 270deg 360deg);
    clip-path:polygon(50% 50%,100% 0,100% 100%,0 100%,0 0);
    border-radius:4px;
  }
  .center-glow{
    grid-row:7/10;grid-column:7/10;
    display:grid;place-items:center;
    font-size:18px;color:rgba(255,255,255,0.9);
    text-shadow:0 0 12px rgba(255,255,255,0.6);
    pointer-events:none;z-index:2
  }

  /* Tokens */
  .token{
    position:absolute;width:5.6%;height:5.6%;border-radius:50%;
    transform:translate(-50%,-50%);
    transition:left .35s ease, top .35s ease;
    z-index:5;cursor:default;
    box-shadow:0 4px 8px rgba(0,0,0,0.5), inset 0 -3px 6px rgba(0,0,0,0.3), inset 0 3px 4px rgba(255,255,255,0.5);
    border:2px solid rgba(255,255,255,0.7);
  }
  .token.red{background:radial-gradient(circle at 30% 30%,#ff6b6b,#c81e1e)}
  .token.green{background:radial-gradient(circle at 30% 30%,#4ade80,#15803d)}
  .token.yellow{background:radial-gradient(circle at 30% 30%,#fde047,#a16207)}
  .token.blue{background:radial-gradient(circle at 30% 30%,#60a5fa,#1d4ed8)}
  .token.movable{cursor:pointer;animation:pulse 1s infinite;z-index:6}
  .token.movable::after{
    content:'';position:absolute;inset:-30%;border-radius:50%;
    border:2px solid var(--gold-glow);animation:ringPulse 1s infinite;
  }
  .token.dim{opacity:0.55;filter:saturate(0.5)}
  .token.home-locked{box-shadow:0 0 16px var(--gold-glow),0 4px 8px rgba(0,0,0,0.5)}

  @keyframes pulse{0%,100%{transform:translate(-50%,-50%) scale(1)}50%{transform:translate(-50%,-50%) scale(1.12)}}
  @keyframes ringPulse{0%{transform:scale(0.8);opacity:1}100%{transform:scale(1.3);opacity:0}}

  /* Dice */
  .dice-zone{
    position:absolute;display:flex;flex-direction:column;align-items:center;gap:8px;
    transition:left .5s ease, top .5s ease;z-index:10;
  }
  .dice{
    width:64px;height:64px;border-radius:14px;position:relative;
    background:linear-gradient(135deg,#fff,#d8d8e0);
    box-shadow:0 8px 20px rgba(0,0,0,0.5), inset 0 -4px 6px rgba(0,0,0,0.15), inset 0 4px 6px rgba(255,255,255,0.8);
    display:grid;place-items:center;font-size:34px;font-weight:900;color:#222;
    transition:transform .15s;
  }
  .dice.rolling{animation:roll .6s linear infinite}
  .dice.disabled{opacity:0.5;cursor:not-allowed}
  .dice.active{cursor:pointer;box-shadow:0 8px 20px var(--gold-glow),inset 0 -4px 6px rgba(0,0,0,0.15),inset 0 4px 6px rgba(255,255,255,0.8)}
  .dice.active:hover{transform:translateY(-2px)}
  @keyframes roll{
    0%{transform:rotateX(0)rotateY(0)rotateZ(0)}
    25%{transform:rotateX(180deg)rotateY(90deg)rotateZ(45deg)}
    50%{transform:rotateX(360deg)rotateY(180deg)rotateZ(90deg)}
    75%{transform:rotateX(180deg)rotateY(270deg)rotateZ(135deg)}
    100%{transform:rotateX(0)rotateY(360deg)rotateZ(0)}
  }
  .turn-label{
    padding:6px 14px;border-radius:20px;background:rgba(0,0,0,0.6);border:1px solid var(--border);
    font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;white-space:nowrap
  }

  /* Player cards */
  .players{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px 10px 4px}
  .pcard{
    background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:8px 10px;
    display:flex;align-items:center;gap:8px;position:relative;transition:all .25s;
    min-width:0
  }
  .pcard .avatar{
    width:28px;height:28px;border-radius:50%;flex-shrink:0;
    box-shadow:inset 0 -2px 3px rgba(0,0,0,0.3),inset 0 2px 3px rgba(255,255,255,0.4);
    border:2px solid rgba(255,255,255,0.4);
  }
  .pcard .info{min-width:0;flex:1}
  .pcard .info .nm{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pcard .info .st{font-size:10px;color:var(--mut);letter-spacing:0.5px}
  .pcard .crown{position:absolute;top:-6px;right:-4px;font-size:14px;filter:drop-shadow(0 0 4px var(--gold-glow))}
  .pcard.red{border-color:rgba(239,68,68,0.4)}
  .pcard.green{border-color:rgba(34,197,94,0.4)}
  .pcard.yellow{border-color:rgba(234,179,8,0.4)}
  .pcard.blue{border-color:rgba(59,130,246,0.4)}
  .pcard.red .avatar{background:radial-gradient(circle at 30% 30%,#ff6b6b,#c81e1e)}
  .pcard.green .avatar{background:radial-gradient(circle at 30% 30%,#4ade80,#15803d)}
  .pcard.yellow .avatar{background:radial-gradient(circle at 30% 30%,#fde047,#a16207)}
  .pcard.blue .avatar{background:radial-gradient(circle at 30% 30%,#60a5fa,#1d4ed8)}
  .pcard.active{
    transform:translateY(-2px);
    box-shadow:0 0 0 1px var(--gold),0 0 24px rgba(245,179,66,0.45);
  }
  .pcard.active.red{box-shadow:0 0 0 1px #ef4444,0 0 24px rgba(239,68,68,0.5)}
  .pcard.active.green{box-shadow:0 0 0 1px #22c55e,0 0 24px rgba(34,197,94,0.5)}
  .pcard.active.yellow{box-shadow:0 0 0 1px #eab308,0 0 24px rgba(234,179,8,0.5)}
  .pcard.active.blue{box-shadow:0 0 0 1px #3b82f6,0 0 24px rgba(59,130,246,0.5)}
  .pcard .disc{font-size:18px;color:var(--mut)}
  .pcard .disc.has{color:var(--txt)}
  .pcard.won{background:linear-gradient(135deg,rgba(245,179,66,0.25),transparent)}

  /* Bottom bar */
  .bottombar{display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--border);background:rgba(0,0,0,0.3)}
  .chat-panel{
    flex:1;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);
    border-radius:12px;overflow:hidden;max-height:160px;min-height:80px
  }
  .chat-msgs{flex:1;overflow-y:auto;padding:8px 10px;font-size:13px;display:flex;flex-direction:column;gap:4px}
  .chat-msgs .m .n{font-weight:700;margin-right:6px}
  .chat-msgs .m .t{color:var(--mut)}
  .chat-input{
    display:flex;border-top:1px solid var(--border);
  }
  .chat-input input{
    flex:1;background:transparent;border:none;padding:8px 10px;color:var(--txt);font-size:13px;outline:none
  }
  .emoji-row{
    display:flex;gap:4px;padding:6px;overflow-x:auto;border-top:1px solid var(--border);
  }
  .emoji-row button{
    font-size:18px;padding:4px 6px;border-radius:6px;flex-shrink:0;transition:background .1s
  }
  .emoji-row button:hover{background:var(--elev)}

  /* Floating emojis */
  .float-layer{position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden}
  .float-emoji{
    position:absolute;font-size:48px;animation:floatUp 3s ease-out forwards;
    text-shadow:0 0 12px rgba(0,0,0,0.6);
  }
  @keyframes floatUp{
    0%{opacity:0;transform:translateY(0) scale(0.5)}
    15%{opacity:1;transform:translateY(-10px) scale(1.2)}
    100%{opacity:0;transform:translateY(-260px) scale(1) rotate(20deg)}
  }

  /* Toasts */
  .toasts{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:80;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
  .toast{
    padding:8px 18px;background:rgba(0,0,0,0.85);border:1px solid var(--gold);
    border-radius:30px;font-size:13px;font-weight:700;letter-spacing:0.5px;
    box-shadow:0 8px 24px rgba(0,0,0,0.5);
    animation:toastIn .3s ease,toastOut .3s ease 2.2s forwards;
  }
  @keyframes toastIn{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:translateY(0)}}
  @keyframes toastOut{to{opacity:0;transform:translateY(-12px)}}

  /* Modals */
  .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);display:grid;place-items:center;z-index:100;padding:16px}
  .modal{
    width:min(420px,92vw);background:var(--surface);border:1px solid var(--border);
    border-radius:18px;padding:24px;box-shadow:0 30px 80px rgba(0,0,0,0.6);
  }
  .modal h2{font-size:18px;margin-bottom:6px}
  .modal .sub{color:var(--mut);font-size:13px;margin-bottom:18px}
  .modal .group{margin-bottom:14px}
  .modal .group label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--mut);margin-bottom:6px}
  .seg{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}
  .seg button{
    padding:10px;background:var(--elev);border:1px solid var(--border);border-radius:8px;
    font-size:16px;font-weight:700;color:var(--txt);transition:all .15s
  }
  .seg button.sel{background:var(--gold);color:#1a1100;border-color:var(--gold)}
  .seg3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  .seg3 button{padding:8px;background:var(--elev);border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:700}
  .seg3 button.sel{background:var(--gold);color:#1a1100;border-color:var(--gold)}
  .num-input{display:flex;gap:6px;align-items:center}
  .num-input input{width:60px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--txt);text-align:center;font-size:14px}
  .modal-actions{display:flex;gap:8px;margin-top:18px}
  .modal-actions .btn{flex:1}
  .host-list{display:flex;flex-direction:column;gap:6px;margin-top:10px}
  .host-list .item{
    display:flex;justify-content:space-between;align-items:center;
    padding:8px 12px;background:var(--elev);border-radius:8px;font-size:13px
  }
  .host-list .item .kick{padding:4px 10px;background:#ff3b3b;color:#fff;border-radius:6px;font-size:11px;font-weight:700}

  /* Win screen */
  .win-card{text-align:center;padding:20px}
  .win-card .trophy{font-size:64px;animation:bounce 1s ease infinite}
  @keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
  .win-card h2{font-size:26px;margin:10px 0}
  .stats{margin:14px 0;font-size:13px;color:var(--mut);line-height:1.7}
  .stats div{display:flex;justify-content:space-between;padding:2px 0}

  /* Confetti */
  #confetti{position:fixed;inset:0;pointer-events:none;z-index:60}

  /* Pause overlay */
  .pause-ov{position:absolute;inset:0;background:rgba(0,0,0,0.6);display:grid;place-items:center;z-index:30;backdrop-filter:blur(2px)}
  .pause-ov .msg{font-size:16px;font-weight:800;letter-spacing:1px;padding:14px 28px;border:1px solid var(--gold);background:rgba(0,0,0,0.7);border-radius:14px}

  @media (max-width:520px){
    .players{grid-template-columns:repeat(2,1fr)}
    .pcard{padding:6px 8px}
    .pcard .info .nm{font-size:11px}
    .dice{width:54px;height:54px;font-size:28px}
    .bottombar{flex-direction:column}
    .chat-panel{max-height:120px}
    .brand h1{font-size:24px}
  }
</style>
</head>
<body>

<!-- ===================== LOBBY ===================== -->
<div id="lobby" class="screen">
  <div class="lobby-card">
    <div class="brand"><div class="dot"></div><h1>Ludo Royale</h1></div>
    <div class="tag">Authoritative multiplayer • Host mods • Chat • Emojis</div>
    <div class="field">
      <label>Your Name</label>
      <input id="nameInput" maxlength="14" placeholder="e.g. Harsh" autocomplete="off">
    </div>
    <button class="btn" id="createBtn">Create Room</button>
    <div class="divider">OR</div>
    <div class="field">
      <label>Room Code</label>
      <input id="codeInput" maxlength="6" placeholder="A7K92P" autocomplete="off" style="text-transform:uppercase;letter-spacing:2px">
    </div>
    <button class="btn secondary" id="joinBtn">Join Room</button>
    <div class="err" id="err"></div>
  </div>
</div>

<!-- ===================== GAME ===================== -->
<div id="game" class="screen hidden">
  <div class="topbar">
    <div class="left">
      <div class="code-chip"><span>ROOM</span><span id="roomCodeDisp">------</span></div>
      <button class="icon-btn" id="copyBtn" title="Copy invite link">🔗</button>
    </div>
    <div class="right">
      <button class="icon-btn on" id="soundBtn" title="Sound">🔊</button>
      <button class="icon-btn" id="hostBtn" title="Host menu" style="display:none">👑</button>
      <button class="icon-btn" id="leaveBtn" title="Leave">🚪</button>
    </div>
  </div>

  <div class="players" id="players"></div>

  <div class="stage">
    <div class="stage-inner" id="board">
      <div class="center-tri"></div>
      <div class="center-glow">🏆</div>
    </div>
    <div class="dice-zone" id="diceZone" style="left:50%;top:50%;transform:translate(-50%,-50%)">
      <div class="turn-label" id="turnLabel">Waiting...</div>
      <div class="dice" id="dice">?</div>
    </div>
    <div class="pause-ov hidden" id="pauseOv"><div class="msg">⏸️ GAME PAUSED BY HOST</div></div>
  </div>

  <div class="bottombar">
    <div class="chat-panel">
      <div class="chat-msgs" id="chatMsgs"></div>
      <div class="emoji-row" id="emojiRow"></div>
      <div class="chat-input">
        <input id="chatInput" maxlength="200" placeholder="Type a message..." autocomplete="off">
      </div>
    </div>
  </div>
</div>

<div class="float-layer" id="floatLayer"></div>
<div class="toasts" id="toasts"></div>
<canvas id="confetti" class="hidden"></canvas>

<script>
// ============== CLIENT ==============
const EMOJIS = ['😂','😎','😱','👏','🔥','❤️','👍','🎉','😭','🤣','😮','👀'];
const $ = id => document.getElementById(id);
const uid = () => localStorage.getItem('ludo_pid') || (localStorage.setItem('ludo_pid', randHex()), localStorage.getItem('ludo_pid'));
function randHex(){const c='abcdef0123456789';let s='';for(let i=0;i<16;i++)s+=c[Math.floor(Math.random()*16)];return s}

let ws = null;
let state = null;
let myPid = null;
let myCode = null;
let isHost = false;
let soundOn = true;
let lastEventSeq = 0;

// ---------- Sound (Web Audio) ----------
let actx = null;
function beep(freq, dur, type='sine', vol=0.15){
  if(!soundOn) return;
  try{
    if(!actx) actx = new (window.AudioContext||window.webkitAudioContext)();
    const o = actx.createOsc(); const g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  }catch(e){}
}
const sRoll = ()=>{beep(180,0.4,'sawtooth',0.08);setTimeout(()=>beep(220,0.3,'sawtooth',0.08),200)};
const sMove = ()=>beep(440,0.12,'sine',0.1);
const sCap  = ()=>{beep(300,0.2,'square',0.15);setTimeout(()=>beep(150,0.3,'square',0.15),150)};
const sHome = ()=>{beep(523,0.1);setTimeout(()=>beep(659,0.1),100);setTimeout(()=>beep(784,0.2),200)};
const sSix  = ()=>{beep(660,0.15,'triangle',0.12);setTimeout(()=>beep(880,0.2,'triangle',0.12),150)};
const sWin  = ()=>{[523,659,784,1047].forEach((f,i)=>setTimeout(()=>beep(f,0.3,'triangle',0.15),i*200))};

// ---------- Lobby ----------
function init(){
  // Prefill room code from URL
  const params = new URLSearchParams(location.search);
  const r = params.get('room');
  if(r){ $('codeInput').value = r.toUpperCase(); }
  const n = localStorage.getItem('ludo_name');
  if(n) $('nameInput').value = n;

  $('createBtn').onclick = ()=>{
    const name = $('nameInput').value.trim() || 'Player';
    localStorage.setItem('ludo_name', name);
    connect({type:'CREATE_ROOM', name});
  };
  $('joinBtn').onclick = ()=>{
    const name = $('nameInput').value.trim() || 'Player';
    const code = $('codeInput').value.trim().toUpperCase();
    if(!code){ err('Enter a room code'); return; }
    localStorage.setItem('ludo_name', name);
    connect({type:'JOIN_ROOM', name, code});
  };
  $('codeInput').oninput = e => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
}
function err(m){ $('err').textContent = m; setTimeout(()=>{ if($('err').textContent===m) $('err').textContent=''; }, 3000); }

function connect(msg){
  if(ws){ try{ ws.close(); }catch{} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onopen = ()=> ws.send(JSON.stringify(msg));
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose = ()=> setTimeout(()=>{ if(state) connect({type:'REJOIN', pid:myPid, code:myCode}); }, 1500);
  ws.onerror = ()=> err('Connection error');
}

function onMsg(m){
  if(m.type === 'JOINED'){
    myPid = m.pid; myCode = m.code;
    if(history.replaceState) history.replaceState({}, '', '?room=' + m.code);
    state = m.state;
    enterGame();
    renderAll();
  } else if(m.type === 'STATE'){
    state = m.state;
    renderAll();
  } else if(m.type === 'EVENT'){
    handleEvent(m.event);
  } else if(m.type === 'CHAT'){
    addChat(m.name, m.color, m.message, false);
  } else if(m.type === 'EMOJI'){
    showEmoji(m.name, m.color, m.emoji);
  } else if(m.type === 'CLOSED'){
    alert('🚪 ROOM CLOSED BY HOST');
    backToLobby();
  } else if(m.type === 'KICKED'){
    alert('You were kicked by the host');
    backToLobby();
  } else if(m.type === 'ERROR'){
    err(m.message);
  }
}

function enterGame(){
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('roomCodeDisp').textContent = state.code;
  isHost = (state.hostId === myPid);
  $('hostBtn').style.display = isHost ? 'grid' : 'none';
  buildBoard();
  buildEmojiRow();
  // Bind dice click
  $('dice').onclick = tryRoll;
  $('chatInput').onkeydown = e => {
    if(e.key === 'Enter'){
      const v = $('chatInput').value.trim();
      if(v){ ws.send(JSON.stringify({type:'CHAT', message:v})); $('chatInput').value=''; }
    }
  };
  $('copyBtn').onclick = ()=>{
    const link = location.origin + '/?room=' + state.code;
    if(navigator.clipboard) navigator.clipboard.writeText(link);
    toast('Invite link copied!');
  };
  $('soundBtn').onclick = ()=>{
    soundOn = !soundOn;
    $('soundBtn').classList.toggle('on', soundOn);
    $('soundBtn').textContent = soundOn ? '🔊' : '🔇';
  };
  $('leaveBtn').onclick = ()=>{ if(confirm('Leave the room?')) backToLobby(); };
  if(isHost){
    $('hostBtn').onclick = openHostMenu;
  }
  $('pauseOv').onclick = ()=>{};
}

function backToLobby(){
  try{ ws.close(); }catch{}
  state = null; myCode = null;
  $('game').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  if(history.replaceState) history.replaceState({}, '', location.pathname);
}

// ---------- Board building (once) ----------
function buildBoard(){
  const board = $('board');
  // We will rebuild cells each render to reflect classes, but base cells can be created once
  if(board.dataset.built) return;
  for(let r=0;r<15;r++){
    for(let c=0;c<15;c++){
      const d = document.createElement('div');
      d.className = 'cell';
      d.dataset.r = r; d.dataset.c = c;
      d.style.gridRow = (r+1) + '/span 1';
      d.style.gridColumn = (c+1) + '/span 1';
      board.appendChild(d);
    }
  }
  // base slots (visual)
  ['red','green','yellow','blue'].forEach(col => {
    BASE_SLOTS[col].forEach(s => {
      const slot = document.createElement('div');
      slot.className = 'base-slot';
      slot.style.background = 'rgba(0,0,0,0.4)';
      slot.style.borderColor = 'rgba(255,255,255,0.3)';
      slot.style.left = ((s[1]+0.5)/15*100)+'%';
      slot.style.top = ((s[0]+0.5)/15*100)+'%';
      board.appendChild(slot);
    });
  });
  board.dataset.built = '1';
}

function getCellEl(r,c){
  return document.querySelector('.cell[r="'+r+'"][c="'+c+'"]') ||
         document.querySelector('.cell[data-r="'+r+'"][data-c="'+c+'"]');
}

// Use attribute selectors
function buildBoardCells(){
  // assign classes to each cell based on its position
  document.querySelectorAll('.cell').forEach(el => {
    const r = +el.dataset.r, c = +el.dataset.c;
    el.className = 'cell';
    // bases
    if(r<6 && c<6) el.classList.add('base-red');
    else if(r<6 && c>8) el.classList.add('base-green');
    else if(r>8 && c>8) el.classList.add('base-yellow');
    else if(r>8 && c<6) el.classList.add('base-blue');
    else {
      // track / home / center
      const abs = TRACK.findIndex(p => p[0]===r && p[1]===c);
      if(abs !== -1){
        el.classList.add('track');
        if(SAFE_SQUARES.includes(abs)) el.classList.add('safe');
        if(abs === 0) el.classList.add('red-start');
        else if(abs === 13) el.classList.add('green-start');
        else if(abs === 26) el.classList.add('yellow-start');
        else if(abs === 39) el.classList.add('blue-start');
      } else {
        // home columns
        let found = null;
        for(const col of COLORS){
          const arr = HOME_COLUMNS[col];
          for(let i=0;i<5;i++){
            if(arr[i][0]===r && arr[i][1]===c){ found = col; break; }
          }
          if(found) break;
        }
        if(found) el.classList.add('home-' + found);
      }
    }
  });
}
// we need TRACK, SAFE_SQUARES, etc. on client too
const TRACK = ${JSON.stringify(TRACK)};
const SAFE_SQUARES = ${JSON.stringify(SAFE_SQUARES)};
const HOME_COLUMNS = ${JSON.stringify(HOME_COLUMNS)};
const BASE_SLOTS = ${JSON.stringify(BASE_SLOTS)};
const COLORS = ${JSON.stringify(COLORS)};
const START_POS = ${JSON.stringify(START_POS)};

function getAbsPos(color, rel){
  if(rel<1||rel>51) return -1;
  return (START_POS[color] + rel - 1) % 52;
}
function getCell(color, rel){
  if(rel===0) return null;
  if(rel<=51) return TRACK[getAbsPos(color, rel)];
  if(rel<=57) return HOME_COLUMNS[color][rel-52];
  return null;
}

// ---------- Render ----------
function renderAll(){
  if(!state) return;
  buildBoardCells();
  renderPlayers();
  renderTokens();
  renderDice();
  renderTurn();
}

function renderPlayers(){
  const cont = $('players');
  cont.innerHTML = '';
  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'pcard ' + p.color;
    if(i === state.currentPlayerIndex && state.started && !state.winner) div.classList.add('active');
    if(p.completed >= 4) div.classList.add('won');
    const crown = p.isHost ? '<div class="crown">👑</div>' : '';
    const disc = state.diceValue ? '<span class="disc has">'+state.diceValue+'</span>' : '<span class="disc">·</span>';
    div.innerHTML = '<div class="avatar"></div><div class="info"><div class="nm">'+escapeHtml(p.name)+'</div><div class="st">'+p.color.toUpperCase()+' · '+(p.completed||0)+'/4'+(p.isAI?' · AI':'')+'</div></div>'+disc+crown;
    cont.appendChild(div);
  });
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

function renderTokens(){
  // remove old
  document.querySelectorAll('.token').forEach(t => t.remove());
  const board = $('board');
  state.players.forEach(p => {
    const tks = state.tokens[p.id] || [];
    // Count tokens on each cell to stack
    const cellCount = {};
    tks.forEach((t, i) => {
      let pos;
      if(t.position === 0){
        pos = 'base_' + i;
        const slot = BASE_SLOTS[p.color][i];
        const r = slot[0], c = slot[1];
        placeToken(board, p, i, t, r, c);
      } else {
        const cell = getCell(p.color, t.position);
        if(cell){
          const key = cell[0]+'_'+cell[1];
          cellCount[key] = (cellCount[key] || 0) + 1;
          const idx = cellCount[key] - 1;
          let dr = 0, dc = 0;
          if(cellCount[key] > 1){
            // small offsets for stacking
            const ang = (idx / cellCount[key]) * Math.PI * 2;
            dr = Math.sin(ang) * 0.4;
            dc = Math.cos(ang) * 0.4;
          }
          placeToken(board, p, i, t, cell[0] + dr, cell[1] + dc);
        }
      }
    });
  });
}

function placeToken(board, p, i, t, r, c){
  const el = document.createElement('div');
  el.className = 'token ' + p.color;
  if(t.position === 57) el.classList.add('home-locked');
  el.style.left = ((c + 0.5) / 15 * 100) + '%';
  el.style.top = ((r + 0.5) / 15 * 100) + '%';
  // movable?
  const isMyTurn = state.started && !state.winner && !state.paused && state.players[state.currentPlayerIndex].id === myPid;
  const isLegal = state.canMove && state.legalMoves.includes(i) && p.id === myPid;
  if(isMyTurn && state.canMove){
    if(p.id === myPid && state.legalMoves.includes(i)){
      el.classList.add('movable');
      el.onclick = ()=>{ if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'MOVE_TOKEN', tokenIndex:i})); };
    } else if(p.id === myPid){
      el.classList.add('dim');
    } else {
      el.classList.add('dim');
    }
  } else if(p.id === myPid && state.canMove){
    el.classList.add('dim');
  }
  board.appendChild(el);
}

function renderDice(){
  const dice = $('dice');
  const zone = $('diceZone');
  if(!state.started){
    dice.textContent = '?';
    dice.classList.remove('active','rolling');
    return;
  }
  if(state.isRolling){
    dice.textContent = ['⚀','⚁','⚂','⚃','⚄','⚅'][Math.floor(Math.random()*6)];
    dice.classList.add('rolling');
    dice.classList.remove('active');
    return;
  }
  dice.classList.remove('rolling');
  if(state.diceValue){
    dice.textContent = state.diceValue;
    dice.classList.remove('active');
  } else {
    dice.textContent = '?';
    // active only if my turn & can roll
    const myTurn = state.players[state.currentPlayerIndex] && state.players[state.currentPlayerIndex].id === myPid;
    if(myTurn && !state.winner && !state.paused){
      dice.classList.add('active');
    } else {
      dice.classList.remove('active');
    }
  }
}

function renderTurn(){
  const zone = $('diceZone');
  const label = $('turnLabel');
  if(!state.started){
    label.textContent = isHost ? 'Tap 👑 to start' : 'Waiting for host...';
    zone.style.left = '50%'; zone.style.top = '50%'; zone.style.transform='translate(-50%,-50%)';
    return;
  }
  if(state.winner){
    label.textContent = 'GAME OVER';
    return;
  }
  const cur = state.players[state.currentPlayerIndex];
  if(!cur){ return; }
  label.textContent = cur.color.toUpperCase() + ' TURN';
  // position dice near current player's corner
  const positions = {
    red: {left:'10%', top:'12%'},
    green: {left:'90%', top:'12%'},
    yellow: {left:'90%', top:'88%'},
    blue: {left:'10%', top:'88%'}
  };
  const pos = positions[cur.color] || {left:'50%',top:'50%'};
  zone.style.left = pos.left; zone.style.top = pos.top;
  zone.style.transform = 'translate(-50%,-50%)';
  // pause overlay
  $('pauseOv').classList.toggle('hidden', !state.paused);
}

function tryRoll(){
  if(!state || !state.started || state.winner || state.paused) return;
  if(state.isRolling || state.canMove) return;
  const cur = state.players[state.currentPlayerIndex];
  if(!cur || cur.id !== myPid) return;
  if(ws && ws.readyState === 1) ws.send(JSON.stringify({type:'ROLL_DICE'}));
}

// ---------- Events ----------
function handleEvent(ev){
  if(ev.seq && ev.seq <= lastEventSeq) return;
  lastEventSeq = ev.seq || 0;
  const me = state ? state.players.find(p=>p.id===myPid) : null;
  switch(ev.kind){
    case 'START': toast('Game started!'); beep(440,0.15); break;
    case 'THREE_SIXES': toast('❌ THREE SIXES — TURN LOST!'); sCap(); break;
    case 'NO_MOVE': toast('No possible move'); beep(220,0.2,'sawtooth',0.1); break;
    case 'CAPTURE': toast('⚔️ CAPTURE! EXTRA ROLL!'); sCap(); break;
    case 'HOME': toast('🏠 TOKEN HOME! EXTRA ROLL!'); sHome(); break;
    case 'EXTRA':
      if(ev.reason==='SIX'){ toast('🎲 6! EXTRA ROLL!'); sSix(); }
      else if(ev.reason==='CAPTURE'){ toast('⚔️ CAPTURE! EXTRA ROLL!'); }
      else if(ev.reason==='HOME'){ toast('🏠 TOKEN HOME! EXTRA ROLL!'); }
      break;
    case 'WIN':
      const w = state.players.find(p=>p.id===ev.player);
      toast('🏆 ' + (w?w.color.toUpperCase():'') + ' WINS!');
      sWin();
      setTimeout(()=>showWinScreen(w), 800);
      break;
    case 'RESTART': toast('🔄 Game restarted'); break;
  }
}

function toast(msg){
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(()=>t.remove(), 2600);
}

function addChat(name, color, msg, mine){
  const c = $('chatMsgs');
  const d = document.createElement('div');
  d.className = 'm';
  d.innerHTML = '<span class="n" style="color:var(--'+color+')">'+escapeHtml(name)+':</span><span class="t">'+escapeHtml(msg)+'</span>';
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
  while(c.children.length > 50) c.removeChild(c.firstChild);
}

function buildEmojiRow(){
  const row = $('emojiRow');
  row.innerHTML = '';
  EMOJIS.forEach(e => {
    const b = document.createElement('button');
    b.textContent = e;
    b.onclick = ()=>{
      if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'EMOJI', emoji:e}));
    };
    row.appendChild(b);
  });
}

function showEmoji(name, color, emoji){
  const layer = $('floatLayer');
  const el = document.createElement('div');
  el.className = 'float-emoji';
  el.innerHTML = '<span style="color:var(--'+color+');font-weight:700;font-size:14px;display:block;margin-bottom:4px;text-shadow:0 0 6px rgba(0,0,0,0.7)">'+escapeHtml(name)+'</span>'+emoji;
  el.style.left = (20 + Math.random()*60) + '%';
  el.style.top = (40 + Math.random()*30) + '%';
  layer.appendChild(el);
  setTimeout(()=>el.remove(), 3000);
}

// ---------- Host menu ----------
function openHostMenu(){
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = \`
  <div class="modal">
    <h2>👑 Host Menu</h2>
    <div class="sub">Control the match — only visible to you.</div>
    <div class="group">
      <label>Match Controls</label>
      <div class="seg3">
        <button id="hPause">⏸ Pause</button>
        <button id="hRestart">🔄 Restart</button>
        <button id="hClose">🚪 Close</button>
      </div>
    </div>
    <div class="group">
      <label>Add AI Player</label>
      <button class="btn secondary" id="hAddAI" style="width:100%">+ Add AI Bot</button>
    </div>
    <div class="group">
      <label>Force Dice (Host Mod)</label>
      <div class="seg" id="forceSeg">
        \${[1,2,3,4,5,6].map(n=>'<button data-v='+n+'>'+n+'</button>').join('')}
      </div>
      <div class="seg3" style="margin-top:8px">
        <button data-mode="next">Next Roll</button>
        <button data-mode="forever">Until Disabled</button>
        <button data-mode="count">Count</button>
      </div>
      <div class="num-input" id="countWrap" style="margin-top:8px;display:none">
        <label style="margin:0">Rolls:</label>
        <input type="number" id="forceCount" value="3" min="1" max="20">
      </div>
      <button class="btn secondary" id="hClearMod" style="margin-top:8px;width:100%">Clear Mod</button>
    </div>
    <div class="group">
      <label>Players</label>
      <div class="host-list" id="hostList"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="hClose2">Close</button>
    </div>
  </div>\`;
  document.body.appendChild(bg);

  const cur = state.hostMod;
  // Pre-select
  if(cur.forcedValue != null){
    bg.querySelector('#forceSeg button[data-v="'+cur.forcedValue+'"]')?.classList.add('sel');
    bg.querySelector('.seg3 button[data-mode="'+cur.mode+'"]')?.classList.add('sel');
    if(cur.mode === 'count') bg.querySelector('#countWrap').style.display='flex';
  }

  bg.querySelectorAll('#forceSeg button').forEach(b=>{
    b.onclick = ()=>{
      bg.querySelectorAll('#forceSeg button').forEach(x=>x.classList.remove('sel'));
      b.classList.add('sel');
    };
  });
  bg.querySelectorAll('.seg3 button').forEach(b=>{
    b.onclick = ()=>{
      bg.querySelectorAll('.seg3 button').forEach(x=>x.classList.remove('sel'));
      b.classList.add('sel');
      bg.querySelector('#countWrap').style.display = (b.dataset.mode==='count')?'flex':'none';
    };
  });

  // Players list with kick
  const list = bg.querySelector('#hostList');
  state.players.forEach(p => {
    if(p.isAI) return;
    const it = document.createElement('div');
    it.className = 'item';
    it.innerHTML = '<span>'+(p.isHost?'👑 ':'')+escapeHtml(p.name)+' ('+p.color+')</span>';
    if(!p.isHost && p.id !== myPid){
      const k = document.createElement('button');
      k.className = 'kick'; k.textContent = 'Kick';
      k.onclick = ()=>{ ws.send(JSON.stringify({type:'KICK_PLAYER', pid:p.id})); };
      it.appendChild(k);
    }
    list.appendChild(it);
  });

  // Apply mod
  function applyMod(){
    const v = bg.querySelector('#forceSeg button.sel')?.dataset.v;
    const mode = bg.querySelector('.seg3 button.sel')?.dataset.mode;
    if(v && mode){
      const count = +bg.querySelector('#forceCount').value || 1;
      ws.send(JSON.stringify({type:'HOST_MOD', action:'set', value:+v, mode, count}));
    }
  }
  bg.querySelectorAll('#forceSeg button, .seg3 button').forEach(b=>{
    b.addEventListener('click', ()=> setTimeout(applyMod, 50));
  });
  bg.querySelector('#forceCount').oninput = applyMod;
  bg.querySelector('#hClearMod').onclick = ()=>{
    bg.querySelectorAll('.sel').forEach(x=>x.classList.remove('sel'));
    ws.send(JSON.stringify({type:'HOST_MOD', action:'clear'}));
  };
  bg.querySelector('#hPause').onclick = ()=>{
    if(state.paused) ws.send(JSON.stringify({type:'RESUME'}));
    else ws.send(JSON.stringify({type:'PAUSE'}));
  };
  bg.querySelector('#hRestart').onclick = ()=>{ if(confirm('Restart the match?')) ws.send(JSON.stringify({type:'RESTART'})); };
  bg.querySelector('#hClose').onclick = ()=>{ if(confirm('Close the room for everyone?')) ws.send(JSON.stringify({type:'CLOSE_ROOM'})); };
  bg.querySelector('#hAddAI').onclick = ()=> ws.send(JSON.stringify({type:'ADD_AI'}));
  bg.querySelector('#hClose2').onclick = ()=> bg.remove();
  bg.addEventListener('click', e=>{ if(e.target===bg) bg.remove(); });

  // Update pause button label
  const updatePause = ()=>{ bg.querySelector('#hPause').textContent = state.paused ? '▶ Resume' : '⏸ Pause'; };
  updatePause();
  const iv = setInterval(updatePause, 500);
  bg.addEventListener('DOMNodeRemoved', ()=>clearInterval(iv));
}

// ---------- Win screen + confetti ----------
function showWinScreen(winner){
  if(!winner) return;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = \`
  <div class="modal win-card">
    <div class="trophy">🏆</div>
    <h2 style="color:var(--\${winner.color})">\${escapeHtml(winner.name)} WINS!</h2>
    <div class="sub">\${winner.color.toUpperCase()} player got all 4 tokens home</div>
    <div class="stats" id="winStats"></div>
    <div class="modal-actions">
      \${isHost ? '<button class="btn" id="wPlayAgain">🔄 Play Again</button>' : ''}
      <button class="btn secondary" id="wLobby">🚪 Back to Lobby</button>
    </div>
  </div>\`;
  document.body.appendChild(bg);
  const stats = bg.querySelector('#winStats');
  state.players.forEach(p=>{
    const d = document.createElement('div');
    d.innerHTML = '<span>'+escapeHtml(p.name)+'</span><span>'+p.color.toUpperCase()+' · '+p.completed+'/4</span>';
    stats.appendChild(d);
  });
  bg.querySelector('#wLobby').onclick = ()=> backToLobby();
  if(isHost){
    bg.querySelector('#wPlayAgain').onclick = ()=>{
      ws.send(JSON.stringify({type:'RESTART'}));
      bg.remove();
    };
  }
  startConfetti();
}

let confettiRunning = false;
function startConfetti(){
  const canvas = $('confetti');
  canvas.classList.remove('hidden');
  canvas.width = innerWidth; canvas.height = innerHeight;
  const ctx = canvas.getContext('2d');
  const colors = ['#ef4444','#22c55e','#eab308','#3b82f6','#f5b342','#ffffff'];
  const pieces = [];
  for(let i=0;i<150;i++){
    pieces.push({
      x: Math.random()*canvas.width,
      y: -20 + Math.random()*-200,
      w: 6+Math.random()*6, h: 8+Math.random()*8,
      vy: 2+Math.random()*3, vx: -1+Math.random()*2,
      rot: Math.random()*Math.PI*2, vr: -0.2+Math.random()*0.4,
      col: colors[Math.floor(Math.random()*colors.length)]
    });
  }
  confettiRunning = true;
  function tick(){
    if(!confettiRunning) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    pieces.forEach(p=>{
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      if(p.y > canvas.height + 20){ p.y = -20; p.x = Math.random()*canvas.width; }
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.col;
      ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      ctx.restore();
    });
    requestAnimationFrame(tick);
  }
  tick();
  setTimeout(()=>{ confettiRunning = false; canvas.classList.add('hidden'); }, 6000);
}

init();
<\/script>
</body>
</html>`;
