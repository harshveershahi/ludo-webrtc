const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = {};
const COLORS = ['Blue', 'Red', 'Green', 'Yellow'];

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substring(2, 9);

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    if (data.type === 'CREATE_ROOM') {
      const roomCode = generateCode();
      const maxPlayers = parseInt(data.maxPlayers) || 4;
      rooms[roomCode] = {
        host: ws,
        mode: data.mode,
        maxPlayers: maxPlayers,
        players: [{ id: ws.id, name: data.name, color: COLORS[0], ws }]
      };
      ws.roomCode = roomCode;
      ws.send(JSON.stringify({ 
        type: 'ROOM_CREATED', 
        roomCode, 
        color: COLORS[0], 
        playerId: ws.id, 
        mode: data.mode,
        maxPlayers: maxPlayers 
      }));
    }

    if (data.type === 'JOIN_ROOM') {
      const room = rooms[data.roomCode];
      if (!room) return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room not found' }));
      if (room.players.length >= room.maxPlayers) return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room full' }));

      const color = COLORS[room.players.length];
      const newPlayer = { id: ws.id, name: data.name, color, ws };
      
      ws.roomCode = data.roomCode;
      room.players.push(newPlayer);

      ws.send(JSON.stringify({ 
        type: 'JOINED_SUCCESS', 
        roomCode: data.roomCode, 
        color, 
        playerId: ws.id,
        mode: room.mode,
        maxPlayers: room.maxPlayers
      }));

      room.host.send(JSON.stringify({
        type: 'NEW_PLAYER_JOINED',
        peerId: ws.id,
        name: data.name,
        color
      }));
    }

    if (['OFFER', 'ANSWER', 'ICE_CANDIDATE'].includes(data.type)) {
      const room = rooms[ws.roomCode];
      if (!room) return;
      const targetPlayer = room.players.find(p => p.id === data.targetId);
      if (targetPlayer) {
        targetPlayer.ws.send(JSON.stringify({ ...data, senderId: ws.id }));
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
