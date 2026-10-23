// Geometry for turfs and walk lists. Polygons are [[lat, lng], ...] rings.

// Ray-casting point-in-polygon on lat/lng (fine at neighbourhood scale).
export const pointInPolygon = (lat, lng, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const crosses = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
};

// Split "12345 72 Ave" → { number: 12345, street: '72 ave' }. Anything that
// doesn't start with a house number sorts after numbered addresses.
export const parseAddress = (address = '') => {
  const m = String(address).trim().match(/^(\d+)[A-Za-z]?\s+(.*)$/);
  if (!m) return { number: Infinity, street: String(address).trim().toLowerCase() };
  return { number: Number(m[1]), street: m[2].trim().toLowerCase() };
};

// Walk order: street by street; along each street, one side up (odd) then the
// other side back (even) — how canvassers actually work a block.
export const walkOrder = (doors) => {
  const byStreet = new Map();
  for (const d of doors) {
    const { number, street } = parseAddress(d.address);
    if (!byStreet.has(street)) byStreet.set(street, []);
    byStreet.get(street).push({ ...d, _n: number });
  }
  const streets = [...byStreet.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const out = [];
  for (const st of streets) {
    const list = byStreet.get(st);
    const odd = list.filter((d) => Number.isFinite(d._n) && d._n % 2 === 1).sort((a, b) => a._n - b._n);
    const even = list.filter((d) => Number.isFinite(d._n) && d._n % 2 === 0).sort((a, b) => b._n - a._n);
    const other = list.filter((d) => !Number.isFinite(d._n));
    for (const d of [...odd, ...even, ...other]) {
      const { _n, ...rest } = d;
      out.push(rest);
    }
  }
  return out;
};

// Group located persons into doors by address + unit.
export const groupDoors = (persons) => {
  const doors = new Map();
  for (const p of persons) {
    if (p.lat == null || p.lng == null) continue;
    const key = `${String(p.address || '').trim().toLowerCase()}|${String(p.unit || '').trim().toLowerCase()}|${p.address ? '' : p.id}`;
    if (!doors.has(key)) doors.set(key, { address: p.address, unit: p.unit, lat: p.lat, lng: p.lng, persons: [] });
    doors.get(key).persons.push(p);
  }
  return [...doors.values()];
};
