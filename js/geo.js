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
