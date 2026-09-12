/* Flight Finder — live plane map.
 *
 * Positions come from api.adsb.lol and route/aircraft details from api.adsbdb.com,
 * both through our own /api/* proxy so the browser never hits a CORS wall.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------- constants */

  var REFRESH_MS = 8000;        // how often we ask for fresh positions
  var ANIM_MS = 120;            // how often we nudge planes along between updates
  var MAX_EXTRAPOLATE_S = 45;   // never guess a position further ahead than this
  var MAX_MARKERS = 260;        // keep the map (and the eye) from being overwhelmed
  var LABEL_ZOOM = 9;           // show flight numbers on the map from this zoom in
  var KM_PER_NM = 1.852;
  var MI_PER_NM = 1.15078;
  var FT_PER_M = 3.28084;

  var imperial = /^en-(US|LR|MM)/i.test(navigator.language || 'en-US');
  try {
    var savedUnits = localStorage.getItem('ff-units');
    if (savedUnits) imperial = savedUnits === 'imperial';
  } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------ dom handles */

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    map: $('map'),
    banner: $('banner'),
    refreshBtn: $('refreshBtn'),
    settingsBtn: $('settingsBtn'),
    settingsOverlay: $('settingsOverlay'),
    settingsClose: $('settingsClose'),
    settingsStatus: $('settingsStatus'),
    sizeChoices: $('sizeChoices'),
    unitChoices: $('unitChoices'),
    showHelpBtn: $('showHelpBtn'),
    locateBtn: $('locateBtn'),
    searchForm: $('searchForm'),
    searchInput: $('searchInput'),
    panel: $('panel'),
    panelHandle: $('panelHandle'),
    panelHandleText: $('panelHandleText'),
    panelBody: $('panelBody'),
    listView: $('listView'),
    airportView: $('airportView'),
    airportName: $('airportName'),
    airportWhere: $('airportWhere'),
    groundList: $('groundList'),
    groundTitle: $('groundTitle'),
    arrivalsList: $('arrivalsList'),
    arrivalsTitle: $('arrivalsTitle'),
    departuresList: $('departuresList'),
    departuresTitle: $('departuresTitle'),
    nearbyList: $('nearbyList'),
    nearbyTitle: $('nearbyTitle'),
    trackNote: $('trackNote'),
    bottomNav: $('bottomNav'),
    destBtn: $('destBtn'),
    listTitle: $('listTitle'),
    listHint: $('listHint'),
    flightList: $('flightList'),
    detailView: $('detailView'),
    backBtn: $('backBtn'),
    flightTitle: $('flightTitle'),
    flightSub: $('flightSub'),
    fromCode: $('fromCode'),
    fromCity: $('fromCity'),
    toCode: $('toCode'),
    toCity: $('toCity'),
    progressWrap: $('progressWrap'),
    progressBar: $('progressBar'),
    progressText: $('progressText'),
    factStatus: $('factStatus'),
    factAlt: $('factAlt'),
    factSpeed: $('factSpeed'),
    factType: $('factType'),
    photoWrap: $('photoWrap'),
    photo: $('photo'),
    followBtn: $('followBtn'),
    helpOverlay: $('helpOverlay'),
    helpClose: $('helpClose')
  };

  /* ----------------------------------------------------------------- state */

  var state = {
    planes: {},          // hex -> plane record (with animated lat/lon)
    markers: {},         // hex -> { marker, iconEl, rotEl, labelEl }
    routes: {},          // callsign -> route or null
    aircraftInfo: {},    // hex -> aircraft details or null
    selected: null,      // hex
    follow: false,
    lastUpdate: 0,
    loading: false,
    me: null,            // {lat, lon}
    meMarker: null,
    routeLayer: null,
    listSignature: '',
    view: 'list',
    airport: null,
    airportFocus: 'all',
    tab: 'home',
    status: 'Starting up…',
    bannerOwner: null
  };

  /* ------------------------------------------------------------------- map */

  var map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
    tap: true
  });

  // A calm, pale base map keeps the planes themselves the loudest thing on screen.
  var ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  L.tileLayer(ESRI + 'World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Map &copy; Esri &middot; flight data from adsb.lol and adsbdb.com',
    maxZoom: 16,
    minZoom: 3
  }).addTo(map);
  L.tileLayer(ESRI + 'World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16,
    minZoom: 3,
    pane: 'shadowPane'
  }).addTo(map);

  map.setView(guessHome(), 8);

  /* Guess a sensible starting place from the computer's time zone, so the very
     first screen is never an empty ocean if location sharing is declined. */
  function guessHome() {
    var zones = {
      'America/Los_Angeles': [33.94, -118.41], 'America/Vancouver': [49.19, -123.18],
      'America/Denver': [39.86, -104.67], 'America/Phoenix': [33.44, -112.01],
      'America/Chicago': [41.98, -87.90], 'America/New_York': [40.69, -74.17],
      'America/Toronto': [43.68, -79.63], 'America/Mexico_City': [19.44, -99.07],
      'America/Sao_Paulo': [-23.43, -46.47], 'Europe/London': [51.47, -0.45],
      'Europe/Dublin': [53.43, -6.25], 'Europe/Paris': [49.01, 2.55],
      'Europe/Madrid': [40.47, -3.56], 'Europe/Berlin': [52.36, 13.50],
      'Europe/Amsterdam': [52.31, 4.76], 'Europe/Rome': [41.80, 12.25],
      'Europe/Zurich': [47.46, 8.55], 'Europe/Stockholm': [59.65, 17.92],
      'Europe/Moscow': [55.41, 37.90], 'Europe/Istanbul': [41.28, 28.75],
      'Asia/Dubai': [25.25, 55.36], 'Asia/Tokyo': [35.55, 139.78],
      'Asia/Singapore': [1.36, 103.99], 'Asia/Hong_Kong': [22.31, 113.91],
      'Asia/Shanghai': [31.14, 121.81], 'Asia/Seoul': [37.46, 126.44],
      'Asia/Kolkata': [28.56, 77.10], 'Australia/Sydney': [-33.94, 151.18],
      'Australia/Melbourne': [-37.67, 144.84], 'Pacific/Auckland': [-37.01, 174.79],
      'Africa/Johannesburg': [-26.14, 28.25], 'Africa/Cairo': [30.11, 31.41]
    };
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ignore */ }
    return zones[tz] || zones['Europe/London'];
  }

  /* --------------------------------------------------------------- airports */

  /* The airport list ships with the app, so pins appear instantly and work
     even when the flight service is having a bad day. */
  var AIRPORT_ZOOM = { 1: 7, 2: 10 };  // big airports appear sooner than small ones
  var airports = [];
  var airportMarkers = {};

  fetch('airports.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      airports = data.airports.map(function (a) {
        return { iata: a[0], icao: a[1], name: a[2], city: a[3], country: a[4],
                 lat: a[5], lon: a[6], size: a[7] };
      });
      drawAirports();
    })
    .catch(function () { /* the map still works without pins */ });

  function drawAirports() {
    var zoom = map.getZoom();
    var bounds = map.getBounds();
    var keep = {};

    airports.forEach(function (ap) {
      if (zoom < AIRPORT_ZOOM[ap.size]) return;
      if (!bounds.contains([ap.lat, ap.lon])) return;
      if (Object.keys(keep).length > 45) return;
      keep[ap.iata] = true;

      if (!airportMarkers[ap.iata]) {
        var marker = L.marker([ap.lat, ap.lon], {
          icon: L.divIcon({
            className: '',
            html: '<div class="airport-pin">' + escapeHtml(ap.iata) + '</div>',
            iconSize: null,
            iconAnchor: [16, 14]
          }),
          keyboard: true,
          title: ap.name,
          zIndexOffset: 1000   // few in number, and always worth being able to tap
        }).addTo(map);
        marker.on('click', function () { openAirport(ap); });
        airportMarkers[ap.iata] = marker;
      }
    });

    Object.keys(airportMarkers).forEach(function (iata) {
      if (keep[iata]) return;
      map.removeLayer(airportMarkers[iata]);
      delete airportMarkers[iata];
    });
  }

  /* ------------------------------------------------------------ geo helpers */

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  // Great-circle distance in nautical miles.
  function distanceNm(a, b) {
    var dLat = toRad(b[0] - a[0]);
    var dLon = toRad(b[1] - a[1]);
    var la1 = toRad(a[0]), la2 = toRad(b[0]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  // Points along the great circle between two coordinates, for a route line
  // that follows the path a plane actually flies.
  function greatCircle(a, b, steps) {
    var la1 = toRad(a[0]), lo1 = toRad(a[1]);
    var la2 = toRad(b[0]), lo2 = toRad(b[1]);
    var d = 2 * Math.asin(Math.sqrt(
      Math.pow(Math.sin((la1 - la2) / 2), 2) +
      Math.cos(la1) * Math.cos(la2) * Math.pow(Math.sin((lo1 - lo2) / 2), 2)));
    if (!d || !isFinite(d)) return [a, b];

    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var f = i / steps;
      var A = Math.sin((1 - f) * d) / Math.sin(d);
      var B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      var y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      var z = A * Math.sin(la1) + B * Math.sin(la2);
      pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
    }
    return unwrap(pts);
  }

  // Keep a line from smearing across the whole map when it crosses the date line.
  function unwrap(pts) {
    for (var i = 1; i < pts.length; i++) {
      var delta = pts[i][1] - pts[i - 1][1];
      if (delta > 180) pts[i][1] -= 360;
      else if (delta < -180) pts[i][1] += 360;
    }
    return pts;
  }

  /* ------------------------------------------------------------- formatting */

  var regionNames = null;
  try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { /* ignore */ }

  function countryName(code) {
    if (!code) return '';
    if (code.length > 3) return code;           // already a full name
    try { return regionNames ? regionNames.of(code) : code; } catch (e) { return code; }
  }

  function formatAltitude(ft, onGround) {
    if (onGround) return 'On the ground';
    if (ft === null || ft === undefined) return 'Not known';
    if (imperial) return Math.round(ft / 100) * 100 + ' feet' + (ft >= 18000 ? '' : '');
    return Math.round(ft / FT_PER_M / 10) * 10 + ' metres';
  }

  function formatSpeed(knots) {
    if (knots === null || knots === undefined) return 'Not known';
    return imperial
      ? Math.round(knots * MI_PER_NM) + ' mph'
      : Math.round(knots * KM_PER_NM) + ' km/h';
  }

  function formatDistance(nm) {
    return imperial
      ? Math.round(nm * MI_PER_NM).toLocaleString() + ' miles'
      : Math.round(nm * KM_PER_NM).toLocaleString() + ' km';
  }

  function formatDuration(hours) {
    var mins = Math.round(hours * 60);
    if (mins < 1) return 'less than a minute';
    if (mins < 60) return mins + (mins === 1 ? ' minute' : ' minutes');
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + (h === 1 ? ' hour' : ' hours') + (m ? ' ' + m + ' minutes' : '');
  }

  function plainStatus(p) {
    if (p.onGround) return 'On the ground';
    var vs = p.verticalRate;
    var low = p.altitude !== null && p.altitude < 3000;
    if (vs !== null && vs > 500) return low ? 'Just taken off' : 'Climbing up';
    if (vs !== null && vs < -500) return low ? 'About to land' : 'Coming down';
    if (low) return 'Close to the ground';
    return 'Cruising along';
  }

  /* A flight number can cover several legs in a day (ORD-FCA-ORD). Pick the leg
     this aircraft is actually flying: the one it sits most neatly between. */
  function pickLeg(route, lat, lon) {
    if (!route || !route.airports || route.airports.length < 2) return null;
    var aps = route.airports;
    var best = null;
    for (var i = 0; i < aps.length - 1; i++) {
      var a = [aps[i].lat, aps[i].lon];
      var b = [aps[i + 1].lat, aps[i + 1].lon];
      var detour = distanceNm(a, [lat, lon]) + distanceNm([lat, lon], b) - distanceNm(a, b);
      if (!best || detour < best.detour) {
        best = { origin: aps[i], destination: aps[i + 1], detour: detour };
      }
    }
    return best;
  }

  function legFor(p) {
    var route = p && p.callsign ? state.routes[p.callsign] : null;
    return pickLeg(route, p.animLat, p.animLon);
  }

  // "SWA184" reads as gibberish; "Southwest 184" does not.
  function friendlyName(p) {
    var route = p.callsign ? state.routes[p.callsign] : null;
    if (route && route.airline) {
      var num = route.number || (p.callsign || '').replace(/^[A-Z]{3}/, '');
      return route.airline + (num ? ' ' + num : '');
    }
    if (p.callsign) return p.callsign;
    return p.registration || 'Unknown plane';
  }

  // True for aircraft with no airline flight number — private and business flights.
  function isPrivate(p) {
    return !p.callsign || (p.registration && p.callsign === p.registration);
  }

  function routeSummary(p) {
    var leg = legFor(p);
    if (!leg) return null;
    return (leg.origin.city || leg.origin.iata || '?') + ' → ' +
           (leg.destination.city || leg.destination.iata || '?');
  }

  /* ------------------------------------------------------------- plane icon */

  var PLANE_PATH = 'M16 1.6c1.2 0 2.1 1.6 2.1 3.9v6.1l11.3 6.6v3.2L18.1 18v6.4l3.7 2.5v2.6L16 27.8l-5.8 1.7v-2.6l3.7-2.5V18L2.6 21.4v-3.2l11.3-6.6V5.5c0-2.3.9-3.9 2.1-3.9z';
  var HELI_PATH = 'M3 4.4h26v2.4H17.2v2.3c4.4.5 7.5 3.6 7.5 7.6v5.1c0 1.5-1.1 2.6-2.5 2.6h-6.4v2.2h5v2.6H10.6v-2.6h2.6v-2.2H9.4c-1.4 0-2.5-1.1-2.5-2.6v-5.1c0-4 3.1-7.1 7.5-7.6V6.8H3V4.4z';

  /* A jumbo and a four-seat trainer should not look the same. The ADS-B
     emitter category is the most reliable size signal; the type code fills in
     when a category is missing. */
  var CATEGORY_SIZE = {
    A1: 20,  // light aircraft
    A2: 25,  // small
    A3: 30,  // large — most airliners
    A4: 34,  // high-vortex large, such as a 757
    A5: 40,  // heavy — 747, 777, A350, A380
    A6: 27,  // high performance
    A7: 24,  // rotorcraft
    B1: 18, B2: 18, B3: 18, B4: 18, B6: 20, B7: 18
  };
  var HEAVY_TYPES = /^(A3[458]|A22|B74|B77|B78|B75|MD11|IL96|AN12|C5M|C17|K35)/;
  var LIGHT_TYPES = /^(C1[5678]|C2[02]|PA[23]|SR2|DA[24]|BE[2359]|P28|M20|TBM|AT7?[5-8]|GLID)/;

  function markerSize(p) {
    var byCategory = CATEGORY_SIZE[p.category];
    if (byCategory) return byCategory;
    var t = p.typeCode || '';
    if (HEAVY_TYPES.test(t)) return 38;
    if (LIGHT_TYPES.test(t)) return 21;
    if (/^(E1|E7|CRJ|CL6|RJ|SF3|DH8|AT4|AT7)/.test(t)) return 26;  // regional
    return 29;
  }

  function isHelicopter(p) {
    return p.category === 'A7' || /^(EC|AS3|R44|R66|S76|B06|B41|H60|UH|AW1)/.test(p.typeCode || '');
  }

  // Airport service vehicles also broadcast; they are not planes in the sky.
  function isGroundVehicle(p) {
    return p.category === 'C1' || p.category === 'C2' || p.category === 'C3';
  }

  function makeIcon(p) {
    var size = markerSize(p);
    var heli = isHelicopter(p);
    var svg = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 32 32" aria-hidden="true">' +
              '<path class="plane-body" d="' + (heli ? HELI_PATH : PLANE_PATH) + '"/></svg>';
    return L.divIcon({
      className: 'plane-icon-wrap',
      html: '<div class="plane-marker" style="width:' + size + 'px;height:' + size + 'px">' +
            '<div class="rot">' + svg + '</div><span class="plane-label"></span></div>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }

  /* ----------------------------------------------------------- data loading */

  function viewRadiusNm() {
    var b = map.getBounds();
    var c = map.getCenter();
    var r = distanceNm([c.lat, c.lng], [b.getNorth(), b.getEast()]);
    return Math.max(2, Math.min(250, Math.ceil(r)));
  }

  /* The map stays uncluttered: routine progress lives in Settings, and only
     something the user needs to know about interrupts them on the map. */
  function setStatus(text, kind) {
    state.status = text;
    el.settingsStatus.textContent = text;
    if (kind === 'bad') showBanner(text, 'status');
    else if (state.bannerOwner === 'status') showBanner(null);
  }

  function showBanner(text, owner) {
    if (!text) {
      el.banner.hidden = true;
      state.bannerOwner = null;
      return;
    }
    el.banner.textContent = text;
    el.banner.hidden = false;
    state.bannerOwner = owner || 'status';
  }

  var refreshTimer = null;
  var moveTimer = null;
  var failures = 0;

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    // Back off politely when the data service is unhappy, instead of hammering it.
    var delay = failures ? Math.min(REFRESH_MS * Math.pow(2, failures), 60000) : REFRESH_MS;
    refreshTimer = setTimeout(refresh, delay);
  }

  function refresh() {
    if (state.loading || document.hidden) { scheduleRefresh(); return; }
    state.loading = true;
    setStatus('Looking for planes…', 'busy');

    var c = map.getCenter();
    var radius = viewRadiusNm();
    var url = '/api/flights?lat=' + c.lat.toFixed(4) + '&lon=' + c.lng.toFixed(4) + '&dist=' + radius;

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        failures = 0;
        ingest(data.aircraft || []);
        state.lastUpdate = Date.now();
        setStatus(data.stale
          ? 'The flight service is busy. Showing the last positions we have.'
          : describeCount(data.aircraft.length), data.stale ? 'busy' : '');
        showBanner(map.getZoom() <= 5
          ? 'Zoom in a little to see every plane. Right now you are seeing planes within ' +
            formatDistance(250) + ' of the middle of the map.'
          : null);
        fetchRoutesFor(visiblePlanes());
      })
      .catch(function (err) {
        console.warn(err);
        failures++;
        // The planes already on screen stay there; we simply try again later.
        setStatus(Object.keys(state.planes).length
          ? 'The flight service is busy. These positions are a little old.'
          : 'Cannot reach the flight service right now. Trying again…', 'bad');
      })
      .then(function () {
        state.loading = false;
        scheduleRefresh();
      });
  }

  function describeCount(n) {
    if (!n) return 'No planes in this part of the sky right now.';
    return (n === 1 ? '1 plane' : n + ' planes') + ' · just now';
  }

  function ingest(list) {
    var now = Date.now();
    var seen = {};

    list.forEach(function (p) {
      seen[p.hex] = true;
      var existing = state.planes[p.hex];
      p.animLat = p.lat;
      p.animLon = p.lon;
      p.fetchedAt = now;
      // Carry a known callsign forward if this sample happens to be missing one.
      if (!p.callsign && existing && existing.callsign) p.callsign = existing.callsign;
      state.planes[p.hex] = p;
    });

    // Drop planes we have not heard from for a while, but never the selected one.
    Object.keys(state.planes).forEach(function (hex) {
      if (seen[hex]) return;
      if (hex === state.selected && now - state.planes[hex].fetchedAt < 120000) return;
      delete state.planes[hex];
      removeMarker(hex);
    });

    drawPlanes();
    renderList();
    if (state.selected) renderDetail();
  }

  function visiblePlanes() {
    var b = map.getBounds().pad(0.15);
    var c = map.getCenter();
    var out = [];
    Object.keys(state.planes).forEach(function (hex) {
      var p = state.planes[hex];
      if (b.contains([p.animLat, p.animLon])) out.push(p);
    });
    out.sort(function (a, b2) {
      return distanceNm([c.lat, c.lng], [a.animLat, a.animLon]) -
             distanceNm([c.lat, c.lng], [b2.animLat, b2.animLon]);
    });
    return out;
  }

  function fetchRoutesFor(planes) {
    var wanted = [];
    var seen = {};
    var add = function (p) {
      if (!p || !p.callsign || seen[p.callsign]) return;
      if (state.routes[p.callsign] !== undefined) return;
      seen[p.callsign] = true;
      wanted.push({ callsign: p.callsign, lat: p.lat, lng: p.lon });
    };
    if (state.selected) add(state.planes[state.selected]);
    planes.slice(0, 80).forEach(add);
    if (!wanted.length) return;

    fetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes: wanted })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        Object.keys(data.routes || {}).forEach(function (cs) {
          state.routes[cs] = data.routes[cs];
        });
        state.listSignature = '';   // names/routes changed, so redraw the list
        renderList();
        updateLabels();
        if (state.selected) renderDetail();
      })
      .catch(function () { /* routes are a bonus; positions still work */ });
  }

  /* ---------------------------------------------------------------- markers */

  function removeMarker(hex) {
    var m = state.markers[hex];
    if (!m) return;
    map.removeLayer(m.marker);
    delete state.markers[hex];
  }

  /* Over a busy airport a hundred planes can land on the same few pixels.
     Keep one plane per small patch of screen so the map stays readable —
     the full list is still in the panel. */
  function declutter(planes) {
    var cell = 34;
    var taken = {};
    var out = [];
    for (var i = 0; i < planes.length; i++) {
      var p = planes[i];
      if (p.hex === state.selected) { out.push(p); continue; }
      var pt = map.latLngToContainerPoint([p.animLat, p.animLon]);
      var key = Math.round(pt.x / cell) + ',' + Math.round(pt.y / cell);
      if (taken[key]) continue;
      taken[key] = true;
      out.push(p);
    }
    return out;
  }

  function drawPlanes() {
    var hideGround = map.getZoom() < LABEL_ZOOM;
    var candidates = visiblePlanes().filter(function (p) {
      if (isGroundVehicle(p)) return false;
      return !(hideGround && p.onGround && p.hex !== state.selected);
    });
    // Airborne planes win a contested patch of screen over taxiing ones.
    candidates.sort(function (a, b) { return (a.onGround ? 1 : 0) - (b.onGround ? 1 : 0); });
    var list = declutter(candidates).slice(0, MAX_MARKERS);
    var keep = {};

    list.forEach(function (p) {
      keep[p.hex] = true;
      var m = state.markers[p.hex];

      if (m && m.size !== markerSize(p)) { removeMarker(p.hex); m = null; }

      if (!m) {
        var marker = L.marker([p.animLat, p.animLon], {
          icon: makeIcon(p),
          keyboard: true,
          riseOnHover: true,
          title: p.callsign || p.registration || 'Plane'
        }).addTo(map);
        marker.on('click', function () { select(p.hex, false); });
        var root = marker.getElement();
        m = state.markers[p.hex] = {
          marker: marker,
          size: markerSize(p),
          box: root.querySelector('.plane-marker'),
          rot: root.querySelector('.rot'),
          label: root.querySelector('.plane-label')
        };
      } else {
        m.marker.setLatLng([p.animLat, p.animLon]);
      }

      m.rot.style.transform = 'rotate(' + (p.track || 0) + 'deg)';
      m.box.className = 'plane-marker' +
        (p.onGround ? ' ground' : '') +
        (p.hex === state.selected ? ' selected' : '');
    });

    Object.keys(state.markers).forEach(function (hex) {
      if (!keep[hex]) removeMarker(hex);
    });

    updateLabels();
  }

  function updateLabels() {
    var showAll = map.getZoom() >= LABEL_ZOOM;
    Object.keys(state.markers).forEach(function (hex) {
      var p = state.planes[hex];
      var m = state.markers[hex];
      if (!p || !m) return;
      var show = showAll || hex === state.selected;
      m.label.textContent = show ? friendlyName(p) : '';
      m.label.style.display = show ? '' : 'none';
    });
  }

  /* Move planes along their heading between server updates so the map feels
     alive instead of jumping every eight seconds. */
  function animate() {
    var now = Date.now();
    Object.keys(state.planes).forEach(function (hex) {
      var p = state.planes[hex];
      if (p.onGround || !p.groundSpeed || p.track === null) return;
      var dt = Math.min((now - p.fetchedAt) / 1000, MAX_EXTRAPOLATE_S);
      if (dt <= 0) return;
      var nm = p.groundSpeed * dt / 3600;
      var rad = toRad(p.track);
      p.animLat = p.lat + (nm * Math.cos(rad)) / 60;
      var cosLat = Math.cos(toRad(p.lat)) || 1e-6;
      p.animLon = p.lon + (nm * Math.sin(rad)) / (60 * cosLat);
      var m = state.markers[hex];
      if (m) m.marker.setLatLng([p.animLat, p.animLon]);
    });

    if (state.selected && state.follow && state.planes[state.selected]) {
      var sp = state.planes[state.selected];
      map.panTo([sp.animLat, sp.animLon], { animate: false });
    }
    if (state.selected) drawRouteLine();

    var age = Math.round((now - state.lastUpdate) / 1000);
    if (state.lastUpdate && !state.loading && age > 12) {
      setStatus('Updated ' + age + ' seconds ago', 'busy');
    }
  }

  /* ------------------------------------------------------------------ views */

  function showView(which) {
    el.listView.hidden = which !== 'list';
    el.detailView.hidden = which !== 'detail';
    el.airportView.hidden = which !== 'airport';
    state.view = which;
    el.panelHandleText.textContent =
      which === 'detail' ? 'Show this flight' :
      which === 'airport' ? 'Show this airport' :
      'Show the list of planes';
    if (which !== 'list') {
      openPanel(true);
      el.panelBody.scrollTop = 0;
    }
  }

  /* ----------------------------------------------------------- airport board */

  /* For the Departures and Arrivals tabs: whichever airport the user is looking
     at, or failing that the most important one near the middle of the map. */
  function nearestAirport(lat, lon) {
    var bestBig = null, bestBigD = Infinity;
    var bestAny = null, bestAnyD = Infinity;
    airports.forEach(function (ap) {
      var d = distanceNm([lat, lon], [ap.lat, ap.lon]);
      if (d < bestAnyD) { bestAnyD = d; bestAny = ap; }
      if (ap.size === 1 && d < bestBigD) { bestBigD = d; bestBig = ap; }
    });
    if (bestBig && bestBigD <= 90) return bestBig;
    if (bestAny && bestAnyD <= 90) return bestAny;
    return bestBig || bestAny;
  }

  function findAirport(iata) {
    for (var i = 0; i < airports.length; i++) {
      if (airports[i].iata === iata) return airports[i];
    }
    return null;
  }

  function openAirport(ap, focus) {
    if (!ap) return;
    state.airport = ap;
    state.airportFocus = focus || 'all';
    setBoardFocus(state.airportFocus);
    clearSelection();
    showView('airport');

    el.airportName.textContent = ap.name;
    el.airportWhere.textContent = ap.iata + ' · ' + [ap.city, countryName(ap.country)].filter(Boolean).join(', ');
    var loading = '<li class="empty">Listening for planes…</li>';
    el.groundList.innerHTML = loading;
    el.arrivalsList.innerHTML = loading;
    el.departuresList.innerHTML = loading;
    el.nearbyList.innerHTML = loading;
    setBoardTitles(null);

    map.setView([ap.lat, ap.lon], Math.max(map.getZoom(), 8));
    markAirportPins();
    if (state.airportFocus === 'all') highlightTab(null);

    fetch('/api/airport?iata=' + encodeURIComponent(ap.iata))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!state.airport || state.airport.iata !== ap.iata) return;  // user moved on
        setBoardTitles(data.counts);
        renderBoard(data.onGround, el.groundList, 'ground');
        renderBoard(data.arrivals, el.arrivalsList, 'in');
        renderBoard(data.departures, el.departuresList, 'out');
        renderBoard(data.nearby, el.nearbyList, 'near');
      })
      .catch(function () {
        var failed = '<li class="empty">Could not reach the flight service just now.</li>';
        el.groundList.innerHTML = failed;
        el.arrivalsList.innerHTML = failed;
        el.departuresList.innerHTML = failed;
        el.nearbyList.innerHTML = failed;
      });
  }

  // A tab asks for one board; tapping a pin on the map asks for all of them.
  function setBoardFocus(focus) {
    [].forEach.call(document.querySelectorAll('.board'), function (board) {
      board.hidden = focus !== 'all' && board.dataset.board !== focus;
    });
  }

  function markAirportPins() {
    Object.keys(airportMarkers).forEach(function (iata) {
      var node = airportMarkers[iata].getElement();
      var pin = node && node.querySelector('.airport-pin');
      if (pin) pin.classList.toggle('selected', !!state.airport && state.airport.iata === iata);
    });
  }

  function setBoardTitles(counts) {
    var n = function (key) { return counts && counts[key] ? ' (' + counts[key] + ')' : ''; };
    el.groundTitle.textContent = 'At the airport right now' + n('onGround');
    el.arrivalsTitle.textContent = 'Landing here soon' + n('arrivals');
    el.departuresTitle.textContent = 'Leaving from here' + n('departures');
    el.nearbyTitle.textContent = 'Other planes in the sky nearby' + n('nearby');
  }

  function boardName(f) {
    if (f.airline) return f.airline + (f.number ? ' ' + f.number : '');
    return f.callsign || f.registration || 'Unknown aircraft';
  }

  var BOARD_EMPTY = {
    ground: 'No aircraft on the ground here are broadcasting at the moment.',
    in: 'Nothing is on its way in at the moment.',
    out: 'Nothing has left here in the last little while.',
    near: 'No other aircraft are flying close by.'
  };

  function renderBoard(list, ul, kind) {
    ul.innerHTML = '';
    if (!list || !list.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = BOARD_EMPTY[kind];
      ul.appendChild(li);
      return;
    }

    list.forEach(function (f) {
      var item = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';

      var name = document.createElement('span');
      name.className = 'fl-name';
      name.textContent = boardName(f);

      var when = document.createElement('span');
      when.className = 'fl-when';
      var where = document.createElement('span');
      where.className = 'fl-route';
      var place = f.other ? (f.other.city || f.other.name || f.other.iata) : null;
      var code = f.other && f.other.iata ? ' (' + f.other.iata + ')' : '';

      if (kind === 'ground') {
        when.textContent = f.moving ? 'moving' : 'parked';
        where.textContent = !place
          ? (f.description || f.typeCode || 'On the ground here')
          : (f.heading === 'out' ? 'going to ' + place + code : 'came in from ' + place + code);
      } else if (kind === 'in') {
        when.textContent = f.minutes !== null ? 'in ' + f.minutes + ' min' : formatDistance(f.distance) + ' away';
        where.textContent = place ? 'from ' + place + code : 'on its way in';
      } else if (kind === 'out') {
        when.textContent = formatDistance(f.distance) + ' away';
        where.textContent = place ? 'to ' + place + code : 'on its way out';
      } else {
        when.textContent = formatAltitude(f.altitude, false);
        where.textContent = (f.description || f.typeCode || 'Aircraft') +
                            ' · ' + formatDistance(f.distance) + ' away';
      }

      btn.appendChild(name);
      btn.appendChild(when);
      btn.appendChild(where);
      btn.addEventListener('click', function () { openFromBoard(f); });
      item.appendChild(btn);
      ul.appendChild(item);
    });
  }

  // A flight on the board may be outside the map's current view, so fetch it.
  function openFromBoard(f) {
    if (state.planes[f.hex]) { select(f.hex, true); return; }
    setStatus('Finding ' + (f.callsign || 'that flight') + '…', 'busy');
    fetch('/api/search?q=' + encodeURIComponent(f.callsign))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var p = data.aircraft && data.aircraft[0];
        if (!p) { showBanner('That flight has just gone out of range.', 'search'); return; }
        p.animLat = p.lat; p.animLon = p.lon; p.fetchedAt = Date.now();
        state.planes[p.hex] = p;
        map.setView([p.lat, p.lon], Math.max(map.getZoom(), 8));
        drawPlanes();
        select(p.hex, false);
      })
      .catch(function () { showBanner('Could not open that flight.', 'search'); });
  }

  function clearSelection() {
    state.selected = null;
    setFollow(false);
    state.listSignature = '';
    if (state.routeLayer) { map.removeLayer(state.routeLayer); state.routeLayer = null; }
    drawPlanes();
  }

  function openPanel(open) {
    el.panel.classList.toggle('open', open);
    el.panelHandle.setAttribute('aria-expanded', String(open));
  }

  function renderList() {
    var list = visiblePlanes().slice();
    list.sort(function (a, b) { return (a.onGround ? 1 : 0) - (b.onGround ? 1 : 0); });
    list = list.slice(0, 40);

    // Only rebuild when something actually changed — a list that reshuffles
    // under your finger every few seconds is hard to use.
    var sig = list.map(function (p) {
      return p.hex + ':' + (p.callsign || '') + ':' + Math.round((p.altitude || 0) / 500);
    }).join('|') + '#' + state.selected;
    if (sig === state.listSignature) return;
    state.listSignature = sig;

    el.listTitle.textContent = list.length
      ? 'Planes flying near here'
      : 'No planes in view';
    el.listHint.textContent = list.length
      ? 'Tap any flight to see where it is going.'
      : 'Try dragging the map, or zooming out with the − button.';
    if (state.view === 'list') {
      el.panelHandleText.textContent = list.length
        ? 'Show ' + list.length + ' planes near here'
        : 'Show the list of planes';
    }

    el.flightList.innerHTML = '';
    list.forEach(function (p) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      if (p.hex === state.selected) btn.setAttribute('aria-current', 'true');

      var name = document.createElement('span');
      name.className = 'fl-name';
      name.textContent = friendlyName(p);

      var route = document.createElement('span');
      route.className = 'fl-route';
      route.textContent = routeSummary(p) ||
        (isPrivate(p) ? 'Private flight' : (p.onGround ? 'On the ground' : 'Looking up the route…'));

      var alt = document.createElement('span');
      alt.className = 'fl-alt';
      alt.textContent = p.onGround ? 'landed' : formatAltitude(p.altitude, false);

      btn.appendChild(name);
      btn.appendChild(alt);
      btn.appendChild(route);
      btn.addEventListener('click', function () { select(p.hex, true); });
      li.appendChild(btn);
      el.flightList.appendChild(li);
    });
  }

  function select(hex, recenter) {
    state.selected = hex;
    state.airport = null;
    markAirportPins();
    setFollow(false);
    state.listSignature = '';
    var p = state.planes[hex];
    if (p && recenter) map.setView([p.animLat, p.animLon], Math.max(map.getZoom(), 8));
    drawPlanes();
    showView('detail');
    highlightTab(null);
    renderDetail();
    loadExtras(hex);
  }

  function loadExtras(hex) {
    var p = state.planes[hex];
    if (!p) return;
    if (p.callsign && state.routes[p.callsign] === undefined) {
      fetch('/api/route?callsign=' + encodeURIComponent(p.callsign) +
            '&lat=' + p.lat.toFixed(4) + '&lon=' + p.lon.toFixed(4))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          state.routes[p.callsign] = d.route || null;
          state.listSignature = '';
          if (state.selected === hex) renderDetail();
          renderList();
          updateLabels();
        })
        .catch(function () {});
    }
    if (state.aircraftInfo[hex] === undefined) {
      fetch('/api/aircraft?hex=' + encodeURIComponent(hex))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          state.aircraftInfo[hex] = d.aircraft || null;
          if (state.selected === hex) renderDetail();
        })
        .catch(function () {});
    }
  }

  function renderDetail() {
    var p = state.planes[state.selected];
    if (!p) return;
    var route = p.callsign ? state.routes[p.callsign] : null;
    var info = state.aircraftInfo[p.hex];

    el.flightTitle.textContent = friendlyName(p);

    var subBits = [];
    if (route && route.flightNumber) subBits.push('Flight ' + route.flightNumber);
    else if (p.callsign && !isPrivate(p)) subBits.push('Flight ' + p.callsign);
    if (p.registration) subBits.push('Tail number ' + p.registration);
    if (isPrivate(p)) subBits.push('a private flight');
    el.flightSub.textContent = subBits.join(' · ');

    var leg = legFor(p);
    setEnd(leg && leg.origin, el.fromCode, el.fromCity, p);
    setEnd(leg && leg.destination, el.toCode, el.toCity, p);

    el.factStatus.textContent = plainStatus(p);
    el.factAlt.textContent = formatAltitude(p.altitude, p.onGround);
    el.factSpeed.textContent = p.onGround ? '—' : formatSpeed(p.groundSpeed);
    var model = (info && (info.manufacturer || info.type))
      ? ((info.manufacturer ? info.manufacturer + ' ' : '') + (info.type || '')).trim()
      : (p.description || p.typeCode || null);
    el.factType.textContent = model || 'Not known';

    if (info && info.photoThumb) {
      el.photo.src = info.photoThumb;
      el.photo.alt = 'Photograph of ' + (info.registration || 'this aircraft');
      el.photoWrap.hidden = false;
    } else {
      el.photoWrap.hidden = true;
      el.photo.removeAttribute('src');
    }

    if (leg && leg.destination.iata) {
      el.destBtn.textContent = 'See all flights at ' + (leg.destination.city || leg.destination.iata);
      el.destBtn.hidden = false;
    } else {
      el.destBtn.hidden = true;
    }

    renderProgress(p, leg);
    drawRouteLine();
  }

  function setEnd(airport, codeEl, cityEl, p) {
    if (!airport) {
      codeEl.textContent = '—';
      cityEl.textContent = p && isPrivate(p)
        ? 'Private flights do not publish a route'
        : 'Still looking…';
      return;
    }
    codeEl.textContent = airport.iata || airport.icao || '—';
    cityEl.textContent = [airport.city, countryName(airport.country)].filter(Boolean).join(', ') ||
                         airport.name || 'Not known';
  }

  function renderProgress(p, leg) {
    if (!leg) { el.progressWrap.hidden = true; return; }
    var route = leg;
    var here = [p.animLat, p.animLon];
    var from = [leg.origin.lat, leg.origin.lon];
    var to = [leg.destination.lat, leg.destination.lon];
    var flown = distanceNm(from, here);
    var left = distanceNm(here, to);
    var total = flown + left;
    if (!total) { el.progressWrap.hidden = true; return; }

    // Route databases store a flight number's usual legs. If this plane is
    // nowhere near the straight line between them we are probably looking at a
    // different leg, so don't invent a progress figure.
    var direct = distanceNm(from, to);
    if (direct > 20 && total > direct * 1.5) {
      el.progressBar.style.width = '0%';
      el.progressText.textContent = 'This flight number usually flies ' +
        (route.origin.city || route.origin.iata) + ' to ' +
        (route.destination.city || route.destination.iata) +
        ', but this aircraft is somewhere else today, so it may be flying a different leg.';
      el.progressWrap.hidden = false;
      return;
    }

    var pct = Math.max(0, Math.min(100, (flown / total) * 100));
    el.progressBar.style.width = pct.toFixed(1) + '%';

    var words;
    if (p.onGround && pct > 90) {
      words = 'Has landed at ' + (route.destination.city || route.destination.iata) + '.';
    } else if (p.onGround) {
      words = 'On the ground at ' + (route.origin.city || route.origin.iata) + '.';
    } else if (p.groundSpeed && p.groundSpeed > 80) {
      words = formatDistance(left) + ' still to fly — about ' +
              formatDuration(left / p.groundSpeed) + ' to go.';
    } else {
      words = formatDistance(left) + ' still to fly.';
    }
    el.progressText.textContent = Math.round(pct) + '% of the way there. ' + words;
    el.progressWrap.hidden = false;
  }

  function drawRouteLine() {
    if (state.routeLayer) { map.removeLayer(state.routeLayer); state.routeLayer = null; }
    var p = state.planes[state.selected];
    if (!p) return;
    var leg = legFor(p);
    if (!leg) return;

    var group = L.layerGroup();
    var here = [p.animLat, p.animLon];
    var from = [leg.origin.lat, leg.origin.lon];
    var to = [leg.destination.lat, leg.destination.lon];

    // Solid behind the plane for the distance already flown, dashed ahead of it.
    L.polyline(greatCircle(from, here, 64), {
      color: '#10365f', weight: 5, opacity: 0.85
    }).addTo(group);
    L.polyline(greatCircle(here, to, 64), {
      color: '#c2410c', weight: 5, opacity: 0.9, dashArray: '10 9'
    }).addTo(group);
    airportMarker(from, leg.origin, 'From').addTo(group);
    airportMarker(to, leg.destination, 'To').addTo(group);

    group.addTo(map);
    state.routeLayer = group;
  }

  function airportMarker(latlon, airport, word) {
    var code = airport.iata || airport.icao || '?';
    var city = airport.city || '';
    return L.marker(latlon, {
      icon: L.divIcon({
        className: '',
        html: '<div class="airport-marker">' + word + ' ' + escapeHtml(code) +
              (city ? '<small>' + escapeHtml(city) + '</small>' : '') + '</div>',
        iconSize: null,
        iconAnchor: [0, 12]
      }),
      interactive: false
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* --------------------------------------------------------------- controls */

  el.refreshBtn.addEventListener('click', function () { refresh(); });

  function goBackToList() {
    clearSelection();
    state.airport = null;
    state.airportFocus = 'all';
    setBoardFocus('all');
    markAirportPins();
    showView('list');
    renderList();
    highlightTab(el.panel.classList.contains('open') ? 'live' : 'home');
  }

  /* ------------------------------------------------------------- bottom nav */

  function highlightTab(tab) {
    state.tab = tab;
    [].forEach.call(el.bottomNav.querySelectorAll('.nav-btn'), function (btn) {
      btn.setAttribute('aria-current', String(btn.dataset.tab === tab));
    });
  }

  function measureNav() {
    var nav = el.bottomNav.offsetHeight;
    document.documentElement.style.setProperty('--nav-h', (nav || 0) + 'px');
    var header = document.querySelector('.topbar').offsetHeight;
    if (header) document.documentElement.style.setProperty('--header-h', header + 'px');
  }

  function openBoardTab(focus) {
    var centre = map.getCenter();
    var ap = state.airport || nearestAirport(centre.lat, centre.lng);
    if (!ap) {
      showBanner('There is no airport near this part of the map. Drag the map towards a city and try again.', 'search');
      return;
    }
    openAirport(ap, focus);
    highlightTab(focus);
  }

  el.bottomNav.addEventListener('click', function (e) {
    var btn = e.target.closest('.nav-btn');
    if (!btn) return;
    var tab = btn.dataset.tab;

    if (tab === 'home') {
      goBackToList();
      openPanel(false);
      highlightTab('home');
    } else if (tab === 'live') {
      goBackToList();
      openPanel(true);
      highlightTab('live');
    } else {
      openBoardTab(tab);
    }
  });

  [].forEach.call(document.querySelectorAll('#backBtn, [data-back]'), function (btn) {
    btn.addEventListener('click', goBackToList);
  });

  el.destBtn.addEventListener('click', function () {
    var p = state.planes[state.selected];
    var leg = p && legFor(p);
    if (!leg) return;
    openAirport(findAirport(leg.destination.iata) || leg.destination);
  });

  function setFollow(on) {
    state.follow = on;
    el.followBtn.textContent = on ? 'Stop tracking this plane' : 'Track this plane';
    el.followBtn.classList.toggle('tracking', on);
    el.trackNote.hidden = !on;
  }

  el.followBtn.addEventListener('click', function () { setFollow(!state.follow); });

  el.panelHandle.addEventListener('click', function () {
    var opening = !el.panel.classList.contains('open');
    openPanel(opening);
    if (state.view === 'list') highlightTab(opening ? 'live' : 'home');
  });

  el.locateBtn.addEventListener('click', function () { locate(true); });

  function locate(announce) {
    if (!navigator.geolocation) {
      if (announce) showBanner('This device cannot share its location, but you can drag the map instead.');
      return;
    }
    el.locateBtn.classList.add('on');
    setStatus('Finding where you are…', 'busy');
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (state.meMarker) map.removeLayer(state.meMarker);
      state.meMarker = L.marker([state.me.lat, state.me.lon], {
        icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false
      }).addTo(map);
      map.setView([state.me.lat, state.me.lon], 9);
      el.locateBtn.classList.remove('on');
      showBanner(null);
      refresh();
    }, function () {
      el.locateBtn.classList.remove('on');
      if (announce) showBanner('Location sharing is switched off, so drag the map to where you want to look.');
      setStatus('Drag the map to choose a place.', '');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  /* ---------------------------------------------------------------- search */

  el.searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = el.searchInput.value.trim();
    if (!q) return;
    setStatus('Searching for ' + q.toUpperCase() + '…', 'busy');
    showBanner(null);

    fetch('/api/search?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.aircraft && data.aircraft.length) {
          var p = data.aircraft[0];
          p.animLat = p.lat; p.animLon = p.lon; p.fetchedAt = Date.now();
          state.planes[p.hex] = p;
          map.setView([p.lat, p.lon], 8);
          drawPlanes();
          select(p.hex, false);
          setStatus('Found ' + (p.callsign || q.toUpperCase()), '');
          el.searchInput.blur();
        } else if (data.reason === 'not-flying' && data.route) {
          var r2 = data.route;
          showBanner(q.toUpperCase() + ' is a real flight (' +
            ((r2.origin && (r2.origin.city || r2.origin.iata)) || '?') + ' to ' +
            ((r2.destination && (r2.destination.city || r2.destination.iata)) || '?') +
            ') but it is not in the air at the moment.');
          setStatus('That flight is not flying right now.', '');
        } else {
          showBanner('No plane called "' + q.toUpperCase() +
            '" is flying right now. Try a flight number like AA100, or a tail number like N221WN.');
          setStatus('Nothing found.', '');
        }
      })
      .catch(function () {
        showBanner('The search could not be finished. Please try again.');
        setStatus('Search failed.', 'bad');
      });
  });

  /* --------------------------------------------------------------- settings */

  var SIZES = ['normal', 'large', 'largest'];
  var savedSize = null;
  try { savedSize = localStorage.getItem('ff-size'); } catch (e) { /* ignore */ }
  applySize(SIZES.indexOf(savedSize) > -1 ? savedSize : 'normal');
  markChoices();

  function applySize(size) {
    document.documentElement.setAttribute('data-size', size);
    try { localStorage.setItem('ff-size', size); } catch (e) { /* ignore */ }
    setTimeout(function () { map.invalidateSize(); measureHandle(); measureNav(); }, 60);
  }

  function measureHandle() {
    var h = el.panelHandle.offsetHeight;
    if (h) document.documentElement.style.setProperty('--handle-h', h + 'px');
  }

  function markChoices() {
    var size = document.documentElement.getAttribute('data-size') || 'normal';
    [].forEach.call(el.sizeChoices.querySelectorAll('.choice'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.size === size));
    });
    [].forEach.call(el.unitChoices.querySelectorAll('.choice'), function (b) {
      b.setAttribute('aria-pressed', String((b.dataset.units === 'imperial') === imperial));
    });
  }

  el.sizeChoices.addEventListener('click', function (e) {
    var btn = e.target.closest('.choice');
    if (!btn) return;
    applySize(btn.dataset.size);
    markChoices();
  });

  el.unitChoices.addEventListener('click', function (e) {
    var btn = e.target.closest('.choice');
    if (!btn) return;
    imperial = btn.dataset.units === 'imperial';
    try { localStorage.setItem('ff-units', imperial ? 'imperial' : 'metric'); } catch (err) { /* ignore */ }
    markChoices();
    state.listSignature = '';
    renderList();
    if (state.selected) renderDetail();
  });

  function openSettings(open) {
    el.settingsOverlay.hidden = !open;
    if (open) {
      el.settingsStatus.textContent = state.status;
      markChoices();
      el.settingsClose.focus();
    } else {
      el.settingsBtn.focus();
    }
  }

  el.settingsBtn.addEventListener('click', function () { openSettings(true); });
  el.settingsClose.addEventListener('click', function () { openSettings(false); });

  el.showHelpBtn.addEventListener('click', function () {
    openSettings(false);
    el.helpOverlay.hidden = false;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!el.settingsOverlay.hidden) openSettings(false);
    else if (!el.helpOverlay.hidden) el.helpOverlay.hidden = true;
  });

  /* ----------------------------------------------------------------- wiring */

  /* Tapping bare map means "I am done with this one". Leaflet does not raise a
     map click for taps that land on a plane or an airport pin, so this only
     fires on empty space. */
  map.on('click', function () {
    if (state.selected || state.airport) goBackToList();
  });

  // Dragging the map by hand should never fight the map re-centring itself.
  map.on('dragstart', function () {
    if (state.follow) setFollow(false);
  });

  map.on('moveend zoomend', function () {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(function () {
      state.listSignature = '';
      drawPlanes();
      drawAirports();
      markAirportPins();
      renderList();
      refresh();
    }, 600);
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });

  window.addEventListener('resize', function () { map.invalidateSize(); measureHandle(); measureNav(); });
  if (window.ResizeObserver) new ResizeObserver(measureHandle).observe(el.panelHandle);

  el.helpClose.addEventListener('click', function () {
    el.helpOverlay.hidden = true;
    try { localStorage.setItem('ff-seen-help', '1'); } catch (e) { /* ignore */ }
    locate(false);
  });

  var seenHelp = false;
  try { seenHelp = localStorage.getItem('ff-seen-help') === '1'; } catch (e) { /* ignore */ }
  if (seenHelp) { el.helpOverlay.hidden = true; locate(false); }
  else { el.helpOverlay.hidden = false; }

  if (window.matchMedia('(min-width: 800px)').matches) openPanel(true);

  showView('list');
  measureHandle();
  measureNav();
  highlightTab(window.matchMedia('(min-width: 800px)').matches ? 'live' : 'home');
  refresh();
  setInterval(animate, ANIM_MS);
})();
