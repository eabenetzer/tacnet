/* ═══════════════════════════════════════════════════════════════
   WebRTC Manager — Peer connections, STUN, ICE, tracks
   ═══════════════════════════════════════════════════════════════ */
window.WebRTCManager = (function () {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  const peers = new Map(); // peerId -> RTCPeerConnection
  let socket = null;
  let localAudioStream = null;
  let localVideoStream = null;
  let onRemoteTrack = null;   // callback(peerId, track, kind)
  let onPeerClosed = null;    // callback(peerId)

  function init(sock, callbacks = {}) {
    socket = sock;
    onRemoteTrack = callbacks.onRemoteTrack || (() => {});
    onPeerClosed = callbacks.onPeerClosed || (() => {});

    socket.on('rtc-offer', async ({ from, offer }) => {
      const pc = getOrCreatePeer(from);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtc-answer', { to: from, answer });
    });

    socket.on('rtc-answer', async ({ from, answer }) => {
      const pc = peers.get(from);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('rtc-ice', async ({ from, candidate }) => {
      const pc = peers.get(from);
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (e) { /* ignore late ICE */ }
      }
    });

    socket.on('peer-disconnected', ({ id }) => {
      closePeer(id);
    });
  }

  function getOrCreatePeer(peerId) {
    if (peers.has(peerId)) return peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(peerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('rtc-ice', { to: peerId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      const track = e.track;
      onRemoteTrack(peerId, track, track.kind);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        closePeer(peerId);
      }
    };

    // Add any existing local streams
    if (localAudioStream) {
      localAudioStream.getTracks().forEach(t => pc.addTrack(t, localAudioStream));
    }
    if (localVideoStream) {
      localVideoStream.getTracks().forEach(t => pc.addTrack(t, localVideoStream));
    }

    return pc;
  }

  async function connectToPeer(peerId) {
    const pc = getOrCreatePeer(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc-offer', { to: peerId, offer });
  }

  function closePeer(peerId) {
    const pc = peers.get(peerId);
    if (pc) {
      pc.close();
      peers.delete(peerId);
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
      // Add audio track to all existing peers
      for (const [peerId, pc] of peers) {
        localAudioStream.getTracks().forEach(t => {
          // check if already has sender for this track kind
          const senders = pc.getSenders();
          const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
          if (!audioSender) {
            pc.addTrack(t, localAudioStream);
          } else {
            audioSender.replaceTrack(t);
          }
        });
        // Renegotiate
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtc-offer', { to: peerId, offer });
      }
      // Mute by default (PTT controls this)
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
  async function startVideo() {
    try {
      localVideoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      // Add video track to all existing peers
      for (const [peerId, pc] of peers) {
        localVideoStream.getTracks().forEach(t => {
          const senders = pc.getSenders();
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          if (!videoSender) {
            pc.addTrack(t, localVideoStream);
          } else {
            videoSender.replaceTrack(t);
          }
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtc-offer', { to: peerId, offer });
      }
      return localVideoStream;
    } catch (e) {
      console.error('Camera access denied:', e);
      return null;
    }
  }

  function stopVideo() {
    if (localVideoStream) {
      localVideoStream.getTracks().forEach(t => t.stop());
      // Remove video senders from all peers
      for (const [, pc] of peers) {
        const senders = pc.getSenders();
        senders.forEach(s => {
          if (s.track && s.track.kind === 'video') {
            pc.removeTrack(s);
          }
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
