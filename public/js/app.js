/* ═══════════════════════════════════════════════════════════════
   App Controller — Main orchestrator
   ═══════════════════════════════════════════════════════════════ */
(function () {
  // ── DOM ───────────────────────────────────────────────────
  const lobbyScreen = document.getElementById('lobby');
  const tacticalScreen = document.getElementById('tactical');
  const joinBtn = document.getElementById('join-btn');
  const callsignInput = document.getElementById('callsign-input');
  const roomInput = document.getElementById('room-input');
  const roomLabel = document.getElementById('room-label');
  const memberCount = document.getElementById('member-count');
  const centerMapBtn = document.getElementById('center-map-btn');
  const rosterList = document.getElementById('roster-list');
  const teammateCodeInput = document.getElementById('teammate-code-input');
  const addTeammateBtn = document.getElementById('add-teammate-btn');
  const boostBtn = document.getElementById('boost-btn');

  let socket = null;
  let myId = null;
  let myCallsign = '';
  let myColor = '';
  let myPairingCode = '';
  let pairedTeammates = new Map(); // id -> userObj

  // ── Panel toggle ──────────────────────────────────────────
  const panelBtns = document.querySelectorAll('.toolbar-btn[data-panel]');
  const panelCloses = document.querySelectorAll('.panel-close');
  let activePanel = null;

  panelBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.dataset.panel;
      togglePanel(panelId, btn);
    });
  });

  panelCloses.forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.dataset.panel;
      closePanel(panelId);
    });
  });

  function togglePanel(panelId, btn) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    if (activePanel === panelId) {
      closePanel(panelId);
      return;
    }

    // Close other panels
    if (activePanel) closePanel(activePanel);

    panel.classList.remove('hidden');
    activePanel = panelId;

    // Mark button active
    panelBtns.forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    // Notify chat module
    if (panelId === 'chat-panel') Chat.setPanelVisible(true);
  }

  function closePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('hidden');
    panelBtns.forEach(b => {
      if (b.dataset.panel === panelId) b.classList.remove('active');
    });
    if (panelId === 'chat-panel') Chat.setPanelVisible(false);
    if (activePanel === panelId) activePanel = null;
  }

  // ── Join Room ─────────────────────────────────────────────
  joinBtn.addEventListener('click', joinRoom);
  callsignInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

  function joinRoom() {
    const callsign = callsignInput.value.trim();
    const roomCode = roomInput.value.trim() || '4321';

    if (!callsign) {
      callsignInput.focus();
      callsignInput.style.borderColor = '#ff5252';
      setTimeout(() => { callsignInput.style.borderColor = ''; }, 1500);
      return;
    }

    myCallsign = callsign;
    myRoomCode = roomCode;

    // Connect socket
    socket = io();

    socket.on('connect', () => {
      socket.emit('join-room', { roomCode, callsign });
    });

    socket.on('joined', (data) => {
      myId = data.userId;
      myColor = data.color;
      myPairingCode = data.pairingCode;

      roomLabel.textContent = `MY CODE: ${data.pairingCode}`;
      
      // I don't start with any roster. Just myself.
      renderRoster([]);

      // Switch screens
      lobbyScreen.classList.remove('active');
      tacticalScreen.classList.add('active');

      // Init all modules
      TacMap.init();
      GeoLocation.init(socket, onMyLocation);
      Chat.init(socket);
      PTT.init(socket);
      Camera.init(socket);

      WebRTCManager.init(socket, {
        onRemoteTrack: (peerId, track, kind) => {
          if (kind === 'audio') {
            // Create audio element for remote audio
            let audio = document.getElementById(`audio-${peerId}`);
            if (!audio) {
              audio = document.createElement('audio');
              audio.id = `audio-${peerId}`;
              audio.autoplay = true;
              document.body.appendChild(audio);
            }
            let stream = audio.srcObject;
            if (!stream) {
              stream = new MediaStream();
              audio.srcObject = stream;
            }
            stream.addTrack(track);
          } else if (kind === 'video') {
            Camera.addRemoteTrack(peerId, track);
          }
        },
        onPeerClosed: (peerId) => {
          // Clean up audio element
          const audio = document.getElementById(`audio-${peerId}`);
          if (audio) {
            if (audio.srcObject) audio.srcObject.getTracks().forEach(t => t.stop());
            audio.remove();
          }
          Camera.removeRemoteFeed(peerId);
        }
      });

      // Start GPS
      GeoLocation.start();
    });

    // ── Teammate pairing ─────────────────────────────────────
    addTeammateBtn.addEventListener('click', () => {
      const code = teammateCodeInput.value.trim();
      if (code && code.length === 4) {
        socket.emit('add-teammate', code);
        teammateCodeInput.value = '';
      }
    });

    socket.on('teammate-added', (u) => {
      pairedTeammates.set(u.id, u);
      memberCount.textContent = `${pairedTeammates.size} paired`;
      renderRoster(Array.from(pairedTeammates.values()));

      if (u.lat != null && u.lng != null) {
        TacMap.updateMarker(u.id, {
          lat: u.lat, lng: u.lng,
          callsign: u.callsign,
          color: u.color,
          isSelf: false
        });
      }

      if (!WebRTCManager.getPeers().has(u.id)) {
        WebRTCManager.connectToPeer(u.id);
      }
    });

    // ── Error handling ───────────────────────────────────────
    socket.on('auth-error', (msg) => {
      alert(msg);
      location.reload();
    });

    // ── Location from others ───────────────────────────────
    socket.on('location-update', (data) => {
      TacMap.updateMarker(data.id, {
        lat: data.lat, lng: data.lng,
        callsign: data.callsign,
        color: data.color,
        isSelf: false
      });
    });

    // ── Peer disconnected ──────────────────────────────────
    socket.on('peer-disconnected', ({ id }) => {
      TacMap.removeMarker(id);
      pairedTeammates.delete(id);
      memberCount.textContent = `${pairedTeammates.size} paired`;
      renderRoster(Array.from(pairedTeammates.values()));
    });
  }

  // ── My location callback ─────────────────────────────────
  function onMyLocation(lat, lng) {
    TacMap.updateMarker(myId, {
      lat, lng,
      callsign: myCallsign,
      color: myColor,
      isSelf: true
    });
  }

  // ── Boost mode toggle ────────────────────────────────────
  boostBtn.addEventListener('click', () => {
    const isBoost = GeoLocation.toggleBoost();
    if (isBoost) {
      boostBtn.style.color = 'var(--accent)';
      boostBtn.classList.add('pulse');
    } else {
      boostBtn.style.color = 'var(--text-muted)';
      boostBtn.classList.remove('pulse');
    }
  });

  // ── Center map on me ─────────────────────────────────────
  centerMapBtn.addEventListener('click', () => {
    const pos = GeoLocation.getLast();
    if (pos.lat != null) {
      TacMap.centerOn(pos.lat, pos.lng, 16);
    } else {
      TacMap.fitTeam();
    }
  });

  // ── Render roster ────────────────────────────────────────
  function renderRoster(data) {
    rosterList.innerHTML = '';
    data.forEach(u => {
      const item = document.createElement('div');
      item.className = 'roster-item';
      item.innerHTML = `
        <span class="roster-color" style="color:${u.color}; background:${u.color}"></span>
        <span class="roster-name">${escHtml(u.callsign)}</span>
        ${u.id === myId ? '<span class="roster-me">YOU</span>' : ''}
      `;
      // Click to center on teammate
      item.addEventListener('click', () => {
        if (u.lat != null && u.lng != null) {
          TacMap.centerOn(u.lat, u.lng, 17);
          closePanel('roster-panel');
        }
      });
      rosterList.appendChild(item);
    });
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Focus callsign input on load ─────────────────────────
  callsignInput.focus();

})();
