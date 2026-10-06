// Journey planner over the rail network, including pedestrian transfers.
// Times are estimates: ride time from track distance, waits from published
// headways are NOT added (the result says "in-train + transfer time").

import { distanceM } from "./geo.js";
import { towardsFor, codeOn } from "./model.js";
import { RUNTIMES } from "../data/runtimes.js";

// Train motion between stations: accelerate, cruise at the line's top speed,
// brake into the next station, then stand for the dwell time.
const ACCEL = 0.9; // m/s²
const BRAKE = 0.9; // m/s²
const TOP_SPEED = { // m/s
  "BTS-SUK": 22, "BTS-SIL": 22, "BTS-GLD": 13.9, "MRT-BL": 22, "MRT-PP": 22, "MRT-PK": 22, "MRT-PKB": 22,
  "MRT-YL": 22, ARL: 44, "SRT-DR": 33, "SRT-LR": 33,
};
export const DWELL_MIN = 0.5;

// Real trains take longer than the ideal run: slower approaches to the
// platform, speed limits and signalling margins. Where we have measured the
// station-to-station time (app/data/runtimes.js, from live predictions) that
// is used; elsewhere the ideal run is stretched by a factor fitted to the
// measurements.
// Fitted 2026-10-06 on 114 measured BTS pairs: run = 1.17 x ideal.
const STRETCH = 1.17;
const EXTRA_S = 0;

// Run between two stations of length `meters`: total seconds and distance
// covered after t seconds (trapezoid, or triangle when stations are close).
export function runProfile(lineId, meters) {
  const v = TOP_SPEED[lineId] || 22;
  const dAcc = (v * v) / (2 * ACCEL);
  const dBrk = (v * v) / (2 * BRAKE);
  let peak = v;
  let tAcc;
  let tCruise;
  let tBrk;
  if (meters >= dAcc + dBrk) {
    tAcc = v / ACCEL;
    tBrk = v / BRAKE;
    tCruise = (meters - dAcc - dBrk) / v;
  } else {
    peak = Math.sqrt((2 * ACCEL * BRAKE * meters) / (ACCEL + BRAKE));
    tAcc = peak / ACCEL;
    tBrk = peak / BRAKE;
    tCruise = 0;
  }
  const seconds = tAcc + tCruise + tBrk;
  const at = (t) => {
    if (t <= 0) return 0;
    if (t < tAcc) return 0.5 * ACCEL * t * t;
    const s1 = 0.5 * ACCEL * tAcc * tAcc;
    if (t < tAcc + tCruise) return s1 + peak * (t - tAcc);
    const tb = Math.min(t - tAcc - tCruise, tBrk);
    return Math.min(meters, s1 + peak * tCruise + peak * tb - 0.5 * BRAKE * tb * tb);
  };
  return { seconds, at };
}

const node = (stationId, lineId) => `${stationId}@${lineId}`;

export function buildGraph(model) {
  const adj = new Map();
  const add = (a, b, edge) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, ...edge });
  };
  for (const line of model.network.lines) {
    for (const [a, b] of line.edges) {
      add(node(a, line.id), node(b, line.id), { kind: "ride", line: line.id, minutes: segment(model, line.id, a, b).minutes });
      add(node(b, line.id), node(a, line.id), { kind: "ride", line: line.id, minutes: segment(model, line.id, b, a).minutes });
    }
  }
  for (const ix of model.network.interchanges) {
    for (const la of ix.lines) for (const lb of ix.lines) {
      if (la !== lb) add(node(ix.station, la), node(ix.station, lb), { kind: "change", minutes: ix.minutes });
    }
  }
  for (const t of model.network.transfers) {
    const sa = model.stations.get(t.a);
    const sb = model.stations.get(t.b);
    for (const la of sa.lines) for (const lb of sb.lines) {
      const edge = { kind: "walk", minutes: t.minutes, transfer: t };
      add(node(t.a, la.line), node(t.b, lb.line), edge);
      add(node(t.b, lb.line), node(t.a, la.line), edge);
    }
  }
  return adj;
}

// Track between two adjacent stations, ordered a -> b, with ride minutes.
const segCache = new WeakMap();
export function segment(model, lineId, a, b) {
  let cache = segCache.get(model);
  if (!cache) segCache.set(model, (cache = new Map()));
  const key = `${lineId}|${a}|${b}`;
  if (!cache.has(key)) cache.set(key, makeSegment(model, lineId, a, b));
  return cache.get(key);
}

function makeSegment(model, lineId, a, b) {
  const line = model.lines.get(lineId);
  const sa = model.stations.get(a);
  const sb = model.stations.get(b);
  let pts = line.geometry?.[`${a}|${b}`];
  if (!pts && line.geometry?.[`${b}|${a}`]) pts = [...line.geometry[`${b}|${a}`]].reverse();
  if (!pts) pts = [[sa.lat, sa.lon], [sb.lat, sb.lon]];
  const meters = pathLength(pts);
  const run = runProfile(lineId, meters);
  const stretched = Math.max(run.seconds, run.seconds * STRETCH + EXTRA_S);
  let runSeconds = stretched;
  let dwellSeconds = DWELL_MIN * 60;
  // Measured: arrival at a -> arrival at b, so it includes the stop at a. Time
  // beyond the ideal run plus a normal stop is split between a longer stop
  // (busy stations like Siam) and a slower run.
  const [measured, samples] = RUNTIMES.lines[lineId]?.[`${codeOn(sa, lineId)}>${codeOn(sb, lineId)}`] || [];
  if (measured) {
    const total = samples >= 2 ? measured : (measured + stretched + dwellSeconds) / 2; // one sample: meet halfway
    dwellSeconds += Math.max(0, total - run.seconds - dwellSeconds) / 2;
    runSeconds = Math.max(run.seconds, total - dwellSeconds);
  }
  const scale = run.seconds / runSeconds; // same accelerate-cruise-brake shape, driven slower
  const runMinutes = runSeconds / 60;
  const dwellMinutes = dwellSeconds / 60;
  return {
    // dwellMinutes: the stop at a before this run; minutes: stop + run.
    pts, meters, runMinutes, dwellMinutes, minutes: runMinutes + dwellMinutes, measured: Boolean(measured),
    // Fraction of the distance covered `m` minutes after leaving station a.
    fractionAt: (m) => (meters ? run.at(m * 60 * scale) / meters : 1),
  };
}

// Point a fraction f (0..1) of the way along a polyline.
export function pointAlong(pts, f) {
  const total = pathLength(pts);
  let target = total * Math.min(Math.max(f, 0), 1);
  for (let i = 1; i < pts.length; i++) {
    const a = { lat: pts[i - 1][0], lon: pts[i - 1][1] };
    const b = { lat: pts[i][0], lon: pts[i][1] };
    const d = distanceM(a, b);
    if (target <= d || i === pts.length - 1) {
      const t = d ? Math.min(target / d, 1) : 0;
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    target -= d;
  }
  return { lat: pts[0][0], lon: pts[0][1] };
}

// Point at fraction f plus a point a little further along, so the map can
// point a train in its direction of travel.
export function pointAndAhead(pts, f) {
  const here = pointAlong(pts, f);
  if (f < 0.97) return { ...here, ahead: pointAlong(pts, f + 0.03) };
  const behind = pointAlong(pts, f - 0.03);
  return { ...here, ahead: { lat: 2 * here.lat - behind.lat, lon: 2 * here.lon - behind.lon } };
}

function pathLength(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    m += distanceM({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] });
  }
  return m;
}

// Dijkstra from any line at `fromId` to any line at `toId`.
export function planRoute(model, graph, fromId, toId) {
  if (fromId === toId) return null;
  const from = model.stations.get(fromId);
  const to = model.stations.get(toId);
  const dist = new Map();
  const prev = new Map();
  const queue = [];
  for (const l of from.lines) {
    const n = node(fromId, l.line);
    dist.set(n, 0);
    queue.push([0, n]);
  }
  const targets = new Set(to.lines.map((l) => node(toId, l.line)));
  let end = null;
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, n] = queue.shift();
    if (d > dist.get(n)) continue;
    if (targets.has(n)) { end = n; break; }
    for (const e of graph.get(n) || []) {
      const nd = d + e.minutes;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: n, edge: e });
        queue.push([nd, e.to]);
      }
    }
  }
  if (!end) return null;
  const steps = [];
  for (let n = end; prev.has(n); n = prev.get(n).from) steps.unshift({ ...prev.get(n).edge, from: prev.get(n).from, to: n });
  return { minutes: dist.get(end), legs: groupLegs(model, steps) };
}

const stationOf = (n) => n.split("@")[0];

function groupLegs(model, steps) {
  const legs = [];
  for (const s of steps) {
    const last = legs[legs.length - 1];
    if (s.kind === "ride" && last?.kind === "ride" && last.line === s.line) {
      last.stops.push(stationOf(s.to));
      last.minutes += s.minutes;
    } else if (s.kind === "ride") {
      legs.push({ kind: "ride", line: s.line, stops: [stationOf(s.from), stationOf(s.to)], minutes: s.minutes });
    } else {
      legs.push({ kind: s.kind, from: stationOf(s.from), to: stationOf(s.to), minutes: s.minutes, transfer: s.transfer });
    }
  }
  for (const leg of legs) {
    leg.minutes = Math.round(leg.minutes);
    if (leg.kind === "ride") leg.towards = rideTowards(model, leg);
  }
  return legs;
}

function rideTowards(model, leg) {
  return towardsFor(model, leg.line, leg.stops[0], leg.stops[1]);
}
