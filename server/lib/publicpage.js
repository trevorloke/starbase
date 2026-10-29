// The look of Starbase's own public pages — petition, newsletter, volunteer,
// unsubscribe, RSVP, donate, a public lesson: one column, the campaign's
// name on top, thumb-sized inputs, one big button, and a link back to the
// campaign's website (workspace settings.website) when it has one. The
// campaign's website itself lives elsewhere; these pages only feed it.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const settingsOf = (ws) => (typeof ws?.settings === 'string' ? JSON.parse(ws.settings) : (ws?.settings || {}));

const CSS = `
  :root{--paper:#f8f6ef;--card:#fffdf7;--ink:#171410;--ink2:#5d5749;--rule:#d6d0bf;--mark:#f2c40f;--bad:#a83a2c}
  @media(prefers-color-scheme:dark){:root{--paper:#15120c;--card:#1d1a13;--ink:#ece7da;--ink2:#a59e8c;--rule:#3a362a;--mark:#d9b60e;--bad:#e08a8a}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.5 Georgia,'Times New Roman',serif}
  main{max-width:520px;margin:0 auto;padding:28px 16px 56px}
  main.wide{max-width:720px}
  .camp{font-size:30px;font-weight:700;line-height:1.1;margin:0 0 24px;padding-bottom:12px;border-bottom:4px solid var(--mark);overflow-wrap:anywhere}
  h1{font-size:26px;line-height:1.2;margin:0 0 12px}
  h2{font-size:21px;line-height:1.25;margin:22px 0 8px}
  p{color:var(--ink2);margin:0 0 14px}
  .big{font-size:20px;font-weight:700;color:var(--ink)}
  .when{font-size:19px;font-weight:700;color:var(--ink);margin:0 0 4px}
  .muted{color:var(--ink2)}
  .prose{color:var(--ink)}
  .prose p,.prose li{color:var(--ink)}
  .prose img{max-width:100%;height:auto;border-radius:4px}
  .prose blockquote{margin:0 0 14px;padding-left:14px;border-left:4px solid var(--rule);color:var(--ink2)}
  form{margin-top:8px}
  label,legend{display:block;font-size:16px;font-weight:700;color:var(--ink);margin:18px 0 6px;padding:0}
  fieldset{border:0;margin:18px 0 0;padding:0;min-width:0}
  legend{margin:0 0 6px}
  input,textarea,select{display:block;width:100%;min-height:52px;font:inherit;font-size:18px;padding:12px 14px;border:1px solid var(--rule);background:var(--card);color:var(--ink);border-radius:4px}
  textarea{min-height:100px}
  input:focus,textarea:focus,select:focus{outline:3px solid var(--mark);outline-offset:1px;border-color:var(--ink)}
  .checks{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .amounts{grid-template-columns:1fr 1fr 1fr}
  @media(max-width:360px){.checks{grid-template-columns:1fr}.amounts{grid-template-columns:1fr 1fr}}
  .check{display:flex;gap:12px;align-items:center;min-height:52px;margin:8px 0;padding:10px 14px;border:1px solid var(--rule);border-radius:4px;background:var(--card);font-size:17px;font-weight:400;line-height:1.3;cursor:pointer}
  .checks .check{margin:0}
  .check input{width:24px;height:24px;min-height:0;flex:none;margin:0;padding:0;accent-color:var(--ink)}
  .check:has(input:checked){border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
  .amounts .check{font-size:19px;font-weight:700}
  .attest{align-items:flex-start}
  .attest input{margin-top:1px}
  .roles{display:grid;gap:8px}
  .role .check{margin:0}
  .gl{display:block;font-size:14px;color:var(--ink2)}
  .rd{display:none;margin:6px 0 4px 38px}
  .rd label{margin:0 0 4px;font-size:15px}
  .role:has(input[name=roles]:checked) .rd{display:block}
  @supports not selector(:has(a)){.rd{display:block}}
  details{margin-top:8px}
  summary{display:flex;align-items:center;min-height:52px;padding:10px 14px;border:1px dashed var(--rule);border-radius:4px;font-size:17px;font-weight:700;cursor:pointer;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:'+';font:700 20px/1 ui-monospace,Menlo,monospace;margin-right:12px}
  details[open] summary::before{content:'−'}
  details[open] summary{margin-bottom:8px}
  summary:focus-visible{outline:3px solid var(--mark);outline-offset:1px}
  button,.btn{display:block;width:100%;min-height:56px;margin-top:24px;font:700 15px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;background:var(--mark);color:#171410;border:0;padding:16px 22px;border-radius:4px;cursor:pointer;text-align:center;text-decoration:none}
  button:focus-visible,.btn:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
  .done{border:1px solid var(--rule);border-left:4px solid var(--mark);background:var(--card);padding:18px;margin-top:16px}
  .err{border-left-color:var(--bad);margin:0 0 8px}
  .note{font-size:15px;margin:16px 0 0}
  .learn-list{list-style:none;margin:0;padding:0}
  .learn-list li{padding:12px 0;border-bottom:1px solid var(--rule)}
  .learn-video{position:relative;padding-top:56.25%;margin:0 0 14px}
  .learn-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:4px}
  footer{margin-top:40px;border-top:1px solid var(--rule);padding-top:12px;font:13px/1.6 ui-monospace,Menlo,monospace;color:var(--ink2)}
  a{color:inherit}
`;

// page(ws, title, inner, { wide, noindex }): ws may be null (a link that
// names no campaign).
export const page = (ws, title, inner, { wide = false, noindex = false } = {}) => {
  const site = ws ? settingsOf(ws).website : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}${ws ? ` · ${esc(ws.name)}` : ''}</title>${noindex ? '<meta name="robots" content="noindex">' : ''}
<style>${CSS}</style></head><body><main${wide ? ' class="wide"' : ''}>
${ws ? `<div class="camp">${esc(ws.name)}</div>` : ''}
${inner}
<footer>${site ? `<a href="${esc(site)}">← ${esc(String(site).replace(/^https?:\/\//, ''))}</a> · ` : ''}Powered by Starbase</footer>
</main></body></html>`;
};
