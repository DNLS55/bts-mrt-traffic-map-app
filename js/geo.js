// Distance and walking estimates. Everything here runs on the device; the
// user's position is never sent anywhere.

const EARTH_RADIUS_M = 6371000;

// Walking assumptions, shown to the user next to every estimate.
export const WALK = {
  speedMPerMin: 80, // ~4.8 km/h
  detourFactor: 1.3, // straight line -> street distance
  platformMin: 3, // street entrance -> platform (stairs, fare gates)
};

export function distanceM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function walkMinutes(meters) {
  return Math.max(1, Math.round((meters * WALK.detourFactor) / WALK.speedMPerMin));
}

export function nearestStations(position, stations, limit = 5) {
  return stations
    .filter((s) => s.lat != null)
    .map((s) => {
      const meters = distanceM(position, s);
      return { station: s, meters, walkMin: walkMinutes(meters) };
    })
    .sort((a, b) => a.meters - b.meters)
    .slice(0, limit);
}

export function formatDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

// Does the straight path a -> b cross any of these polylines ([[lat, lon], ...])?
// Used to avoid suggesting a station on the other side of the river.
export function crosses(a, b, lines) {
  const ccw = (p, q, r) => (r[0] - p[0]) * (q[1] - p[1]) - (q[0] - p[0]) * (r[1] - p[1]);
  const A = [a.lat, a.lon];
  const B = [b.lat, b.lon];
  const lo = [Math.min(A[0], B[0]), Math.min(A[1], B[1])];
  const hi = [Math.max(A[0], B[0]), Math.max(A[1], B[1])];
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const P = line[i - 1];
      const Q = line[i];
      if (Math.max(P[0], Q[0]) < lo[0] || Math.min(P[0], Q[0]) > hi[0] || Math.max(P[1], Q[1]) < lo[1] || Math.min(P[1], Q[1]) > hi[1]) continue;
      if (ccw(A, B, P) * ccw(A, B, Q) < 0 && ccw(P, Q, A) * ccw(P, Q, B) < 0) return true;
    }
  }
  return false;
}
