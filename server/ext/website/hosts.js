// Which hosts are the public website's own domain.
//   STARBASE_SITE_HOSTS=imaginesurrey.ca,www.imaginesurrey.ca
// A request to one of them gets the site at / (server/index.js); every other
// host (the staff app's, e.g. starbase.imaginesurrey.ca) has it at /site.
// Read on each request so a test (or a restart with new settings) applies it.
export const siteHosts = () => String(process.env.STARBASE_SITE_HOSTS || '')
  .split(',').map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);

// The request's host, without a port. Behind Render's proxy the Host header
// is the visitor's own (imaginesurrey.ca).
export const hostOf = (c) => {
  const raw = c.req.header('x-forwarded-host') || c.req.header('host') || new URL(c.req.url).host;
  return String(raw).split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
};

export const onSiteHost = (c) => {
  const hosts = siteHosts();
  return hosts.length > 0 && hosts.includes(hostOf(c));
};

// The visitor-facing origin (for canonical links, Open Graph, Stripe return
// links): https behind a TLS proxy, the request's own scheme otherwise.
export const originOf = (c) => {
  const url = new URL(c.req.url);
  const proto = (c.req.header('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || url.host;
  return `${proto}://${String(host).split(',')[0].trim()}`;
};
