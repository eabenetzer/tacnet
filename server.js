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

// ── Room & User State ──────────────────────────────────────────
// In the new privacy model, all users are in the same 'server' if they have the entry pass,
// but they only exchange data with their 'paired' teammates.
const users = new Map(); // socketId -> userObj
const pairingToSocket = new Map(); // pairingCode -> socketId

// Helper to send to paired peers
function emitToPaired(socketId, event, data, ioInstance, socketInstance) {
  const me = users.get(socketId);
  if (!me) return;
  for (const peerId of me.pairedWith) {
    socketInstance.to(peerId).emit(event, data);
  }
}

const MARKER_COLORS = [
  '#00e676', '#00b0ff', '#ff9100', '#e040fb',
  '#ffea00', '#ff5252', '#69f0ae', '#448aff',
  '#ff6e40', '#ea80fc', '#76ff03', '#40c4ff'
];

// ── Socket.IO ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentUser = null;

  // ── Join Server ────────────────────────────────────────────────
  socket.on('join-room', ({ roomCode, callsign }) => {
    roomCode = (roomCode || '').trim();
    if (roomCode !== ENTRY_PASS) {
      socket.emit('auth-error', 'Invalid Entry Pass');
      return;
    }
    
    callsign = (callsign || 'Operator').trim().substring(0, 20);
    const color = MARKER_COLORS[users.size % MARKER_COLORS.length];
    
    // Ensure unique pairing code
    let pairingCode = generatePairingCode();
    while(pairingToSocket.has(pairingCode)) pairingCode = generatePairingCode();

    currentUser = { 
      id: socket.id,
      callsign, 
      lat: null, lng: null, 
      color,
      pairingCode,
      pairedWith: new Set()
    };
    
    users.set(socket.id, currentUser);
    pairingToSocket.set(pairingCode, socket.id);

    socket.emit('joined', { 
      callsign, 
      color, 
      userId: socket.id,
      pairingCode 
    });
  });

  // ── Add Teammate ─────────────────────────────────────────────
  socket.on('add-teammate', (code) => {
    if (!currentUser) return;
    const targetCode = (code || '').toUpperCase().trim();
    if (targetCode === currentUser.pairingCode) return;
    
    const targetSocketId = pairingToSocket.get(targetCode);
    if (targetSocketId) {
      const targetUser = users.get(targetSocketId);
      if (targetUser) {
        // Mutual pair
        currentUser.pairedWith.add(targetSocketId);
        targetUser.pairedWith.add(socket.id);
        
        // Notify both
        socket.emit('teammate-added', {
          id: targetSocketId, callsign: targetUser.callsign, color: targetUser.color, lat: targetUser.lat, lng: targetUser.lng
        });
        socket.to(targetSocketId).emit('teammate-added', {
          id: socket.id, callsign: currentUser.callsign, color: currentUser.color, lat: currentUser.lat, lng: currentUser.lng
        });
        
        // System chat notification
        socket.emit('chat-message', { from: 'SYSTEM', text: `Paired with ${targetUser.callsign}`, time: Date.now(), color: '#888' });
        socket.to(targetSocketId).emit('chat-message', { from: 'SYSTEM', text: `${currentUser.callsign} paired with you`, time: Date.now(), color: '#888' });
      }
    } else {
      socket.emit('chat-message', { from: 'SYSTEM', text: `Invalid code: ${targetCode}`, time: Date.now(), color: '#ff5252' });
    }
  });

  // ── Location Update ──────────────────────────────────────────
  socket.on('location', ({ lat, lng, heading, speed }) => {
    if (!currentUser) return;
    currentUser.lat = lat;
    currentUser.lng = lng;
    currentUser.heading = heading;
    currentUser.speed = speed;
    
    emitToPaired(socket.id, 'location-update', {
      id: socket.id,
      lat, lng, heading, speed,
      callsign: currentUser.callsign,
      color: currentUser.color
    }, io, socket);
  });

  // ── Chat ─────────────────────────────────────────────────────
  socket.on('chat-message', ({ text }) => {
    if (!currentUser) return;
    const msg = {
      from: currentUser.callsign,
      text: text.substring(0, 500),
      time: Date.now(),
      color: currentUser.color
    };
    // Send to self
    socket.emit('chat-message', msg);
    // Send to paired
    emitToPaired(socket.id, 'chat-message', msg, io, socket);
  });

  // ── WebRTC Signaling ─────────────────────────────────────────
  // Signaling needs to be passed through even if not fully paired yet? 
  // No, only paired users should do WebRTC.
  socket.on('rtc-offer', ({ to, offer }) => {
    if(currentUser && currentUser.pairedWith.has(to)) {
      socket.to(to).emit('rtc-offer', { from: socket.id, offer });
    }
  });

  socket.on('rtc-answer', ({ to, answer }) => {
    if(currentUser && currentUser.pairedWith.has(to)) {
      socket.to(to).emit('rtc-answer', { from: socket.id, answer });
    }
  });

  socket.on('rtc-ice', ({ to, candidate }) => {
    if(currentUser && currentUser.pairedWith.has(to)) {
      socket.to(to).emit('rtc-ice', { from: socket.id, candidate });
    }
  });

  // ── PTT State ────────────────────────────────────────────────
  socket.on('ptt-start', () => {
    if (!currentUser) return;
    emitToPaired(socket.id, 'ptt-active', {
      id: socket.id,
      callsign: currentUser.callsign,
      color: currentUser.color
    }, io, socket);
  });

  socket.on('ptt-stop', () => {
    if (!currentUser) return;
    emitToPaired(socket.id, 'ptt-inactive', { id: socket.id }, io, socket);
  });

  // ── Camera State ─────────────────────────────────────────────
  socket.on('camera-on', () => {
    if (!currentUser) return;
    emitToPaired(socket.id, 'camera-on', {
      id: socket.id,
      callsign: currentUser.callsign
    }, io, socket);
  });

  socket.on('camera-off', () => {
    if (!currentUser) return;
    emitToPaired(socket.id, 'camera-off', { id: socket.id }, io, socket);
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentUser) return;
    
    // Remove from other people's paired sets
    for (const peerId of currentUser.pairedWith) {
      const peer = users.get(peerId);
      if (peer) {
        peer.pairedWith.delete(socket.id);
        io.to(peerId).emit('chat-message', {
          from: 'SYSTEM',
          text: `${currentUser.callsign} went offline`,
          time: Date.now(),
          color: '#888'
        });
        io.to(peerId).emit('peer-disconnected', { id: socket.id });
      }
    }
    
    pairingToSocket.delete(currentUser.pairingCode);
    users.delete(socket.id);
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
