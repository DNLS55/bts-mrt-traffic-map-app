// Live arrivals: polling, normalisation and freshness.
//
// A live source must be public-and-permitted or explicitly authorised (see
// VERIFICATION.md). None is configured today, so LIVE_SOURCES is empty and the
// app shows "Live arrivals unavailable" for every line.
//
// Feed contract (JSON over HTTPS, CORS-enabled), documented in LIVE_FEED.md:
// {
//   "source": "Operator feed name",
//   "generatedAt": "2026-10-06T09:37:25Z",          // when the operator produced it
//   "arrivals": [
//     { "line": "BTS-SUK", "station": "N8", "destination": "E23",
//       "minutes": 1.9, "train": "008", "platform": "1" }
//   ],
//   "positions": [ { "line": "BTS-SUK", "lat": 13.80, "lon": 100.55, "train": "008" } ]  // optional
// }

export const LIVE_SOURCES = [
  // { id: "bts-tta", name: "BTS TTA", url: "https://…", lines: ["BTS-SUK", "BTS-SIL"], pollMs: 20000 }
];

export const LIVE_STALE_MS = 60_000;

// Local testing only: ?testfeed=http://localhost:PORT/feed.json&testlines=BTS-SUK,BTS-SIL
// is accepted only when the app itself runs on localhost, so a link can never
// make the hosted app show third-party data as "live".
export function sourcesFor(loc = globalThis.location) {
  const sources = [...LIVE_SOURCES];
  try {
    const params = new URLSearchParams(loc.search);
    const url = params.get("testfeed");
    const local = (h) => h === "localhost" || h === "127.0.0.1";
    if (url && local(loc.hostname) && local(new URL(url).hostname)) {
      sources.push({ id: "test", name: "Local test feed", url, lines: (params.get("testlines") || "").split(",").filter(Boolean), pollMs: 5000, test: true });
    }
  } catch { /* no location in tests */ }
  return sources;
}

// Turn a feed document into arrivals keyed by our station ids.
export function normalise(doc, model, receivedAt = Date.now()) {
  const byCode = new Map();
  for (const s of model.network.stations) for (const l of s.lines) byCode.set(`${l.line}|${l.code}`, s.id);
  const sourceTime = Date.parse(doc.generatedAt);
  if (!Number.isFinite(sourceTime)) throw new Error("feed has no valid generatedAt");
  const arrivals = [];
  for (const a of doc.arrivals || []) {
    const station = byCode.get(`${a.line}|${a.station}`);
    const destination = byCode.get(`${a.line}|${a.destination}`);
    if (!station || !destination || !Number.isFinite(a.minutes)) continue;
    arrivals.push({ line: a.line, station, destination, etaAt: sourceTime + a.minutes * 60000, train: a.train ?? null, platform: a.platform ?? null });
  }
  const positions = (doc.positions || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => ({ lineId: p.line, lat: p.lat, lon: p.lon, kind: "live", train: p.train ?? null }));
  return { source: String(doc.source || ""), sourceTime, receivedAt, arrivals, positions };
}

// Polls one source; calls onUpdate(state) after every attempt.
// state: { status: "loading"|"ok"|"error", data, error, lastOk, lastTry }
export function startPolling(source, model, onUpdate, { fetchImpl = fetch, isOffline = () => false } = {}) {
  const state = { source, status: "loading", data: null, error: null, lastOk: null, lastTry: null };
  let timer = 0;
  let stopped = false;
  async function tick() {
    if (stopped) return;
    if (isOffline()) {
      state.status = state.data ? "ok" : "error";
      state.error = "offline";
    } else {
      state.lastTry = Date.now();
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetchImpl(source.url, { cache: "no-store", signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.data = normalise(await res.json(), model);
        state.status = "ok";
        state.error = null;
        state.lastOk = Date.now();
      } catch (e) {
        state.status = state.data ? "ok" : "error";
        state.error = e.name === "AbortError" ? "timed out" : e.message;
      }
    }
    onUpdate(state);
    if (!stopped) timer = setTimeout(tick, source.pollMs || 20000);
  }
  tick();
  return { state, stop: () => { stopped = true; clearTimeout(timer); }, refresh: () => { clearTimeout(timer); tick(); } };
}

export function isStale(state, now = Date.now()) {
  return !state?.data || now - state.data.sourceTime > LIVE_STALE_MS;
}

// Next trains at a station towards a destination, soonest first.
export function nextTrains(state, stationId, destinationId, now = Date.now(), limit = 3) {
  if (!state?.data) return [];
  return state.data.arrivals
    .filter((a) => a.station === stationId && a.destination === destinationId && a.etaAt > now - 30000)
    .sort((a, b) => a.etaAt - b.etaAt)
    .slice(0, limit);
}
