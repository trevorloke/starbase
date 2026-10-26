// lib/geocode.js: the Google provider and the fallback chain, with fetch mocked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { geocodeAddress } from '../lib/geocode.js';

const realFetch = globalThis.fetch;
const env = { ...process.env };
const calls = [];
let googleBody = null;
let bcBody = null;

before(() => {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.hostname === 'maps.googleapis.com') return new Response(JSON.stringify(googleBody), { status: 200 });
    if (u.hostname === 'geocoder.api.gov.bc.ca') return new Response(JSON.stringify(bcBody), { status: 200 });
    return realFetch(url);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['GEOCODER', 'GEOCODER_FALLBACK', 'GOOGLE_MAPS_SERVER_KEY']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

const rooftop = (lat, lng, formatted, types = ['street_address']) => ({
  status: 'OK', results: [{ geometry: { location: { lat, lng }, location_type: 'ROOFTOP' }, types, formatted_address: formatted }],
});

test('google: asks with the key, biased to Surrey and limited to BC; a rooftop match is a door', async () => {
  process.env.GEOCODER = 'google';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'server-key';
  delete process.env.GEOCODER_FALLBACK;
  googleBody = rooftop(49.1906, -122.8466, '13450 104 Ave, Surrey, BC V3T 1V3, Canada');
  calls.length = 0;
  const r = await geocodeAddress({ address: '13450 104 Ave' });
  assert.deepEqual({ lat: r.lat, lng: r.lng }, { lat: 49.1906, lng: -122.8466 });
  const u = calls[0];
  assert.equal(u.searchParams.get('key'), 'server-key');
  assert.equal(u.searchParams.get('address'), '13450 104 Ave, Surrey, BC');
  assert.equal(u.searchParams.get('components'), 'country:CA|administrative_area:BC');
  assert.match(u.searchParams.get('bounds'), /^49\.002,-122\.92\|49\.222,-122\.67$/);
});

test('google: a city-level or approximate answer is too vague; no results is no match; quota reads as busy; no key is an error', async () => {
  process.env.GEOCODER = 'google';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'server-key';
  googleBody = { status: 'OK', results: [{ geometry: { location: { lat: 49.1, lng: -122.8 }, location_type: 'APPROXIMATE' }, types: ['locality', 'political'], formatted_address: 'Surrey, BC, Canada' }] };
  const vague = await geocodeAddress({ address: 'Somewhere Rd' });
  assert.equal(vague.weak, true);
  assert.equal(vague.matched, 'Surrey, BC, Canada');
  googleBody = { status: 'ZERO_RESULTS', results: [] };
  assert.equal(await geocodeAddress({ address: '1 Nowhere St' }), null);
  googleBody = { status: 'OVER_QUERY_LIMIT', results: [] };
  assert.match((await geocodeAddress({ address: '1 Busy St' })).error, /429|too many/);
  googleBody = { status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.', results: [] };
  assert.match((await geocodeAddress({ address: '1 Denied St' })).error, /REQUEST_DENIED.*invalid/);
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  assert.match((await geocodeAddress({ address: '1 Keyless St' })).error, /GOOGLE_MAPS_SERVER_KEY/);
});

test('fallback: Google is asked only for what the BC geocoder cannot place; a BC error stays an error', async () => {
  process.env.GEOCODER = 'bc';
  process.env.GEOCODER_FALLBACK = 'google';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'server-key';
  googleBody = rooftop(49.17, -122.84, '9999 King George Blvd, Surrey, BC, Canada');
  // BC finds it: Google is not asked.
  bcBody = { features: [{ geometry: { coordinates: [-122.8466, 49.1906] }, properties: { score: 98, matchPrecision: 'CIVIC_NUMBER', fullAddress: '13450 104 Ave, Surrey, BC' } }] };
  calls.length = 0;
  assert.equal((await geocodeAddress({ address: '13450 104 Ave' })).lat, 49.1906);
  assert.ok(calls.every((u) => u.hostname === 'geocoder.api.gov.bc.ca'));
  // BC only gets to the locality: Google's rooftop answer wins.
  bcBody = { features: [{ geometry: { coordinates: [-122.8, 49.1] }, properties: { score: 40, matchPrecision: 'LOCALITY', fullAddress: 'Surrey, BC' } }] };
  calls.length = 0;
  const r = await geocodeAddress({ address: '9999 King George Blvd' });
  assert.equal(r.lat, 49.17);
  assert.ok(calls.some((u) => u.hostname === 'maps.googleapis.com'));
  // BC finds nothing and neither does Google: no match, not vague.
  bcBody = { features: [] };
  googleBody = { status: 'ZERO_RESULTS', results: [] };
  assert.equal(await geocodeAddress({ address: '1 Nowhere St' }), null);
  // Google is down: the BC answer (too vague) stands and nobody is set aside as failed.
  bcBody = { features: [{ geometry: { coordinates: [-122.8, 49.1] }, properties: { score: 40, matchPrecision: 'LOCALITY', fullAddress: 'Surrey, BC' } }] };
  googleBody = { status: 'UNKNOWN_ERROR', results: [] };
  assert.equal((await geocodeAddress({ address: '2 Vague Rd' })).weak, true);
  // BC is down: that is an error, Google is not asked (the run backs off instead).
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.hostname === 'geocoder.api.gov.bc.ca') return new Response('busy', { status: 503 });
    return new Response(JSON.stringify(googleBody), { status: 200 });
  };
  calls.length = 0;
  assert.match((await geocodeAddress({ address: '3 Down St' })).error, /503/);
  assert.ok(calls.every((u) => u.hostname === 'geocoder.api.gov.bc.ca'));
});
