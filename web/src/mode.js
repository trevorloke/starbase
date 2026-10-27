// Two apps from one build, told apart by the address:
//   /           the field app — what a volunteer sees and uses (Today ·
//               Map · Calls · Shifts · ImagineU). Anyone may open it; a
//               manager or staffer gets the same screens a volunteer does.
//   /admin/…    the admin — the desk: everything, for managers, staff and
//               treasurers (and a volunteer given an area under Permissions).
// main.jsx picks the router's base from the address; links across the two
// are plain hrefs (a full load), inside each they are router links.
export const ADMIN_BASE = '/admin';
export const appMode = () => {
  if (typeof window === 'undefined') return 'field';
  const p = window.location.pathname;
  return p === ADMIN_BASE || p.startsWith(`${ADMIN_BASE}/`) ? 'admin' : 'field';
};
export const adminHref = (path = '/') => `${ADMIN_BASE}${path}`;
export const fieldHref = (path = '/') => path;
const DESK = ['manager', 'staff', 'treasurer'];
export const isDeskRole = (me) => DESK.includes(me?.role);
// Who may open the admin: a desk role, or a volunteer given an area.
export const mayAdmin = (me) => isDeskRole(me) || (Array.isArray(me?.areas) && me.areas.length > 0);
// Where someone lands after signing in, from either app.
export const landing = (me, mode) => {
  if (mode === 'field' && isDeskRole(me)) return { href: adminHref('/') };
  if (mode === 'admin' && !mayAdmin(me)) return { href: fieldHref('/') };
  return { to: '/' };
};
// The field app shows every role the volunteer's screens: the same person,
// seen as a volunteer. admin_role keeps who they really are, for the
// "Admin ↗" link; the server still answers as them.
export const fieldView = (me) => (me && me.role !== 'volunteer' ? { ...me, role: 'volunteer', areas: [], admin_role: me.role, admin_areas: me.areas } : me);
