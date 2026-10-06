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

export function createMap(container, model, { onStationTap }) {
  const net = model.network;
  const svg = el("svg", { class: "net-map", role: "img", "aria-label": "Map of BTS, MRT, Airport Rail Link and SRT Red Line stations" });
  container.appendChild(svg);
  const root = el("g", {}, svg);
  const landG = el("g", { class: "land" }, root);
  const linesG = el("g", { class: "lines" }, root);
  const xferG = el("g", { class: "xfers" }, root);
  const stationsG = el("g", { class: "stations" }, root);
  const meG = el("g", { class: "me" }, root);
  // Screen-space layers: trains, text and furniture keep their size at any zoom.
  const trainsG = el("g", { class: "trains" }, svg);
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

  const pts = net.stations.filter((s) => s.lat != null).map((s) => project(s.lat, s.lon));
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
    ].sort((a, b) => a.prio - b.prio);
    const maxPrio = view.s > 14 ? 4 : view.s > 6 ? 3 : view.s > 3 ? 2 : 0.5;
    for (const { label, prio, station } of all) {
      const x = label._p.x * view.s + view.x;
      const y = label._p.y * view.s + view.y;
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
    const pax = el("g", { class: "pax", "aria-hidden": "true" }, g);
    for (const [x, side, delay] of [[-16, -1, 0], [-11, 1, 0.35], [-4, -1, 0.7], [1, 1, 1.05], [-8, -1, 1.2]]) {
      el("circle", { cx: x, cy: 0, r: 1.3, class: `p ${side < 0 ? "up" : "down"}`, style: `animation-delay:${delay}s` }, pax);
    }
    // Rear car, then the leading car with the nose.
    el("rect", { x: -22, y: -3.4, width: 12, height: 6.8, rx: 2, fill: color, class: "car" }, g);
    el("rect", { x: -20.5, y: -1.3, width: 9, height: 2.6, rx: 1, class: "win" }, g);
    el("rect", { x: -9, y: -3.4, width: 15, height: 6.8, rx: 2.2, fill: color, class: "car" }, g);
    el("path", { d: "M5.5 -3.4 Q 11 -3.4 11 0 Q 11 3.4 5.5 3.4 Z", fill: color, class: "car" }, g);
    el("rect", { x: -7.2, y: -1.3, width: 10.5, height: 2.6, rx: 1, class: "win" }, g);
    el("path", { d: "M7 -2.4 Q 9.6 -2 9.6 0 Q 9.6 2 7 2.4 Z", class: "screen" }, g);
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
    const k = Math.min(Math.max(0.5 + view.s / 24, 0.55), 1.5);
    for (const rec of trainEls.values()) {
      const x = rec.p.x * view.s + view.x;
      const y = rec.p.y * view.s + view.y;
      const off = x < -20 || y < -20 || x > w + 20 || y > h + 20;
      rec.g.style.display = off ? "none" : "";
      if (!off) rec.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(rec.angle || 0).toFixed(1)}) scale(${k.toFixed(2)})`);
    }
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
    setMe, setTrains, highlight, focusOn,
    fitAll: () => fit(),
    zoomIn: () => zoomAt(1.5, svg.clientWidth / 2, svg.clientHeight / 2),
    zoomOut: () => zoomAt(1 / 1.5, svg.clientWidth / 2, svg.clientHeight / 2),
  };
}
