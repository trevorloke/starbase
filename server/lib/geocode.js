// Address geocoding. Default provider is the BC Address Geocoder (the BC
// government's free service, built for BC civic addresses). Google's
// Geocoding API and Nominatim (OSM) are the others. Plain fetch, no SDKs.
//   GEOCODER=bc (default) | google | nominatim | off
//   GEOCODER_FALLBACK=google|bc|nominatim   a second provider asked only for
//                     addresses the first can't place (no match or too vague)
//   BC_GEOCODER_KEY   optional api key for higher BC rate limits
//   BC_GEOCODER_URL   base URL (default the official service; set for a self-hosted mirror)
//   GEOCODE_MIN_SCORE minimum BC match score to accept (default 75)
//   GOOGLE_MAPS_SERVER_KEY  a Google Cloud key with the Geocoding API enabled
//                     (restrict it to that API and the server's IP — not the
//                     browser key). Lookups are biased to Surrey and only a
//                     rooftop or street-number match counts as a door.

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

// Surrey, BC: results are biased to this box and limited to Canada / BC.
const SURREY_BOUNDS = '49.002,-122.92|49.222,-122.67';
const google = async (q) => {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) return { error: 'GOOGLE_MAPS_SERVER_KEY is not set' };
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', q);
  url.searchParams.set('region', 'ca');
  url.searchParams.set('components', 'country:CA|administrative_area:BC');
  url.searchParams.set('bounds', SURREY_BOUNDS);
  url.searchParams.set('key', key);
  const res = await fetch(url);
  if (!res.ok) return { error: `geocoder ${res.status}` };
  const body = await res.json();
  if (body.status === 'ZERO_RESULTS') return null;
  // OVER_QUERY_LIMIT reads as "busy" to the background run, which then backs off.
  if (body.status === 'OVER_QUERY_LIMIT') return { error: 'geocoder 429 too many requests (Google quota)' };
  if (body.status !== 'OK') return { error: `geocoder ${body.status}${body.error_message ? `: ${String(body.error_message).slice(0, 120)}` : ''}` };
  const hit = body.results?.[0];
  if (!hit) return null;
  const loc = hit.geometry?.location;
  const precise = ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(hit.geometry?.location_type)
    && (hit.types || []).some((t) => ['street_address', 'premise', 'subpremise'].includes(t));
  if (!loc || !precise) return { weak: true, score: null, matched: hit.formatted_address };
  return { lat: loc.lat, lng: loc.lng, score: null, matched: hit.formatted_address };
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

const PROVIDERS = { bc, google, nominatim };

const ask = async (name, q) => {
  const fn = PROVIDERS[name] || bc;
  try {
    return await fn(q);
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  }
};

// → { lat, lng, score, matched } | { weak, matched } | { error } | null (no match)
// With GEOCODER_FALLBACK set, an address the first provider can't place (no
// match or too vague) goes to the second; an error from the first is an
// error (the service is down), not a reason to ask elsewhere.
export const geocodeAddress = async (parts) => {
  const provider = (process.env.GEOCODER || 'bc').toLowerCase();
  if (provider === 'off') return { error: 'geocoding is turned off (GEOCODER=off)' };
  if (!parts?.address) return null;
  const q = formatAddress(parts);
  const first = await ask(provider, q);
  const fallback = (process.env.GEOCODER_FALLBACK || '').toLowerCase();
  if (!fallback || fallback === provider || !PROVIDERS[fallback]) return first;
  if (first?.error || (first && !first.weak)) return first;
  const second = await ask(fallback, q);
  // A fallback that errors or finds nothing leaves the first answer standing.
  if (second?.error || second === null) return first;
  return second;
};
