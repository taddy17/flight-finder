/* Flight Finder — live plane map.
 *
 * Positions come from api.adsb.lol and route/aircraft details from api.adsbdb.com,
 * both through our own /api/* proxy so the browser never hits a CORS wall.
 *
 * The map has to stay smooth with several hundred aircraft moving at once on a
 * phone, so the drawing is deliberately frugal: one animation loop driven by
 * the screen's own refresh, plane icons that are plain pooled DOM nodes moved
 * with a transform, and no work at all for anything that has not changed.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------- constants */

  var REFRESH_MS = 6000;        // how often we ask for fresh positions
  var MAX_EXTRAPOLATE_S = 45;   // never guess a position further ahead than this
  var MAX_MARKERS = 420;        // keep the map (and the eye) from being overwhelmed
  var LABEL_ZOOM = 9;           // show flight numbers on the map from this zoom in
  var SMOOTH_TAU = 0.28;        // seconds for a plane to settle onto a new fix
  var KM_PER_NM = 1.852;
  var MI_PER_NM = 1.15078;
  var FT_PER_M = 3.28084;
  var RAD = Math.PI / 180;

  /* Zoomed out, a plane stands for a much bigger patch of ground, so the same
     number of markers reads as a swarm. Both the spacing between markers and
     the ceiling on them loosen up as you zoom back in. */
  var SPARSE = [
    { zoom: 5, cell: 76, markers: 70 },
    { zoom: 6, cell: 62, markers: 110 },
    { zoom: 7, cell: 52, markers: 150 },
    { zoom: 8, cell: 42, markers: 200 }
  ];

  function crowding() {
    var zoom = map.getZoom();
    for (var i = 0; i < SPARSE.length; i++) {
      if (zoom <= SPARSE[i].zoom) return SPARSE[i];
    }
    return { cell: 34, markers: MAX_MARKERS };
  }

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
    mapChoices: $('mapChoices'),
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
    peekSummary: $('peekSummary'),
    peekName: $('peekName'),
    peekRoute: $('peekRoute'),
    peekFacts: $('peekFacts'),
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

  /* Writing to the DOM is only expensive when the value really changed; every
     render pass here goes through these two so an unchanged screen costs
     nothing at all. */
  function setText(node, text) {
    if (node && node.__t !== text) { node.__t = text; node.textContent = text; }
  }

  function setHidden(node, hidden) {
    if (node && node.hidden !== hidden) node.hidden = hidden;
  }

  /* ----------------------------------------------------------------- state */

  var state = {
    planes: new Map(),   // hex -> plane record
    routes: new Map(),   // callsign -> route or null
    aircraftInfo: new Map(),  // hex -> aircraft details or null
    visible: [],         // planes inside the current view, nearest first
    visibleAt: 0,        // the map/data version `visible` was built from
    version: 0,          // bumped whenever positions or the view change
    selected: null,      // hex
    follow: false,
    lastUpdate: 0,
    loading: false,
    me: null,            // {lat, lon}
    meMarker: null,
    routeLine: null,     // { flown, ahead, from, to, path, cumulative, key }
    listSignature: '',
    view: 'list',
    sheet: 'closed',
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
    tap: true,
    // Panning is smoother when Leaflet is not also fetching and laying out
    // tiles for every intermediate frame of a zoom.
    zoomAnimationThreshold: 4,
    preferCanvas: true
  });

  /* The picture under the planes. Plain is the default — a calm, pale map keeps
     the planes themselves the loudest thing on screen — but the ground is worth
     looking at too, so satellite and the rest are a tap away in Settings.
     `labels` is a separate see-through layer of place names, for the pictures
     that do not come with any of their own. */
  var ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/';
  var DATA_CREDIT = ' &middot; flight data from adsb.lol and adsbdb.com';
  var MAP_STYLES = {
    plain: {
      base: 'Canvas/World_Light_Gray_Base',
      labels: 'Canvas/World_Light_Gray_Reference',
      credit: 'Map &copy; Esri'
    },
    streets: {
      base: 'World_Street_Map',
      credit: 'Map &copy; Esri, HERE, Garmin'
    },
    landscape: {
      base: 'World_Topo_Map',
      credit: 'Map &copy; Esri, USGS, NOAA'
    },
    satellite: {
      base: 'World_Imagery',
      labels: 'Reference/World_Boundaries_and_Places',
      credit: 'Pictures &copy; Esri, Maxar, Earthstar Geographics',
      dark: true
    }
  };

  var mapStyle = 'plain';
  var baseLayer = null;
  var labelLayer = null;

  function tiles(path, opts) {
    opts.maxZoom = 16;
    opts.minZoom = 3;
    // One tile pass when the zoom settles beats one per animated frame, and a
    // little off-screen margin means a pan shows tiles instead of grey.
    opts.updateWhenZooming = false;
    opts.keepBuffer = 3;
    return L.tileLayer(ESRI + path + '/MapServer/tile/{z}/{y}/{x}', opts);
  }

  function applyMapStyle(name) {
    var style = MAP_STYLES[name] ? name : 'plain';
    var conf = MAP_STYLES[style];
    mapStyle = style;

    var old = [baseLayer, labelLayer];
    baseLayer = tiles(conf.base, { attribution: conf.credit + DATA_CREDIT }).addTo(map);
    labelLayer = conf.labels ? tiles(conf.labels, { pane: 'shadowPane' }).addTo(map) : null;
    // Swap rather than clear first, so the map never flashes empty mid-change.
    old.forEach(function (layer) { if (layer) map.removeLayer(layer); });
    baseLayer.bringToBack();

    /* Planes are navy on white, which needs help against a dark photograph. */
    document.body.setAttribute('data-map', conf.dark ? 'dark' : 'light');
    try { localStorage.setItem('ff-map', style); } catch (e) { /* ignore */ }
  }

  var savedMap = null;
  try { savedMap = localStorage.getItem('ff-map'); } catch (e) { /* ignore */ }
  applyMapStyle(savedMap || 'plain');

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

  /* ------------------------------------------------------- fast projection */

  /* Leaflet's latLngToLayerPoint allocates a Point and re-reads the map on
     every call. Plane positions are recomputed for every aircraft on every
     frame, so instead read the map once per frame and do the Web-Mercator
     arithmetic inline. It is the same answer, without the garbage. */
  var proj = { scale: 0, originX: 0, originY: 0 };

  function syncProjection() {
    var origin = map.getPixelOrigin();
    proj.scale = 256 * Math.pow(2, map.getZoom());
    proj.originX = origin.x;
    proj.originY = origin.y;
  }

  function projectX(lon) {
    return proj.scale * (lon + 180) / 360 - proj.originX;
  }

  function projectY(lat) {
    var s = Math.sin(lat * RAD);
    if (s > 0.99999) s = 0.99999; else if (s < -0.99999) s = -0.99999;
    return proj.scale * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) - proj.originY;
  }

  /* --------------------------------------------------------------- airports */

  /* The airport list ships with the app, so pins appear instantly and work
     even when the flight service is having a bad day. Three thousand of them
     is far too many to walk through on every pan, so they go into a coarse
     grid and only the handful of cells on screen are ever looked at. */
  var AIRPORT_ZOOM = { 1: 7, 2: 10 };  // big airports appear sooner than small ones
  var CELL = 3;                        // degrees of latitude/longitude per cell
  var airports = [];
  var airportsByIata = new Map();
  var airportGrid = new Map();
  var airportMarkers = new Map();

  function cellKey(lat, lon) {
    return (Math.floor(lat / CELL) + 64) * 256 + (Math.floor(lon / CELL) + 64);
  }

  function indexAirports() {
    airportGrid.clear();
    airportsByIata.clear();
    for (var i = 0; i < airports.length; i++) {
      var ap = airports[i];
      airportsByIata.set(ap.iata, ap);
      var key = cellKey(ap.lat, ap.lon);
      var bucket = airportGrid.get(key);
      if (bucket) bucket.push(ap);
      else airportGrid.set(key, [ap]);
    }
  }

  /* Every airport whose cell overlaps the given box, biggest first. */
  function airportsIn(south, west, north, east) {
    var out = [];
    var latFrom = Math.floor(south / CELL), latTo = Math.floor(north / CELL);
    var lonFrom = Math.floor(west / CELL), lonTo = Math.floor(east / CELL);
    for (var la = latFrom; la <= latTo; la++) {
      for (var lo = lonFrom; lo <= lonTo; lo++) {
        var bucket = airportGrid.get((la + 64) * 256 + (lo + 64));
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          var ap = bucket[i];
          if (ap.lat >= south && ap.lat <= north && ap.lon >= west && ap.lon <= east) out.push(ap);
        }
      }
    }
    return out;
  }

  fetch('airports.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var rows = data.airports;
      airports = new Array(rows.length);
      for (var i = 0; i < rows.length; i++) {
        var a = rows[i];
        airports[i] = { iata: a[0], icao: a[1], name: a[2], city: a[3], country: a[4],
                        lat: a[5], lon: a[6], size: a[7] };
      }
      indexAirports();
      drawAirports();
    })
    .catch(function () { /* the map still works without pins */ });

  function drawAirports() {
    if (!airports.length) return;
    var zoom = map.getZoom();
    var b = map.getBounds();
    var near = airportsIn(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());

    // Where they crowd together, the larger airports are the ones worth a pin.
    near.sort(function (x, y) { return x.size - y.size; });

    // Zoomed out the pins crowd each other and the planes; close in there is
    // room to name every field in view.
    var most = zoom <= 8 ? 16 : 45;
    var keep = new Set();

    // The airport you are reading about always keeps its pin, wherever it is.
    if (state.airport) {
      keep.add(state.airport.iata);
      if (!airportMarkers.has(state.airport.iata)) {
        airportMarkers.set(state.airport.iata, makeAirportPin(state.airport));
      }
    }

    for (var i = 0; i < near.length && keep.size < most; i++) {
      var ap = near[i];
      if (zoom < AIRPORT_ZOOM[ap.size]) continue;
      keep.add(ap.iata);
      if (airportMarkers.has(ap.iata)) continue;
      airportMarkers.set(ap.iata, makeAirportPin(ap));
    }

    airportMarkers.forEach(function (marker, iata) {
      if (keep.has(iata)) return;
      map.removeLayer(marker);
      airportMarkers.delete(iata);
    });
  }

  function makeAirportPin(ap) {
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
    return marker;
  }

  /* ------------------------------------------------------------ geo helpers */

  function toDeg(r) { return r * 180 / Math.PI; }

  // Great-circle distance in nautical miles.
  function distanceNm(a, b) {
    var dLat = (b[0] - a[0]) * RAD;
    var dLon = (b[1] - a[1]) * RAD;
    var la1 = a[0] * RAD, la2 = b[0] * RAD;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  /* Sorting only needs the order to come out right, not the distance itself,
     so use flat-earth arithmetic and skip a few hundred square roots. */
  function roughDistance(lat1, lon1, lat2, lon2) {
    var x = (lon2 - lon1) * Math.cos((lat1 + lat2) * 0.5 * RAD);
    var y = lat2 - lat1;
    return x * x + y * y;
  }

  // Points along the great circle between two coordinates, for a route line
  // that follows the path a plane actually flies.
  function greatCircle(a, b, steps) {
    var la1 = a[0] * RAD, lo1 = a[1] * RAD;
    var la2 = b[0] * RAD, lo2 = b[1] * RAD;
    var d = 2 * Math.asin(Math.sqrt(
      Math.pow(Math.sin((la1 - la2) / 2), 2) +
      Math.cos(la1) * Math.cos(la2) * Math.pow(Math.sin((lo1 - lo2) / 2), 2)));
    if (!d || !isFinite(d)) return [a.slice(), b.slice()];

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
    if (ft == null) return 'Not known';
    if (imperial) return Math.round(ft / 100) * 100 + ' feet';
    return Math.round(ft / FT_PER_M / 10) * 10 + ' metres';
  }

  function formatSpeed(knots) {
    if (knots == null) return 'Not known';
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
    var low = p.altitude != null && p.altitude < 3000;
    if (vs != null && vs > 500) return low ? 'Just taken off' : 'Climbing up';
    if (vs != null && vs < -500) return low ? 'About to land' : 'Coming down';
    if (low) return 'Close to the ground';
    return 'Cruising along';
  }

  /* A flight number can cover several legs in a day (ORD-FCA-ORD). Pick the leg
     this aircraft is actually flying: the one it sits most neatly between. */
  function pickLeg(route, lat, lon) {
    if (!route || !route.airports || route.airports.length < 2) return null;
    var aps = route.airports;
    if (aps.length === 2) return { origin: aps[0], destination: aps[1], detour: 0 };
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

  function routeFor(p) {
    return p && p.callsign ? state.routes.get(p.callsign) : null;
  }

  /* The leg only changes when the aircraft crosses to a different one, which is
     rare, so remember the answer rather than re-deriving it every frame. */
  function legFor(p) {
    if (!p) return null;
    var route = routeFor(p);
    if (!route) return null;
    if (p.__legRoute === route && p.__legAt && Math.abs(p.dispLat - p.__legAt[0]) < 0.5 &&
        Math.abs(p.dispLon - p.__legAt[1]) < 0.5) {
      return p.__leg;
    }
    p.__legRoute = route;
    p.__legAt = [p.dispLat, p.dispLon];
    p.__leg = pickLeg(route, p.dispLat, p.dispLon);
    return p.__leg;
  }

  // "SWA184" reads as gibberish; "Southwest 184" does not.
  function friendlyName(p) {
    var route = routeFor(p);
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

  /* Panning around for an hour would otherwise quietly accumulate a route and
     an aircraft record for every flight ever seen. Maps keep their insertion
     order, so the oldest entries are the ones to let go of. */
  function remember(cache, key, value, limit) {
    cache.set(key, value);
    while (cache.size > limit) {
      var oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
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
  var HELI_TYPES = /^(EC|AS3|R44|R66|S76|B06|B41|H60|UH|AW1)/;
  var REGIONAL_TYPES = /^(E1|E7|CRJ|CL6|RJ|SF3|DH8|AT4|AT7)/;

  function markerSize(p) {
    var byCategory = CATEGORY_SIZE[p.category];
    if (byCategory) return byCategory;
    var t = p.typeCode || '';
    if (HEAVY_TYPES.test(t)) return 38;
    if (LIGHT_TYPES.test(t)) return 21;
    if (REGIONAL_TYPES.test(t)) return 26;  // regional
    return 29;
  }

  function isHelicopter(p) {
    return p.category === 'A7' || HELI_TYPES.test(p.typeCode || '');
  }

  // Airport service vehicles also broadcast; they are not planes in the sky.
  function isGroundVehicle(p) {
    return p.category === 'C1' || p.category === 'C2' || p.category === 'C3';
  }

  /* ------------------------------------------------------------ plane layer */

  /* Every aircraft used to be a Leaflet marker, and every position change went
     through Leaflet's own projection, bounds and pane bookkeeping. With a few
     hundred of them moving sixty times a second that is most of a frame spent
     on housekeeping. This layer keeps the same look and the same behaviour but
     is only a pool of plain <div>s that get moved with a CSS transform — and
     one that has not actually moved this frame is not touched at all. */
  var planeLayer = (function () {
    map.createPane('planes');
    var pane = map.getPane('planes');
    pane.style.zIndex = 590;   // above the route line, below the airport pins
    // The pane covers the whole map, so it has to be invisible to the mouse;
    // the icons inside it opt back in. Otherwise it would eat every drag.
    pane.style.pointerEvents = 'none';

    var nodes = new Map();     // hex -> node record
    var pool = [];

    function build() {
      var box = document.createElement('div');
      box.className = 'plane-marker';
      box.setAttribute('role', 'button');
      box.tabIndex = 0;
      box.innerHTML =
        '<span class="rot"><svg viewBox="0 0 32 32" aria-hidden="true">' +
        '<path class="plane-body"/></svg></span><span class="plane-label"></span>';
      var rot = box.firstChild;
      return {
        box: box,
        rot: rot,
        svg: rot.firstChild,
        path: rot.firstChild.firstChild,
        label: box.lastChild,
        x: NaN, y: NaN, deg: NaN, size: 0, heli: null, cls: '', label_: null
      };
    }

    function acquire(hex) {
      var rec = pool.pop() || build();
      rec.box.dataset.hex = hex;
      pane.appendChild(rec.box);
      nodes.set(hex, rec);
      return rec;
    }

    function release(hex) {
      var rec = nodes.get(hex);
      if (!rec) return;
      nodes.delete(hex);
      if (rec.box.parentNode) rec.box.parentNode.removeChild(rec.box);
      rec.x = rec.y = rec.deg = NaN;
      if (pool.length < 80) pool.push(rec);
    }

    /* The things that only change when the aircraft data changes: how big it
       is, which silhouette, whether it is on the ground or picked out. */
    function dress(rec, p, selected) {
      var size = markerSize(p);
      if (rec.size !== size) {
        rec.size = size;
        rec.half = size / 2;
        rec.box.style.width = rec.box.style.height = size + 'px';
        rec.svg.setAttribute('width', size);
        rec.svg.setAttribute('height', size);
        rec.x = rec.y = NaN;   // the anchor moved, so force a reposition
      }
      var heli = isHelicopter(p);
      if (rec.heli !== heli) {
        rec.heli = heli;
        rec.path.setAttribute('d', heli ? HELI_PATH : PLANE_PATH);
      }
      var cls = 'plane-marker' + (p.onGround ? ' ground' : '') + (selected ? ' selected' : '');
      if (rec.cls !== cls) { rec.cls = cls; rec.box.className = cls; }

      var title = friendlyName(p);
      if (rec.title !== title) {
        rec.title = title;
        rec.box.setAttribute('aria-label', title);
      }
    }

    function label(rec, text) {
      if (rec.label_ === text) return;
      rec.label_ = text;
      rec.label.textContent = text || '';
      rec.label.style.display = text ? '' : 'none';
    }

    /* Sub-pixel moves are invisible; skipping them means a map full of distant
       aircraft costs almost nothing between one frame and the next. */
    function place(rec, x, y) {
      if (Math.abs(x - rec.x) < 0.2 && Math.abs(y - rec.y) < 0.2) return;
      rec.x = x;
      rec.y = y;
      rec.box.style.transform =
        'translate(' + (x - rec.half).toFixed(1) + 'px,' + (y - rec.half).toFixed(1) + 'px)';
    }

    function turn(rec, deg) {
      if (Math.abs(deg - rec.deg) < 0.8) return;
      rec.deg = deg;
      rec.rot.style.transform = 'rotate(' + deg.toFixed(0) + 'deg)';
    }

    return {
      pane: pane,
      nodes: nodes,
      get: function (hex) { return nodes.get(hex); },
      acquire: acquire,
      release: release,
      dress: dress,
      label: label,
      place: place,
      turn: turn,
      has: function (hex) { return nodes.has(hex); }
    };
  })();

  /* One listener for the whole layer rather than one per aircraft. A drag that
     happens to start on a plane must not count as a tap on it. */
  (function () {
    var downX = 0, downY = 0, moved = false;
    planeLayer.pane.addEventListener('pointerdown', function (e) {
      downX = e.clientX; downY = e.clientY; moved = false;
    }, { passive: true });
    planeLayer.pane.addEventListener('pointermove', function (e) {
      if (Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8) moved = true;
    }, { passive: true });
    planeLayer.pane.addEventListener('click', function (e) {
      if (moved) return;
      var box = e.target.closest ? e.target.closest('.plane-marker') : null;
      if (box && box.dataset.hex) select(box.dataset.hex, false, 'peek');
    });
    planeLayer.pane.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var box = e.target.closest ? e.target.closest('.plane-marker') : null;
      if (!box || !box.dataset.hex) return;
      e.preventDefault();
      select(box.dataset.hex, false, 'peek');
    });
  })();

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
    if (!el.settingsOverlay.hidden) setText(el.settingsStatus, text);
    if (kind === 'bad') showBanner(text, 'status');
    else if (state.bannerOwner === 'status') showBanner(null);
  }

  function showBanner(text, owner) {
    if (!text) {
      if (state.bannerOwner !== null) {
        el.banner.hidden = true;
        state.bannerOwner = null;
      }
      return;
    }
    setText(el.banner, text);
    el.banner.hidden = false;
    state.bannerOwner = owner || 'status';
  }

  var refreshTimer = null;
  var moveTimer = null;
  var failures = 0;
  var inflight = null;

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    // Back off politely when the data service is unhappy, instead of hammering it.
    var delay = failures ? Math.min(REFRESH_MS * Math.pow(2, failures), 60000) : REFRESH_MS;
    refreshTimer = setTimeout(refresh, delay);
  }

  function refresh() {
    clearTimeout(refreshTimer);
    if (document.hidden) { scheduleRefresh(); return; }

    // A poll for the patch of sky the user has already panned away from is
    // wasted work at both ends, so drop it the moment the view changes.
    if (inflight) inflight.abort();
    var ctrl = new AbortController();
    inflight = ctrl;
    state.loading = true;
    setStatus('Looking for planes…', 'busy');

    var c = map.getCenter();
    var radius = viewRadiusNm();
    var url = '/api/flights?lat=' + c.lat.toFixed(3) + '&lon=' + c.lng.toFixed(3) + '&dist=' + radius;

    fetch(url, { signal: ctrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        failures = 0;
        // Routes the server already knew arrive with the positions, so most
        // planes have a name before the second request is even sent.
        if (data.routes) {
          for (var cs in data.routes) {
            if (state.routes.get(cs) == null) remember(state.routes, cs, data.routes[cs], 4000);
          }
        }
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
        if (err && err.name === 'AbortError') return;
        console.warn(err);
        failures++;
        // The planes already on screen stay there; we simply try again later.
        setStatus(state.planes.size
          ? 'The flight service is busy. These positions are a little old.'
          : 'Cannot reach the flight service right now. Trying again…', 'bad');
      })
      .then(function () {
        if (inflight === ctrl) { inflight = null; state.loading = false; }
        scheduleRefresh();
      });
  }

  function describeCount(n) {
    if (!n) return 'No planes in this part of the sky right now.';
    return (n === 1 ? '1 plane' : n + ' planes') + ' · just now';
  }

  function ingest(list) {
    var now = Date.now();
    var planes = state.planes;

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var existing = planes.get(p.hex);
      p.fetchedAt = now;
      p.stamp = now;
      if (existing) {
        // Keep whatever is already drawn on screen and let it glide to the new
        // fix, rather than snapping the aircraft sideways every few seconds.
        p.dispLat = existing.dispLat;
        p.dispLon = existing.dispLon;
        p.dispTrack = existing.dispTrack;
        p.__leg = existing.__leg;
        p.__legRoute = existing.__legRoute;
        p.__legAt = existing.__legAt;
        if (!p.callsign && existing.callsign) p.callsign = existing.callsign;
      } else {
        p.dispLat = p.lat;
        p.dispLon = p.lon;
        p.dispTrack = p.track || 0;
      }
      planes.set(p.hex, p);
    }

    // Drop planes we have not heard from for a while, but never the selected one.
    planes.forEach(function (p, hex) {
      if (p.stamp === now) return;
      if (hex === state.selected && now - p.fetchedAt < 120000) return;
      planes.delete(hex);
      planeLayer.release(hex);
    });

    state.version++;
    syncMarkers();
    renderList();
    if (state.selected) renderDetail();
  }

  /* The planes inside the current view, nearest the middle first. Recomputed
     only when the data or the map has actually changed since last time. */
  function visiblePlanes() {
    if (state.visibleAt === state.version) return state.visible;

    var b = map.getBounds().pad(0.15);
    var south = b.getSouth(), north = b.getNorth();
    var west = b.getWest(), east = b.getEast();
    var c = map.getCenter();
    var out = [];

    state.planes.forEach(function (p) {
      if (p.dispLat < south || p.dispLat > north) return;
      // Dragging past the date line leaves the bounds outside -180..180, so
      // shift the aircraft into the same copy of the world before comparing.
      var lon = p.dispLon;
      if (lon < west && lon + 360 <= east) lon += 360;
      else if (lon > east && lon - 360 >= west) lon -= 360;
      if (lon < west || lon > east) return;
      // Work the distance out once here instead of inside the comparator,
      // which would otherwise recompute it for every comparison.
      p.__d = roughDistance(c.lat, c.lng, p.dispLat, p.dispLon);
      out.push(p);
    });
    out.sort(function (a, b2) { return a.__d - b2.__d; });

    state.visible = out;
    state.visibleAt = state.version;
    return out;
  }

  function fetchRoutesFor(planes) {
    var wanted = [];
    var seen = new Set();
    var add = function (p) {
      if (!p || !p.callsign || seen.has(p.callsign)) return;
      if (state.routes.has(p.callsign)) return;
      seen.add(p.callsign);
      wanted.push({ callsign: p.callsign, lat: p.lat, lng: p.lon });
    };
    if (state.selected) add(state.planes.get(state.selected));
    for (var i = 0; i < planes.length && i < 80; i++) add(planes[i]);
    if (!wanted.length) return;

    fetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes: wanted })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var routes = data.routes || {};
        for (var cs in routes) remember(state.routes, cs, routes[cs], 4000);
        state.listSignature = '';   // names/routes changed, so redraw the list
        renderList();
        refreshLabels();
        if (state.selected) renderDetail();
      })
      .catch(function () { /* routes are a bonus; positions still work */ });
  }

  /* ---------------------------------------------------------------- markers */

  /* Over a busy airport a hundred planes can land on the same few pixels.
     Keep one plane per small patch of screen so the map stays readable —
     the full list is still in the panel. */
  function declutter(planes, cell, limit) {
    var taken = new Set();
    var out = [];
    for (var i = 0; i < planes.length && out.length < limit; i++) {
      var p = planes[i];
      if (p.hex === state.selected) { out.push(p); continue; }
      // An integer key avoids building a string for every aircraft.
      var key = ((projectX(p.dispLon) / cell) | 0) * 65536 + ((projectY(p.dispLat) / cell) | 0);
      if (taken.has(key)) continue;
      taken.add(key);
      out.push(p);
    }
    return out;
  }

  /* Decides which aircraft have an icon on the map and sets everything about
     them that does not change from frame to frame. The per-frame loop below
     then only ever has to move them. */
  function syncMarkers() {
    syncProjection();
    var zoom = map.getZoom();
    var wide = zoom < LABEL_ZOOM;
    var showLabels = zoom >= LABEL_ZOOM;
    var room = crowding();

    var candidates = [];
    var all = visiblePlanes();
    for (var i = 0; i < all.length; i++) {
      var p = all[i];
      if (isGroundVehicle(p)) continue;
      if (wide && p.onGround && p.hex !== state.selected) continue;
      candidates.push(p);
    }
    /* Airborne planes win a contested patch of screen over taxiing ones. Zoomed
       out there is only room for a few, so the airliner beats the light aircraft
       next to it; closer in, the plane nearest the middle keeps winning. */
    candidates.sort(function (a, b) {
      var ground = (a.onGround ? 1 : 0) - (b.onGround ? 1 : 0);
      if (ground || !wide) return ground;
      return markerSize(b) - markerSize(a);
    });

    var list = declutter(candidates, room.cell, room.markers);
    var keep = new Set();

    for (var j = 0; j < list.length; j++) {
      var q = list[j];
      keep.add(q.hex);
      var rec = planeLayer.get(q.hex) || planeLayer.acquire(q.hex);
      planeLayer.dress(rec, q, q.hex === state.selected);
      planeLayer.label(rec, showLabels || q.hex === state.selected ? friendlyName(q) : '');
    }

    planeLayer.nodes.forEach(function (rec, hex) {
      if (!keep.has(hex)) planeLayer.release(hex);
    });

    markersAt = state.version;
    step(0);   // place the new icons before the next paint, without moving them
  }

  /* Names arrive after the positions do, so the labels need a second pass —
     but only the text, never the icons. */
  function refreshLabels() {
    var showLabels = map.getZoom() >= LABEL_ZOOM;
    planeLayer.nodes.forEach(function (rec, hex) {
      var p = state.planes.get(hex);
      if (!p) return;
      planeLayer.label(rec, showLabels || hex === state.selected ? friendlyName(p) : '');
    });
  }

  /* -------------------------------------------------------- animation loop */

  /* One loop, driven by the display itself, replaces the old fixed timer. It
     does three things and nothing else: carry each aircraft forward along its
     heading, ease what is drawn towards that, and move the handful of nodes
     that ended up somewhere new. */
  var drLat = 0, drLon = 0;

  function deadReckon(p, now) {
    drLat = p.lat;
    drLon = p.lon;
    if (p.onGround || !p.groundSpeed || p.track == null) return;
    var dt = (now - p.fetchedAt) / 1000;
    if (dt <= 0) return;
    if (dt > MAX_EXTRAPOLATE_S) dt = MAX_EXTRAPOLATE_S;
    var nm = p.groundSpeed * dt / 3600;
    var rad = p.track * RAD;
    var cosLat = Math.cos(p.lat * RAD);
    if (cosLat < 1e-6) cosLat = 1e-6;
    drLat = p.lat + (nm * Math.cos(rad)) / 60;
    drLon = p.lon + (nm * Math.sin(rad)) / (60 * cosLat);
  }

  function advance(p, now, k) {
    deadReckon(p, now);
    var dLat = drLat - p.dispLat;
    var dLon = drLon - p.dispLon;
    // A search result or a fresh aircraft has no sensible "previous" place to
    // slide from, so put it straight where it belongs.
    if (dLat > 1 || dLat < -1 || dLon > 1 || dLon < -1) {
      p.dispLat = drLat;
      p.dispLon = drLon;
    } else {
      p.dispLat += dLat * k;
      p.dispLon += dLon * k;
    }
    if (p.track != null) {
      var turn = ((p.track - p.dispTrack + 540) % 360) - 180;   // the short way round
      p.dispTrack += turn * k;
    }
  }

  var markersAt = -1;
  var lastFrame = 0;
  var lastSync = 0;
  var lastRouteDraw = 0;
  var lastAgeNote = 0;

  /* A dt of zero means "just put everything where it already is" — used after
     the set of icons changes, so a newly created node lands in the right place
     without the aircraft jumping forward a step it has not taken yet. */
  function step(dt) {
    var now = Date.now();
    var moving = dt > 0;
    var k = moving ? 1 - Math.exp(-dt / SMOOTH_TAU) : 0;
    syncProjection();

    planeLayer.nodes.forEach(function (rec, hex) {
      var p = state.planes.get(hex);
      if (!p) return;
      if (moving) advance(p, now, k);
      planeLayer.place(rec, projectX(p.dispLon), projectY(p.dispLat));
      planeLayer.turn(rec, p.dispTrack);
    });

    var chosen = state.selected ? state.planes.get(state.selected) : null;
    if (moving && chosen && !planeLayer.has(chosen.hex)) advance(chosen, now, k);

    // Following means keeping the plane on screen, not re-centring the map
    // sixty times a second — which would restart the tile machinery each time.
    if (chosen && state.follow) {
      var size = map.getSize();
      var x = projectX(chosen.dispLon), y = projectY(chosen.dispLat);
      var c = map.latLngToLayerPoint(map.getCenter());
      if (Math.abs(x - c.x) > size.x * 0.22 || Math.abs(y - c.y) > size.y * 0.22) {
        map.panTo([chosen.dispLat, chosen.dispLon], { animate: true, duration: 0.6 });
      }
    }

    if (chosen && now - lastRouteDraw > 400) {
      lastRouteDraw = now;
      drawRouteLine();
    }

    if (now - lastAgeNote > 1000) {
      lastAgeNote = now;
      var age = Math.round((now - state.lastUpdate) / 1000);
      if (state.lastUpdate && !state.loading && age > 12) {
        setStatus('Updated ' + age + ' seconds ago', 'busy');
      }
    }
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    // A hidden tab gets no frames worth drawing, and the browser will have
    // throttled us anyway; do not pretend otherwise.
    if (document.hidden) { lastFrame = 0; return; }

    var dt = lastFrame ? (ts - lastFrame) / 1000 : 1 / 60;
    lastFrame = ts;
    if (dt > 0.5) dt = 0.5;

    var now = Date.now();
    // The set of icons only needs rethinking when the data or the view moved,
    // plus an occasional pass so decluttering keeps up with planes drifting.
    if (markersAt !== state.version || now - lastSync > 2500) {
      if (markersAt === state.version) state.visibleAt = -1;  // periodic pass
      lastSync = now;
      syncMarkers();
      return;   // syncMarkers has already placed everything for this frame
    }
    step(dt);
  }

  /* ------------------------------------------------------------ route line */

  /* The line from origin to destination barely changes: only the point where
     it switches from "flown" to "still to go" moves. Work the great circle out
     once per leg and afterwards just move the split. */
  function drawRouteLine() {
    var p = state.selected ? state.planes.get(state.selected) : null;
    var leg = p ? legFor(p) : null;
    if (!p || !leg) { clearRouteLine(); return; }

    var key = p.hex + '|' + (leg.origin.iata || leg.origin.icao) + '>' +
              (leg.destination.iata || leg.destination.icao);
    var line = state.routeLine;

    if (!line || line.key !== key) {
      clearRouteLine();
      var from = [leg.origin.lat, leg.origin.lon];
      var to = [leg.destination.lat, leg.destination.lon];
      var path = greatCircle(from, to, 96);
      var group = L.layerGroup();
      line = state.routeLine = {
        key: key,
        path: path,
        split: -1,
        // Solid behind the plane for the distance already flown, dashed ahead.
        flown: L.polyline([], { color: '#10365f', weight: 5, opacity: 0.85 }).addTo(group),
        ahead: L.polyline([], { color: '#c2410c', weight: 5, opacity: 0.9, dashArray: '10 9' }).addTo(group),
        group: group
      };
      airportMarker(from, leg.origin, 'From').addTo(group);
      airportMarker(to, leg.destination, 'To').addTo(group);
      group.addTo(map);
    }

    // Where along the precomputed path the aircraft currently sits.
    var path = line.path;
    var best = 0, bestD = Infinity;
    for (var i = 0; i < path.length; i++) {
      var d = roughDistance(p.dispLat, p.dispLon, path[i][0], path[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }

    var here = [p.dispLat, p.dispLon];
    var flown = path.slice(0, best + 1);
    flown.push(here);
    var ahead = path.slice(best);
    ahead[0] = here;
    line.flown.setLatLngs(flown);
    line.ahead.setLatLngs(ahead);
  }

  function clearRouteLine() {
    if (!state.routeLine) return;
    map.removeLayer(state.routeLine.group);
    state.routeLine = null;
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

  /* ------------------------------------------------------------------ views */

  function showView(which, sheet) {
    setHidden(el.listView, which !== 'list');
    setHidden(el.detailView, which !== 'detail');
    setHidden(el.airportView, which !== 'airport');
    state.view = which;
    if (which !== 'list') {
      el.panelBody.scrollTop = 0;
      setSheet(sheet || 'full');
    } else {
      updateHandleLabel();
    }
  }

  /* ----------------------------------------------------------- airport board */

  /* For the Departures and Arrivals tabs: whichever airport the user is looking
     at, or failing that the most important one near the middle of the map.
     The grid keeps this to the few cells around the point rather than a walk
     through every airport in the world. */
  function nearestAirport(lat, lon) {
    var bestBig = null, bestBigD = Infinity;
    var bestAny = null, bestAnyD = Infinity;

    for (var ring = 0; ring <= 2; ring++) {
      var span = CELL * (ring + 1);
      var near = airportsIn(lat - span, lon - span, lat + span, lon + span);
      for (var i = 0; i < near.length; i++) {
        var ap = near[i];
        var d = roughDistance(lat, lon, ap.lat, ap.lon);
        if (d < bestAnyD) { bestAnyD = d; bestAny = ap; }
        if (ap.size === 1 && d < bestBigD) { bestBigD = d; bestBig = ap; }
      }
      if (bestBig) break;
    }

    var withinReach = function (ap) {
      return ap && distanceNm([lat, lon], [ap.lat, ap.lon]) <= 90 ? ap : null;
    };
    return withinReach(bestBig) || withinReach(bestAny) || bestBig || bestAny;
  }

  function findAirport(iata) {
    return airportsByIata.get(iata) || null;
  }

  function openAirport(ap, focus) {
    if (!ap) return;
    state.airport = ap;
    state.airportFocus = focus || 'all';
    setBoardFocus(state.airportFocus);
    clearSelection();
    showView('airport');

    setText(el.airportName, ap.name);
    setText(el.airportWhere, ap.iata + ' · ' + [ap.city, countryName(ap.country)].filter(Boolean).join(', '));
    var loading = '<li class="empty">Listening for planes…</li>';
    el.groundList.innerHTML = loading;
    el.arrivalsList.innerHTML = loading;
    el.departuresList.innerHTML = loading;
    el.nearbyList.innerHTML = loading;
    setBoardTitles(null);

    map.setView([ap.lat, ap.lon], Math.max(map.getZoom(), 8));
    drawAirports();      // the airport you are reading about always keeps its pin
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
  var boards = [].slice.call(document.querySelectorAll('.board'));
  function setBoardFocus(focus) {
    boards.forEach(function (board) {
      setHidden(board, focus !== 'all' && board.dataset.board !== focus);
    });
  }

  function markAirportPins() {
    airportMarkers.forEach(function (marker, iata) {
      var node = marker.getElement();
      var pin = node && node.firstChild;
      if (pin && pin.classList) {
        pin.classList.toggle('selected', !!state.airport && state.airport.iata === iata);
      }
    });
  }

  function setBoardTitles(counts) {
    var n = function (key) { return counts && counts[key] ? ' (' + counts[key] + ')' : ''; };
    setText(el.groundTitle, 'At the airport right now' + n('onGround'));
    setText(el.arrivalsTitle, 'Landing here soon' + n('arrivals'));
    setText(el.departuresTitle, 'Leaving from here' + n('departures'));
    setText(el.nearbyTitle, 'Other planes in the sky nearby' + n('nearby'));
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

    // Build the whole board off-screen and attach it once, so the browser lays
    // the page out a single time rather than once per row.
    var frag = document.createDocumentFragment();
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
      frag.appendChild(item);
    });
    ul.appendChild(frag);
  }

  // A flight on the board may be outside the map's current view, so fetch it.
  function openFromBoard(f) {
    if (state.planes.has(f.hex)) { select(f.hex, true, 'full'); return; }
    setStatus('Finding ' + (f.callsign || 'that flight') + '…', 'busy');
    fetch('/api/search?q=' + encodeURIComponent(f.callsign))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var p = data.aircraft && data.aircraft[0];
        if (!p) { showBanner('That flight has just gone out of range.', 'search'); return; }
        adopt(p);
        map.setView([p.lat, p.lon], Math.max(map.getZoom(), 8));
        select(p.hex, false, 'full');
      })
      .catch(function () { showBanner('Could not open that flight.', 'search'); });
  }

  /* Put a plane that arrived from somewhere other than the area poll into the
     same shape as everything else on the map. */
  function adopt(p) {
    p.fetchedAt = Date.now();
    p.stamp = p.fetchedAt;
    p.dispLat = p.lat;
    p.dispLon = p.lon;
    p.dispTrack = p.track || 0;
    state.planes.set(p.hex, p);
    state.version++;
  }

  function clearSelection() {
    var was = state.selected;
    state.selected = null;
    setFollow(false);
    state.listSignature = '';
    clearRouteLine();
    if (was) {
      var rec = planeLayer.get(was);
      var p = state.planes.get(was);
      if (rec && p) planeLayer.dress(rec, p, false);
    }
    state.version++;
  }

  /* The sheet has three heights: out of the way, a quarter-screen peek with the
     headline, and the whole thing. */
  var wideScreen = window.matchMedia('(min-width: 800px)');

  function setSheet(mode) {
    // On a wide screen the panel is a fixed column, so there is nothing to peek.
    if (wideScreen.matches) mode = 'full';
    if (state.sheet === mode && mode !== 'peek') { updateHandleLabel(); return; }
    state.sheet = mode;
    el.panel.classList.toggle('open', mode === 'full');
    el.panel.classList.toggle('peek', mode === 'peek');
    el.panelHandle.setAttribute('aria-expanded', String(mode === 'full'));
    updateHandleLabel();
    if (mode === 'peek') measurePeek(true);
  }

  function openPanel(open) { setSheet(open ? 'full' : 'closed'); }

  function updateHandleLabel() {
    var label;
    if (state.view === 'detail') {
      label = state.sheet === 'full' ? 'Hide the flight details' : 'Show more about this flight';
    } else if (state.view === 'airport') {
      label = state.sheet === 'full' ? 'Hide this airport' : 'Show this airport';
    } else {
      var n = visibleRows;
      label = n ? 'Show ' + n + ' planes near here' : 'Show the list of planes';
    }
    setText(el.panelHandleText, label);
  }

  /* A quarter of the screen, unless the headline genuinely needs more room —
     which it does at the largest text size. Measuring forces the browser to
     lay the page out, so only do it when the headline has actually changed. */
  var peekSignature = null;

  function measurePeek(force) {
    var sig = el.peekName.textContent + '|' + el.peekRoute.textContent + '|' +
              el.peekFacts.textContent + '|' + window.innerHeight;
    if (!force && sig === peekSignature) return;
    peekSignature = sig;

    var handle = el.panelHandle.offsetHeight || 0;
    var body = el.panelBody;
    var style = getComputedStyle(body);
    var padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    var needed = handle + (el.peekSummary.offsetHeight || 0) + (padding || 32);

    var header = document.querySelector('.topbar').offsetHeight || 0;
    var nav = el.bottomNav.offsetHeight || 0;
    var most = window.innerHeight - header - nav;

    var quarter = window.innerHeight * 0.25;
    var peek = Math.min(Math.max(quarter, needed), most);
    document.documentElement.style.setProperty('--peek-h', Math.round(peek) + 'px');
  }

  /* ------------------------------------------------------------- flight list */

  /* The list is rebuilt every few seconds. Creating forty buttons each time
     churns through the DOM for no reason, so the rows are made once and then
     only their words change — and only the words that are actually different. */
  var listRows = [];
  var visibleRows = 0;

  function listRow(i) {
    var row = listRows[i];
    if (row) return row;
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    var name = document.createElement('span'); name.className = 'fl-name';
    var alt = document.createElement('span'); alt.className = 'fl-alt';
    var route = document.createElement('span'); route.className = 'fl-route';
    btn.appendChild(name);
    btn.appendChild(alt);
    btn.appendChild(route);
    li.appendChild(btn);
    row = listRows[i] = { li: li, btn: btn, name: name, alt: alt, route: route, hex: null };
    btn.addEventListener('click', function () { if (row.hex) select(row.hex, true, 'full'); });
    el.flightList.appendChild(li);
    return row;
  }

  function renderList() {
    var all = visiblePlanes();
    var list = [];
    for (var i = 0; i < all.length && list.length < 40; i++) {
      if (!all[i].onGround) list.push(all[i]);
    }
    for (var j = 0; j < all.length && list.length < 40; j++) {
      if (all[j].onGround) list.push(all[j]);
    }

    // Only rebuild when something actually changed — a list that reshuffles
    // under your finger every few seconds is hard to use.
    var sig = '';
    for (var k = 0; k < list.length; k++) {
      var p = list[k];
      sig += p.hex + ':' + (p.callsign || '') + ':' + Math.round((p.altitude || 0) / 500) + '|';
    }
    sig += '#' + state.selected;
    if (sig === state.listSignature) return;
    state.listSignature = sig;

    setText(el.listTitle, list.length ? 'Planes flying near here' : 'No planes in view');
    setText(el.listHint, list.length
      ? 'Tap any flight to see where it is going.'
      : 'Try dragging the map, or zooming out with the − button.');

    for (var n = 0; n < list.length; n++) {
      var q = list[n];
      var row = listRow(n);
      row.hex = q.hex;
      if (row.li.hidden) row.li.hidden = false;
      setText(row.name, friendlyName(q));
      setText(row.alt, q.onGround ? 'landed' : formatAltitude(q.altitude, false));
      setText(row.route, routeSummary(q) ||
        (isPrivate(q) ? 'Private flight' : (q.onGround ? 'On the ground' : 'Looking up the route…')));
      var current = q.hex === state.selected;
      if (current) row.btn.setAttribute('aria-current', 'true');
      else row.btn.removeAttribute('aria-current');
    }
    for (var m = list.length; m < listRows.length; m++) {
      if (!listRows[m].li.hidden) { listRows[m].li.hidden = true; listRows[m].hex = null; }
    }
    visibleRows = list.length;

    if (state.view === 'list') updateHandleLabel();
  }

  /* ----------------------------------------------------------- detail view */

  /* sheet: 'peek' when the plane was tapped on the map, so the map stays
     visible; 'full' when the choice came from a list that already filled the
     screen. */
  function select(hex, recenter, sheet) {
    var previous = state.selected;
    state.selected = hex;
    state.airport = null;
    markAirportPins();
    setFollow(false);
    state.listSignature = '';
    clearRouteLine();

    var p = state.planes.get(hex);
    if (p && recenter) map.setView([p.dispLat, p.dispLon], Math.max(map.getZoom(), 8));

    // Only the two aircraft whose appearance changed need redressing.
    [previous, hex].forEach(function (id) {
      if (!id) return;
      var rec = planeLayer.get(id);
      var q = state.planes.get(id);
      if (rec && q) {
        planeLayer.dress(rec, q, id === state.selected);
        planeLayer.label(rec, map.getZoom() >= LABEL_ZOOM || id === state.selected ? friendlyName(q) : '');
      }
    });
    if (p && !planeLayer.has(hex)) { state.version++; }

    showView('detail', sheet || 'peek');
    highlightTab(null);
    renderDetail();
    loadExtras(hex);
  }

  function loadExtras(hex) {
    var p = state.planes.get(hex);
    if (!p) return;
    if (p.callsign && !state.routes.has(p.callsign)) {
      fetch('/api/route?callsign=' + encodeURIComponent(p.callsign) +
            '&lat=' + p.lat.toFixed(4) + '&lon=' + p.lon.toFixed(4))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          remember(state.routes, p.callsign, d.route || null, 4000);
          state.listSignature = '';
          if (state.selected === hex) renderDetail();
          renderList();
          refreshLabels();
        })
        .catch(function () {});
    }
    if (!state.aircraftInfo.has(hex)) {
      fetch('/api/aircraft?hex=' + encodeURIComponent(hex))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          remember(state.aircraftInfo, hex, d.aircraft || null, 600);
          if (state.selected === hex) renderDetail();
        })
        .catch(function () {});
    }
  }

  function renderDetail() {
    var p = state.planes.get(state.selected);
    if (!p) return;
    var route = routeFor(p);
    var info = state.aircraftInfo.get(p.hex);

    setText(el.flightTitle, friendlyName(p));

    var subBits = [];
    if (route && route.flightNumber) subBits.push('Flight ' + route.flightNumber);
    else if (p.callsign && !isPrivate(p)) subBits.push('Flight ' + p.callsign);
    if (p.registration) subBits.push('Tail number ' + p.registration);
    if (isPrivate(p)) subBits.push('a private flight');
    setText(el.flightSub, subBits.join(' · '));

    var leg = legFor(p);
    setEnd(leg && leg.origin, el.fromCode, el.fromCity, p);
    setEnd(leg && leg.destination, el.toCode, el.toCity, p);

    setText(el.factStatus, plainStatus(p));
    setText(el.factAlt, formatAltitude(p.altitude, p.onGround));
    setText(el.factSpeed, p.onGround ? '—' : formatSpeed(p.groundSpeed));
    var model = (info && (info.manufacturer || info.type))
      ? ((info.manufacturer ? info.manufacturer + ' ' : '') + (info.type || '')).trim()
      : (p.description || p.typeCode || null);
    setText(el.factType, model || 'Not known');

    if (info && info.photoThumb) {
      if (el.photo.getAttribute('src') !== info.photoThumb) {
        el.photo.src = info.photoThumb;
        el.photo.alt = 'Photograph of ' + (info.registration || 'this aircraft');
      }
      setHidden(el.photoWrap, false);
    } else {
      setHidden(el.photoWrap, true);
      el.photo.removeAttribute('src');
    }

    if (leg && leg.destination.iata) {
      setText(el.destBtn, 'See all flights at ' + (leg.destination.city || leg.destination.iata));
      setHidden(el.destBtn, false);
    } else {
      setHidden(el.destBtn, true);
    }

    renderProgress(p, leg);
    renderPeek(p, leg);
    drawRouteLine();
  }

  /* The quarter-screen version: who it is, the two cities, and what it is doing
     right now. Everything else waits until the sheet is opened fully. */
  function renderPeek(p, leg) {
    setText(el.peekName, friendlyName(p));

    if (leg) {
      var fromCode = leg.origin.iata || leg.origin.icao || '?';
      var toCode = leg.destination.iata || leg.destination.icao || '?';
      var html = '<b>' + escapeHtml(fromCode) + '</b> ' + escapeHtml(leg.origin.city || '') +
                 '  →  <b>' + escapeHtml(toCode) + '</b> ' + escapeHtml(leg.destination.city || '');
      if (el.peekRoute.__h !== html) {
        el.peekRoute.__h = html;
        el.peekRoute.innerHTML = html;
      }
    } else {
      var words = isPrivate(p)
        ? 'A private flight — no route is published'
        : 'Looking up where it is going…';
      if (el.peekRoute.__h !== words) {
        el.peekRoute.__h = words;
        el.peekRoute.textContent = words;
      }
    }

    var bits = [plainStatus(p)];
    if (!p.onGround) {
      bits.push(formatAltitude(p.altitude, false));
      if (p.groundSpeed) bits.push(formatSpeed(p.groundSpeed));
    }
    setText(el.peekFacts, bits.join(' · '));

    if (state.sheet === 'peek') measurePeek(false);
  }

  function setEnd(airport, codeEl, cityEl, p) {
    if (!airport) {
      setText(codeEl, '—');
      setText(cityEl, p && isPrivate(p)
        ? 'Private flights do not publish a route'
        : 'Still looking…');
      return;
    }
    setText(codeEl, airport.iata || airport.icao || '—');
    setText(cityEl, [airport.city, countryName(airport.country)].filter(Boolean).join(', ') ||
                    airport.name || 'Not known');
  }

  function renderProgress(p, leg) {
    if (!leg) { setHidden(el.progressWrap, true); return; }
    var route = leg;
    var here = [p.dispLat, p.dispLon];
    var from = [leg.origin.lat, leg.origin.lon];
    var to = [leg.destination.lat, leg.destination.lon];
    var flown = distanceNm(from, here);
    var left = distanceNm(here, to);
    var total = flown + left;
    if (!total) { setHidden(el.progressWrap, true); return; }

    // Route databases store a flight number's usual legs. If this plane is
    // nowhere near the straight line between them we are probably looking at a
    // different leg, so don't invent a progress figure.
    var direct = distanceNm(from, to);
    if (direct > 20 && total > direct * 1.5) {
      el.progressBar.style.width = '0%';
      setText(el.progressText, 'This flight number usually flies ' +
        (route.origin.city || route.origin.iata) + ' to ' +
        (route.destination.city || route.destination.iata) +
        ', but this aircraft is somewhere else today, so it may be flying a different leg.');
      setHidden(el.progressWrap, false);
      return;
    }

    var pct = Math.max(0, Math.min(100, (flown / total) * 100));
    var width = pct.toFixed(1) + '%';
    if (el.progressBar.style.width !== width) el.progressBar.style.width = width;

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
    setText(el.progressText, Math.round(pct) + '% of the way there. ' + words);
    setHidden(el.progressWrap, false);
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

  var navButtons = [].slice.call(el.bottomNav.querySelectorAll('.nav-btn'));

  function highlightTab(tab) {
    state.tab = tab;
    navButtons.forEach(function (btn) {
      var on = String(btn.dataset.tab === tab);
      if (btn.getAttribute('aria-current') !== on) btn.setAttribute('aria-current', on);
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
    var p = state.planes.get(state.selected);
    var leg = p && legFor(p);
    if (!leg) return;
    openAirport(findAirport(leg.destination.iata) || leg.destination);
  });

  function setFollow(on) {
    if (state.follow === on) return;
    state.follow = on;
    el.followBtn.textContent = on ? 'Stop tracking this plane' : 'Track this plane';
    el.followBtn.classList.toggle('tracking', on);
    el.trackNote.hidden = !on;
  }

  el.followBtn.addEventListener('click', function () { setFollow(!state.follow); });

  // Tapping the handle always means "more", until there is no more to give.
  el.panelHandle.addEventListener('click', function () {
    var opening = state.sheet !== 'full';
    setSheet(opening ? 'full' : 'closed');
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
          adopt(p);
          map.setView([p.lat, p.lon], 8);
          select(p.hex, false, 'peek');
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
    setTimeout(function () {
      map.invalidateSize();
      measureHandle();
      measureNav();
      measurePeek(true);
    }, 60);
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
    [].forEach.call(el.mapChoices.querySelectorAll('.choice'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.map === mapStyle));
    });
  }

  el.sizeChoices.addEventListener('click', function (e) {
    var btn = e.target.closest('.choice');
    if (!btn) return;
    applySize(btn.dataset.size);
    markChoices();
  });

  el.mapChoices.addEventListener('click', function (e) {
    var btn = e.target.closest('.choice');
    if (!btn) return;
    applyMapStyle(btn.dataset.map);
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
      setText(el.settingsStatus, state.status);
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

  /* Tapping bare map means "I am done with this one": drop the selection and
     put the sheet away, so the details that popped up do not linger over the
     map. A tap that landed on a plane is handled by the plane layer itself, and
     Leaflet does not raise a map click for taps on an airport pin, so this only
     fires on empty space. */
  map.on('click', function (e) {
    var target = e.originalEvent && e.originalEvent.target;
    if (target && target.closest && target.closest('.plane-marker')) return;
    if (!state.selected && !state.airport) return;
    goBackToList();
    openPanel(false);
    highlightTab('home');
  });

  // Dragging the map by hand should never fight the map re-centring itself.
  map.on('dragstart', function () {
    if (state.follow) setFollow(false);
  });

  /* While the map is being dragged the icons ride along with Leaflet's own
     pane, so a pan costs us nothing at all. Only when it comes to rest does
     the set of aircraft on screen need working out again — and only then is it
     worth asking the server about a different patch of sky. */
  map.on('moveend zoomend', function () {
    state.listSignature = '';
    state.version++;
    state.visibleAt = -1;
    syncMarkers();
    drawAirports();
    markAirportPins();
    renderList();
    clearTimeout(moveTimer);
    moveTimer = setTimeout(refresh, 300);
  });

  /* Leaflet zooms by transforming the whole map pane, so every icon has to be
     told where it will belong at the new zoom before the animation starts —
     otherwise they all slide to the wrong place and snap back at the end. */
  map.on('zoomanim', function (e) {
    if (!map._getNewPixelOrigin) return;
    var origin = map._getNewPixelOrigin(e.center, e.zoom);
    proj.scale = 256 * Math.pow(2, e.zoom);
    proj.originX = origin.x;
    proj.originY = origin.y;
    planeLayer.nodes.forEach(function (rec, hex) {
      var p = state.planes.get(hex);
      if (p) planeLayer.place(rec, projectX(p.dispLon), projectY(p.dispLat));
    });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    lastFrame = 0;
    // Everything on screen is now stale by however long the tab was away.
    refresh();
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      map.invalidateSize();
      measureHandle();
      measureNav();
      measurePeek(true);
    }, 150);
  });
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

  if (wideScreen.matches) openPanel(true);

  showView('list');
  measureHandle();
  measureNav();
  highlightTab(wideScreen.matches ? 'live' : 'home');
  refresh();
  requestAnimationFrame(frame);
})();
