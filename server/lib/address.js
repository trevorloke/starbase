// A civic address in two parts: the house number and the street.
//
//   civic({ house_number, address })  → { house_number, address }
//     "13450" + "104 Ave"        → "13450", "13450 104 Ave"
//     "" + "13450 104 Ave"       → "13450", "13450 104 Ave"   (the number is read off the front)
//     "" + "104 Ave"             → null,    "104 Ave"         (a numbered street is not a house)
//     "13450" + "13450 104 Ave"  → "13450", "13450 104 Ave"   (not doubled)
//   streetOf(house_number, address) → the street alone ("104 Ave")
//
// persons.address stays the whole civic line — everything that reads,
// geocodes, matches or shows an address is unchanged — and house_number is
// the number on its own, for the door card and the lists.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const HOUSE_RE = /^(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?)\s+(.+)$/;
// Street types that may follow a street's own number ("104 Ave", "132 St").
const STREET_TYPES = new Set(['ave', 'avenue', 'st', 'street', 'blvd', 'boulevard', 'rd', 'road', 'dr', 'drive', 'cres', 'crescent',
  'pl', 'place', 'way', 'lane', 'ln', 'crt', 'court', 'ct', 'hwy', 'highway', 'pkwy', 'parkway', 'cir', 'circle', 'terr', 'terrace',
  'close', 'gate', 'mews', 'row', 'trail', 'diversion', 'div', 'connector', 'loop', 'link', 'grove', 'green', 'bay', 'cove', 'rise',
  'ridge', 'hill', 'park', 'square', 'sq', 'walk', 'wynd', 'pt', 'point', 'pathway', 'path', 'alley', 'byway']);
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const startsWithHouse = (addr, house) => addr.toLowerCase().startsWith(`${house.toLowerCase()} `);

// Does this line begin with a house number (not a numbered street's own number)?
const houseOf = (addr) => {
  const m = HOUSE_RE.exec(addr);
  if (!m) return null;
  const rest = m[2].toLowerCase().replace(/[.,]/g, '').split(' ').filter((w) => !DIRECTIONS.has(w));
  // "104 Ave": the number plus a bare street type is the street itself.
  if (rest.length === 1 && STREET_TYPES.has(rest[0])) return null;
  return m[1];
};

export const civic = ({ house_number, address } = {}) => {
  let house = norm(house_number).replace(/\.0$/, '');
  let addr = norm(address);
  if (house && addr && !startsWithHouse(addr, house)) addr = `${house} ${addr}`;
  if (!house && addr) house = houseOf(addr) || '';
  return { house_number: house || null, address: addr || null };
};

export const streetOf = (house_number, address) => {
  const addr = norm(address); const house = norm(house_number);
  return house && startsWithHouse(addr, house) ? addr.slice(house.length + 1) : addr;
};
