/* ═══════════════════════════════════════════════════════════════
   Location Module — GPS tracking via Geolocation API
   ═══════════════════════════════════════════════════════════════ */
window.GeoLocation = (function () {
  let watchId = null;
  let socket = null;
  let lastLat = null;
  let lastLng = null;
  let onUpdate = null;  // callback(lat, lng, heading, speed)

  function init(sock, callback) {
    socket = sock;
    onUpdate = callback || (() => {});
  }

  function start() {
    if (!navigator.geolocation) {
      console.warn('Geolocation not supported');
      return;
    }

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, heading, speed } = pos.coords;
        lastLat = latitude;
        lastLng = longitude;

        // Send to server
        socket.emit('location', {
          lat: latitude,
          lng: longitude,
          heading: heading || 0,
          speed: speed || 0
        });

        onUpdate(latitude, longitude, heading, speed);
      },
      (err) => {
        console.warn('Geolocation error:', err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 10000
      }
    );
  }

  function stop() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function getLast() {
    return { lat: lastLat, lng: lastLng };
  }

  return { init, start, stop, getLast };
})();
