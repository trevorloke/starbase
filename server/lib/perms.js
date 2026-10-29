// Permissions: what each person may do in the app, in one place.
//
// A role is the baseline (manager, treasurer, staff, volunteer — each action
// names the roles that may run it, as before). On top of it a manager can
// grant or deny an AREA — People, Map, Shifts, Money, Signs, Outreach,
// Website, Data, Admin — to a whole role (workspace settings.permissions.roles)
// or to one person (memberships.permissions), under Admin → Permissions.
//
//   decide(perms, area)      false: denied · true: granted · null: the role decides
//   mayRun(ctx, name, action)  the one check for POST /api/actions/:name
//   areaOfPath(path)         a read's area, for the same check on GET
//   areasFor(ctx)            the areas this person has, for the app's tabs
//
// A manager is never denied anything: the one who sets permissions can't lock
// themselves out. A grant lets a volunteer run an area's actions; what a
// volunteer's browser receives about a person (lib/viewer.js) is unchanged.
export const AREAS = [
  { key: 'people', label: 'People', what: 'the directory, profiles, imports' },
  { key: 'map', label: 'Map & turfs', what: 'turfs, walk lists, who canvasses where' },
  { key: 'shifts', label: 'Shifts', what: 'the board, bookings, notices' },
  { key: 'money', label: 'Donations', what: 'gifts, pledges, receipts' },
  { key: 'signs', label: 'Signs', what: 'requests, crews, the map of signs' },
  { key: 'outreach', label: 'Outreach', what: 'newsletters, press, petitions, events, surveys, texting' },
  { key: 'website', label: 'Website', what: 'pages, news, the store and its orders' },
  { key: 'data', label: 'Data', what: 'the full export, the event log, records' },
  { key: 'admin', label: 'Admin', what: 'members, teams, permissions, the rating scale' },
  { key: 'learn', label: 'ImagineU', what: 'training: the lessons, their files, who has done what' },
];
export const AREA_KEYS = AREAS.map((a) => a.key);
// What each role has with nothing granted or denied — the app's tabs.
export const BASE = {
  manager: AREA_KEYS,
  treasurer: ['people', 'map', 'shifts', 'money', 'signs', 'outreach', 'data', 'learn'],
  staff: ['people', 'map', 'shifts', 'money', 'signs', 'outreach', 'website', 'data', 'learn'],
  volunteer: [],
};

const ACTION_AREA = {
  person: 'people', relationship: 'people', call: 'people', volunteer: 'people', contact: 'people',
  turf: 'map',
  shift: 'shifts',
  gift: 'money', pledge: 'money', receipt: 'money',
  sign: 'signs',
  blast: 'outreach', petition: 'outreach', cevent: 'outreach', rsvp: 'outreach', survey: 'outreach',
  ladder: 'outreach', text: 'outreach', texting: 'outreach', subscription: 'outreach',
  site: 'website', store: 'website', tracker: 'website',
  member: 'admin', team: 'admin', permission: 'admin', workspace: 'admin', scale: 'admin', field: 'admin',
  bank: 'people', member: 'people', list: 'people',
  learn: 'learn',
};
// field.values.set is a person's record; field.ping ("I'm here", from the
// map) is nobody's area — anyone who canvasses may say where they are.
export const areaOfAction = (name) => {
  if (name === 'field.values.set') return 'people';
  if (name === 'field.ping' || name === 'learn.done' || name === 'person.details') return null;
  return ACTION_AREA[String(name).split('.')[0]] || null;
};

const PATH_AREA = [
  [/^\/api\/(records|export|events|audit|reports)(\/|$)/, 'data'],
  [/^\/api\/data\/(import|export)/, 'data'],
  [/^\/api\/(gifts|pledges|receipts|money|cap)(\/|$)/, 'money'],
  [/^\/api\/(site|store|tracker)(\/|$)/, 'website'],
  [/^\/api\/(blasts|petitions|campaign-events|surveys|ladders|subscriptions|texting|inbox)(\/|$)/, 'outreach'],
  [/^\/api\/shifts(\/|$)/, 'shifts'],
  [/^\/api\/signs(\/|$)/, 'signs'],
  [/^\/api\/turfs(\/|$)/, 'map'],
  [/^\/api\/(team|admin|invites)(\/|$)/, 'admin'],
  [/^\/api\/fields(\/|$)/, 'admin'],
  [/^\/api\/learn\/progress$/, 'learn'],
  [/^\/api\/(banks|membership|lists)(\/|$)/, 'people'],
  [/^\/api\/persons(\/|$)/, 'people'],
];
export const areaOfPath = (path) => PATH_AREA.find(([re]) => re.test(path))?.[1] || null;

const list = (v) => (Array.isArray(v) ? v.filter((k) => AREA_KEYS.includes(k)) : []);
// The grants and denies that apply to one person: the role's, then their own
// (a person's grant lifts the role's deny and the other way round).
export const permsOf = (role, wsSettings, memberPerms) => {
  if (role === 'manager') return { grant: new Set(), deny: new Set() };
  const r = wsSettings?.permissions?.roles?.[role] || {};
  const m = memberPerms || {};
  const grant = new Set(list(r.grant)); const deny = new Set(list(r.deny));
  for (const k of list(m.grant)) { grant.add(k); deny.delete(k); }
  for (const k of list(m.deny)) { deny.add(k); grant.delete(k); }
  return { grant, deny };
};
export const decide = (perms, area) => {
  if (!area || !perms) return null;
  if (perms.deny.has(area)) return false;
  if (perms.grant.has(area)) return true;
  return null;
};
export const mayRun = (ctx, name, action) => {
  const d = decide(ctx.perms, areaOfAction(name));
  if (d === false) return false;
  if (action.roles.includes(ctx.role)) return true;
  return d === true;
};
export const areasFor = (ctx) => AREA_KEYS.filter((k) => {
  const d = decide(ctx.perms, k);
  return d === null ? (BASE[ctx.role] || []).includes(k) : d;
});
