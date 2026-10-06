// Data feeds. Three kinds of information, never mixed up in the UI:
//   live      - real-time data from an operator feed (none verified yet)
//   timetable - published headways / operating hours (not per-train times)
//   demo      - simulated trains, only in the explicitly labelled demo mode
//
// A live adapter can be registered per line once a permitted public feed is
// verified. Until then the line reports "unavailable" with the reason.

import { SCHEDULE } from "./schedule.js";
import { distanceM } from "./geo.js";

export const STALE_AFTER_MS = 60_000;


// ---------- timetable estimates ----------

// Bangkok is UTC+7 all year (no DST).
export function bangkokClock(date) {
  const t = new Date(date.getTime() + 7 * 3600 * 1000);
  return { minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), weekday: t.getUTCDay() };
}

function parseHm(s) {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

// Current published headway for a line, or why there isn't one.
export function timetableFor(lineId, now = new Date()) {
  const s = SCHEDULE[lineId];
  if (!s) return { status: "unavailable", reason: "No published timetable found." };
  let { minutes, weekday } = bangkokClock(now);
  // Service after midnight belongs to the previous day's timetable.
  if (minutes < 4 * 60) {
    minutes += 24 * 60;
    weekday = (weekday + 6) % 7;
  }
  const dayType = weekday === 0 || weekday === 6 ? "weekend" : "weekday";
  const period = s[dayType].find(([a, b]) => minutes >= parseHm(a) && minutes < parseHm(b));
  const fmt = (hm) => (parseHm(hm) >= 24 * 60 ? `${String(Math.floor(parseHm(hm) / 60) - 24).padStart(2, "0")}:${hm.slice(3)}` : hm);
  return {
    status: "ok",
    dayType,
    inService: Boolean(period),
    headwayMin: period ? period[2] : null,
    hours: `${s.hours[0]}–${s.hours[1]}`,
    periodLabel: period ? `${fmt(period[0])}–${fmt(period[1])}` : null,
    verified: s.verified,
    source: s.source,
    note: s.note,
  };
}

export function formatHeadway(min) {
  const m = Math.floor(min);
  const sec = Math.round((min - m) * 60);
  return sec ? `${m} min ${sec} s` : `${m} min`;
}

// ---------- demo simulation ----------
// Deterministic fake trains. Every value produced here is tagged kind "demo".

const DEMO_SPEED_M_PER_MIN = 600; // ~36 km/h average incl. acceleration
const DEMO_DWELL_MIN = 0.5;
const DEMO_LAYOVER_MIN = 4;
const DEMO_FALLBACK_SEGMENT_MIN = 3;

function demoRoute(line) {
  if (line.kind !== "loop-tail") return line.stations;
  // Blue Line, as the "Lak Song → Tha Phra" service runs (see model.towardsFor):
  // BL38..BL33, BL01, BL32..BL02, BL01.
  const byCode = line.stations;
  const tail = byCode.slice(32).reverse(); // BL38..BL33
  const loop = byCode.slice(1, 32).reverse(); // BL32..BL02
  return [...tail, byCode[0], ...loop, byCode[0]];
}

function buildDemoLine(model, line) {
  const route = demoRoute(line);
  const t = [0];
  for (let i = 1; i < route.length; i++) {
    const a = model.stations.get(route[i - 1]);
    const b = model.stations.get(route[i]);
    const seg =
      a.lat != null && b.lat != null
        ? (distanceM(a, b) * 1.15) / DEMO_SPEED_M_PER_MIN
        : DEMO_FALLBACK_SEGMENT_MIN;
    t.push(t[i - 1] + seg + DEMO_DWELL_MIN);
  }
  const oneWay = t[t.length - 1];
  const cycle = 2 * (oneWay + DEMO_LAYOVER_MIN);
  const headway = 6; // demo trains run every 6 minutes on every line
  return { line, route, t, oneWay, cycle, headway };
}

const mod = (a, n) => ((a % n) + n) % n;

export function createDemoFeed(model) {
  const sims = new Map();
  for (const line of model.network.lines) sims.set(line.id, buildDemoLine(model, line));

  return {
    kind: "demo",
    arrivals(directionKey, lineId, stationId, nextId, nowMs) {
      const sim = sims.get(lineId);
      const nowMin = nowMs / 60000;
      const etas = [];
      sim.route.forEach((id, i) => {
        if (id !== stationId) return;
        let at = null;
        if (sim.route[i + 1] === nextId) at = sim.t[i];
        else if (sim.route[i - 1] === nextId)
          at = sim.oneWay + DEMO_LAYOVER_MIN + (sim.oneWay - sim.t[i]);
        if (at == null) return;
        const first = mod(at - nowMin, sim.headway);
        for (let k = 0; k < 3; k++) etas.push(Math.round((first + k * sim.headway) * 60));
      });
      etas.sort((a, b) => a - b);
      return etas.slice(0, 3);
    },
    positions(nowMs) {
      const out = [];
      const nowMin = nowMs / 60000;
      for (const sim of sims.values()) {
        const base = mod(nowMin, sim.headway);
        for (let phase = base; phase < sim.cycle; phase += sim.headway) {
          const p = positionAt(model, sim, phase);
          if (p) out.push({ ...p, lineId: sim.line.id, kind: "demo", id: `d|${sim.line.id}|${Math.round(phase - base)}` });
        }
      }
      return out;
    },
  };
}

function positionAt(model, sim, phase) {
  let forward = true;
  let x = phase;
  if (x > sim.oneWay + DEMO_LAYOVER_MIN) {
    forward = false;
    x -= sim.oneWay + DEMO_LAYOVER_MIN;
    x = sim.oneWay - x;
  }
  x = Math.min(Math.max(x, 0), sim.oneWay);
  let i = 1;
  while (i < sim.t.length - 1 && sim.t[i] < x) i++;
  const a = model.stations.get(sim.route[i - 1]);
  const b = model.stations.get(sim.route[i]);
  if (a.lat == null || b.lat == null) return null;
  const span = sim.t[i] - sim.t[i - 1] - DEMO_DWELL_MIN;
  const f = Math.min(1, Math.max(0, (x - sim.t[i - 1]) / span));
  const ahead = forward ? b : a;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    ahead: { lat: ahead.lat, lon: ahead.lon },
    towards: forward ? sim.route[sim.route.length - 1] : sim.route[0],
  };
}
