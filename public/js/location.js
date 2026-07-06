/* ═══════════════════════════════════════════════════════════════
   Location Module — GPS tracking with battery optimization
   ═══════════════════════════════════════════════════════════════ */
window.GeoLocation = (function () {
  let timerId = null;
  let socket = null;
  let lastLat = null;
  let lastLng = null;
  let onUpdate = null;  // callback(lat, lng, heading, speed)
  
  let boostMode = false;
  let updateInterval = 15000; // 15 seconds normally
  const BOOST_INTERVAL = 3000; // 3 seconds in boost mode
  const DISTANCE_THRESHOLD = 75; // meters

  function init(sock, callback) {
    socket = sock;
    onUpdate = callback || (() => {});
  }
  
  // Haversine formula to calculate distance in meters
  function calcDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  function fetchPosition() {
    if (!navigator.geolocation) return;
    
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, heading, speed } = pos.coords;
        
        let shouldUpdate = false;
        
        if (lastLat === null || lastLng === null) {
          shouldUpdate = true;
        } else {
          const dist = calcDistance(lastLat, lastLng, latitude, longitude);
          // Update if moved > 75m, OR if in boost mode
          if (dist >= DISTANCE_THRESHOLD || boostMode) {
            shouldUpdate = true;
          }
        }

        if (shouldUpdate) {
          lastLat = latitude;
          lastLng = longitude;
          socket.emit('location', {
            lat: latitude,
            lng: longitude,
            heading: heading || 0,
            speed: speed || 0
          });
          onUpdate(latitude, longitude, heading, speed);
        }
      },
      (err) => {
        console.warn('Geolocation error:', err.message);
      },
      {
        enableHighAccuracy: boostMode, // Only use high power GPS if boosting
        maximumAge: updateInterval,
        timeout: 5000
      }
    );
  }

  function start() {
    if (timerId) clearInterval(timerId);
    fetchPosition(); // immediate fetch
    timerId = setInterval(fetchPosition, updateInterval);
  }

  function stop() {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  function toggleBoost() {
    boostMode = !boostMode;
    updateInterval = boostMode ? BOOST_INTERVAL : 15000;
    start(); // Restart timer with new interval
    return boostMode;
  }

  function getLast() {
    return { lat: lastLat, lng: lastLng };
  }

  return { init, start, stop, getLast, toggleBoost };
})();
