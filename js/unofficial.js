// OPT-IN, UNOFFICIAL live arrivals from bangkoktransit.com, for personal use.
//
// bangkoktransit.com is a third-party site ("not affiliated with or endorsed by
// BTSC") that re-serves BTS-group arrival times. Its API answers browsers on any
// site (CORS *), needs no key for a preview period, and is rate-limited
// (about one request per 3 s). After the preview it asks for a sign-in on its
// own site, which this app cannot use, so the feed then shows as unavailable.
// It is off by default and enabled per device in Settings. The app only reads
// what the service returns to an ordinary visitor; it never handles BTS keys.
//
// Checked 2026-10-06: Sukhumvit, Silom, Yellow, Pink (incl. Muang Thong Thani
// branch) return countdowns with train numbers; Gold returns "line unavailable".

import { segment, pointAndAhead, DWELL_MIN } from "./route.js";

export const UNOFFICIAL = {
  id: "bangkoktransit",
  name: "bangkoktransit.com",
  site: "https://bangkoktransit.com/",
  base: "https://bangkoktransit.com/api",
  lines: ["BTS-SUK", "BTS-SIL", "MRT-YL", "MRT-PK", "MRT-PKB"],
  pollMs: 20000,
  unofficial: true,
};

const GAP_MS = 3500; // stay under the anonymous rate limit between requests

// Station codes to ask for at this station (one request per code).
export function codesFor(model, stationId) {
  const s = model.stations.get(stationId);
  if (!s) return [];
  return [...new Set(s.lines.filter((l) => UNOFFICIAL.lines.includes(l.line)).map((l) => l.code))];
}

// Convert one /api/arrivals/{code} response into the app's arrival records.
export function normaliseArrivals(doc, model) {
  const ts = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(doc.timestamp || "") ? doc.timestamp : `${doc.timestamp}Z`);
  if (!Number.isFinite(ts)) throw new Error("response has no timestamp");
  const byCode = (lineId, code) => model.network.stations.find((s) => s.lines.some((l) => l.line === lineId && l.code === code))?.id;
  const out = [];
  const stationCode = doc.station?.code;
  for (const p of doc.platforms || []) {
    // The line is the covered line that contains both this station and the platform's direction.
    const lineId = UNOFFICIAL.lines.find((l) => byCode(l, stationCode) && byCode(l, p.direction_key));
    if (!lineId) continue;
    const station = byCode(lineId, stationCode);
    const towards = byCode(lineId, p.direction_key);
    for (const t of p.trains || []) {
      if (!Number.isFinite(t.eta_precise ?? t.eta_minutes)) continue;
      out.push({
        line: lineId, station, towards,
        destination: byCode(lineId, t.destination_key) || towards,
        etaAt: ts + (t.eta_precise ?? t.eta_minutes) * 60000,
        train: t.train_no ?? null, platform: p.platform ?? null, status: t.status ?? null,
      });
    }
  }
  return { sourceTime: ts, arrivals: out, serviceActive: doc.service_active !== false };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A live source for live.js: loads arrivals for the station being viewed.
export function createUnofficialSource(model, currentStation) {
  return {
    ...UNOFFICIAL,
    async load({ fetchImpl = fetch, signal } = {}) {
      const stationId = currentStation();
      const codes = stationId ? codesFor(model, stationId) : [];
      if (!codes.length) return null;
      const arrivals = [];
      let sourceTime = 0;
      for (const [i, code] of codes.entries()) {
        if (i) await wait(GAP_MS);
        let doc;
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await fetchImpl(`${UNOFFICIAL.base}/arrivals/${encodeURIComponent(code)}`, { cache: "no-store", signal });
          doc = await res.json().catch(() => ({}));
          const err = doc?.detail?.error || doc?.error;
          if (err === "rate_limited" && attempt === 0) { await wait(((doc.detail?.retry_after ?? 3) + 0.5) * 1000); continue; }
          if (err === "preview_expired" || res.status === 401) throw new Error("the free preview has ended (bangkoktransit.com now asks for a sign-in on its own site)");
          if (err === "rate_limited") throw new Error("rate-limited, will retry");
          if (!res.ok) throw new Error(typeof doc?.detail === "string" ? doc.detail : `HTTP ${res.status}`);
          break;
        }
        const n = normaliseArrivals(doc, model);
        arrivals.push(...n.arrivals);
        sourceTime = Math.max(sourceTime, n.sourceTime);
      }
      return { source: "bangkoktransit.com (unofficial)", sourceTime, receivedAt: Date.now(), arrivals, positions: [] };
    },
  };
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
  if (idx < 0 || remaining < -0.5) return null;
  if (remaining <= 0) { // arriving / at the platform now
    const prev = ids[idx - sign];
    const seg = prev ? segment(model, arrival.line, prev, ids[idx]) : null;
    return seg ? { ...pointAndAhead(seg.pts, 1), dwell: true } : null;
  }
  let cur = ids[idx];
  for (;;) {
    const prev = ids[idx - sign];
    if (!prev) { // still at (or before leaving) the terminus
      const s = model.stations.get(cur);
      return { lat: s.lat, lon: s.lon, atTerminus: true };
    }
    const seg = segment(model, arrival.line, prev, cur);
    if (remaining <= seg.runMinutes) {
      return pointAndAhead(seg.pts, seg.fractionAt(seg.runMinutes - remaining));
    }
    remaining -= seg.runMinutes;
    if (remaining <= DWELL_MIN) {
      // Standing at the previous station, doors open.
      return { ...pointAndAhead(seg.pts, 0), dwell: true };
    }
    remaining -= DWELL_MIN;
    cur = prev;
    idx -= sign;
  }
}
