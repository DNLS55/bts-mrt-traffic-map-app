import { NETWORK } from "../data/network.js";
import { PLACES } from "../data/places.js";
import { ROADS } from "../data/roads.js";
import { PLACE_ICONS } from "../icons/places/index.js";
import { LOGO_IDS } from "../icons/logos/index.js";
import { PLACE_INFO } from "../data/place-info.js";
import { buildModel, directionsAt } from "./model.js";
import { nearestStations, walkMinutes, distanceM, formatDistance, WALK, crosses } from "./geo.js";
import { createMap, PLACE_COLORS } from "./map.js";
import { STALE_AFTER_MS, createDemoFeed, timetableFor, formatHeadway } from "./feeds.js";
import { COVERAGE, LIVE_REASON } from "./coverage.js";
import { sourcesFor, startPolling, isStale, nextTrains, LIVE_STALE_MS } from "./live.js";
import { createUnofficialSource, trackTrains, coveredBy, UNOFFICIAL, EVERY_MS } from "./unofficial.js";
import { scheduledArrivals, scheduledPositions } from "./scheduled.js";
import { buildGraph, planRoute } from "./route.js";

const model = buildModel(NETWORK);
const graph = buildGraph(model);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  view: "home", // home | station | pick | route | places | place
  placeRank: null,
  placeQuery: "",
  route: { from: null, to: null, q: "" },
  stationId: null,
  pickQuery: "",
  location: null, // {lat, lon, accuracy, at}
  locStatus: "idle", // idle | asking | ok | denied | unavailable | unsupported
  demo: store.get("demo", false),
  simStale: false,
  simOffline: false,
  online: navigator.onLine,
  feed: null, // demo only: {updatedAt, fetchedAt, etas: Map(directionKey -> seconds[]), positions}
  live: new Map(), // lineId -> poll state of the live source covering it
  unofficial: store.get("unofficial", true), // bangkoktransit.com feed: on unless switched off
  scheduled: true, // timetable estimates are always on where there's no live data
};
const HOSTED_URL = "https://dnls55.github.io/bts-mrt-traffic-map-app/";
const COPYRIGHT_HTML = `<p class="copyright">© 2026 Professor Daniel Schlagwein. All rights reserved. No responsibility taken; for demonstration purposes only.</p>`;
const embedded = (() => { try { return window.top !== window.self; } catch { return true; } })();

const demoFeed = createDemoFeed(model);
const placeById = new Map(PLACES.places.map((p) => [p.id, p]));
const map = createMap($("#map"), model, {
  onStationTap: openStation, places: PLACES.places, onPlaceTap: (id) => { openPlace(id); showPlacePop(id); }, icons: PLACE_ICONS, roads: ROADS.roads,
});

// ---------------- location (device only) ----------------
let watchId = null;
function requestLocation() {
  if (!("geolocation" in navigator)) {
    state.locStatus = "unsupported";
    return render();
  }
  state.locStatus = "asking";
  render();
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  let first = true;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.location = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, at: pos.timestamp };
      state.locStatus = "ok";
      map.setMe(state.location);
      if (first) {
        first = false;
        const near = nearestStations(state.location, NETWORK.stations, 3);
        map.focusOn([state.location, ...near.map((n) => n.station)]);
      }
      render();
    },
    (err) => {
      state.locStatus = err.code === 1 ? "denied" : "unavailable";
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      if (state.locStatus === "denied") state.view = "pick";
      render();
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
  );
}

// ---------------- feeds ----------------
function isOffline() {
  return !state.online || state.simOffline;
}

function refreshFeed() {
  if (!state.demo) {
    state.feed = null;
    return;
  }
  if (isOffline()) return; // keep last data; banner explains
  const now = Date.now();
  const prevUpdated = state.feed?.updatedAt;
  const updatedAt = state.simStale && prevUpdated ? prevUpdated : now;
  const etas = new Map();
  if (state.stationId) {
    const st = model.stations.get(state.stationId);
    for (const { line } of st.lines) {
      for (const d of directionsAt(model, line, st.id)) {
        etas.set(d.key, demoFeed.arrivals(d.key, line, st.id, d.next, updatedAt));
      }
    }
  }
  state.feed = { updatedAt, fetchedAt: now, etas, positions: demoFeed.positions(updatedAt) };
}

function feedAgeMs() {
  return state.feed ? Date.now() - state.feed.updatedAt : null;
}

// ---------------- rendering ----------------
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Bangkok" });

function lineChip(lineId, code) {
  const l = model.lines.get(lineId);
  return `<span class="line-chip" style="--c:${l.color}"><b>${esc(code)}</b> ${esc(l.short)}</span>`;
}

function stationLines(s) {
  return s.lines.map((x) => lineChip(x.line, x.code)).join("");
}

function renderChrome() {
  const off = isOffline();
  const chip = $("#net-chip");
  chip.textContent = off ? "Offline" : "Online";
  chip.className = "chip " + (off ? "bad" : "good");
  $("#demo-banner").hidden = !state.demo;
  const ob = $("#offline-banner");
  if (off) {
    ob.hidden = false;
    const lastLive = [...state.live.values()].map((l) => l.data?.sourceTime).filter(Boolean).sort().pop();
    ob.textContent = lastLive
      ? `No connection. Live arrivals last updated ${fmtTime(lastLive)} and may be out of date.`
      : state.feed
      ? `No connection. Showing data last updated ${fmtTime(state.feed.updatedAt)} — it may be out of date.`
      : "No connection. Station map and walking times still work; arrivals can't be refreshed.";
  } else ob.hidden = true;

  const { trains, note } = mapTrains();
  map.setTrains(trains);
  $("#map-note").innerHTML = note;
}

// Trains never run backwards. When a newer answer says a train is a little
// behind where we showed it (it was held at a platform), keep it where it was
// until the estimate catches up. A big step back is a different train reusing
// the number, so that one moves.
const shown = new Map(); // train id -> { prog, t, at }
function holdBack(trains) {
  const now = Date.now();
  const out = trains.map((t) => {
    if (!t.from) return t;
    const ids = model.lines.get(t.lineId).stations;
    const a = ids.indexOf(t.from);
    const b = ids.indexOf(t.to);
    const prog = (a + (b - a) * t.f) * Math.sign(b - a); // stations travelled, in the direction of travel
    const prev = shown.get(t.id);
    if (prev && prog < prev.prog && prev.prog - prog < 0.75) { prev.at = now; return prev.t; }
    shown.set(t.id, { prog, t, at: now });
    return t;
  });
  for (const [id, v] of shown) if (now - v.at > 60000) shown.delete(id);
  return out;
}

// Train markers for the map: one best estimate per train.
//  - lines with live times: every train listed by any station, placed from its
//    train number (work back from the next station it is due at);
//  - stretches of those lines no station answer covers yet (just after
//    start-up), and every other line: the timetable, assuming trains run on time.
function mapTrains() {
  const now = Date.now();
  if (state.demo && state.feed) {
    return { trains: state.feed.positions, note: `<span class="tag demo">DEMO</span> Simulated train markers` };
  }
  const trains = [];
  const liveLines = new Set();
  const windows = [];
  let loading = "";
  let failed = "";
  for (const live of new Set(state.live.values())) {
    const lines = new Set([...state.live].filter(([, l]) => l === live).map(([id]) => id));
    if (!live.data || isStale(live)) {
      if (live.error && live.status !== "loading") failed = `${live.source.name}: ${live.error}`;
      continue;
    }
    for (const id of lines) liveLines.add(id);
    trains.push(...holdBack(trackTrains(model, live.data, now, lines)), ...live.data.positions);
    windows.push(...(live.data.windows || []));
    // Until every swept station has answered, faded timetable trains fill the gaps.
    if (live.data.sweep && live.data.swept < live.data.sweep) loading = ` · ${live.data.swept}/${live.data.sweep} stations`;
  }
  const sched = scheduledPositions(model, NETWORK.lines.map((l) => l.id), now, {
    // Where live answers cover a stretch, they already say which trains are in it.
    skip: (trip, k) => liveLines.has(trip.lineId) && coveredBy(windows, trip, k),
  });
  trains.push(...sched);
  // "Pink" and "Pink branch" read as one line on the map, as do the two Red lines.
  // "Pink" and "Pink branch" read as one line on the map, as do the two Red lines.
  const names = (ids) => [...new Set([...ids].map((id) => model.lines.get(id).short.replace(" branch", "").replace(/^(Dark|Light) /, "")))].join(" · ");
  const schedOnly = [...new Set(sched.map((t) => t.lineId))].filter((id) => !liveLines.has(id));
  const parts = [];
  if (liveLines.size) parts.push(`<span class="tag live">LIVE</span> ${esc(names(liveLines))} <span class="sub">unofficial${loading}</span>`);
  else if (state.unofficial && failed) parts.push(`<span class="tag stale">NO LIVE</span> <span class="sub">${esc(failed)}</span>`);
  else if (state.unofficial) parts.push(`<span class="tag stale">LIVE</span> <span class="sub">connecting…</span>`);
  if (schedOnly.length) parts.push(`<span class="tag ttag">SCHEDULED</span> ${esc(names(schedOnly))} <span class="sub">on-time timetable</span>`);
  return { trains, note: parts.join("<br>") };
}

function locationMessage() {
  switch (state.locStatus) {
    case "asking": return `<p class="muted">Finding your location…</p>`;
    case "denied": return embedded
      ? `<p class="note warn">This preview can't use your location. Open the full app in Safari: <a href="${HOSTED_URL}" target="_blank" rel="noopener">${HOSTED_URL.replace("https://", "")}</a>, or choose a station below.</p>`
      : `<p class="note warn">Location is blocked for this site. In Safari tap <b>aA</b> › Website Settings › Location › Allow, and check Settings › Privacy &amp; Security › Location Services › Safari Websites is set to <i>While Using the App</i>. Or choose a station below.</p>`;
    case "unavailable": return `<p class="note warn">Couldn't get your location right now. Try again outdoors, or choose a station.</p>`;
    case "unsupported": return `<p class="note warn">This browser can't share location. Choose a station instead.</p>`;
    default: return "";
  }
}

// One-time hint for iPhone/iPad Safari visitors who haven't installed the app.
function installHint() {
  if (embedded) {
    return `<p class="note install">For location and Add to Home Screen, open the full app in Safari: <a href="${HOSTED_URL}" target="_blank" rel="noopener">${HOSTED_URL.replace("https://", "")}</a></p>`;
  }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (!ios || installed || store.get("hideInstall", false)) return "";
  return `<div class="note install"><img src="icons/icon.svg" alt="" width="36" height="36">
    <span><b>Install as an app:</b> tap <b>Share</b> ⬆︎ in Safari, then <b>Add to Home Screen</b>.</span>
    <button class="icon-btn" id="hide-install" aria-label="Hide install tip">✕</button></div>`;
}

function renderHome() {
  let html = `${installHint()}
    <div class="actions">
      <button class="primary" id="use-loc">📍 Use my location</button>
      <button id="pick">Choose station</button>
      <button id="places-btn" class="wide">🗺️ Bangkok top 100+ places</button>
    </div>
    ${locationMessage()}`;
  if (state.location) {
    const near = nearestStations(state.location, NETWORK.stations, 5);
    const far = near[0].meters > 30000;
    html += `<h2 class="section-h">Nearest stations</h2>
      ${far ? `<p class="note">You appear to be far from the Bangkok network (${formatDistance(near[0].meters)} to the closest station).</p>` : ""}
      <p class="fine">Accuracy ±${Math.round(state.location.accuracy)} m · walking times are estimates</p>
      <ul class="list">${near.map((n) => `
        <li><button class="row" data-station="${esc(n.station.id)}">
          <span class="row-main"><span class="name">${esc(n.station.name)}</span><span class="lines">${stationLines(n.station)}</span></span>
          <span class="walk"><b>${n.walkMin} min</b> walk<br><small>${formatDistance(n.meters)}</small></span>
        </button></li>`).join("")}</ul>`;
    map.highlight(near.map((n) => n.station.id));
  } else {
    map.highlight([]);
    html += `<p class="muted intro">Find stations near you, then tap one to see trains in both directions.</p>`;
  }
  return html + COPYRIGHT_HTML;
}

// Nearest stations to a place, on foot: a station across the Chao Phraya
// counts as 2.5 km further (bridges are few; Talat Noi is not "near" Khlong San).
const RIVER_PENALTY_M = 2500;
function nearestToPlace(pl, n = 3) {
  const river = NETWORK.landmarks?.river?.lines || [];
  return nearestStations(pl, NETWORK.stations, 15)
    .map((x) => ({ ...x, cost: x.meters + (crosses(pl, x.station, river) ? RIVER_PENALTY_M : 0) }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, n);
}

function placeBadge(pl, size = 40) {
  const icon = PLACE_ICONS[pl.id] || PLACE_ICONS[pl.icon];
  const art = icon ? `<svg viewBox="0 0 32 32" aria-hidden="true">${icon}</svg>` : `<span>${pl.emoji}</span>`;
  return `<span class="pl-badge" style="--pc:${PLACE_COLORS[pl.category] || "#4a5568"};--sz:${size}px">${art}<b>${pl.id}</b></span>`;
}

function renderPlaces() {
  const q = state.placeQuery.trim().toLowerCase();
  const list = PLACES.places.filter((p) => !q || `${p.name} ${p.note} ${p.category}`.toLowerCase().includes(q));
  return `
    <div class="panel-head"><button class="back" data-go="home">‹ Back</button><h2>Bangkok top 100+</h2></div>
    <input id="place-q" class="search" type="search" placeholder="Search places (e.g. temple, rooftop, market)" value="${esc(state.placeQuery)}" autocomplete="off">
    <ul class="list">${list.map((p) => {
      const near = nearestToPlace(p, 1)[0];
      return `<li><button class="row" data-place="${esc(p.id)}">
        <span class="pl-row">${placeBadge(p, 38)}<span class="row-main"><span class="name">${esc(p.name)}</span><small class="muted">${esc(p.note)}</small></span></span>
        <span class="walk"><small>${esc(near.station.name)}</small><br><b>${near.walkMin} min</b> walk</span>
      </button></li>`;
    }).join("") || `<li class="muted">No place matches “${esc(state.placeQuery)}”.</li>`}</ul>
    <p class="fine">Places: merged top-100 list. Locations and outlines: © OpenStreetMap contributors (ODbL), via Nominatim.</p>`;
}

// ---------------- place pop-up (tap a place on the map) ----------------
const LOGOS = new Set(LOGO_IDS);
const systemOf = (st) => [...new Set(st.lines.map((l) => l.line.split("-")[0]))].join("/");

// The ChatGPT-made logo card where there is one (#1-100), drawn over the
// hand-drawn icon, which shows if the picture can't load (e.g. offline).
function placeArt(pl, size) {
  const icon = PLACE_ICONS[pl.id] || PLACE_ICONS[pl.icon];
  return `<span class="pop-art" style="--sz:${size}px;--pc:${PLACE_COLORS[pl.category] || "#4a5568"}">
    ${icon ? `<svg viewBox="0 0 32 32" aria-hidden="true">${icon}</svg>` : `<span>${pl.emoji}</span>`}
    ${LOGOS.has(pl.id) ? `<img src="icons/logos/${pl.id}.png" alt="" width="${size}" height="${size}" loading="lazy">` : ""}</span>`;
}

function placeBlurb(pl) {
  const i = PLACE_INFO[pl.id];
  if (!i) return pl.note ? `<p>${esc(pl.note)}</p>` : "";
  return `<p class="blurb"><b>${esc(i.what)}</b> ${esc(i.why)}</p>${i.when ? `<p class="when"><span aria-hidden="true">🕒</span> ${esc(i.when)}</p>` : ""}`;
}

// Google Maps: the place itself, and directions from its nearest station
// (walking when it is close, otherwise Google picks the mode).
function googleLinks(pl, near) {
  const place = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${pl.name}, Bangkok`)}`;
  const dir = `https://www.google.com/maps/dir/?api=1&origin=${near.station.lat},${near.station.lon}&destination=${pl.lat},${pl.lon}${near.meters <= 2500 ? "&travelmode=walking" : ""}`;
  return { place, dir };
}

function showPlacePop(id) {
  const pl = placeById.get(String(id));
  const pop = $("#place-pop");
  if (!pl) { pop.hidden = true; return; }
  const near = nearestToPlace(pl, 1)[0];
  const g = googleLinks(pl, near);
  pop.innerHTML = `
    <button class="pop-x" data-pop-close aria-label="Close">×</button>
    <div class="pop-head">${placeArt(pl, 84)}
      <div><h3>${esc(pl.name)}</h3><div class="muted">#${esc(pl.id)} · ${esc(pl.category)}</div></div></div>
    ${placeBlurb(pl)}
    <p class="pop-near">Nearest station: <b>${esc(near.station.name)}</b> (${esc(systemOf(near.station))}) · ${near.walkMin} min walk</p>
    <div class="pop-actions">
      <a class="btn-link" href="${g.place}" target="_blank" rel="noopener">Google Maps</a>
      <a class="btn-link go" href="${g.dir}" target="_blank" rel="noopener">Go there from ${esc(near.station.name)} ${esc(systemOf(near.station))}</a>
      <button class="btn-link" data-route-to-place="${esc(pl.id)}">Train route here</button>
      <button class="btn-link" data-pop-more>More</button>
    </div>`;
  pop.querySelector("img")?.addEventListener("error", (e) => e.target.remove());
  pop.hidden = false;
  pop.scrollTop = 0;
}

function hidePlacePop() { $("#place-pop").hidden = true; }

function routeToPlace(id) {
  const pl = placeById.get(id);
  state.route.to = nearestToPlace(pl, 1)[0].station.id;
  state.route.from = state.location ? nearestStations(state.location, NETWORK.stations, 1)[0].station.id : null;
  state.route.q = "";
  state.view = "route";
  showRouteOnMap();
  render();
}

function renderPlace() {
  const pl = placeById.get(state.placeRank);
  const near = nearestToPlace(pl, 3);
  const mine = state.location ? nearestStations(state.location, NETWORK.stations, 1)[0] : null;
  const kind = pl.areas ? "Outlined area on the map" : pl.lines ? "Highlighted street on the map" : "Point on the map";
  return `
    <div class="panel-head"><button class="back" data-go="places">‹ Top 100</button></div>
    <div class="place-hero">${placeArt(pl, 72)}<div><h2>${esc(pl.name)}</h2><div class="muted">#${esc(pl.id)}${pl.extra ? " (added)" : ""} · ${esc(pl.category)}</div></div></div>
    ${placeBlurb(pl)}
    <p class="fine">${kind}${pl.approx ? " · position approximate" : ""}.</p>
    <h3 class="section-h">Nearest stations</h3>
    <ul class="list">${near.map((n) => `<li><button class="row" data-station="${esc(n.station.id)}">
      <span class="row-main"><span class="name">${esc(n.station.name)}</span><span class="lines">${stationLines(n.station)}</span></span>
      <span class="walk"><b>${n.walkMin} min</b> walk<br><small>${formatDistance(n.meters)}</small></span></button></li>`).join("")}</ul>
    <div class="actions">
      <button class="primary" data-route-to-place="${esc(pl.id)}">${mine ? `Route from ${esc(mine.station.name)}` : "Plan a route here"}</button>
      <a class="btn-link" href="${googleLinks(pl, near[0]).place}" target="_blank" rel="noopener">Google Maps</a>
      <a class="btn-link wide" href="${googleLinks(pl, near[0]).dir}" target="_blank" rel="noopener">Go there from ${esc(near[0].station.name)} ${esc(systemOf(near[0].station))} (Google Maps)</a>
    </div>`;
}

function openPlace(id) {
  const pl = placeById.get(String(id));
  if (!pl) return;
  state.placeRank = pl.id;
  state.view = "place";
  map.selectPlace(pl.id);
  const near = nearestToPlace(pl, 1)[0];
  map.highlight([near.station.id]);
  // Fit the whole outline (e.g. all of Bang Krachao), the marker and the station.
  const outline = (pl.areas || []).flat().map(([lat, lon]) => ({ lat, lon }));
  map.focusOn([pl, near.station, ...outline], 1200);
  render();
  $("#panel").scrollTop = 0;
}

function renderPicker() {
  const q = state.pickQuery.trim().toLowerCase();
  const groups = NETWORK.lines.map((line) => {
    const items = line.stations
      .map((id) => model.stations.get(id))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.nameTh || "").includes(q) ||
        s.lines.some((x) => x.code.toLowerCase() === q))
      .map((s) => `<li><button class="row compact" data-station="${esc(s.id)}">
          <span class="code" style="--c:${line.color}">${esc(s.lines.find((x) => x.line === line.id).code)}</span>
          <span class="name">${esc(s.name)}</span>${s.lat == null ? `<small class="muted"> · location unknown</small>` : ""}
        </button></li>`).join("");
    return items ? `<h3 class="line-h" style="--c:${line.color}">${esc(line.name)}</h3><ul class="list">${items}</ul>` : "";
  }).join("");
  return `
    <div class="panel-head"><button class="back" data-go="home">‹ Back</button><h2>Choose station</h2></div>
    ${locationMessage()}
    <input id="pick-q" class="search" type="search" placeholder="Search name or code (e.g. Asok, E4)" value="${esc(state.pickQuery)}" autocomplete="off">
    ${groups || `<p class="muted">No station matches “${esc(state.pickQuery)}”.</p>`}`;
}

const KIND_LABEL = { skywalk: "covered skywalk", street: "street-level walk", underground: "underground walkway", linked: "direct link, separate fare gates" };

function stationSearch(q, inputId, attr) {
  const needle = q.trim().toLowerCase();
  const hits = needle ? NETWORK.stations.filter((s) => s.name.toLowerCase().includes(needle) ||
    (s.nameTh || "").includes(needle) || s.lines.some((x) => x.code.toLowerCase() === needle)).slice(0, 8) : [];
  return `<input id="${inputId}" class="search" type="search" placeholder="Station name or code" value="${esc(q)}" autocomplete="off">
    <ul class="list">${hits.map((h) => `<li><button class="row compact" ${attr}="${esc(h.id)}"><span class="name">${esc(h.name)}</span> <span class="lines">${stationLines(h)}</span></button></li>`).join("")}</ul>`;
}

function renderRoute() {
  const r = state.route;
  const from = r.from && model.stations.get(r.from);
  const to = r.to && model.stations.get(r.to);
  let body = "";
  if (!from) body = `<h3 class="section-h">From</h3>${stationSearch(r.q, "route-q", "data-route-from")}`;
  else if (!to) body = `<h3 class="section-h">To</h3>${stationSearch(r.q, "route-q", "data-route-to")}`;
  else {
    const plan = planRoute(model, graph, from.id, to.id);
    body = plan ? `
      <div class="route-total"><b>About ${Math.round(plan.minutes)} min</b> in trains and transfers <span class="fine">(waiting time not included)</span></div>
      <ol class="legs">${plan.legs.map((leg) => renderLeg(leg)).join("")}</ol>
      <p class="fine">Ride times are estimated from track length; transfer times are estimates. Check station signs.</p>`
      : `<p class="note warn">No connection found between these stations.</p>`;
  }
  return `
    <div class="panel-head"><button class="back" data-go="${state.stationId ? "station" : "home"}">‹ Back</button><h2>Plan a route</h2></div>
    <div class="route-ends">
      <button class="end" data-route-clear="from"><small>From</small>${from ? esc(from.name) : "Choose…"}</button>
      <button class="swap" id="route-swap" aria-label="Swap start and destination">⇅</button>
      <button class="end" data-route-clear="to"><small>To</small>${to ? esc(to.name) : "Choose…"}</button>
    </div>
    ${body}`;
}

function renderLeg(leg) {
  if (leg.kind === "ride") {
    const line = model.lines.get(leg.line);
    const a = model.stations.get(leg.stops[0]);
    const b = model.stations.get(leg.stops[leg.stops.length - 1]);
    const n = leg.stops.length - 1;
    return `<li class="leg leg-ride" style="--c:${line.color}">
      <div><b>${esc(line.name)}</b> towards ${esc(model.stations.get(leg.towards).name)}</div>
      <div>${esc(a.name)} → ${esc(b.name)} · ${n} stop${n > 1 ? "s" : ""} · ~${leg.minutes} min</div></li>`;
  }
  if (leg.kind === "change") {
    return `<li class="leg leg-change"><div><b>Change lines at ${esc(model.stations.get(leg.from).name)}</b> · ~${leg.minutes} min</div></li>`;
  }
  const t = leg.transfer;
  return `<li class="leg leg-walk"><div><b>Walk from ${esc(model.stations.get(leg.from).name)} to ${esc(model.stations.get(leg.to).name)}</b> · ~${leg.minutes} min</div>
    <div class="fine">${esc(KIND_LABEL[t.kind] || t.kind)}${t.connector ? ` — ${esc(t.connector)}` : ""}</div></li>`;
}

// When the live answer for this station was produced (sources that answer per
// station say so; others give one time for everything).
function liveTimeAt(live, stationId) {
  return live.data?.stations ? live.data.stations.get(stationId) ?? null : live.data?.sourceTime ?? null;
}

function renderLive(live, stationId, destinationId, needMin) {
  if (!live.data) {
    return `<div class="src"><span class="tag na">Live arrivals unavailable</span> ${live.status === "loading" ? "Connecting…" : esc(live.error || "")}</div>`;
  }
  const now = Date.now();
  const stale = now - (liveTimeAt(live, stationId) ?? 0) > LIVE_STALE_MS;
  const trains = nextTrains(live, stationId, destinationId, now);
  if (!trains.length) return `<div class="src muted">No trains reported in this direction.</div>`;
  return `<ul class="etas">${trains.map((t) => {
    const sec = Math.max(0, Math.round((t.etaAt - now) / 1000));
    return `<li class="${stale ? "is-stale" : ""}"><span class="eta">${sec < 45 ? "Now" : `${Math.round(sec / 60)} min`}</span>
      <span class="eta-meta">${t.destination !== destinationId ? `to ${esc(model.stations.get(t.destination)?.name)} · ` : ""}${t.train ? `train ${esc(t.train)}` : ""}</span>${catchTag(sec, needMin)}</li>`;
  }).join("")}</ul>
    <div class="src">${stale ? `<span class="tag stale">STALE</span>` : `<span class="tag live">LIVE</span>`} ${esc(live.data.source)}</div>`;
}

function renderScheduled(lineId, stationId, nextId, needMin) {
  const now = Date.now();
  const trains = scheduledArrivals(model, lineId, stationId, nextId, now);
  if (!trains.length) return `<div class="src muted">No more scheduled trains in the next 90 min.</div>`;
  return `<ul class="etas">${trains.map((t) => {
    const sec = Math.max(0, Math.round((t.etaAt - now) / 1000));
    return `<li class="sched"><span class="eta">${sec < 45 ? "Due" : `${Math.round(sec / 60)} min`}</span>
      <span class="eta-meta">${fmtTime(t.etaAt).slice(0, 5)}</span>${catchTag(sec, needMin)}</li>`;
  }).join("")}</ul>
    <div class="src"><span class="tag ttag">SCHEDULED</span> assumes trains run on time</div>`;
}

function liveStatusLine(live, stationId) {
  if (live.status === "idle") return "";
  if (!live.data) return `<p class="fine">Live source: ${esc(live.source.name)}${live.source.unofficial ? " (unofficial)" : ""} · ${live.status === "loading" ? "connecting…" : `unavailable: ${esc(live.error)}`}</p>`;
  const at = liveTimeAt(live, stationId);
  if (at == null) return `<p class="fine live-line"><span class="tag stale">LIVE</span> asking ${esc(live.source.name)} for this station…${live.error ? ` <span class="warn-text">(${esc(live.error)})</span>` : ""}</p>`;
  const stale = Date.now() - at > LIVE_STALE_MS;
  const every = live.source.unofficial ? EVERY_MS.open : live.source.pollMs || 20000;
  return `<p class="fine live-line">${stale ? `<span class="tag stale">STALE</span>` : `<span class="tag live">LIVE</span>`}
    Source time ${fmtTime(at)} · received ${fmtTime(live.data.receivedAt)} · refreshes every ${Math.round(every / 1000)} s
    ${live.error ? ` · <span class="warn-text">last refresh failed (${esc(live.error)}), showing previous data</span>` : ""}
    ${stale ? ` · <span class="warn-text">data is ${Math.round((Date.now() - at) / 1000)} s old, countdowns may be wrong</span>` : ""}
    ${live.source.test ? ` · <b>local test feed</b>` : ""}
    ${live.source.unofficial ? ` · <b>unofficial</b> via <a href="${UNOFFICIAL.site}" target="_blank" rel="noopener">${esc(live.source.name)}</a>, not endorsed by BTS` : ""}</p>`;
}

function freshnessBadge() {
  if (!state.demo) return "";
  if (!state.feed) return `<span class="tag stale">No data yet</span>`;
  const age = feedAgeMs();
  const stale = age > STALE_AFTER_MS;
  return `<span class="tag ${stale ? "stale" : "fresh"}">${stale ? "STALE" : "Updated"} ${fmtTime(state.feed.updatedAt)}</span>`;
}

function catchTag(etaSec, needMin) {
  if (needMin == null) return "";
  const slack = etaSec / 60 - needMin;
  if (slack >= 1) return `<span class="catch ok">can make it</span>`;
  if (slack >= -1) return `<span class="catch tight">tight</span>`;
  return `<span class="catch no">too soon</span>`;
}

function renderStation() {
  const s = model.stations.get(state.stationId);
  const meters = state.location && s.lat != null ? distanceM(state.location, s) : null;
  const walk = meters != null ? walkMinutes(meters) : null;
  const needMin = walk != null ? walk + WALK.platformMin : null;
  const age = feedAgeMs();
  const stale = state.demo && age != null && age > STALE_AFTER_MS;
  const elapsed = state.feed ? Math.floor((Date.now() - state.feed.updatedAt) / 1000) : 0;

  const walkBlock = walk != null
    ? `<div class="walk-card"><div><b>${walk} min</b> walk to the entrance · ${formatDistance(meters)}</div>
        <div class="fine">+ about ${WALK.platformMin} min to reach the platform. Estimate: straight-line distance ×${WALK.detourFactor} at ${WALK.speedMPerMin * 60 / 1000} km/h.</div></div>`
    : `<div class="walk-card muted">${s.lat == null ? "This station's location isn't in our verified data, so walking time is unavailable." : "Turn on location to see your walking time."}</div>`;

  const lineBlocks = s.lines.map(({ line: lineId, code }) => {
    const line = model.lines.get(lineId);
    const tt = timetableFor(lineId);
    const live = state.live.get(lineId);
    const dirs = directionsAt(model, lineId, s.id).map((d) => {
      let body;
      if (live && live.data && nextTrains(live, s.id, d.terminusId).length) {
        // Live times for this direction: use them.
        body = renderLive(live, s.id, d.terminusId, needMin);
      } else if (state.demo) {
        const etas = (state.feed?.etas.get(d.key) || []).map((e) => Math.max(0, e - elapsed));
        body = etas.length
          ? `<ul class="etas">${etas.map((e) => `<li class="${stale ? "is-stale" : ""}"><span class="eta">${e < 45 ? "Now" : `${Math.round(e / 60)} min`}</span>${catchTag(e, needMin)}</li>`).join("")}</ul>
             <div class="src"><span class="tag demo">DEMO</span> simulated countdown</div>`
          : `<div class="src muted">No demo data yet.</div>`;
      } else {
        // No live times for this direction: the timetable, assuming trains run on time.
        body = renderScheduled(lineId, s.id, d.next, needMin);
      }
      const term = model.stations.get(d.terminusId);
      return `<div class="dir">
          <div class="dir-h">${esc(d.label)}</div>
          <div class="fine">Next stop: ${esc(d.nextName)}${term.id !== s.id ? ` · destination ${esc(term.name)}` : ""}</div>
          ${body}
        </div>`;
    }).join("");
    // Next trains come from live times or the timetable (above); only say
    // when the line isn't running.
    const ttBlock = tt.status === "ok" && !tt.inService
      ? `<div class="tt"><b>No trains now.</b> Service ${esc(tt.hours)}.</div>`
      : "";
    return `<section class="line-block" style="--c:${line.color}">
        <h3>${lineChip(lineId, code)}</h3>
        ${live ? liveStatusLine(live, s.id) : `<p class="fine">${esc(LIVE_REASON[lineId] || "No live arrival data.")} Times below are from the timetable.</p>`}
        <div class="dirs">${dirs}</div>
        ${ttBlock}
      </section>`;
  }).join("");

  const ix = NETWORK.interchanges.find((i) => i.station === s.id);
  const sameStation = ix ? `<li class="conn same">
      <span class="conn-icon" aria-hidden="true">⇄</span>
      <span class="conn-body"><b>Change lines inside this station</b>
        <span class="lines">${stationLines(s)}</span>
        <small class="muted">About ${ix.minutes} min · ${esc(ix.how)}${ix.source && ix.source.startsWith("EBM") ? " · time from the EBM journey planner" : " · time is an estimate"}</small></span></li>` : "";
  const walkXfers = (model.transfers.get(s.id) || []).map((t) => {
    const o = model.stations.get(t.id);
    return `<li class="conn walk"><button class="row compact" data-station="${esc(o.id)}">
      <span class="conn-icon" aria-hidden="true">↝</span>
      <span class="conn-body"><b>Walk to ${esc(o.name)}</b> <span class="lines">${stationLines(o)}</span>
        <small class="muted">${t.minutes} min · ${t.meters} m between station points · ${esc(KIND_LABEL[t.kind] || t.kind)}${t.connector ? ` — ${esc(t.connector)}` : ""}</small></span></button></li>`;
  }).join("");
  const connections = sameStation + walkXfers;

  return `
    <div class="panel-head"><button class="back" data-go="${state.location ? "home" : "pick"}">‹ Back</button>
      <div><h2>${esc(s.name)}</h2>${s.nameTh ? `<div class="th">${esc(s.nameTh)}</div>` : ""}</div></div>
    <div class="lines">${stationLines(s)}</div>
    ${walkBlock}
    <div class="fresh-row">${freshnessBadge()} ${stale ? `<span class="warn-text">Feed hasn't updated for ${Math.round(age / 1000)} s — countdowns may be wrong.</span>` : ""}
      ${!state.demo ? `<span class="fine">Station data: Wikidata, ${esc(NETWORK.source.retrieved)}. Checked ${fmtTime(Date.now())}.</span>` : ""}</div>
    <button class="route-btn" data-route-from="${esc(s.id)}">Plan a route from ${esc(s.name)}</button>
    ${connections ? `<h3 class="section-h">Connections</h3><ul class="list conns">${connections}</ul>` : ""}
    ${lineBlocks}`;
}

function render() {
  renderChrome();
  const panel = $("#panel");
  const focused = document.activeElement?.id;
  if (state.view !== "place") { map.selectPlace(null); hidePlacePop(); }
  if (state.view === "places") panel.innerHTML = renderPlaces();
  else if (state.view === "place" && state.placeRank) panel.innerHTML = renderPlace();
  else if (state.view === "route") panel.innerHTML = renderRoute();
  else if (state.view === "station" && state.stationId) panel.innerHTML = renderStation();
  else if (state.view === "pick") panel.innerHTML = renderPicker();
  else panel.innerHTML = renderHome();
  if (focused === "pick-q" || focused === "route-q" || focused === "place-q") {
    const q = $("#" + focused);
    if (q) {
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  }
}

function openStation(id) {
  state.stationId = id;
  state.view = "station";
  const s = model.stations.get(id);
  map.highlight([id]);
  if (s.lat != null) map.focusOn(state.location ? [s, state.location] : [s]);
  refreshFeed();
  // Per-station live sources ask for the newly opened station next.
  for (const p of polls) if (p.source.load) p.refresh();
  render();
  $("#panel").scrollTop = 0;
}

function showRouteOnMap() {
  const { from, to } = state.route;
  if (!from || !to) return;
  const plan = planRoute(model, graph, from, to);
  if (!plan) return;
  const ids = [...new Set(plan.legs.flatMap((l) => (l.kind === "ride" ? l.stops : [l.from, l.to])))];
  map.highlight(ids);
  map.focusOn(ids.map((id) => model.stations.get(id)).filter((s) => s.lat != null), 1500);
}

// ---------------- events ----------------
$("#panel").addEventListener("click", (e) => {
  const rf = e.target.closest("[data-route-from]");
  const rt = e.target.closest("[data-route-to]");
  const rc = e.target.closest("[data-route-clear]");
  if (rf || rt) {
    if (rf) state.route.from = rf.dataset.routeFrom;
    if (rt) state.route.to = rt.dataset.routeTo;
    state.route.q = "";
    state.view = "route";
    showRouteOnMap();
    render();
    return;
  }
  if (rc) { state.route[rc.dataset.routeClear] = null; state.route.q = ""; render(); return; }
  if (e.target.closest("#route-swap")) {
    [state.route.from, state.route.to] = [state.route.to, state.route.from];
    showRouteOnMap();
    render();
    return;
  }
  const st = e.target.closest("[data-station]");
  if (st) return openStation(st.dataset.station);
  const go = e.target.closest("[data-go]");
  if (go) { state.view = go.dataset.go; render(); return; }
  if (e.target.closest("#use-loc")) return requestLocation();
  if (e.target.closest("#hide-install")) { store.set("hideInstall", true); render(); return; }
  if (e.target.closest("#pick")) { state.view = "pick"; render(); }
  if (e.target.closest("#places-btn")) { state.view = "places"; render(); return; }
  const pr = e.target.closest("[data-place]");
  if (pr) { openPlace(pr.dataset.place); return; }
  const rp = e.target.closest("[data-route-to-place]");
  if (rp) routeToPlace(rp.dataset.routeToPlace);
});
$("#place-pop").addEventListener("click", (e) => {
  if (e.target.closest("[data-pop-close]")) return hidePlacePop();
  if (e.target.closest("[data-pop-more]")) { hidePlacePop(); $("#panel").scrollIntoView?.({ behavior: "smooth" }); return; }
  const rp = e.target.closest("[data-route-to-place]");
  if (rp) { hidePlacePop(); routeToPlace(rp.dataset.routeToPlace); }
});
$("#panel").addEventListener("input", (e) => {
  if (e.target.id === "pick-q") { state.pickQuery = e.target.value; render(); }
  if (e.target.id === "route-q") { state.route.q = e.target.value; render(); }
  if (e.target.id === "place-q") { state.placeQuery = e.target.value; render(); }
});
$("#zoom-in").onclick = () => map.zoomIn();
$("#zoom-out").onclick = () => map.zoomOut();
$("#zoom-fit").onclick = () => map.fitAll();

window.addEventListener("online", () => { state.online = true; refreshFeed(); render(); });
window.addEventListener("offline", () => { state.online = false; render(); });

// Settings dialog
const dlg = $("#settings");
$("#settings-btn").onclick = () => dlg.showModal();
const demoToggle = $("#demo-toggle");
demoToggle.checked = state.demo;
$("#demo-tests").disabled = !state.demo;
demoToggle.onchange = () => {
  state.demo = demoToggle.checked;
  store.set("demo", state.demo);
  $("#demo-tests").disabled = !state.demo;
  if (!state.demo) { state.simStale = state.simOffline = false; $("#sim-stale").checked = $("#sim-offline").checked = false; }
  state.feed = null;
  refreshFeed();
  render();
};
const unofficialToggle = $("#unofficial-toggle");
unofficialToggle.checked = state.unofficial;
unofficialToggle.onchange = () => {
  state.unofficial = unofficialToggle.checked;
  store.set("unofficial", state.unofficial);
  setupLive();
  render();
};
$("#sim-stale").onchange = (e) => { state.simStale = e.target.checked; refreshFeed(); render(); };
$("#sim-offline").onchange = (e) => { state.simOffline = e.target.checked; refreshFeed(); render(); };

$("#coverage").innerHTML = `<div class="table-wrap"><table>
  <thead><tr><th>Line</th>${COVERAGE.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
  <tbody>${COVERAGE.rows.map((r) => `<tr><th><span class="sw" style="--c:${model.lines.get(r.line).color}"></span>${esc(model.lines.get(r.line).short)}</th>${r.cells.map((c) => `<td class="cov ${c.s}">${esc(c.t)}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div><p class="fine">${esc(COVERAGE.note)}</p>`;
$("#data-src").innerHTML = `Stations: <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a> (CC0), snapshot ${esc(NETWORK.source.retrieved)}; some coordinates from the OTP Namtang GTFS (สนข./OTP, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC-BY 4.0</a>). Track alignment, Chao Phraya River (centreline) and Lumphini Park: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, ODbL. Headways and hours: operator publications (BTS/EBM, BEM, SRTET).`;

// Live sources: none official; the unofficial one only when switched on.
let polls = [];
function setupLive() {
  for (const p of polls) p.stop();
  polls = [];
  state.live.clear();
  const sources = [...sourcesFor()];
  if (state.unofficial) {
    sources.push(createUnofficialSource(model, () => ({
      open: state.view === "station" ? state.stationId : null,
      near: state.location ? nearestStations(state.location, NETWORK.stations, 2).filter((n) => n.meters < 2500).map((n) => n.station.id) : [],
      inView: (s) => map.inView(s),
    })));
  }
  for (const source of sources) {
    const poll = startPolling(source, model, () => render(), { isOffline });
    poll.source = source;
    polls.push(poll);
    // Earlier sources win: an official (or local test) feed beats the unofficial one.
    for (const lineId of source.lines) if (!state.live.has(lineId)) state.live.set(lineId, poll.state);
  }
}
window.addEventListener("online", () => polls.forEach((p) => p.refresh()));
document.addEventListener("visibilitychange", () => { if (!document.hidden) polls.forEach((p) => p.refresh()); });
setupLive();

// Ticks: re-render countdowns every second, refresh the (demo) feed every 15 s.
setInterval(() => {
  // Don't rebuild the panel while someone is typing a search.
  if (document.activeElement?.matches?.("#pick-q, #route-q, #place-q")) return;
  if (state.view === "places") return; // static list; keeps scroll position
  if (state.view === "station" || state.demo || state.live.size || state.scheduled) render();
}, 1000);
setInterval(() => { refreshFeed(); }, 15000);

// Deep link for testing: #station=Q1016037
const m = location.hash.match(/station=([^&]+)/);
refreshFeed();
if (m && model.stations.has(decodeURIComponent(m[1]))) openStation(decodeURIComponent(m[1]));
else render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
