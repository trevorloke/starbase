// CSV as spreadsheets open it: UTF-8 with a byte-order mark (Excel reads
// accents right), CRLF lines, every cell quoted when it needs to be, and a
// leading = + - @ (a formula) made harmless with a quote.
export const csvCell = (v) => {
  let s = v instanceof Date ? v.toISOString() : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvText = (head, rows) => `﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
export const csvFileName = (name, fallback = 'export') =>
  `${String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || fallback}.csv`;
export const csvResponse = (c, name, head, rows) => {
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${csvFileName(name)}"`);
  c.header('Cache-Control', 'no-store');
  return c.body(csvText(head, rows));
};
