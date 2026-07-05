/* ═══════════════════════════════════════════════════════════════
   Map Module — Leaflet map with teammate markers
   ═══════════════════════════════════════════════════════════════ */
window.TacMap = (function () {
  let map = null;
  const markers = new Map(); // id -> { marker, popup }

  function init() {
    map = L.map('map', {
      center: [0, 0],
      zoom: 3,
      zoomControl: false,
      attributionControl: true
    });

    // Clean, easy-to-read OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    }).addTo(map);

    // Handle resize
    window.addEventListener('resize', () => map.invalidateSize());
    setTimeout(() => map.invalidateSize(), 300);
  }

  function createMarkerIcon(callsign, color, isSelf) {
    const html = `
      <div class="marker-icon ${isSelf ? 'marker-self' : ''}">
        <div class="marker-pulse" style="background:${color}"></div>
        <div class="marker-dot" style="background:${color}"></div>
        <div class="marker-label">${callsign}</div>
      </div>
    `;
    return L.divIcon({
      html,
      className: '',
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
  }

  function updateMarker(id, { lat, lng, callsign, color, isSelf }) {
    if (!map || lat == null || lng == null) return;

    const latlng = [lat, lng];

    if (markers.has(id)) {
      const m = markers.get(id);
      m.marker.setLatLng(latlng);
      m.marker.setIcon(createMarkerIcon(callsign, color, isSelf));
    } else {
      const icon = createMarkerIcon(callsign, color, isSelf);
      const marker = L.marker(latlng, { icon }).addTo(map);
      markers.set(id, { marker, callsign, color });

      // If first marker, zoom in
      if (markers.size === 1) {
        map.setView(latlng, 16);
      }
    }
  }

  function removeMarker(id) {
    if (markers.has(id)) {
      map.removeLayer(markers.get(id).marker);
      markers.delete(id);
    }
  }

  function centerOn(lat, lng, zoom) {
    if (map) map.setView([lat, lng], zoom || map.getZoom());
  }

  function fitTeam() {
    if (markers.size === 0) return;
    const bounds = [];
    for (const [, m] of markers) {
      bounds.push(m.marker.getLatLng());
    }
    if (bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.3));
    }
  }

  function getMap() { return map; }

  return { init, updateMarker, removeMarker, centerOn, fitTeam, getMap };
})();
