/* ═══════════════════════════════════════════════════════════════
   WebRTC Manager — Peer connections, STUN/TURN, ICE, tracks
   ═══════════════════════════════════════════════════════════════ */
window.WebRTCManager = (function () {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // TURN relay servers — required for internet/mobile connections
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  const peers = new Map();          // peerId -> RTCPeerConnection
  const negLocks = new Map();       // peerId -> Promise (negotiation queue)
  let socket = null;
  let localAudioStream = null;
  let localVideoStream = null;
  let onRemoteTrack = null;         // callback(peerId, track, kind)
  let onPeerClosed = null;          // callback(peerId)

  function init(sock, callbacks = {}) {
    socket = sock;
    onRemoteTrack = callbacks.onRemoteTrack || (() => {});
    onPeerClosed  = callbacks.onPeerClosed  || (() => {});

    socket.on('rtc-offer', async ({ from, offer }) => {
      const pc = getOrCreatePeer(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc-answer', { to: from, answer });
      } catch (e) {
        console.warn('rtc-offer handling error:', e);
      }
    });

    socket.on('rtc-answer', async ({ from, answer }) => {
      const pc = peers.get(from);
      if (pc) {
        try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); }
        catch (e) { console.warn('rtc-answer error:', e); }
      }
    });

    socket.on('rtc-ice', async ({ from, candidate }) => {
      const pc = peers.get(from);
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (e) { /* ignore late ICE */ }
      }
    });

    socket.on('peer-disconnected', ({ id }) => closePeer(id));
  }

  function getOrCreatePeer(peerId) {
    if (peers.has(peerId)) return peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(peerId, pc);
    negLocks.set(peerId, Promise.resolve());

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('rtc-ice', { to: peerId, candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      onRemoteTrack(peerId, e.track, e.track.kind);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        // Try ICE restart
        negotiatePeer(peerId, true);
      }
      if (pc.iceConnectionState === 'disconnected') {
        setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') closePeer(peerId);
        }, 5000);
      }
    };

    // Add any existing local streams to new peer
    if (localAudioStream) {
      localAudioStream.getTracks().forEach(t => pc.addTrack(t, localAudioStream));
    }
    if (localVideoStream) {
      localVideoStream.getTracks().forEach(t => pc.addTrack(t, localVideoStream));
    }

    return pc;
  }

  // ── Serialised negotiation per peer ───────────────────────
  // Queues offers so audio and video never collide mid-handshake
  function negotiatePeer(peerId, iceRestart = false) {
    const prev = negLocks.get(peerId) || Promise.resolve();
    const next = prev.then(async () => {
      const pc = peers.get(peerId);
      if (!pc) return;
      try {
        const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : {});
        await pc.setLocalDescription(offer);
        socket.emit('rtc-offer', { to: peerId, offer });
      } catch (e) {
        console.warn('negotiatePeer error:', e);
      }
    });
    negLocks.set(peerId, next);
    return next;
  }

  async function connectToPeer(peerId) {
    getOrCreatePeer(peerId);
    await negotiatePeer(peerId);
  }

  function closePeer(peerId) {
    const pc = peers.get(peerId);
    if (pc) {
      pc.close();
      peers.delete(peerId);
      negLocks.delete(peerId);
      onPeerClosed(peerId);
    }
  }

  function closeAll() {
    for (const [id] of peers) closePeer(id);
  }

  // ── Audio (PTT) ──────────────────────────────────────────
  async function startAudio() {
    try {
      localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      for (const [peerId, pc] of peers) {
        const senders = pc.getSenders();
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (!audioSender) {
          localAudioStream.getTracks().forEach(t => pc.addTrack(t, localAudioStream));
        } else {
          await audioSender.replaceTrack(localAudioStream.getTracks()[0]);
        }
        // Queue renegotiation — won't overlap with video
        negotiatePeer(peerId);
      }

      // Mute by default (PTT controls unmute)
      localAudioStream.getTracks().forEach(t => { t.enabled = false; });
      return localAudioStream;
    } catch (e) {
      console.error('Mic access denied:', e);
      return null;
    }
  }

  function setAudioEnabled(enabled) {
    if (localAudioStream) {
      localAudioStream.getTracks().forEach(t => { t.enabled = enabled; });
    }
  }

  function stopAudio() {
    if (localAudioStream) {
      localAudioStream.getTracks().forEach(t => t.stop());
      localAudioStream = null;
    }
  }

  // ── Video (Camera) ───────────────────────────────────────
  async function startVideo(facingMode = 'environment') {
    // Stop any existing stream first
    if (localVideoStream) {
      localVideoStream.getTracks().forEach(t => t.stop());
      localVideoStream = null;
    }

    // Try with facing constraint first, fall back to basic video
    try {
      localVideoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode } }
      });
    } catch (e1) {
      console.warn('Facing constraint failed, trying basic video:', e1);
      try {
        localVideoStream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (e2) {
        console.error('Camera access denied:', e2);
        return null;
      }
    }

    for (const [peerId, pc] of peers) {
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (!videoSender) {
        localVideoStream.getTracks().forEach(t => pc.addTrack(t, localVideoStream));
        // Queue renegotiation — won't overlap with audio
        negotiatePeer(peerId);
      } else {
        // replaceTrack does NOT require renegotiation
        await videoSender.replaceTrack(localVideoStream.getTracks()[0]);
      }
    }

    return localVideoStream;
  }

  function stopVideo() {
    if (localVideoStream) {
      localVideoStream.getTracks().forEach(t => t.stop());
      for (const [, pc] of peers) {
        pc.getSenders().forEach(s => {
          if (s.track && s.track.kind === 'video') pc.removeTrack(s);
        });
      }
      localVideoStream = null;
    }
  }

  function getLocalVideoStream() { return localVideoStream; }
  function getLocalAudioStream() { return localAudioStream; }
  function getPeers() { return peers; }

  return {
    init, connectToPeer, closePeer, closeAll, getPeers,
    startAudio, stopAudio, setAudioEnabled, getLocalAudioStream,
    startVideo, stopVideo, getLocalVideoStream
  };
})();
