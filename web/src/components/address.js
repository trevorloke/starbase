// A civic address in two parts on screen: the house number and the street.
// The server keeps address as the whole line ("13450 104 Ave") and
// house_number on its own; forms show and send the two apart.
export const streetOf = (p) => {
  const addr = String(p?.address || '').trim();
  const house = String(p?.house_number || '').trim();
  return house && addr.toLowerCase().startsWith(`${house.toLowerCase()} `) ? addr.slice(house.length + 1) : addr;
};
