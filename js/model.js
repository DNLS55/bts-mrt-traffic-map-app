// Network model helpers built on the generated NETWORK data.

export function buildModel(network) {
  const stations = new Map(network.stations.map((s) => [s.id, s]));
  const lines = new Map(network.lines.map((l) => [l.id, l]));
  const adjacency = new Map(); // `${lineId}|${stationId}` -> [neighbourId]
  for (const line of network.lines) {
    for (const [a, b] of line.edges) {
      push(adjacency, `${line.id}|${a}`, b);
      push(adjacency, `${line.id}|${b}`, a);
    }
  }
  const transfers = new Map();
  for (const t of network.transfers) {
    push(transfers, t.a, { ...t, id: t.b });
    push(transfers, t.b, { ...t, id: t.a });
  }
  return { network, stations, lines, adjacency, transfers };
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

export function neighbours(model, lineId, stationId) {
  return model.adjacency.get(`${lineId}|${stationId}`) || [];
}

// Destination of a train going from station a to neighbouring station b.
export function towardsFor(model, lineId, a, b) {
  const line = model.lines.get(lineId);
  const ids = line.stations;
  if (line.kind === "loop-tail") {
    // Blue Line services (OpenStreetMap route relations, stop order checked):
    //   Lak Song → Tha Phra: BL38…BL33, BL01, BL32 … BL02, BL01 (loop, codes falling)
    //   Tha Phra → Lak Song: BL01, BL02 … BL32, BL01, BL33 … BL38 (codes rising)
    // Codes: BL01 Tha Phra, BL02-BL32 loop, BL33-BL38 tail.
    const n = (id) => Number(codeOn(model.stations.get(id), lineId).slice(2));
    const first = ids[0];
    const last = ids[ids.length - 1];
    const tail = (id) => n(id) >= 33;
    if (tail(a) && tail(b)) return n(b) > n(a) ? last : first;
    if (n(a) === 1) return n(b) === 32 ? first : last;
    if (n(b) === 1) return n(a) === 32 ? last : first;
    return n(b) > n(a) ? last : first;
  }
  return ids.indexOf(b) > ids.indexOf(a) ? ids[ids.length - 1] : ids[0];
}

// One entry per direction a train can leave this station on this line.
export function directionsAt(model, lineId, stationId) {
  const line = model.lines.get(lineId);
  return neighbours(model, lineId, stationId).map((next) => {
    const terminusId = towardsFor(model, lineId, stationId, next);
    const terminus = model.stations.get(terminusId);
    const nextStation = model.stations.get(next);
    const label = line.kind === "loop-tail" && terminusId === line.stations[0]
      ? `Towards ${terminus.name} (loop)`
      : `Towards ${terminus.name}`;
    return { key: `${lineId}|${stationId}>${next}`, lineId, next, nextName: nextStation.name, terminusId, label };
  });
}

export function codeOn(station, lineId) {
  return station.lines.find((l) => l.line === lineId)?.code;
}
