// Timetable-based train estimates ("SCHEDULED · assumes on time").
//
// For lines without a live feed, trains are generated from the published
// first-train times and the published headway for each part of the day, then
// moved along the real track at an average speed (route.segment). This is
// what the timetable says should happen if every train runs on time; it is
// never labelled live. Real trains drift from this, especially late in the day.

import { SCHEDULE } from "./schedule.js";
import { segment, pointAndAhead } from "./route.js";

// First departure from each origin (station code), weekday / weekend.
// Sources as in schedule.js; entries marked * are assumptions where the
// operator publishes only "service hours".
const FIRST = {
  "BTS-SUK": { N24: ["05:15"], E23: ["05:15"] },
  "BTS-SIL": { W1: ["05:30"], S12: ["05:30"] },
  "BTS-GLD": { G1: ["06:00"], G3: ["06:06"] },
  "MRT-BL": { BL01: ["06:00"], BL38: ["06:00"] }, // * BEM: service 06:00–24:00
  "MRT-PP": { PP01: ["05:30", "06:00"], PP16: ["05:30", "06:00"] },
  "MRT-PK": { PK01: ["05:30"], PK30: ["05:27"] },
  "MRT-PKB": { PK10: ["06:00"], MT02: ["06:00"] }, // * branch 06:00–24:00
  "MRT-YL": { YL01: ["05:30"], YL23: ["05:30"] },
  ARL: { A1: ["05:30"], A8: ["05:30"] }, // * secondary sources
  "SRT-DR": { RN01: ["05:00"], RN10: ["05:00"] }, // * SRTET departures from 05:00
  "SRT-LR": { RW01: ["05:00"], RW06: ["05:16"] }, // SRTET: :00/:20/:40 and :16/:36/:56
};

const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const DAY = 86400000;

// Bangkok service day: starts at 04:00 local, so after-midnight trains belong
// to the previous day's timetable.
export function serviceDay(now = Date.now()) {
  let ms = (now + 7 * 3600000) % DAY;
  let dayIndex = Math.floor((now + 7 * 3600000) / DAY);
  if (ms < 4 * 3600000) { ms += DAY; dayIndex -= 1; }
  const weekday = (dayIndex + 4) % 7; // 1970-01-01 was a Thursday (4)
  return { start: now - ms, weekend: weekday === 0 || weekday === 6 };
}

// Station sequences for each service pattern, keyed by origin code.
function servicePatterns(model, line) {
  const code = (id) => model.stations.get(id).lines.find((l) => l.line === line.id).code;
  const ids = line.stations;
  if (line.kind === "loop-tail") {
    // Same stop order as the OpenStreetMap service relations (see model.towardsFor).
    const thaPhra = ids[0];
    const loopUp = ids.slice(1, 32); // BL02..BL32
    const tail = ids.slice(32); // BL33..BL38
    return [
      { origin: code(thaPhra), stops: [thaPhra, ...loopUp, thaPhra, ...tail] },
      { origin: code(ids[ids.length - 1]), stops: [...[...tail].reverse(), thaPhra, ...[...loopUp].reverse(), thaPhra] },
    ];
  }
  return [
    { origin: code(ids[0]), stops: [...ids] },
    { origin: code(ids[ids.length - 1]), stops: [...ids].reverse() },
  ];
}

function headwayAt(periods, minute) {
  const p = periods.find(([a, b]) => minute >= hm(a) && minute < hm(b));
  return p ? p[2] : null;
}

const cache = new Map();

// All scheduled trips for one line on one service day.
export function tripsFor(model, lineId, now = Date.now()) {
  const day = serviceDay(now);
  const key = `${lineId}|${day.start}`;
  if (cache.has(key)) return cache.get(key);
  const line = model.lines.get(lineId);
  const sched = SCHEDULE[lineId];
  const first = FIRST[lineId];
  const trips = [];
  if (line && sched && first) {
    const periods = day.weekend ? sched.weekend : sched.weekday;
    let last = hm(sched.hours[1]);
    if (last < 4 * 60) last += 24 * 60;
    for (const pattern of servicePatterns(model, line)) {
      const f = first[pattern.origin];
      if (!f) continue;
      const cum = [0];
      const segs = [];
      for (let i = 1; i < pattern.stops.length; i++) {
        const seg = segment(model, lineId, pattern.stops[i - 1], pattern.stops[i]);
        segs.push(seg);
        cum.push(cum[i - 1] + seg.minutes);
      }
      for (let t = hm(day.weekend && f[1] ? f[1] : f[0]); t <= last;) {
        trips.push({ lineId, stops: pattern.stops, cum, segs, dep: day.start + t * 60000 });
        const h = headwayAt(periods, t) ?? headwayAt(periods, t - 1);
        if (!h) break;
        t += h;
      }
    }
  }
  cache.set(key, trips);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return trips;
}

// Next scheduled trains at a station leaving towards `nextId`.
export function scheduledArrivals(model, lineId, stationId, nextId, now = Date.now(), limit = 3) {
  const out = [];
  for (const trip of tripsFor(model, lineId, now)) {
    for (let i = 0; i < trip.stops.length - 1; i++) {
      if (trip.stops[i] !== stationId || trip.stops[i + 1] !== nextId) continue;
      const at = trip.dep + trip.cum[i] * 60000;
      if (at >= now - 20000) out.push({ etaAt: at, destination: trip.stops[trip.stops.length - 1] });
    }
  }
  out.sort((a, b) => a.etaAt - b.etaAt);
  return out.filter((a) => a.etaAt - now < 90 * 60000).slice(0, limit);
}

// Where every scheduled train would be right now if all ran on time.
// `skip(trip, k)` may drop a trip that is on segment k (stops[k] -> stops[k+1])
// because live data already covers that stretch.
export function scheduledPositions(model, lineIds, now = Date.now(), { skip = () => false } = {}) {
  const out = [];
  for (const lineId of lineIds) {
    for (const trip of tripsFor(model, lineId, now)) {
      const elapsed = (now - trip.dep) / 60000;
      const total = trip.cum[trip.cum.length - 1];
      if (elapsed < 0 || elapsed > total) continue;
      let k = 0;
      while (k < trip.segs.length - 1 && trip.cum[k + 1] <= elapsed) k++;
      if (skip(trip, k)) continue;
      const seg = trip.segs[k];
      // Each segment: run (accelerate, cruise, brake), then the dwell at the next station.
      const t = elapsed - trip.cum[k];
      const dwell = t >= seg.runMinutes;
      const p = pointAndAhead(seg.pts, dwell ? 1 : seg.fractionAt(t));
      out.push({ ...p, lineId, kind: "scheduled", dwell, id: `s|${lineId}|${trip.stops[0]}|${trip.dep}` });
    }
  }
  return out;
}

// Timetable arrival times at a station leaving towards `nextId`, between two instants.
export function scheduledEtasAt(model, lineId, stationId, nextId, fromMs, toMs) {
  const out = [];
  for (const trip of tripsFor(model, lineId, fromMs)) {
    for (let i = 0; i < trip.stops.length - 1; i++) {
      if (trip.stops[i] !== stationId || trip.stops[i + 1] !== nextId) continue;
      const at = trip.dep + trip.cum[i] * 60000;
      if (at >= fromMs && at <= toMs) out.push(at);
    }
  }
  return out.sort((a, b) => a - b);
}
