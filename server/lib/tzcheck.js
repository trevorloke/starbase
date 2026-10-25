// Is this runtime's time-zone data current for B.C.? From March 2026 B.C.
// stays on UTC-7 all year (no fall-back on Nov 1, 2026). Node carries its own
// copy of the time-zone rules: an older Node still falls back, and then every
// time after Nov 1, 2026 — shifts, events, emails — shows an hour off.
// → null when current, else a sentence saying what to do.
export const staleTimeZoneData = () => {
  try {
    const hour = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23',
    }).format(new Date('2026-11-15T20:00:00Z'));
    if (Number(hour) === 13) return null; // UTC-7: current
    return `This server's time-zone rules are out of date (Node ${process.versions.node}, tz ${process.versions.tz || '?'}): `
      + 'times after Nov 1, 2026 show an hour off, because B.C. no longer falls back. Update the server to a newer Node 22.';
  } catch {
    return null;
  }
};
