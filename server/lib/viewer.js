// What a volunteer's browser may receive about a person: phone and address
// (they call and knock), never anyone else's email, and never a tag that
// gives money away ('donor-prospect', 'lapsed', …). Their own record keeps
// its email — it is theirs. Applied to every person row a volunteer reads
// (routes/api.js: /persons, /persons/:id, /map/doors, /turfs/:id/walk; and
// feature modules that hand out person rows, such as "My people").
// Desk roles see the row as it is.
export const isMoneyTag = (t) => {
  const s = String(t ?? '').trim().toLowerCase();
  return s.includes('donor') || s === 'lapsed';
};
export const loginEmail = (ctx) => String(ctx.user.email || '').trim().toLowerCase();
export const forViewer = (ctx) => {
  if (ctx.role !== 'volunteer') return (p) => p;
  const mine = loginEmail(ctx);
  return (p) => ({
    ...p,
    email: mine && String(p.email || '').trim().toLowerCase() === mine ? p.email : null,
    tags: (Array.isArray(p.tags) ? p.tags : []).filter((t) => !isMoneyTag(t)),
  });
};
