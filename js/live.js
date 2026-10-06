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
    const towards = (a.towards && byCode.get(`${a.line}|${a.towards}`)) || destination;
    arrivals.push({ line: a.line, station, towards, destination, etaAt: sourceTime + a.minutes * 60000, train: a.train ?? null, platform: a.platform ?? null });
  }
  const positions = (doc.positions || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => ({ lineId: p.line, lat: p.lat, lon: p.lon, kind: "live", train: p.train ?? null }));
  return { source: String(doc.source || ""), sourceTime, receivedAt, arrivals, positions };
}

// Polls one source; calls onUpdate(state) after every attempt.
// state: { status: "loading"|"idle"|"ok"|"error", data, error, lastOk, lastTry }
// A source either has a `url` serving the contract above, or a `load()` that
// returns normalised data (or null when there is nothing to fetch right now).
export function startPolling(source, model, onUpdate, { fetchImpl = fetch, isOffline = () => false } = {}) {
  const state = { source, status: "loading", data: null, error: null, lastOk: null, lastTry: null };
  let timer = 0;
  let stopped = false;
  let busy = false;
  async function tick() {
    if (stopped || busy) return; // a running tick schedules the next one itself
    busy = true;
    if (isOffline()) {
      state.status = state.data ? "ok" : "error";
      state.error = "offline";
    } else {
      state.lastTry = Date.now();
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        let data;
        if (source.load) {
          data = await source.load({ fetchImpl, signal: ctrl.signal });
        } else {
          const res = await fetchImpl(source.url, { cache: "no-store", signal: ctrl.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = normalise(await res.json(), model);
        }
        clearTimeout(t);
        if (data === null) {
          state.status = "idle";
          state.data = null;
        } else {
          state.data = data;
          state.status = "ok";
          state.lastOk = Date.now();
        }
        state.error = null;
      } catch (e) {
        state.status = state.data ? "ok" : "error";
        state.error = e.name === "AbortError" ? "timed out" : e.message;
      }
    }
    busy = false;
    onUpdate(state);
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(tick, source.nextDelay?.() ?? source.pollMs ?? 20000);
  }
  tick();
  return {
    state,
    stop: () => { stopped = true; clearTimeout(timer); },
    // Re-fetch now; `reset` drops data that belongs to a previous station.
    refresh: ({ reset = false } = {}) => {
      if (reset) { state.data = null; state.status = "loading"; state.error = null; }
      clearTimeout(timer);
      tick();
    },
  };
}

export function isStale(state, now = Date.now()) {
  return !state?.data || now - state.data.sourceTime > LIVE_STALE_MS;
}

// Next trains at a station heading towards a terminus, soonest first. A train
// may stop short of that terminus (e.g. Samrong); `destination` says where.
export function nextTrains(state, stationId, towardsId, now = Date.now(), limit = 3) {
  if (!state?.data) return [];
  return state.data.arrivals
    .filter((a) => a.station === stationId && (a.towards ?? a.destination) === towardsId && a.etaAt > now - 30000)
    .sort((a, b) => a.etaAt - b.etaAt)
    .slice(0, limit);
}
