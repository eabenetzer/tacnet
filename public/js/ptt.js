/* ═══════════════════════════════════════════════════════════════
   PTT Module — Push-to-Talk with WebRTC audio
   ═══════════════════════════════════════════════════════════════ */
window.PTT = (function () {
  let socket = null;
  let audioReady = false;
  let isTalking = false;
  const pttBtn = document.getElementById('ptt-btn');
  const pttIndicator = document.getElementById('ptt-indicator');
  const pttIndicatorName = document.getElementById('ptt-indicator-name');

  // Audio context for PTT beep
  let audioCtx = null;

  function init(sock) {
    socket = sock;

    // Touch events for mobile (hold to talk)
    pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTalk(); }, { passive: false });
    pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTalk(); }, { passive: false });
    pttBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); stopTalk(); }, { passive: false });

    // Mouse events for desktop
    pttBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startTalk(); });
    pttBtn.addEventListener('mouseup', (e) => { e.preventDefault(); stopTalk(); });
    pttBtn.addEventListener('mouseleave', () => { if (isTalking) stopTalk(); });

    // Keyboard shortcut — hold spacebar
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        startTalk();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        stopTalk();
      }
    });

    // Listen for others talking
    socket.on('ptt-active', ({ callsign, color }) => {
      pttIndicatorName.textContent = `${callsign} is talking`;
      pttIndicatorName.style.color = '#fff';
      pttIndicator.classList.remove('hidden');
    });

    socket.on('ptt-inactive', () => {
      pttIndicator.classList.add('hidden');
    });
  }

  async function startTalk() {
    if (isTalking) return;
    isTalking = true;
    pttBtn.classList.add('active');

    // Initialize audio if first time
    if (!audioReady) {
      const stream = await WebRTCManager.startAudio();
      if (stream) audioReady = true;
      else {
        isTalking = false;
        pttBtn.classList.remove('active');
        return;
      }
    }

    // Enable mic
    WebRTCManager.setAudioEnabled(true);
    socket.emit('ptt-start');
    playBeep(800, 0.08);
  }

  function stopTalk() {
    if (!isTalking) return;
    isTalking = false;
    pttBtn.classList.remove('active');

    // Mute mic
    WebRTCManager.setAudioEnabled(false);
    socket.emit('ptt-stop');
    playBeep(500, 0.06);
  }

  function playBeep(freq, duration) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.value = 0.15;
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) { /* no audio context */ }
  }

  return { init };
})();
