import { NETWORK } from "../data/network.js";
import { buildModel, directionsAt } from "./model.js";
import { nearestStations, walkMinutes, distanceM, formatDistance, WALK } from "./geo.js";
import { createMap } from "./map.js";
import { STALE_AFTER_MS, createDemoFeed, timetableFor, formatHeadway } from "./feeds.js";
import { COVERAGE, LIVE_REASON } from "./coverage.js";
import { sourcesFor, startPolling, isStale, nextTrains } from "./live.js";
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
  view: "home", // home | station | pick | route
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
};
const liveSources = sourcesFor();

const demoFeed = createDemoFeed(model);
const map = createMap($("#map"), model, { onStationTap: openStation });

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

  const livePositions = [...new Set(state.live.values())].flatMap((l) => (l.data && !isStale(l) ? l.data.positions : []));
  const trains = livePositions.length ? livePositions : state.demo && state.feed ? state.feed.positions : [];
  map.setTrains(trains);
  $("#map-note").innerHTML = livePositions.length
    ? `<span class="tag live">LIVE</span> Train positions from ${esc([...state.live.values()][0].data.source)}`
    : state.demo
      ? `<span class="tag demo">DEMO</span> Simulated train markers`
      : `No live train positions: no verified feed`;
}

function locationMessage() {
  switch (state.locStatus) {
    case "asking": return `<p class="muted">Finding your location…</p>`;
    case "denied": return `<p class="note warn">Location permission is off. Choose a station below, or enable Location for this site in Settings › Privacy › Location Services.</p>`;
    case "unavailable": return `<p class="note warn">Couldn't get your location right now. Try again outdoors, or choose a station.</p>`;
    case "unsupported": return `<p class="note warn">This browser can't share location. Choose a station instead.</p>`;
    default: return "";
  }
}

function renderHome() {
  let html = `
    <div class="actions">
      <button class="primary" id="use-loc">📍 Use my location</button>
      <button id="pick">Choose station</button>
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
  return html;
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

function renderLive(live, stationId, destinationId, needMin) {
  if (!live.data) {
    return `<div class="src"><span class="tag na">Live arrivals unavailable</span> ${live.status === "loading" ? "Connecting…" : esc(live.error || "")}</div>`;
  }
  const now = Date.now();
  const stale = isStale(live, now);
  const trains = nextTrains(live, stationId, destinationId, now);
  if (!trains.length) return `<div class="src muted">No trains reported in this direction.</div>`;
  return `<ul class="etas">${trains.map((t) => {
    const sec = Math.max(0, Math.round((t.etaAt - now) / 1000));
    return `<li class="${stale ? "is-stale" : ""}"><span class="eta">${sec < 45 ? "Now" : `${Math.round(sec / 60)} min`}</span>
      ${t.train ? `<small class="muted">train ${esc(t.train)}</small>` : ""}${catchTag(sec, needMin)}</li>`;
  }).join("")}</ul>
    <div class="src">${stale ? `<span class="tag stale">STALE</span>` : `<span class="tag live">LIVE</span>`} ${esc(live.data.source)}</div>`;
}

function liveStatusLine(live) {
  if (!live.data) return `<p class="fine">Live source: ${esc(live.source.name)} · ${live.status === "loading" ? "connecting…" : `not reachable (${esc(live.error)})`}</p>`;
  const stale = isStale(live);
  return `<p class="fine live-line">${stale ? `<span class="tag stale">STALE</span>` : `<span class="tag live">LIVE</span>`}
    Source time ${fmtTime(live.data.sourceTime)} · received ${fmtTime(live.data.receivedAt)} · refreshes every ${Math.round((live.source.pollMs || 20000) / 1000)} s
    ${live.error ? ` · <span class="warn-text">last refresh failed (${esc(live.error)}), showing previous data</span>` : ""}
    ${stale ? ` · <span class="warn-text">data is ${Math.round((Date.now() - live.data.sourceTime) / 1000)} s old, countdowns may be wrong</span>` : ""}
    ${live.source.test ? ` · <b>local test feed</b>` : ""}</p>`;
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
      if (live) {
        body = renderLive(live, s.id, d.terminusId, needMin);
      } else if (state.demo) {
        const etas = (state.feed?.etas.get(d.key) || []).map((e) => Math.max(0, e - elapsed));
        body = etas.length
          ? `<ul class="etas">${etas.map((e) => `<li class="${stale ? "is-stale" : ""}"><span class="eta">${e < 45 ? "Now" : `${Math.round(e / 60)} min`}</span>${catchTag(e, needMin)}</li>`).join("")}</ul>
             <div class="src"><span class="tag demo">DEMO</span> simulated countdown</div>`
          : `<div class="src muted">No demo data yet.</div>`;
      } else {
        body = `<div class="src"><span class="tag na">Live arrivals unavailable</span></div>`;
      }
      const term = model.stations.get(d.terminusId);
      return `<div class="dir">
          <div class="dir-h">${esc(d.label)}</div>
          <div class="fine">Next stop: ${esc(d.nextName)}${term.id !== s.id ? ` · destination ${esc(term.name)}` : ""}</div>
          ${body}
        </div>`;
    }).join("");
    const ttBlock = tt.status !== "ok"
      ? `<div class="tt"><span class="tag na">Timetable unavailable</span> ${esc(tt.reason)}</div>`
      : `<div class="tt"><span class="tag tt">Timetable estimate</span>
          ${tt.inService
            ? `Trains about every <b>${formatHeadway(tt.headwayMin)}</b> now (${tt.dayType} timetable, ${esc(tt.periodLabel)}).`
            : `<b>Outside published service hours</b>.`}
          Service ${esc(tt.hours)}.
          ${tt.note ? `<span class="fine">${esc(tt.note)}</span>` : ""}
          <span class="fine">${tt.verified ? "Operator-published" : "Unverified, secondary source"} · <a href="${esc(tt.source)}" target="_blank" rel="noopener">source</a></span></div>`;
    return `<section class="line-block" style="--c:${line.color}">
        <h3>${lineChip(lineId, code)}</h3>
        ${live ? liveStatusLine(live) : `<p class="fine">${esc(LIVE_REASON[lineId] || "No live arrival data.")}</p>`}
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
  if (state.view === "route") panel.innerHTML = renderRoute();
  else if (state.view === "station" && state.stationId) panel.innerHTML = renderStation();
  else if (state.view === "pick") panel.innerHTML = renderPicker();
  else panel.innerHTML = renderHome();
  if (focused === "pick-q" || focused === "route-q") {
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
  if (e.target.closest("#pick")) { state.view = "pick"; render(); }
});
$("#panel").addEventListener("input", (e) => {
  if (e.target.id === "pick-q") { state.pickQuery = e.target.value; render(); }
  if (e.target.id === "route-q") { state.route.q = e.target.value; render(); }
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
$("#sim-stale").onchange = (e) => { state.simStale = e.target.checked; refreshFeed(); render(); };
$("#sim-offline").onchange = (e) => { state.simOffline = e.target.checked; refreshFeed(); render(); };

$("#coverage").innerHTML = `<div class="table-wrap"><table>
  <thead><tr><th>Line</th>${COVERAGE.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
  <tbody>${COVERAGE.rows.map((r) => `<tr><th><span class="sw" style="--c:${model.lines.get(r.line).color}"></span>${esc(model.lines.get(r.line).short)}</th>${r.cells.map((c) => `<td class="cov ${c.s}">${esc(c.t)}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div><p class="fine">${esc(COVERAGE.note)}</p>`;
$("#data-src").innerHTML = `Stations: <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a> (CC0), snapshot ${esc(NETWORK.source.retrieved)}; some coordinates from the OTP Namtang GTFS (สนข./OTP, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC-BY 4.0</a>). Track alignment, Chao Phraya River (centreline) and Lumphini Park: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, ODbL. Headways and hours: operator publications (BTS/EBM, BEM, SRTET).`;

// Live sources (none configured in production; see live.js).
for (const source of liveSources) {
  const poll = startPolling(source, model, () => render(), { isOffline });
  for (const lineId of source.lines) state.live.set(lineId, poll.state);
  window.addEventListener("online", () => poll.refresh());
}

// Ticks: re-render countdowns every second, refresh the (demo) feed every 15 s.
setInterval(() => {
  // Don't rebuild the panel while someone is typing a search.
  if (document.activeElement?.matches?.("#pick-q, #route-q")) return;
  if (state.view === "station" || state.demo || state.live.size) render();
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
