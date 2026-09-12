#!/usr/bin/env node
/**
 * Flight Finder - local server.
 *
 * Acts as a small caching proxy in front of two free, key-less data sources:
 *   - api.adsb.lol   live ADS-B positions (no CORS headers, so it must be proxied)
 *   - api.adsbdb.com callsign -> airline + origin/destination airport, hex -> aircraft
 *
 * Also serves the static front-end in public/.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 5173);
const HOST = '0.0.0.0';
const UA = 'FlightFinder/1.0 (personal hobby flight map)';

const CACHE_DIR = path.join(__dirname, 'cache');
const ROUTE_CACHE_FILE = path.join(CACHE_DIR, 'routes.json');
const AIRCRAFT_CACHE_FILE = path.join(CACHE_DIR, 'aircraft.json');
const AIRLINE_CACHE_FILE = path.join(CACHE_DIR, 'airlines.json');

const DAY = 86400e3;
const TTL = {
  flights: 4e3,        // live positions: very short
  route: 3 * DAY,      // schedules shift, so re-check a route every few days
  routeMiss: 1 * DAY,  // remember "unknown" for a day so we stop asking
  airline: 365 * DAY,  // an airline's name is not going anywhere
  aircraft: 120 * DAY, // tail number -> aircraft type basically never changes
};

/* ------------------------------------------------------------------ caches */

function loadCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** The bundled airport list, indexed by IATA code. */
const airportsByIata = (() => {
  const index = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'airports.json'), 'utf8'));
    for (const row of raw.airports) {
      const [iata, icao, name, city, country, lat, lon, size] = row;
      index.set(iata, { iata, icao, name, city, country, lat, lon, size });
    }
  } catch (err) {
    console.warn('airport list unavailable:', err.message);
  }
  return index;
})();

const routeCache = loadCache(ROUTE_CACHE_FILE);
const aircraftCache = loadCache(AIRCRAFT_CACHE_FILE);
const airlineCache = loadCache(AIRLINE_CACHE_FILE);
const flightCache = new Map();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(ROUTE_CACHE_FILE, JSON.stringify(routeCache));
      fs.writeFileSync(AIRCRAFT_CACHE_FILE, JSON.stringify(aircraftCache));
      fs.writeFileSync(AIRLINE_CACHE_FILE, JSON.stringify(airlineCache));
    } catch (err) {
      console.warn('could not write cache:', err.message);
    }
  }, 5000);
  saveTimer.unref?.();
}

function fresh(entry, ttl) {
  return entry && Date.now() - entry.at < ttl;
}

/* ----------------------------------------------------------------- fetching */

async function getJSON(url, timeoutMs = 9000) {
  return requestJSON(url, null, timeoutMs);
}

async function postJSON(url, body, timeoutMs = 12000) {
  return requestJSON(url, body, timeoutMs);
}

async function requestJSON(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      method: body ? 'POST' : 'GET',
      headers: Object.assign(
        { 'User-Agent': UA, Accept: 'application/json' },
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * These are free, community-run services. Space our calls out, and if one
 * starts refusing us, stand back from it for a while and use the other.
 */
// The live-position feeds are strict; the route database is happy with a
// faster trickle, and its answers are cached forever afterwards.
const HOST_GAP_MS = { 'api.adsbdb.com': 200, 'adsb.im': 700 };
const DEFAULT_GAP_MS = 1300;
const hostState = new Map(); // host -> { queue, lastStart, cooldownUntil }

function hostInfo(host) {
  if (!hostState.has(host)) {
    hostState.set(host, { queue: Promise.resolve(), lastStart: 0, cooldownUntil: 0 });
  }
  return hostState.get(host);
}

function available(host) {
  return Date.now() >= hostInfo(host).cooldownUntil;
}

function paced(host, fn) {
  const info = hostInfo(host);
  const run = info.queue.then(async () => {
    const gap = HOST_GAP_MS[host] || DEFAULT_GAP_MS;
    const wait = Math.max(0, info.lastStart + gap - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    info.lastStart = Date.now();
    try {
      return await fn();
    } catch (err) {
      if (/\b(429|5\d\d)\b/.test(err.message)) {
        info.cooldownUntil = Date.now() + (/429/.test(err.message) ? 20000 : 10000);
      }
      throw err;
    }
  });
  info.queue = run.catch(() => {}); // one failure must not block the queue
  return run;
}

// Collapse identical concurrent upstream calls into one.
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ------------------------------------------------------------ normalisation */

function cleanCallsign(s) {
  return (s || '').trim().toUpperCase();
}

function normalizeAircraft(a) {
  const onGround = a.alt_baro === 'ground';
  return {
    hex: a.hex,
    callsign: cleanCallsign(a.flight),
    registration: a.r || null,
    typeCode: a.t || null,
    lat: a.lat,
    lon: a.lon,
    altitude: onGround ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : null),
    onGround,
    groundSpeed: typeof a.gs === 'number' ? a.gs : null, // knots
    track: typeof a.track === 'number' ? a.track : (typeof a.true_heading === 'number' ? a.true_heading : null),
    verticalRate: typeof a.baro_rate === 'number' ? a.baro_rate
      : (typeof a.geom_rate === 'number' ? a.geom_rate : null),
    squawk: a.squawk || null,
    emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
    category: a.category || null,
    description: a.desc || null,
    operator: a.ownOp || null,
    year: a.year || null,
    seen: typeof a.seen_pos === 'number' ? a.seen_pos : null,
  };
}

function usableAircraft(a) {
  return a && typeof a.lat === 'number' && typeof a.lon === 'number';
}

/* ---------------------------------------------------------------- endpoints */

const POSITION_SOURCES = [
  {
    host: 'api.adsb.lol',
    area: (lat, lon, d) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${d}`,
    lookup: (kind, value) => `https://api.adsb.lol/v2/${kind}/${value}`,
  },
  {
    host: 'opendata.adsb.fi',
    area: (lat, lon, d) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${d}`,
    lookup: (kind, value) => `https://opendata.adsb.fi/api/v2/${kind}/${value}`,
  },
];

function planesFrom(data) {
  const raw = data.ac || data.aircraft || [];
  return raw.filter(usableAircraft).map(normalizeAircraft);
}

// Try each source in turn, preferring ones not currently in a cooldown.
async function fromAnySource(build) {
  const ordered = POSITION_SOURCES.slice().sort((a, b) => available(b.host) - available(a.host));
  let lastErr = new Error('no source available');
  for (const source of ordered) {
    try {
      return await paced(source.host, () => getJSON(build(source)));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchFlights(lat, lon, dist) {
  const key = `${lat.toFixed(2)}/${lon.toFixed(2)}/${dist}`;
  const hit = flightCache.get(key);
  if (fresh(hit, TTL.flights)) return hit.value;

  return once('f:' + key, async () => {
    try {
      const data = await fromAnySource((s) => s.area(lat.toFixed(4), lon.toFixed(4), dist));
      const value = { aircraft: planesFrom(data), updatedAt: Date.now(), stale: false };
      flightCache.set(key, { at: Date.now(), value });
      if (flightCache.size > 80) flightCache.delete(flightCache.keys().next().value);
      return value;
    } catch (err) {
      // Rather than blanking the map, hand back the last good picture of this
      // area if we have a recent one.
      const stale = flightCache.get(key);
      if (stale && Date.now() - stale.at < 120e3) {
        return Object.assign({}, stale.value, { stale: true });
      }
      throw err;
    }
  });
}

/**
 * Routes come from the tar1090 route service, which picks the right leg for a
 * multi-stop flight number from the aircraft's current position. It is far more
 * accurate for live traffic than a plain callsign database, and it is a batch
 * endpoint, so one request covers every flight on the screen.
 */
const ROUTESET_URL = 'https://adsb.im/api/0/routeset';

function normalizeRoute(row) {
  const airports = (row._airports || [])
    .filter((a) => typeof a.lat === 'number' && typeof a.lon === 'number')
    .map((a) => ({
      iata: a.iata || null,
      icao: a.icao || null,
      name: a.name || null,
      city: a.location || null,
      country: a.countryiso2 || null,
      lat: a.lat,
      lon: a.lon,
    }));
  if (airports.length < 2) return null;
  const clean = (v) => (v && v !== 'unknown' ? String(v) : null);
  return {
    airports,
    airlineCode: clean(row.airline_code),
    number: clean(row.number),
    airline: null,
    flightNumber: null,
  };
}

async function fetchRoutes(planes, budget = 80) {
  const out = {};
  const todo = [];

  for (const p of planes) {
    const cs = cleanCallsign(p && p.callsign);
    if (!cs || !/^[A-Z0-9]{3,10}$/.test(cs) || out[cs] !== undefined) continue;
    const hit = routeCache[cs];
    if (fresh(hit, hit && hit.value ? TTL.route : TTL.routeMiss)) {
      out[cs] = hit.value;
      continue;
    }
    todo.push({
      callsign: cs,
      lat: Number(p.lat) || 0,
      lng: Number(p.lng !== undefined ? p.lng : p.lon) || 0,
    });
  }

  const batch = todo.slice(0, budget);
  if (batch.length) {
    try {
      const rows = await paced('adsb.im', () => postJSON(ROUTESET_URL, { planes: batch }));
      (Array.isArray(rows) ? rows : []).forEach((row, i) => {
        const cs = cleanCallsign(row && row.callsign) || batch[i].callsign;
        const value = normalizeRoute(row || {});
        routeCache[cs] = { at: Date.now(), value };
        out[cs] = value;
      });
      scheduleSave();
    } catch (err) {
      console.warn('route lookup failed:', err.message);
    }
    // Anything the service skipped is simply unknown for now.
    batch.forEach((b) => { if (out[b.callsign] === undefined) out[b.callsign] = null; });
  }

  await attachAirlineNames(out);
  return { routes: out, pending: Math.max(0, todo.length - batch.length) };
}

/**
 * The route service names the airline only by code. Resolve each code to a
 * readable name once, then remember it — after a short while this costs nothing.
 */
async function attachAirlineNames(routes) {
  const wanted = new Map(); // airline code -> a callsign we can ask about

  Object.keys(routes).forEach((cs) => {
    const r = routes[cs];
    if (!r || !r.airlineCode) return;
    const known = airlineCache[r.airlineCode];
    if (fresh(known, TTL.airline)) {
      applyAirline(r, known.value);
    } else if (!wanted.has(r.airlineCode)) {
      wanted.set(r.airlineCode, cs);
    }
  });

  const lookups = Array.from(wanted.keys()).slice(0, 6);
  await Promise.all(lookups.map(async (code) => {
    let value = null;
    try {
      const data = await paced('api.adsbdb.com', () =>
        getJSON(`https://api.adsbdb.com/v0/airline/${code}`));
      const row = data && Array.isArray(data.response) ? data.response[0] : null;
      if (row && row.name) value = { name: row.name, iata: row.iata || null };
    } catch { /* the code itself is a usable fallback */ }
    airlineCache[code] = { at: Date.now(), value };
    scheduleSave();
  }));

  Object.keys(routes).forEach((cs) => {
    const r = routes[cs];
    if (!r || r.airline || !r.airlineCode) return;
    const known = airlineCache[r.airlineCode];
    if (known) applyAirline(r, known.value);
  });
}

function applyAirline(route, airline) {
  if (!airline) return;
  route.airline = airline.name || null;
  // Passengers know their flight as "AA1339", not "AAL1339".
  if (airline.iata && route.number) route.flightNumber = airline.iata + route.number;
}

/**
 * adsbdb's callsign record. Its route data is often out of date, so we use it
 * only for the airline name and for turning "AA100" into "AAL100".
 */
async function lookupCallsign(callsign) {
  const cs = cleanCallsign(callsign);
  if (!/^[A-Z0-9]{3,10}$/.test(cs)) return null;

  const hit = aircraftCache['CS:' + cs];
  if (fresh(hit, hit && hit.value ? TTL.airline : TTL.routeMiss)) return hit.value;

  return once('c:' + cs, async () => {
    let value = null;
    try {
      const data = await paced('api.adsbdb.com', () =>
        getJSON(`https://api.adsbdb.com/v0/callsign/${cs}`));
      const fr = data && data.response && data.response.flightroute;
      if (fr) {
        value = {
          callsign: fr.callsign_icao || fr.callsign || cs,
          flightNumber: fr.callsign_iata || null,
          airline: (fr.airline && fr.airline.name) || null,
        };
      }
    } catch {
      return (aircraftCache['CS:' + cs] && aircraftCache['CS:' + cs].value) || null;
    }
    aircraftCache['CS:' + cs] = { at: Date.now(), value };
    scheduleSave();
    return value;
  });
}

async function fetchAircraftInfo(hex) {
  const id = (hex || '').trim().toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(id)) return null;

  const hit = aircraftCache[id];
  if (fresh(hit, hit && hit.value ? TTL.aircraft : TTL.routeMiss)) return hit.value;

  return once('a:' + id, async () => {
    let value = null;
    try {
      const data = await paced('api.adsbdb.com', () => getJSON(`https://api.adsbdb.com/v0/aircraft/${id}`));
      const ac = data?.response?.aircraft;
      if (ac) {
        value = {
          registration: ac.registration || null,
          manufacturer: ac.manufacturer || null,
          type: ac.type || null,
          icaoType: ac.icao_type || null,
          owner: ac.registered_owner || null,
          photo: ac.url_photo || null,
          photoThumb: ac.url_photo_thumbnail || null,
        };
      }
    } catch {
      return aircraftCache[id]?.value ?? null;
    }
    aircraftCache[id] = { at: Date.now(), value };
    scheduleSave();
    return value;
  });
}

/**
 * Find one flight by flight number (BA283 or BAW283) or tail number (N221WN).
 */
async function searchFlight(query) {
  const q = (query || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(q)) return { aircraft: [], reason: 'bad-query' };

  for (const kind of ['callsign', 'registration', 'hex']) {
    if (kind === 'hex' && !/^[A-F0-9]{6}$/.test(q)) continue;
    try {
      const data = await fromAnySource((s) => s.lookup(kind, q));
      const list = planesFrom(data);
      if (list.length) return { aircraft: list };
    } catch { /* try the next form */ }
  }

  // Maybe they typed the airline's 2-letter code (AA100); translate to ICAO (AAL100).
  const route = await lookupCallsign(q).catch(() => null);
  if (route?.callsign && route.callsign !== q) {
    try {
      const data = await fromAnySource((s) => s.lookup('callsign', route.callsign));
      const list = planesFrom(data);
      if (list.length) return { aircraft: list };
    } catch { /* fall through */ }
    return { aircraft: [], reason: 'not-flying', route };
  }

  return { aircraft: [], reason: 'not-found' };
}

/* ---------------------------------------------------------- airport activity */

function haversineNm(aLat, aLon, bLat, bLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const la1 = toRad(aLat), la2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function pickLeg(route, lat, lon) {
  if (!route || !route.airports || route.airports.length < 2) return null;
  const aps = route.airports;
  let best = null;
  for (let i = 0; i < aps.length - 1; i++) {
    const a = aps[i], b = aps[i + 1];
    const detour = haversineNm(a.lat, a.lon, lat, lon) +
                   haversineNm(lat, lon, b.lat, b.lon) -
                   haversineNm(a.lat, a.lon, b.lat, b.lon);
    if (!best || detour < best.detour) best = { origin: a, destination: b, detour };
  }
  return best;
}

/**
 * There is no free schedule feed, so build the board from what is actually in
 * the sky: every aircraft within range whose current leg starts or ends here.
 */
async function airportBoard(iata) {
  const airport = airportsByIata.get((iata || '').trim().toUpperCase());
  if (!airport) return null;

  const flights = await fetchFlights(airport.lat, airport.lon, 200);

  // Airport service vehicles broadcast too, but they are not aircraft.
  const live = flights.aircraft.filter((a) => !['C1', 'C2', 'C3'].includes(a.category));

  const withCallsign = live.filter((a) => a.callsign);
  const { routes } = await fetchRoutes(
    withCallsign.map((a) => ({ callsign: a.callsign, lat: a.lat, lng: a.lon })), 100);

  const onGround = [];
  const arrivals = [];
  const departures = [];
  const nearby = [];

  for (const a of live) {
    const distance = haversineNm(airport.lat, airport.lon, a.lat, a.lon);
    const route = a.callsign ? routes[a.callsign] : null;
    const leg = pickLeg(route, a.lat, a.lon);

    const entry = {
      hex: a.hex,
      callsign: a.callsign || null,
      registration: a.registration,
      typeCode: a.typeCode,
      description: a.description,
      airline: route ? route.airline : null,
      number: route ? route.number : null,
      flightNumber: route ? route.flightNumber : null,
      altitude: a.altitude,
      onGround: a.onGround,
      groundSpeed: a.groundSpeed,
      verticalRate: a.verticalRate,
      distance: Math.round(distance * 10) / 10,
      seen: a.seen,
      lat: a.lat,
      lon: a.lon,
      other: null,
      minutes: null,
    };

    // Sitting on the airport itself: parked, at a gate, or taxiing.
    if (a.onGround && distance <= 8) {
      entry.other = leg ? (leg.destination.iata === airport.iata ? leg.origin : leg.destination) : null;
      entry.heading = leg && leg.origin.iata === airport.iata ? 'out' : 'in';
      entry.moving = (a.groundSpeed || 0) > 3;
      onGround.push(entry);
      continue;
    }
    if (a.onGround) continue;   // on the ground somewhere else entirely

    if (leg && leg.destination.iata === airport.iata) {
      entry.other = leg.origin;
      entry.minutes = a.groundSpeed > 60 ? Math.round((distance / a.groundSpeed) * 60) : null;
      arrivals.push(entry);
    } else if (leg && leg.origin.iata === airport.iata) {
      entry.other = leg.destination;
      departures.push(entry);
    } else if (distance <= 30) {
      // Flying close by with no route of ours — still a real aircraft overhead.
      if (leg) entry.other = leg.destination;
      nearby.push(entry);
    }
  }

  onGround.sort((x, y) => Number(y.moving) - Number(x.moving) ||
                          (y.groundSpeed || 0) - (x.groundSpeed || 0));
  arrivals.sort((x, y) => (x.minutes ?? 999) - (y.minutes ?? 999) || x.distance - y.distance);
  departures.sort((x, y) => x.distance - y.distance);
  nearby.sort((x, y) => x.distance - y.distance);

  return {
    airport,
    onGround: onGround.slice(0, 40),
    arrivals: arrivals.slice(0, 25),
    departures: departures.slice(0, 25),
    nearby: nearby.slice(0, 25),
    counts: {
      onGround: onGround.length,
      arrivals: arrivals.length,
      departures: departures.length,
      nearby: nearby.length,
    },
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------ http plumbing */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/health') return sendJSON(res, 200, { ok: true, cachedRoutes: Object.keys(routeCache).length });

    if (p === '/api/flights') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      let dist = Math.round(Number(url.searchParams.get('dist') || 100));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return sendJSON(res, 400, { error: 'lat and lon are required' });
      }
      dist = Math.min(250, Math.max(1, Number.isFinite(dist) ? dist : 100));
      return sendJSON(res, 200, await fetchFlights(lat, lon, dist));
    }

    if (p === '/api/routes' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const list = Array.isArray(body.planes) ? body.planes.slice(0, 150) : [];
      return sendJSON(res, 200, await fetchRoutes(list, 100));
    }

    if (p === '/api/route') {
      const cs = url.searchParams.get('callsign');
      const result = await fetchRoutes([{
        callsign: cs,
        lat: Number(url.searchParams.get('lat')) || 0,
        lng: Number(url.searchParams.get('lon')) || 0,
      }], 1);
      return sendJSON(res, 200, { route: result.routes[cleanCallsign(cs)] || null });
    }

    if (p === '/api/aircraft') {
      const aircraft = await fetchAircraftInfo(url.searchParams.get('hex'));
      return sendJSON(res, 200, { aircraft });
    }

    if (p === '/api/airport') {
      const board = await airportBoard(url.searchParams.get('iata'));
      if (!board) return sendJSON(res, 404, { error: 'unknown airport' });
      return sendJSON(res, 200, board);
    }

    if (p === '/api/search') {
      return sendJSON(res, 200, await searchFlight(url.searchParams.get('q')));
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: 'unknown endpoint' });

    return serveStatic(req, res, p);
  } catch (err) {
    console.error(`${p} failed:`, err.message);
    sendJSON(res, 502, { error: 'Could not reach the flight data service. Please try again.' });
  }
});

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  console.log('\n  ✈  Flight Finder is running\n');
  console.log(`     On this computer:  http://localhost:${PORT}`);
  if (lan) console.log(`     On your phone:     http://${lan}:${PORT}   (same Wi-Fi)`);
  console.log('\n     Press Control-C to stop.\n');
});
