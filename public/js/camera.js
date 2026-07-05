/* ═══════════════════════════════════════════════════════════════
   Camera Module — Share phone camera via WebRTC
   ═══════════════════════════════════════════════════════════════ */
window.Camera = (function () {
  let socket = null;
  let cameraOn = false;
  const localVideoContainer = document.getElementById('local-video-container');
  const localVideo = document.getElementById('local-video');
  const cameraFeeds = document.getElementById('camera-feeds');
  const myCamBtn = document.getElementById('btn-my-cam');

  const remoteVideos = new Map(); // peerId -> video element

  function init(sock) {
    socket = sock;

    myCamBtn.addEventListener('click', toggleCamera);

    // Remote camera events
    socket.on('camera-on', ({ id, callsign }) => {
      // Remote peer turned on camera — the video track will arrive via WebRTC ontrack
    });

    socket.on('camera-off', ({ id }) => {
      removeRemoteFeed(id);
    });
  }

  async function toggleCamera() {
    if (cameraOn) {
      stopCamera();
    } else {
      await startCamera();
    }
  }

  async function startCamera() {
    const stream = await WebRTCManager.startVideo();
    if (!stream) return;

    cameraOn = true;
    myCamBtn.classList.add('active');
    localVideo.srcObject = stream;
    localVideoContainer.classList.remove('hidden');

    socket.emit('camera-on');
  }

  function stopCamera() {
    WebRTCManager.stopVideo();
    cameraOn = false;
    myCamBtn.classList.remove('active');
    localVideo.srcObject = null;
    localVideoContainer.classList.add('hidden');

    socket.emit('camera-off');
  }

  function addRemoteTrack(peerId, track) {
    if (track.kind !== 'video') return;

    let container = remoteVideos.get(peerId);
    if (!container) {
      container = document.createElement('div');
      container.className = 'camera-feed';
      container.id = `feed-${peerId}`;

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = false;

      const label = document.createElement('span');
      label.className = 'camera-feed-label';
      label.textContent = peerId.substring(0, 6);

      container.appendChild(video);
      container.appendChild(label);
      cameraFeeds.appendChild(container);

      remoteVideos.set(peerId, container);
    }

    const video = container.querySelector('video');
    let stream = video.srcObject;
    if (!stream) {
      stream = new MediaStream();
      video.srcObject = stream;
    }
    stream.addTrack(track);
  }

  function updateFeedLabel(peerId, callsign) {
    const container = remoteVideos.get(peerId);
    if (container) {
      const label = container.querySelector('.camera-feed-label');
      if (label) label.textContent = callsign;
    }
  }

  function removeRemoteFeed(peerId) {
    const container = remoteVideos.get(peerId);
    if (container) {
      const video = container.querySelector('video');
      if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
      }
      container.remove();
      remoteVideos.delete(peerId);
    }
  }

  return { init, addRemoteTrack, updateFeedLabel, removeRemoteFeed };
})();
