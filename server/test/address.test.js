// The house number apart from the street (lib/address.js): read off a whole
// line, joined when given apart, never doubled, and a numbered street is not
// a house. On a person: create, update, the map's doors, the import.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { civic, streetOf } from '../lib/address.js';

let mgr;
before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'addr.mgr@example.org', jurisdiction: 'bc-municipal' });
});

test('civic(): the two parts settle from either side', () => {
  assert.deepEqual(civic({ house_number: '13450', address: '104 Ave' }), { house_number: '13450', address: '13450 104 Ave' });
  assert.deepEqual(civic({ address: '13450 104 Ave' }), { house_number: '13450', address: '13450 104 Ave' });
  assert.deepEqual(civic({ house_number: '13450', address: '13450 104 Ave' }), { house_number: '13450', address: '13450 104 Ave' }, 'not doubled');
  assert.deepEqual(civic({ address: '104 Ave' }), { house_number: null, address: '104 Ave' }, 'a numbered street is not a house');
  assert.deepEqual(civic({ address: '132 St' }), { house_number: null, address: '132 St' });
  assert.deepEqual(civic({ address: '10200 King George Blvd' }), { house_number: '10200', address: '10200 King George Blvd' });
  assert.deepEqual(civic({ house_number: '12A', address: '72 Ave' }), { house_number: '12A', address: '12A 72 Ave' });
  assert.deepEqual(civic({ house_number: '13450.0', address: '104 Ave' }), { house_number: '13450', address: '13450 104 Ave' }, 'a spreadsheet’s .0');
  assert.deepEqual(civic({}), { house_number: null, address: null });
  assert.equal(streetOf('13450', '13450 104 Ave'), '104 Ave');
  assert.equal(streetOf(null, '104 Ave'), '104 Ave');
});

test('a person: created with the parts or the line, edited either way, read everywhere', async () => {
  const a = (await mgr.action('person.create', { name: 'Parts Person', house_number: '13450', address: '104 Ave', city: 'Surrey' })).json.person;
  assert.equal(a.address, '13450 104 Ave'); assert.equal(a.house_number, '13450');
  const b = (await mgr.action('person.create', { name: 'Line Person', address: '7580 132 St' })).json.person;
  assert.equal(b.house_number, '7580', 'read off the line');
  const c = (await mgr.action('person.create', { name: 'Street Only', address: '104 Ave' })).json.person;
  assert.equal(c.house_number, null);
  const got = (await mgr.get(`/api/persons/${a.id}`)).json.person;
  assert.equal(got.house_number, '13450');
  assert.equal((await mgr.get('/api/persons?q=Parts')).json.persons[0].house_number, '13450');
  // A new house number on the same street; a new street with its own number.
  const moved = (await mgr.action('person.update', { id: a.id, house_number: '13460' })).json.person;
  assert.equal(moved.address, '13460 104 Ave', 'the line follows the number');
  assert.equal(moved.lat, null, 'a changed address drops the pin');
  const street = (await mgr.action('person.update', { id: a.id, address: '10200 King George Blvd' })).json.person;
  assert.deepEqual([street.house_number, street.address], ['10200', '10200 King George Blvd'], 'a new line brings its own number');
  const cleared = (await mgr.action('person.update', { id: a.id, house_number: null, address: '132 St' })).json.person;
  assert.deepEqual([cleared.house_number, cleared.address], [null, '132 St']);
  // The import keeps the parts too.
  const imp = await mgr.post('/api/data/import', { rows: [{ name: 'Imported Parts', house_number: 9, address: '72 Ave' }, { name: 'Imported Line', address: '8 72 Ave' }] });
  assert.equal(imp.json.created, 2, JSON.stringify(imp.json));
  const ip = (await mgr.get('/api/persons?q=Imported%20Parts')).json.persons[0];
  assert.deepEqual([ip.house_number, ip.address], ['9', '9 72 Ave']);
  assert.equal((await mgr.get('/api/persons?q=Imported%20Line')).json.persons[0].house_number, '8');
});
