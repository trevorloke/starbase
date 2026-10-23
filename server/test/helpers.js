// Test helpers: a fresh in-memory PGlite per test file, plus tiny HTTP
// wrappers over app.request() that carry the session cookie.
import { _resetDbForTest, getDb } from '../db/client.js';
import { app } from '../index.js';

export const freshDb = async () => {
  _resetDbForTest();
  return getDb();
};

export class Client {
  constructor() { this.cookie = ''; }

  async req(method, path, body) {
    const res = await app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  }

  get(path) { return this.req('GET', path); }
  post(path, body) { return this.req('POST', path, body); }

  async signup(overrides = {}) {
    return this.post('/api/auth/signup', {
      name: 'Avery Chen',
      email: `avery+${Math.random().toString(36).slice(2, 8)}@example.org`,
      password: 'northshore2026',
      workspaceName: 'North Shore 2026',
      jurisdiction: 'bc-provincial',
      ...overrides,
    });
  }

  async action(name, input) {
    return this.post(`/api/actions/${name}`, input);
  }

  async createPerson(name, extra = {}) {
    const r = await this.action('person.create', { name, ...extra });
    return r.json.person;
  }
}
