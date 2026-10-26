// What this process serves (STARBASE_SERVE), so the public website can run
// as its own service, apart from the field app, on the same database:
//
//   all   (default) the field app, the public forms and the website, in one
//   app   the field app and the public forms; no website pages, no website admin
//   site  the website at / on every host, its admin at /website-admin, the
//         public forms and the Stripe webhook; of the API only what the
//         website's admin needs — never the campaign's people, money or lists
//
// Read on each request (cheap), so tests can switch it.
export const serveMode = () => (['app', 'site'].includes(process.env.STARBASE_SERVE) ? process.env.STARBASE_SERVE : 'all');

// In site mode, the part of /api the website admin uses and nothing else.
const SITE_API = [
  /^\/api\/health$/, /^\/api\/auth(\/|$)/, /^\/api\/public(\/|$)/,
  /^\/api\/site(\/|$)/, /^\/api\/store(\/|$)/, /^\/api\/campaign-events(\/|$)/,
  /^\/api\/actions\/(site|store|cevent)\./,
];
export const siteApiAllows = (path) => SITE_API.some((re) => re.test(path));

// Where the website's admin is, for the field app's account menu: on this
// service, or on the site's own host when the site runs apart.
export const siteAdminUrl = () => {
  const mode = serveMode();
  if (mode !== 'app') return '/website-admin';
  const host = (process.env.STARBASE_SITE_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return host ? `https://${host}/website-admin` : null;
};
