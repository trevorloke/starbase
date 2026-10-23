// Address geocoding. Default provider is the BC Address Geocoder (the BC
// government's free service, built for BC civic addresses); Nominatim (OSM)
// is the fallback. Plain fetch, no SDKs.
//   GEOCODER=bc (default) | nominatim | off
//   BC_GEOCODER_KEY   optional api key for higher BC rate limits
//   BC_GEOCODER_URL   base URL (default the official service; set for a self-hosted mirror)
//   GEOCODE_MIN_SCORE minimum BC match score to accept (default 75)

const DEFAULT_CITY = 'Surrey';

const formatAddress = ({ address, unit, city, postal }) => {
  const street = [unit ? `${unit} -` : null, address].filter(Boolean).join(' ');
  return [street, city || DEFAULT_CITY, 'BC', postal].filter(Boolean).join(', ');
};

const bc = async (q) => {
  const base = (process.env.BC_GEOCODER_URL || 'https://geocoder.api.gov.bc.ca').replace(/\/$/, '');
  const url = new URL(`${base}/addresses.json`);
  url.searchParams.set('addressString', q);
  url.searchParams.set('maxResults', '1');
  url.searchParams.set('outputSRS', '4326');
  url.searchParams.set('locationDescriptor', 'accessPoint');
  const headers = process.env.BC_GEOCODER_KEY ? { apikey: process.env.BC_GEOCODER_KEY } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) return { error: `geocoder ${res.status}` };
  const body = await res.json();
  const f = body?.features?.[0];
  if (!f) return null;
  const score = Number(f.properties?.score ?? 0);
  const min = Number(process.env.GEOCODE_MIN_SCORE) || 75;
  // Precision CIVIC_NUMBER/BLOCK is a real door; LOCALITY means "somewhere in Surrey".
  const precise = ['CIVIC_NUMBER', 'BLOCK'].includes(f.properties?.matchPrecision);
  if (score < min || !precise) return { weak: true, score, matched: f.properties?.fullAddress };
  const [lng, lat] = f.geometry.coordinates;
  return { lat, lng, score, matched: f.properties?.fullAddress };
};

const nominatim = async (q) => {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q);
  url.searchParams.set('countrycodes', 'ca');
  url.searchParams.set('limit', '1');
  const res = await fetch(url, { headers: { 'User-Agent': 'Starbase campaign OS (geocoding voter addresses)' } });
  if (!res.ok) return { error: `geocoder ${res.status}` };
  const [hit] = await res.json();
  if (!hit) return null;
  if (!['house', 'building', 'residential'].includes(hit.addresstype) && hit.type !== 'house') {
    return { weak: true, matched: hit.display_name };
  }
  return { lat: Number(hit.lat), lng: Number(hit.lon), score: null, matched: hit.display_name };
};

// → { lat, lng, score, matched } | { weak, matched } | { error } | null (no match)
export const geocodeAddress = async (parts) => {
  const provider = (process.env.GEOCODER || 'bc').toLowerCase();
  if (provider === 'off') return { error: 'geocoding is turned off (GEOCODER=off)' };
  if (!parts?.address) return null;
  const q = formatAddress(parts);
  try {
    return provider === 'nominatim' ? await nominatim(q) : await bc(q);
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  }
};
