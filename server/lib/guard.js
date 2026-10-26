// Small guards for what faces the open internet: who a request is from,
// how often one address may do something, and whether a cookie-carrying
// write really came from the app.
//
// clientIp(c)  The address a request came from, as the proxy in front saw
//   it. Proxies append the address they saw to X-Forwarded-For, so the
//   trustworthy entry is the one STARBASE_TRUSTED_PROXIES hops from the
//   right (default 1: one proxy, e.g. Render); anything further left was
//   written by whoever sent the request and is ignored. With no proxy
//   header, X-Real-IP, else 'local'.
// makeLimiter({ windowMs, max })  → limited(key): true once `key` has done
//   more than `max` things in the window. Old entries are swept, and the
//   table never grows past LIMITER_MAX keys (each spoofed address would
//   otherwise be one more entry forever).
// crossSiteWrite(c)  A state-changing request that can't be the app's own
//   fetch: the browser says it came from another site, or the body isn't
//   JSON (a plain <form> can post text/plain or form data with the cookie
//   attached; the app never does). → the refusal to send, or null.
const LIMITER_MAX = 20_000;

export const clientIp = (c) => {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const hops = Math.max(1, Number(process.env.STARBASE_TRUSTED_PROXIES) || 1);
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const ip = parts[Math.max(0, parts.length - hops)];
    if (ip) return ip.slice(0, 64);
  }
  return c.req.header('x-real-ip')?.slice(0, 64) || 'local';
};

export const makeLimiter = ({ windowMs, max }) => {
  const hits = new Map();
  let sweptAt = Date.now();
  const sweep = (now) => {
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
    sweptAt = now;
  };
  const limited = (key) => {
    const now = Date.now();
    if (now - sweptAt > windowMs || hits.size > LIMITER_MAX) sweep(now);
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length > max;
  };
  // How many `key` has done in the window, without counting one more.
  limited.count = (key) => { const now = Date.now(); return (hits.get(key) || []).filter((t) => now - t < windowMs).length; };
  limited.clear = (key) => hits.delete(key);
  limited._size = () => hits.size;
  return limited;
};

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const crossSiteWrite = (c) => {
  if (SAFE.has(c.req.method)) return null;
  const site = c.req.header('sec-fetch-site');
  // same-site is another host under the same domain (the public website,
  // say): not the app, so not allowed to write with its cookie either.
  if (site && site !== 'same-origin' && site !== 'none') return 'requests from other sites are refused';
  const type = c.req.header('content-type');
  if (type && !/^application\/json\b/i.test(type)) return 'send JSON (Content-Type: application/json)';
  return null;
};
