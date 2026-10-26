// The map's tiles (GET /api/map/config), shared by the canvass map and the
// dashboard's field-tracking map.
export const DEFAULT_TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
};
export const SURREY = [49.1913, -122.849];

// The provider's credit line, kept to text and http(s) links.
export function safeAttribution(html) {
  if (!html || typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const out = document.createElement('span');
  const walk = (node, into) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) into.append(n.textContent);
      else if (n.nodeType === 1 && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName)) continue;
      else if (n.nodeType === 1 && n.tagName === 'A' && /^https?:\/\//i.test(n.getAttribute('href') || '')) {
        const a = document.createElement('a');
        a.href = n.getAttribute('href');
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = n.textContent;
        into.append(a);
      } else if (n.nodeType === 1) walk(n, into);
    }
  };
  walk(doc.body.firstChild || doc.body, out);
  return out.innerHTML;
}
