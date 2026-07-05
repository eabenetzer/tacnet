const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Room & User State ──────────────────────────────────────────
const rooms = new Map();   // roomCode -> Map<socketId, userObj>

function broadcastRoster(roomCode) {
  const members = rooms.get(roomCode);
  if (!members) return;
  const roster = [];
  for (const [id, u] of members) {
    roster.push({ id, callsign: u.callsign, lat: u.lat, lng: u.lng, color: u.color });
  }
  io.to(roomCode).emit('roster', roster);
}

const MARKER_COLORS = [
  '#00e676', '#00b0ff', '#ff9100', '#e040fb',
  '#ffea00', '#ff5252', '#69f0ae', '#448aff',
  '#ff6e40', '#ea80fc', '#76ff03', '#40c4ff'
];

// ── Socket.IO ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // ── Join Room ────────────────────────────────────────────────
  socket.on('join-room', ({ roomCode, callsign }) => {
    roomCode = (roomCode || '4321').toUpperCase().trim();
    callsign = (callsign || 'Operator').trim().substring(0, 20);

    if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
    const members = rooms.get(roomCode);

    const color = MARKER_COLORS[members.size % MARKER_COLORS.length];
    currentUser = { callsign, lat: null, lng: null, color };
    currentRoom = roomCode;

    members.set(socket.id, currentUser);
    socket.join(roomCode);

    socket.emit('joined', { roomCode, callsign, color, userId: socket.id });
    broadcastRoster(roomCode);

    // Notify others
    socket.to(roomCode).emit('chat-message', {
      from: 'SYSTEM',
      text: `${callsign} joined the room`,
      time: Date.now(),
      color: '#888'
    });
  });

  // ── Location Update ──────────────────────────────────────────
  socket.on('location', ({ lat, lng, heading, speed }) => {
    if (!currentRoom || !currentUser) return;
    currentUser.lat = lat;
    currentUser.lng = lng;
    currentUser.heading = heading;
    currentUser.speed = speed;
    socket.to(currentRoom).emit('location-update', {
      id: socket.id,
      lat, lng, heading, speed,
      callsign: currentUser.callsign,
      color: currentUser.color
    });
  });

  // ── Chat ─────────────────────────────────────────────────────
  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !currentUser) return;
    const msg = {
      from: currentUser.callsign,
      text: text.substring(0, 500),
      time: Date.now(),
      color: currentUser.color
    };
    io.to(currentRoom).emit('chat-message', msg);
  });

  // ── WebRTC Signaling ─────────────────────────────────────────
  socket.on('rtc-offer', ({ to, offer }) => {
    socket.to(to).emit('rtc-offer', { from: socket.id, offer });
  });

  socket.on('rtc-answer', ({ to, answer }) => {
    socket.to(to).emit('rtc-answer', { from: socket.id, answer });
  });

  socket.on('rtc-ice', ({ to, candidate }) => {
    socket.to(to).emit('rtc-ice', { from: socket.id, candidate });
  });

  // ── PTT State ────────────────────────────────────────────────
  socket.on('ptt-start', () => {
    if (!currentRoom || !currentUser) return;
    socket.to(currentRoom).emit('ptt-active', {
      id: socket.id,
      callsign: currentUser.callsign,
      color: currentUser.color
    });
  });

  socket.on('ptt-stop', () => {
    if (!currentRoom || !currentUser) return;
    socket.to(currentRoom).emit('ptt-inactive', { id: socket.id });
  });

  // ── Camera State ─────────────────────────────────────────────
  socket.on('camera-on', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('camera-on', {
      id: socket.id,
      callsign: currentUser.callsign
    });
  });

  socket.on('camera-off', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('camera-off', { id: socket.id });
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const members = rooms.get(currentRoom);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) {
        rooms.delete(currentRoom);
      } else {
        broadcastRoster(currentRoom);
        io.to(currentRoom).emit('chat-message', {
          from: 'SYSTEM',
          text: `${currentUser?.callsign || 'Unknown'} left the room`,
          time: Date.now(),
          color: '#888'
        });
        io.to(currentRoom).emit('peer-disconnected', { id: socket.id });
      }
    }
  });
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   TacNet Server — Port ${PORT}          ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
