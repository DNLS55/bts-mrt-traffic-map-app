// Network map drawn as SVG on the device, in true geographic proportions.
// Projection: equirectangular centred on Bangkok (x scaled by cos 13.78°),
// north up. At city scale this keeps distances and angles within ~1%.
// No map tiles are loaded, so the user's position never leaves the phone.

const SVG_NS = "http://www.w3.org/2000/svg";
const LAT0 = 13.78;
const K = 1000; // svg units per degree of latitude (1 unit ≈ 111 m)
const COS0 = Math.cos((LAT0 * Math.PI) / 180);
const M_PER_UNIT = 111320 / K;

export const project = (lat, lon) => ({ x: (lon - 100.5) * COS0 * K, y: -(lat - LAT0) * K });

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

const pathD = (pts) => pts.map(([lat, lon], i) => {
  const p = project(lat, lon);
  return `${i ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
}).join("");

// Category colours for place badges and outlines.
export const PLACE_COLORS = {
  temple: "#d39b0b", market: "#e67e22", nightlife: "#8e44ad", food: "#e4572e", park: "#2e9d4f",
  mall: "#e2336f", culture: "#138a8a", neighbourhood: "#2f6fd6", river: "#1b8fd0", view: "#5b4bd6",
  landmark: "#4a5568", wellness: "#c06c84", hospital: "#b91c1c", hotel: "#9a6b3f",
};

export function createMap(container, model, { onStationTap, places = [], onPlaceTap = () => {}, icons = {}, roads = [] }) {
  const net = model.network;
  const svg = el("svg", { class: "net-map", role: "img", "aria-label": "Map of BTS, MRT, Airport Rail Link and SRT Red Line stations" });
  container.appendChild(svg);
  const root = el("g", {}, svg);
  const landG = el("g", { class: "land" }, root);
  const roadsG = el("g", { class: "roads" }, root);
  const placeShapesG = el("g", { class: "place-shapes" }, root);
  const linesG = el("g", { class: "lines" }, root);
  const xferG = el("g", { class: "xfers" }, root);
  const stationsG = el("g", { class: "stations" }, root);
  const meG = el("g", { class: "me" }, root);
  // Screen-space layers: trains, text and furniture keep their size at any zoom.
  const trainsG = el("g", { class: "trains" }, svg);
  const placesG = el("g", { class: "places" }, svg);
  const labelsG = el("g", { class: "labels" }, svg);
  const furnG = el("g", { class: "furniture" }, svg);

  // ---- landmarks (OpenStreetMap) ----
  for (const park of net.landmarks?.parks || []) {
    el("path", { d: pathD(park.polygon) + "Z", class: "park" }, landG);
  }
  for (const line of net.landmarks?.river?.lines || []) {
    el("path", { d: pathD(line), class: "river" }, landG);
  }

  // ---- track ----
  for (const line of net.lines) {
    for (const [a, b] of line.edges) {
      const sa = model.stations.get(a);
      const sb = model.stations.get(b);
      if (sa.lat == null || sb.lat == null) continue;
      const geom = line.geometry?.[`${a}|${b}`] || [[sa.lat, sa.lon], [sb.lat, sb.lon]];
      el("path", { d: pathD(geom), stroke: line.color, class: "seg" + (line.geometry?.[`${a}|${b}`] ? "" : " approx") }, linesG);
    }
  }

  // ---- pedestrian transfers ----
  const xferLabels = [];
  for (const t of net.transfers) {
    const a = model.stations.get(t.a);
    const b = model.stations.get(t.b);
    const pa = project(a.lat, a.lon);
    const pb = project(b.lat, b.lon);
    el("line", { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: "xfer-casing" }, xferG);
    el("line", { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: "xfer" }, xferG);
    const label = el("text", { class: "xfer-lbl" }, labelsG);
    label.textContent = `${t.minutes} min walk`;
    label._p = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    label._prio = 1;
    label._xfer = true;
    label._ends = [t.a, t.b];
    xferLabels.push(label);
  }

  // ---- stations ----
  const stationEls = new Map();
  const ixIds = new Set(net.interchanges.map((i) => i.station));
  const xferIds = new Set(net.transfers.flatMap((t) => [t.a, t.b]));
  for (const s of net.stations) {
    if (s.lat == null) continue;
    const p = project(s.lat, s.lon);
    const shared = ixIds.has(s.id);
    const walk = xferIds.has(s.id);
    const color = model.lines.get(s.lines[0].line).color;
    const g = el("g", { class: "st" + (shared ? " ix" : "") + (walk ? " wx" : ""), tabindex: "0", role: "button", "aria-label": s.name }, stationsG);
    el("circle", { cx: p.x, cy: p.y, r: 14, class: "hit" }, g);
    el("circle", { cx: p.x, cy: p.y, r: 3, stroke: shared ? "currentColor" : color, class: "dot" }, g);
    const label = el("text", { class: "lbl" + (shared || walk ? " ix" : "") }, labelsG);
    label.textContent = s.name;
    label._p = p;
    label._prio = shared || walk ? 2 : 3;
    const tap = () => onStationTap(s.id);
    g.addEventListener("click", tap);
    g.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && tap());
    stationEls.set(s.id, { g, label });
  }

  // River and park labels
  const landLabels = [];
  const riverLine = (net.landmarks?.river?.lines || []).flat();
  if (riverLine.length) {
    const mid = riverLine.reduce((best, q) => (Math.abs(q[0] - 13.70) < Math.abs(best[0] - 13.70) ? q : best));
    const l = el("text", { class: "land-lbl river-lbl" }, labelsG);
    l.textContent = "Chao Phraya River";
    l._p = project(mid[0], mid[1]);
    l._prio = 4;
    landLabels.push(l);
  }
  for (const park of net.landmarks?.parks || []) {
    const c = park.polygon.reduce((a, q) => [a[0] + q[0] / park.polygon.length, a[1] + q[1] / park.polygon.length], [0, 0]);
    const l = el("text", { class: "land-lbl park-lbl" }, labelsG);
    l.textContent = park.name;
    l._p = project(c[0], c[1]);
    l._prio = 4;
    l._minZoom = 12;
    landLabels.push(l);
  }

  // ---- major roads (OpenStreetMap): drawn under the rail lines, labelled when zoomed in ----
  const roadLabels = [];
  for (const road of roads) {
    if (!road.lines.length) continue;
    // One plain grey line per road (tools/build_roads.py joins the OSM pieces).
    el("path", { d: road.lines.map((l) => pathD(l)).join(""), class: "road" }, roadsG);
    // Label at the vertex closest to the road's centre of mass.
    const all = road.lines.flat();
    const c = all.reduce((a, q) => [a[0] + q[0] / all.length, a[1] + q[1] / all.length], [0, 0]);
    const mid = all.reduce((best, q) => ((q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 < (best[0] - c[0]) ** 2 + (best[1] - c[1]) ** 2 ? q : best));
    const l = el("text", { class: "road-lbl" }, labelsG);
    l.textContent = road.name;
    l._p = project(mid[0], mid[1]);
    l._prio = 3.3;
    l._minZoom = 5;
    roadLabels.push(l);
  }

  // ---- top-100 places: outlines for areas, highlighted streets, emoji badges ----
  const landmarkOsm = new Set((net.landmarks?.parks || []).map((p) => p.osm));
  const badges = []; // { g, _p, rank, id }
  for (const pl of places) {
    const color = PLACE_COLORS[pl.category] || "#4a5568";
    if (!landmarkOsm.has(pl.osm)) {
      for (const ring of pl.areas || []) el("path", { d: pathD(ring) + "Z", class: "place-area", style: `--pc:${color}` }, placeShapesG);
    }
    for (const line of pl.lines || []) el("path", { d: pathD(line), class: "place-street", style: `--pc:${color}` }, placeShapesG);
    const spots = pl.spots || [{ lat: pl.lat, lon: pl.lon, label: null }];
    for (const [i, spot] of spots.entries()) {
      const tagText = pl.id;
      const g = el("g", { class: "place", tabindex: "0", role: "button", "aria-label": `${pl.id}. ${pl.name}${spot.label ? `: ${spot.label}` : ""}`, style: `--pc:${color}` }, placesG);
      el("circle", { r: 13, class: "pl-bg" }, g);
      const icon = icons[pl.id] || icons[pl.icon];
      if (icon) {
        // Custom illustration (32×32) scaled into the badge.
        const art = el("g", { class: "pl-art", transform: "translate(-11 -11) scale(0.6875)" }, g);
        art.innerHTML = icon;
      } else {
        el("text", { y: 5.2, class: "pl-emoji", "text-anchor": "middle" }, g).textContent = pl.emoji;
      }
      const tag = el("g", { class: "pl-rank", transform: "translate(10 -10)" }, g);
      const tw = Math.max(13, 5 + tagText.length * 4.6);
      el("rect", { x: -tw / 2, y: -6.5, width: tw, height: 13, rx: 6.5 }, tag);
      el("text", { y: 2.6, "text-anchor": "middle" }, tag).textContent = tagText;
      const tap = () => onPlaceTap(pl.id);
      g.addEventListener("click", tap);
      g.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && tap());
      badges.push({ g, _p: project(spot.lat, spot.lon), rank: pl.rank, place: pl.id, pinned: Boolean(pl.pinned), id: `${pl.id}|${i}` });
    }
  }
  let selectedPlace = null;

  const pts = [...net.stations.filter((s) => s.lat != null), ...places].map((s) => project(s.lat, s.lon));
  const bounds = {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  };

  // ---- scale bar + north arrow ----
  const north = el("g", { class: "north", "aria-hidden": "true" }, furnG);
  el("path", { d: "M0 -11 L5 4 L0 1 L-5 4 Z", class: "north-arrow" }, north);
  el("text", { x: 0, y: 16, class: "north-n" }, north).textContent = "N";
  const scale = el("g", { class: "scale", "aria-hidden": "true" }, furnG);
  const scaleBar = el("rect", { x: 0, y: 0, height: 4, class: "scale-bar" }, scale);
  const scaleText = el("text", { x: 0, y: -4, class: "scale-text" }, scale);

  // ---- view state, pan / zoom ----
  let view = { x: 0, y: 0, s: 1 };
  let highlighted = new Set();
  const pointers = new Map();
  let pinch = null;
  let moved = false;
  let raf = 0;

  function placeLabels() {
    const w = svg.clientWidth || 360;
    const h = svg.clientHeight || 360;
    const boxes = [];
    const fits = (b) => b.x2 > 0 && b.x1 < w && b.y2 > 0 && b.y1 < h;
    const overlaps = (b) => boxes.some((o) => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
    // Stations one walk away from a highlighted station rank just below it.
    const partners = new Set(net.transfers.flatMap((t) => (highlighted.has(t.a) ? [t.b] : highlighted.has(t.b) ? [t.a] : [])));
    const all = [
      ...[...stationEls.entries()].map(([id, { label }]) => ({
        label, station: true, prio: highlighted.has(id) ? 0 : partners.has(id) && view.s > 3 ? 0.1 : label._prio,
      })),
      ...xferLabels.map((label) => ({ label, prio: label._ends.some((id) => highlighted.has(id)) && view.s > 3 ? 0.2 : view.s > 5 ? 1 : 9 })),
      ...landLabels.map((label) => ({ label, prio: view.s >= (label._minZoom || 0) ? label._prio : 9 })),
      ...roadLabels.map((label) => ({ label, prio: view.s >= label._minZoom ? label._prio : 9 })),
      ...badges.map((b) => ({
        label: b, badge: true,
        prio: b.place === selectedPlace ? 0 : b.rank <= 10 || b.pinned ? 0.4 : b.rank <= 30 ? 1.6 : 2.6,
      })),
    ].sort((a, b) => a.prio - b.prio);
    const maxPrio = view.s > 14 ? 4 : view.s > 6 ? 3 : view.s > 3 ? 2 : 0.5;
    for (const { label, prio, station, badge } of all) {
      const x = label._p.x * view.s + view.x;
      const y = label._p.y * view.s + view.y;
      if (badge) {
        const b = { x1: x - 14, x2: x + 17, y1: y - 18, y2: y + 14 };
        const show = prio <= maxPrio && fits(b) && !overlaps(b);
        label.g.style.display = show ? "" : "none";
        if (show) {
          label.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
          label.g.classList.toggle("sel", label.place === selectedPlace);
          boxes.push(b);
        }
        continue;
      }
      const width = label.textContent.length * (station ? 6.2 : 5.6) + 4;
      // Candidate placements: stations right, left, above, below; others centred.
      const cands = station
        ? [
          { tx: x + 7, ty: y + 4, anchor: "start", b: { x1: x + 5, x2: x + 7 + width, y1: y - 6, y2: y + 7 } },
          { tx: x - 7, ty: y + 4, anchor: "end", b: { x1: x - 7 - width, x2: x - 5, y1: y - 6, y2: y + 7 } },
          { tx: x, ty: y - 9, anchor: "middle", b: { x1: x - width / 2, x2: x + width / 2, y1: y - 19, y2: y - 6 } },
          { tx: x, ty: y + 17, anchor: "middle", b: { x1: x - width / 2, x2: x + width / 2, y1: y + 6, y2: y + 19 } },
        ]
        : (label._xfer
          ? [[0, -7], [0, 13], [-width / 2 - 6, 3], [width / 2 + 6, 3], [-width / 2, -12], [width / 2, 18]]
          : [[0, 3]]).map(([ox, oy]) => (
          { tx: x + ox, ty: y + oy, anchor: "middle", b: { x1: x + ox - width / 2, x2: x + ox + width / 2, y1: y + oy - 9, y2: y + oy + 3 } }));
      let placed = null;
      if (prio <= maxPrio) placed = cands.find((c) => fits(c.b) && !overlaps(c.b));
      label.style.display = placed ? "inline" : "none";
      if (!placed) continue;
      label.setAttribute("x", placed.tx.toFixed(1));
      label.setAttribute("y", placed.ty.toFixed(1));
      label.setAttribute("text-anchor", placed.anchor);
      boxes.push(placed.b);
    }
  }

  function placeFurniture() {
    const w = svg.clientWidth || 360;
    const h = svg.clientHeight || 360;
    north.setAttribute("transform", `translate(${w - 22} ${h - 46})`);
    // Pick a round distance that is 50–110 px long.
    const mPerPx = M_PER_UNIT / view.s;
    const nice = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000];
    const m = nice.find((d) => d / mPerPx >= 50) || 20000;
    scale.setAttribute("transform", `translate(12 ${h - 10})`);
    scaleBar.setAttribute("width", (m / mPerPx).toFixed(1));
    scaleText.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  }

  function apply() {
    root.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.s})`);
    svg.style.setProperty("--zoom", view.s);
    svg.dataset.detail = view.s > 9 ? "high" : view.s > 4.5 ? "mid" : "low";
    // The river is ~250–600 m wide in central Bangkok: draw it near that width
    // when zoomed in, as a thin line when zoomed out.
    svg.style.setProperty("--river-px", `${Math.min(Math.max(300 / M_PER_UNIT * view.s, 3), 40)}px`);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { placeLabels(); placeFurniture(); placeTrains(); });
  }

  function fit(b = bounds, pad = 20) {
    const w = svg.clientWidth || 360;
    const h = svg.clientHeight || 360;
    const s = Math.min((w - pad * 2) / (b.maxX - b.minX || 1), (h - pad * 2) / (b.maxY - b.minY || 1));
    view.s = Math.min(Math.max(s, 0.5), 80);
    view.x = w / 2 - ((b.minX + b.maxX) / 2) * view.s;
    view.y = h / 2 - ((b.minY + b.maxY) / 2) * view.s;
    apply();
  }

  function zoomAt(factor, cx, cy) {
    const ns = Math.min(Math.max(view.s * factor, 0.5), 120);
    const f = ns / view.s;
    view.x = cx - (cx - view.x) * f;
    view.y = cy - (cy - view.y) * f;
    view.s = ns;
    apply();
  }

  const local = (e) => {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, local(e));
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const cur = local(e);
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.d = d;
      moved = true;
    } else if (pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      svg.setPointerCapture?.(e.pointerId);
      view.x += dx;
      view.y += dy;
      apply();
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  // Swallow the click that ends a drag so it doesn't open a station.
  svg.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); moved = false; } }, true);
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(Math.exp(-e.deltaY * 0.002), p.x, p.y);
  }, { passive: false });

  // ---- dynamic layers ----
  function setMe(pos) {
    meG.replaceChildren();
    if (!pos) return;
    const p = project(pos.lat, pos.lon);
    const accUnits = (pos.accuracy || 0) / M_PER_UNIT;
    if (accUnits > 0) el("circle", { cx: p.x, cy: p.y, r: accUnits, class: "acc" }, meG);
    el("circle", { cx: p.x, cy: p.y, r: 3.2, class: "dot" }, meG);
  }

  // Mini trains: a car body in the line colour with a rounded nose and a dark
  // windscreen at the front, rotated to the direction of travel. Trains that
  // are standing at a platform show passengers getting on and off.
  const trainEls = new Map(); // id -> { g, p, angle }
  function makeTrain(t) {
    const color = model.lines.get(t.lineId).color;
    const g = el("g", { class: `train ${t.kind}` }, trainsG);
    // Passengers walking between the platform (below) and the doors.
    const pax = el("g", { class: "pax", "aria-hidden": "true" }, g);
    for (const [x, dir, delay] of [[-13, "up", 0], [-8, "down", 0.35], [-3, "up", 0.7], [4, "down", 1.05], [9, "up", 0.5]]) {
      el("circle", { cx: x, cy: 4, r: 1.4, class: `p ${dir}`, style: `animation-delay:${delay}s` }, pax);
    }
    // Zoomed out: just a small dot in the line colour.
    el("circle", { r: 3.2, fill: color, class: "mini" }, g);
    // Side view, pointing +x: rear car, gangway, leading car with a rounded nose.
    const body = el("g", { class: "body" }, g);
    el("rect", { x: -17, y: -6, width: 15, height: 11, rx: 3, class: "shell" }, body);
    el("rect", { x: -2.4, y: -3, width: 1.6, height: 6, class: "gangway" }, body);
    el("path", { d: "M1 -6 H10 Q16.6 -6 17 0 L17 3.4 Q17 5 15.4 5 H1 Q-1 5 -1 3 V-4 Q-1 -6 1 -6 Z", class: "shell" }, body);
    // Line-colour stripe along both cars (BTS trains also get their dark band).
    el("path", { d: "M-17 1.2 H-2 V3.4 H-17 Z M-1 1.2 H17 V3.4 H-1 Z", fill: color, class: "stripe" }, body);
    if (t.lineId.startsWith("BTS-")) el("path", { d: "M-17 0.2 H-2 V0.9 H-17 Z M-1 0.2 H17 V0.9 H-1 Z", class: "band" }, body);
    for (const x of [-15.3, -10.9, -6.5, 1, 5.2]) el("rect", { x, y: -4.3, width: 3.3, height: 3.1, rx: 0.9, class: "window" }, body);
    el("path", { d: "M10.6 -5.2 Q15.9 -5.1 16.5 -0.4 H10.6 Z", class: "windscreen" }, body);
    el("path", { d: "M11.6 -4.3 Q13.6 -4.2 14.4 -2.6", class: "shine" }, body);
    el("circle", { cx: 15.6, cy: 4.1, r: 0.95, class: "headlight" }, body);
    for (const x of [-14, -5.2, 2.4, 12.6]) el("circle", { cx: x, cy: 5.6, r: 1.7, class: "wheel" }, body);
    return g;
  }
  function setTrains(trains) {
    const seen = new Set();
    trains.forEach((t, i) => {
      const id = t.id || `${t.kind}|${t.lineId}|${i}`;
      seen.add(id);
      let rec = trainEls.get(id);
      if (!rec || !rec.g.isConnected || !rec.g.classList.contains(t.kind)) {
        rec?.g.remove();
        rec = { g: makeTrain(t) };
        trainEls.set(id, rec);
      }
      rec.p = project(t.lat, t.lon);
      const a = t.ahead ? project(t.ahead.lat, t.ahead.lon) : null;
      if (a && (a.x !== rec.p.x || a.y !== rec.p.y)) rec.angle = (Math.atan2(a.y - rec.p.y, a.x - rec.p.x) * 180) / Math.PI;
      rec.g.classList.toggle("dwell", Boolean(t.dwell));
    });
    for (const [id, rec] of trainEls) if (!seen.has(id)) { rec.g.remove(); trainEls.delete(id); }
    placeTrains();
  }
  function placeTrains() {
    const w = svg.clientWidth || 360;
    const h = svg.clientHeight || 360;
    const k = Math.min(Math.max(0.45 + view.s / 26, 0.5), 1.35);
    for (const rec of trainEls.values()) {
      const x = rec.p.x * view.s + view.x;
      const y = rec.p.y * view.s + view.y;
      const off = x < -20 || y < -20 || x > w + 20 || y > h + 20;
      rec.g.style.display = off ? "none" : "";
      // Heading left: mirror instead of turning the train upside down.
      const a = rec.angle || 0;
      const flip = Math.abs(((a + 540) % 360) - 180) > 90 ? -1 : 1;
      if (!off) rec.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(1)}) scale(${k.toFixed(2)} ${(flip * k).toFixed(2)})`);
    }
  }

  function selectPlace(id) {
    selectedPlace = id;
    apply();
  }

  function highlight(ids) {
    highlighted = new Set(ids);
    for (const [id, { g, label }] of stationEls) {
      g.classList.toggle("hl", highlighted.has(id));
      label.classList.toggle("hl", highlighted.has(id));
    }
    apply();
  }

  function focusOn(points, minSpanM = 2000) {
    focusedEarly = true;
    const ps = points.map((p) => project(p.lat, p.lon));
    const b = {
      minX: Math.min(...ps.map((p) => p.x)), maxX: Math.max(...ps.map((p) => p.x)),
      minY: Math.min(...ps.map((p) => p.y)), maxY: Math.max(...ps.map((p) => p.y)),
    };
    const span = minSpanM / M_PER_UNIT;
    for (const [lo, hi] of [["minX", "maxX"], ["minY", "maxY"]]) {
      const grow = Math.max(0, span - (b[hi] - b[lo])) / 2;
      b[lo] -= grow;
      b[hi] += grow;
    }
    fit(b, 30);
  }

  // Initial overview, unless a station was focused before the first frame.
  let focusedEarly = false;
  requestAnimationFrame(() => { if (!focusedEarly) fit(); });
  window.addEventListener("resize", () => apply());

  return {
    setMe, setTrains, highlight, focusOn, selectPlace,
    // Is this point on screen now (give or take a margin in pixels)?
    inView: (p, margin = 40) => {
      if (p?.lat == null) return false;
      const q = project(p.lat, p.lon);
      const x = q.x * view.s + view.x;
      const y = q.y * view.s + view.y;
      return x > -margin && y > -margin && x < (svg.clientWidth || 360) + margin && y < (svg.clientHeight || 360) + margin;
    },
    fitAll: () => fit(),
    zoomIn: () => zoomAt(1.5, svg.clientWidth / 2, svg.clientHeight / 2),
    zoomOut: () => zoomAt(1 / 1.5, svg.clientWidth / 2, svg.clientHeight / 2),
  };
}
