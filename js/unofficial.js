// OPT-IN, UNOFFICIAL live arrivals from bangkoktransit.com, for personal use.
//
// bangkoktransit.com is a third-party site ("not affiliated with or endorsed by
// BTSC") that re-serves BTS-group arrival times. Its API answers browsers on any
// site (CORS *), needs no key for a preview period, and is rate-limited
// (about one request per 3 s). After the preview it asks for a sign-in on its
// own site, which this app cannot use, so the feed then shows as unavailable.
// It is on by default and can be switched off per device in Settings. The app
// only reads what the service returns to an ordinary visitor; it never handles
// BTS keys.
//
// There is no "all trains" endpoint, only arrivals per station. So the app asks
// the stations in turn (one request every few seconds): the open station and
// the ones nearest you most often, and a sweep of every third station along
// each covered line so every train shows up in some station's answer. Each
// train is then placed from its train number: work back from the next station
// it is due at (trackTrains).
//
// Checked 2026-10-06: Sukhumvit, Silom, Yellow, Pink (incl. Muang Thong Thani
// branch) return countdowns with train numbers; Gold returns "line unavailable".

import { segment, pointAndAhead } from "./route.js";
import { neighbours, codeOn } from "./model.js";
import { distanceM } from "./geo.js";

export const UNOFFICIAL = {
  id: "bangkoktransit",
  name: "bangkoktransit.com",
  site: "https://bangkoktransit.com/",
  base: "https://bangkoktransit.com/api",
  lines: ["BTS-SUK", "BTS-SIL", "MRT-YL", "MRT-PK", "MRT-PKB"],
  pollMs: 4000,
  unofficial: true,
};

const MIN_GAP_MS = 4000; // between requests; widened while the service says "rate_limited"
const MAX_GAP_MS = 15000;
const KEEP_MS = 8 * 60000; // forget a station's answer after this
// How often each station is asked again. The service allows roughly 8-10
// requests a minute, so these are wishes: the open station and the one nearest
// you come first, then their neighbours, then the sweep (stations on screen
// before the rest). Whatever is left over goes to the most overdue.
export const EVERY_MS = { open: 15000, near: 30000, around: 60000, sweepInView: 90000, sweep: 240000 };
const CLASS = { open: 0, near: 1, around: 2, sweepInView: 3, sweep: 3 };
const WINDOW_IF_SHORT_MIN = 20; // fewer than 3 trains listed: none other due within this

// Station codes to ask for at this station (one request per code).
export function codesFor(model, stationId) {
  const s = model.stations.get(stationId);
  if (!s) return [];
  return [...new Set(s.lines.filter((l) => UNOFFICIAL.lines.includes(l.line)).map((l) => l.code))];
}

// Stations to sweep so every train on a covered line is listed somewhere:
// every third station, plus the ones next to each terminus. Each answer lists
// the next three trains each way, which reach back past the previous swept station.
export function sweepCodes(model) {
  const codes = [];
  for (const lineId of UNOFFICIAL.lines) {
    const ids = model.lines.get(lineId).stations;
    ids.forEach((id, i) => {
      if (i % 3 === 1 || i === ids.length - 2) codes.push(codeOn(model.stations.get(id), lineId));
    });
  }
  return [...new Set(codes)];
}

// Convert one /api/arrivals/{code} response into the app's arrival records,
// plus one "window" per platform: no other train is due there before `until`.
export function normaliseArrivals(doc, model) {
  const ts = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(doc.timestamp || "") ? doc.timestamp : `${doc.timestamp}Z`);
  if (!Number.isFinite(ts)) throw new Error("response has no timestamp");
  const byCode = (lineId, code) => model.network.stations.find((s) => s.lines.some((l) => l.line === lineId && l.code === code))?.id;
  const out = [];
  const windows = [];
  const stationCode = doc.station?.code;
  for (const p of doc.platforms || []) {
    // The line is the covered line that contains both this station and the platform's direction.
    const lineId = UNOFFICIAL.lines.find((l) => byCode(l, stationCode) && byCode(l, p.direction_key));
    if (!lineId) continue;
    const station = byCode(lineId, stationCode);
    const towards = byCode(lineId, p.direction_key);
    const trains = (p.trains || []).filter((t) => Number.isFinite(t.eta_precise ?? t.eta_minutes));
    for (const t of trains) {
      out.push({
        line: lineId, station, towards,
        destination: byCode(lineId, t.destination_key) || towards,
        etaAt: ts + (t.eta_precise ?? t.eta_minutes) * 60000,
        train: t.train_no ?? null, platform: p.platform ?? null, status: t.status ?? null, sourceTime: ts,
      });
    }
    const last = Math.max(0, ...trains.map((t) => t.eta_precise ?? t.eta_minutes));
    windows.push({ line: lineId, station, towards, until: ts + (trains.length >= 3 ? last : Math.max(last, WINDOW_IF_SHORT_MIN)) * 60000 });
  }
  return { sourceTime: ts, arrivals: out, windows, serviceActive: doc.service_active !== false };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A live source for live.js. Each load() asks at most one station (the most
// overdue one) and returns everything still known, from all stations.
// `focus()` returns { open: stationId|null, near: [stationId] }.
export function createUnofficialSource(model, focus = () => ({}), { hidden = () => globalThis.document?.hidden } = {}) {
  const answers = new Map(); // code -> { at, sourceTime, arrivals, windows, stations }
  const sweep = sweepCodes(model);
  const where = new Map(); // code -> station, to sweep outwards from where you are
  for (const s of model.network.stations) for (const l of s.lines) if (UNOFFICIAL.lines.includes(l.line)) where.set(l.code, s);
  let gap = MIN_GAP_MS;
  let pausedUntil = 0;
  let lastAsked = 0;
  let lastReceived = 0;

  function plan() {
    const want = new Map(); // code -> { every, cls }
    const add = (code, kind) => {
      const cur = want.get(code);
      if (!cur || EVERY_MS[kind] < cur.every) want.set(code, { every: EVERY_MS[kind], cls: CLASS[kind] });
    };
    const { open, near = [], inView } = focus() || {};
    for (const id of [open, ...near].filter(Boolean)) {
      for (const l of model.stations.get(id)?.lines || []) {
        if (!UNOFFICIAL.lines.includes(l.line)) continue;
        for (const n of neighbours(model, l.line, id)) for (const c of codesFor(model, n)) add(c, "around");
      }
    }
    for (const id of near) for (const c of codesFor(model, id)) add(c, "near");
    if (open) for (const c of codesFor(model, open)) add(c, "open");
    for (const c of sweep) add(c, inView?.(where.get(c)) ? "sweepInView" : "sweep");
    return want;
  }

  // The station to ask next, or null when nothing is due. Strict priority by
  // class (open, near, around, sweep); within a class the most overdue, and
  // stations never asked first, nearest to you first.
  function nextCode(now) {
    const { open, near = [] } = focus() || {};
    const centre = model.stations.get(open || near[0]);
    let best = null;
    let bestKey = null;
    for (const [code, { every, cls }] of plan()) {
      const a = answers.get(code);
      const overdue = a ? (now - a.at) / every : Infinity;
      if (overdue < 1) continue;
      const s = where.get(code);
      const km = centre?.lat != null && s?.lat != null ? distanceM(centre, s) / 1000 : 0;
      const key = [cls, -overdue, km];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        best = code;
        bestKey = key;
      }
    }
    return best;
  }

  async function ask(code, fetchImpl, signal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchImpl(`${UNOFFICIAL.base}/arrivals/${encodeURIComponent(code)}`, { cache: "no-store", signal });
      const doc = await res.json().catch(() => ({}));
      const err = doc?.detail?.error || doc?.error;
      if (err === "preview_expired" || res.status === 401) throw new Error("the free preview has ended (bangkoktransit.com now asks for a sign-in on its own site)");
      if (err === "rate_limited") {
        gap = Math.min(gap * 1.5, MAX_GAP_MS);
        const retry = ((doc.detail?.retry_after ?? 3) + 0.5) * 1000;
        if (attempt === 0 && retry <= 10000) { await wait(retry); continue; }
        pausedUntil = Date.now() + retry;
        throw new Error("rate-limited, will retry");
      }
      if (!res.ok) throw new Error(typeof doc?.detail === "string" ? doc.detail : `HTTP ${res.status}`);
      gap = Math.max(MIN_GAP_MS, gap * 0.9);
      const n = normaliseArrivals(doc, model);
      lastReceived = Date.now();
      answers.set(code, { at: lastReceived, ...n, stations: [...new Set([...n.arrivals, ...n.windows].map((a) => a.station))] });
      return;
    }
  }

  function snapshot(now) {
    const arrivals = [];
    const windows = [];
    const stations = new Map(); // stationId -> sourceTime of its latest answer
    let sourceTime = 0;
    for (const [code, a] of answers) {
      if (now - a.at > KEEP_MS) { answers.delete(code); continue; }
      arrivals.push(...a.arrivals);
      windows.push(...a.windows);
      for (const id of a.stations) stations.set(id, Math.max(stations.get(id) ?? 0, a.sourceTime));
      sourceTime = Math.max(sourceTime, a.sourceTime);
    }
    if (!sourceTime) return null;
    const swept = sweep.filter((c) => answers.has(c)).length;
    return { source: "bangkoktransit.com (unofficial)", sourceTime, receivedAt: lastReceived, arrivals, windows, stations, positions: [], swept, sweep: sweep.length };
  }

  return {
    ...UNOFFICIAL,
    // Wait at least `gap` between requests, longer while rate-limited.
    nextDelay: () => Math.max(250, lastAsked + gap - Date.now(), pausedUntil - Date.now()),
    async load({ fetchImpl = fetch, signal } = {}) {
      const now = Date.now();
      const code = now >= pausedUntil && now - lastAsked >= gap - 250 && !hidden() ? nextCode(now) : null;
      if (code) {
        lastAsked = now;
        await ask(code, fetchImpl, signal);
      }
      return snapshot(Date.now());
    },
  };
}

// The train's journey from the arrival at `arrival.station` on: dwell, run
// to the next station, dwell, ... `t` minutes after that arrival.
function onwards(model, arrival, t) {
  const ids = model.lines.get(arrival.line).stations;
  let idx = ids.indexOf(arrival.station);
  const sign = ids.indexOf(arrival.towards) > idx ? 1 : -1;
  for (;;) {
    const next = ids[idx + sign];
    if (!next) return null; // reached the terminus; it turns back under a new listing
    const seg = segment(model, arrival.line, ids[idx], next);
    if (t <= seg.dwellMinutes) return { ...pointAndAhead(seg.pts, 0), dwell: true, from: ids[idx], to: next, f: 0 };
    t -= seg.dwellMinutes;
    if (t <= seg.runMinutes) return { ...pointAndAhead(seg.pts, seg.fractionAt(t)), from: ids[idx], to: next, f: seg.fractionAt(t) };
    t -= seg.runMinutes;
    idx += sign;
  }
}

// Where an approaching train probably is now. Work back from its live arrival
// time: it is either running on the segment into the station (accelerate,
// cruise, brake), standing at the previous platform, or further back.
export function estimatePosition(model, arrival, now = Date.now()) {
  const line = model.lines.get(arrival.line);
  const ids = line.stations;
  let idx = ids.indexOf(arrival.station);
  const sign = ids.indexOf(arrival.towards) > idx ? 1 : -1;
  let remaining = (arrival.etaAt - now) / 60000;
  if (idx < 0) return null;
  if (remaining <= 0) return onwards(model, arrival, -remaining); // at the platform, or just left
  let cur = ids[idx];
  for (;;) {
    const prev = ids[idx - sign];
    if (!prev) { // still at (or before leaving) the terminus
      const s = model.stations.get(cur);
      return { lat: s.lat, lon: s.lon, atTerminus: true };
    }
    const seg = segment(model, arrival.line, prev, cur);
    if (remaining <= seg.runMinutes) {
      const f = seg.fractionAt(seg.runMinutes - remaining);
      return { ...pointAndAhead(seg.pts, f), from: prev, to: cur, f };
    }
    remaining -= seg.runMinutes;
    if (remaining <= seg.dwellMinutes) {
      // Standing at the previous station, doors open.
      return { ...pointAndAhead(seg.pts, 0), dwell: true, from: prev, to: cur, f: 0 };
    }
    remaining -= seg.dwellMinutes;
    cur = prev;
    idx -= sign;
  }
}

const ONWARDS_MAX_MIN = 4; // carry a train on past its last listed station for this long
// Which listing of a train to work back from: the nearest station ahead is
// best, but an older answer drifts as the train is held, so prefer a fresher
// answer from a station further on when the nearer one is old. Expected error,
// in seconds: about 12 s per minute of age, about 18 s per segment worked back.
const AGE_COST_PER_MIN = 12;
const SEGMENT_COST = 18;

// One position per train, from every station's answer. A train is listed at
// each station it will reach soon, under the same train number; the soonest
// of those arrivals is the station it is heading for, so work back from there.
// If it has passed every station that listed it, carry it on from the last one.
export function trackTrains(model, data, now = Date.now(), lines = null) {
  const byTrain = new Map();
  for (const a of data.arrivals) {
    if (lines && !lines.has(a.line)) continue;
    const key = `${a.line}|${a.towards}|${a.train ?? `${a.station}@${a.etaAt}`}`;
    if (!byTrain.has(key)) byTrain.set(key, []);
    byTrain.get(key).push(a);
  }
  const out = [];
  for (const [key, list] of byTrain) {
    const ahead = list.filter((a) => a.etaAt >= now - 15000).sort((x, y) => x.etaAt - y.etaAt);
    let last = null;
    for (const a of list) if (a.etaAt < now - 15000 && (!last || a.etaAt > last.etaAt)) last = a;
    let next = ahead[0] || null;
    if (ahead.length > 1) {
      const ids = model.lines.get(next.line).stations;
      const cost = (a) => ((now - (a.sourceTime ?? now)) / 60000) * AGE_COST_PER_MIN + (Math.abs(ids.indexOf(a.station) - ids.indexOf(ahead[0].station)) + 1) * SEGMENT_COST;
      next = ahead.reduce((b, a) => (cost(a) < cost(b) ? a : b));
    }
    let p = null;
    if (next) p = estimatePosition(model, next, now);
    else if (now - last.etaAt < ONWARDS_MAX_MIN * 60000) p = onwards(model, last, (now - last.etaAt) / 60000);
    const a = next || last;
    if (p && !p.atTerminus) out.push({ ...p, lineId: a.line, kind: "live-est", train: a.train, id: `l|${key}` });
  }
  return out;
}

// Is this stretch of track covered by a live answer? A timetable trip that
// would reach a listed station before that station's window closes would have
// been listed there, so live data already says whether a train is in it.
export function coveredBy(windows, trip, k) {
  const towards = trip.stops[trip.stops.length - 1];
  for (const w of windows) {
    if (w.line !== trip.lineId || w.towards !== towards) continue;
    for (let j = k + 1; j < trip.stops.length; j++) {
      if (trip.stops[j] === w.station) {
        if (trip.dep + trip.cum[j] * 60000 <= w.until) return true;
        break;
      }
    }
  }
  return false;
}
