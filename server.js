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

const ENTRY_PASS = '4321';

function generatePairingCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for(let i=0; i<4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

// ── Persistent Room & User State ───────────────────────────────
// Users are indexed by persistent deviceId (survives reconnection)
const users = new Map();              // deviceId -> userObj
const socketIdToDeviceId = new Map(); // socket.id -> deviceId
const pairingToDeviceId = new Map();  // pairingCode -> deviceId

// Helper to send to paired peers
function emitToPaired(deviceId, event, data, socketInstance) {
  const me = users.get(deviceId);
  if (!me) return;
  for (const peerDeviceId of me.pairedWith) {
    const peer = users.get(peerDeviceId);
    if (peer && peer.socketId) {
      socketInstance.to(peer.socketId).emit(event, data);
    }
  }
}

const MARKER_COLORS = [
  '#00e676', '#00b0ff', '#ff9100', '#e040fb',
  '#ffea00', '#ff5252', '#69f0ae', '#448aff',
  '#ff6e40', '#ea80fc', '#76ff03', '#40c4ff'
];

// ── Socket.IO ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentDeviceId = null;

  // ── Join Server ────────────────────────────────────────────────
  socket.on('join-room', ({ roomCode, callsign, deviceId }) => {
    roomCode = (roomCode || '').trim();
    if (roomCode !== ENTRY_PASS) {
      socket.emit('auth-error', 'Invalid Entry Pass');
      return;
    }

    if (!deviceId) {
      socket.emit('auth-error', 'Device identification missing');
      return;
    }

    currentDeviceId = deviceId;
    socketIdToDeviceId.set(socket.id, currentDeviceId);

    callsign = (callsign || 'Operator').trim().substring(0, 20);
    
    let user = users.get(currentDeviceId);

    if (user) {
      // Reconnecting existing user: update socket ID and callsign if changed
      user.socketId = socket.id;
      user.callsign = callsign;
    } else {
      // New user
      const color = MARKER_COLORS[users.size % MARKER_COLORS.length];
      let pairingCode = generatePairingCode();
      while(pairingToDeviceId.has(pairingCode)) pairingCode = generatePairingCode();

      user = {
        deviceId: currentDeviceId,
        socketId: socket.id,
        callsign,
        lat: null, lng: null,
        color,
        pairingCode,
        pairedWith: new Set()
      };
      users.set(currentDeviceId, user);
      pairingToDeviceId.set(pairingCode, currentDeviceId);
    }

    socket.emit('joined', {
      callsign: user.callsign,
      color: user.color,
      userId: user.deviceId, // client expects this to map to marker identifiers
      pairingCode: user.pairingCode
    });

    // Notify any active paired teammates that this user came back online
    for (const peerDeviceId of user.pairedWith) {
      const peer = users.get(peerDeviceId);
      if (peer && peer.socketId) {
        socket.to(peer.socketId).emit('teammate-added', {
          id: user.deviceId,
          callsign: user.callsign,
          color: user.color,
          lat: user.lat,
          lng: user.lng
        });
      }
    }
  });

  // ── Add Teammate ─────────────────────────────────────────────
  socket.on('add-teammate', (code) => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (!currentUser) return;

    const targetCode = (code || '').toUpperCase().trim();
    if (targetCode === currentUser.pairingCode) return;

    const targetDeviceId = pairingToDeviceId.get(targetCode);
    if (targetDeviceId) {
      const targetUser = users.get(targetDeviceId);
      if (targetUser) {
        // Mutual pair by device ID
        currentUser.pairedWith.add(targetDeviceId);
        targetUser.pairedWith.add(currentDeviceId);

        // Notify current user if target is online/registered
        socket.emit('teammate-added', {
          id: targetDeviceId,
          callsign: targetUser.callsign,
          color: targetUser.color,
          lat: targetUser.lat,
          lng: targetUser.lng
        });

        // Notify target user if they are currently online
        if (targetUser.socketId) {
          socket.to(targetUser.socketId).emit('teammate-added', {
            id: currentDeviceId,
            callsign: currentUser.callsign,
            color: currentUser.color,
            lat: currentUser.lat,
            lng: currentUser.lng
          });
          socket.to(targetUser.socketId).emit('chat-message', { from: 'SYSTEM', text: `${currentUser.callsign} paired with you`, time: Date.now(), color: '#888' });
        }
        
        socket.emit('chat-message', { from: 'SYSTEM', text: `Paired with ${targetUser.callsign}`, time: Date.now(), color: '#888' });
      }
    } else {
      socket.emit('chat-message', { from: 'SYSTEM', text: `Invalid code: ${targetCode}`, time: Date.now(), color: '#ff5252' });
    }
  });

  // ── Location Update ──────────────────────────────────────────
  socket.on('location', ({ lat, lng, heading, speed }) => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (!currentUser) return;

    currentUser.lat = lat;
    currentUser.lng = lng;
    currentUser.heading = heading;
    currentUser.speed = speed;

    emitToPaired(currentDeviceId, 'location-update', {
      id: currentDeviceId,
      lat, lng, heading, speed,
      callsign: currentUser.callsign,
      color: currentUser.color
    }, socket);
  });

  // ── Chat ─────────────────────────────────────────────────────
  socket.on('chat-message', ({ text }) => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (!currentUser) return;

    const msg = {
      from: currentUser.callsign,
      text: text.substring(0, 500),
      time: Date.now(),
      color: currentUser.color
    };
    socket.emit('chat-message', msg);
    emitToPaired(currentDeviceId, 'chat-message', msg, socket);
  });

  // ── WebRTC Signaling ─────────────────────────────────────────
  socket.on('rtc-offer', ({ to, offer }) => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (currentUser && currentUser.pairedWith.has(to)) {
      const targetUser = users.get(to);
      if (targetUser && targetUser.socketId) {
        socket.to(targetUser.socketId).emit('rtc-offer', { from: currentDeviceId, offer });
      }
    }
  });

  socket.on('rtc-answer', ({ to, answer }) => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (currentUser && currentUser.pairedWith.has(to)) {
      const targetUser = users.get(to);
      if (targetUser && targetUser.socketId) {
        socket.to(targetUser.socketId).emit('rtc-answer', { from: currentDeviceId, answer });
      }
    }
  });

  socket.on('rtc-ice', ({ to, candidate }) => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (currentUser && currentUser.pairedWith.has(to)) {
      const targetUser = users.get(to);
      if (targetUser && targetUser.socketId) {
        socket.to(targetUser.socketId).emit('rtc-ice', { from: currentDeviceId, candidate });
      }
    }
  });

  // ── PTT State ────────────────────────────────────────────────
  socket.on('ptt-start', () => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (!currentUser) return;

    emitToPaired(currentDeviceId, 'ptt-active', {
      id: currentDeviceId,
      callsign: currentUser.callsign,
      color: currentUser.color
    }, socket);
  });

  socket.on('ptt-stop', () => {
    if (!currentDeviceId) return;
    emitToPaired(currentDeviceId, 'ptt-inactive', { id: currentDeviceId }, socket);
  });

  // ── Camera State ─────────────────────────────────────────────
  socket.on('camera-on', () => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (!currentUser) return;

    emitToPaired(currentDeviceId, 'camera-on', {
      id: currentDeviceId,
      callsign: currentUser.callsign
    }, socket);
  });

  socket.on('camera-off', () => {
    if (!currentDeviceId) return;
    emitToPaired(currentDeviceId, 'camera-off', { id: currentDeviceId }, socket);
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentDeviceId) return;
    const currentUser = users.get(currentDeviceId);
    if (!currentUser) return;

    // Clear connection socket mapping, keep pairing and coordinates intact
    currentUser.socketId = null;
    socketIdToDeviceId.delete(socket.id);

    // Notify peers that they went offline temporarily
    for (const peerDeviceId of currentUser.pairedWith) {
      const peer = users.get(peerDeviceId);
      if (peer && peer.socketId) {
        io.to(peer.socketId).emit('chat-message', {
          from: 'SYSTEM',
          text: `${currentUser.callsign} went offline`,
          time: Date.now(),
          color: '#888'
        });
        io.to(peer.socketId).emit('peer-disconnected', { id: currentDeviceId });
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
