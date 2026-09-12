# Flight Finder

A live map of the planes overhead — where each one came from, where it is going,
and what is landing and leaving at any airport.

Built to be readable and tappable for someone who does not enjoy fiddly apps:
large type, high contrast, big targets, plain words instead of aviation jargon.
No API keys, no accounts, no build step, no dependencies.

<!-- Add a screenshot and uncomment:
![Flight Finder](docs/screenshot.png)
-->

## Quick start

```bash
git clone https://github.com/<your-username>/flight-finder.git
cd flight-finder
npm start
```

Open **http://localhost:5173**.

The server also prints a second address (like `http://192.168.1.144:5173`) that
works from a phone or tablet on the same Wi-Fi. On an iPhone, open that address
in Safari and use *Share → Add to Home Screen* to get an app icon.

Node 18 or newer is the only requirement — there is nothing to `npm install`.

## What it does

- **Live map.** Planes are drawn where they actually are and glide between
  updates instead of jumping. Marker size follows the real aircraft: a light
  four-seater is small, a 777 is large, helicopters get their own shape.
  Overlapping aircraft are thinned out so busy airspace stays readable.
- **Tap a plane** on the map and the sheet rises a quarter of the way up with
  just the headline — who it is, the two cities, and what it is doing right now —
  so the map and the plane you tapped stay in view. The handle across the top
  opens it the rest of the way for progress, height, speed, aircraft type and a
  photograph. Picking a flight out of a list opens it fully straight away.
- **Track this plane** keeps the map centred on it, and says so while it is on.
  Tapping an empty patch of map, or dragging the map by hand, lets go again.
- **Tap an airport** for four live boards: what is on the ground there right now
  (parked or taxiing, with its transponder on), what is landing soon, what is
  leaving, and any other aircraft flying close by.
- **Bottom navigation on phones** — Map, Departures, Arrivals and Live flights.
  Departures and Arrivals use the airport you are looking at, or the nearest big
  one to the middle of the map.
- **Search** a flight number (`AA100`, `DL1556`) or a tail number (`N221WN`).
- **◎** centres the map on wherever you are. If location is declined, the map
  opens over the nearest busy airspace guessed from your time zone.
- **Settings** holds text size (three sizes), miles or kilometres, and the
  refresh control.

## How it is put together

```
server.js            caching proxy + static file server (no dependencies)
public/index.html    three views: nearby list, one flight, one airport
public/app.js        map, markers, route lines, panels
public/styles.css    large type, high contrast, big targets
public/airports.json bundled airport list, 3,244 with scheduled service
cache/               created at runtime; safe to delete
```

The browser never calls the data services directly — most of them send no CORS
headers, so everything goes through `/api/*` on the local server. That also gives
one place to cache, rate-limit and fail over.

### API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/flights?lat=&lon=&dist=` | live aircraft within `dist` nautical miles (max 250) |
| `POST /api/routes` | batch route lookup for `{ planes: [{callsign, lat, lng}] }` |
| `GET /api/route?callsign=&lat=&lon=` | one route |
| `GET /api/aircraft?hex=` | aircraft type, operator, photo |
| `GET /api/airport?iata=` | live board for one airport: on the ground, arriving, leaving, nearby |
| `GET /api/search?q=` | find a flight by flight number or tail number |
| `GET /api/health` | liveness plus cache size |

## Where the data comes from

| What | Source | Key needed |
|---|---|---|
| Live aircraft positions | [adsb.lol](https://adsb.lol), falling back to [adsb.fi](https://adsb.fi) | no |
| Flight routes (origin / destination) | [adsb.im](https://adsb.im) `routeset` | no |
| Airline names, aircraft type, photos | [adsbdb.com](https://api.adsbdb.com) | no |
| Airport list | [OurAirports](https://ourairports.com) (public domain), bundled | no |
| Map tiles | Esri light grey canvas | no |

These are volunteer-run services, so `server.js` is deliberately a good
neighbour. It spaces out its calls per host, backs off for 20 seconds when one
starts refusing, fails over to the second position source, and caches routes,
airline names and aircraft details to `cache/` so the same question is never
asked twice. If every source is unreachable it keeps showing the last known
positions rather than blanking the map.

**If you fork this,** check each provider's terms before doing anything
commercial or high-volume with it. The ADS-B feeds are offered for personal and
non-commercial use, and the Esri basemap has its own terms of use.

## Honest limitations

- **Coverage is community ADS-B.** Very remote areas and mid-ocean stretches have
  few receivers, and some military and private aircraft do not broadcast.
- **Routes are a best guess.** There is no free live schedule feed. The route
  service knows which airports a flight number connects, and the app picks the
  leg the aircraft best fits. When a plane is nowhere near that leg, the app says
  so rather than showing a confident wrong answer.

  This choice was measured, not assumed: against live traffic over Chicago
  O'Hare, the widely used callsign database returned a plausible route for 4 of
  19 flights, while the position-aware `routeset` service managed 15 of 19.
- **Airport boards are built from live transponder signals, not a schedule.**
  Every aircraft listed is broadcasting at that moment, including ones parked and
  taxiing at the airport. A flight that has not reached the airport yet, or whose
  transponder is off, will not appear.
- **Arrival times** are distance ÷ current ground speed, so they tighten up as a
  plane slows for approach.

## Accessibility notes

The design targets comfortable use at arm's length on a phone:

- three text sizes, remembered between visits, with everything sized in `rem`
- a minimum touch target of about 50 px, growing with the text size
- no information conveyed by colour alone, and no hover-only behaviour
- full keyboard operation, visible focus rings, and `prefers-reduced-motion`
  honoured
- a four-item bottom bar on phones, each item an icon with a written label
- a bottom sheet with three heights rather than an all-or-nothing panel, so
  reading about one flight never hides the map entirely; the quarter-height peek
  grows rather than clipping when the text size is turned up
- plain language throughout: "Coming down" rather than "descending at 1,800 fpm"

## Licence

MIT — see [LICENSE](LICENSE). The bundled airport data is from OurAirports and is
public domain. Map tiles and flight data remain the property of their providers.
