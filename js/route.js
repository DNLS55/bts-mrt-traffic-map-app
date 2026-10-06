// Journey planner over the rail network, including pedestrian transfers.
// Times are estimates: ride time from track distance, waits from published
// headways are NOT added (the result says "in-train + transfer time").

import { distanceM } from "./geo.js";
import { towardsFor } from "./model.js";

const RIDE_M_PER_MIN = 600; // ~36 km/h average between stations
const DWELL_MIN = 0.5;

const node = (stationId, lineId) => `${stationId}@${lineId}`;

export function buildGraph(model) {
  const adj = new Map();
  const add = (a, b, edge) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, ...edge });
  };
  for (const line of model.network.lines) {
    for (const [a, b] of line.edges) {
      const sa = model.stations.get(a);
      const sb = model.stations.get(b);
      const geom = line.geometry?.[`${a}|${b}`] || line.geometry?.[`${b}|${a}`];
      const meters = geom ? pathLength(geom) : distanceM(sa, sb) * 1.15;
      const minutes = meters / RIDE_M_PER_MIN + DWELL_MIN;
      add(node(a, line.id), node(b, line.id), { kind: "ride", line: line.id, minutes });
      add(node(b, line.id), node(a, line.id), { kind: "ride", line: line.id, minutes });
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
export function segment(model, lineId, a, b) {
  const line = model.lines.get(lineId);
  let pts = line.geometry?.[`${a}|${b}`];
  if (!pts && line.geometry?.[`${b}|${a}`]) pts = [...line.geometry[`${b}|${a}`]].reverse();
  if (!pts) {
    const sa = model.stations.get(a);
    const sb = model.stations.get(b);
    pts = [[sa.lat, sa.lon], [sb.lat, sb.lon]];
  }
  return { pts, minutes: pathLength(pts) / RIDE_M_PER_MIN + DWELL_MIN };
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
