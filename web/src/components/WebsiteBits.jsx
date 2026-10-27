// Shared pieces of the Website screens (pages/Website*.jsx):
//   useSiteRefresh()   refetch everything a website edit can change
//   useSave()          run an action with busy / error / "Saved" state
//   MarkdownField      a textarea with a small toolbar (bold, italic, heading,
//                      link, list, picture, and "Link to…" for the campaign's
//                      own pages when given `links`) and a Preview that is
//                      exactly the site's own renderer (@starbase/shared/markdown);
//                      `upload` swaps the picture's action (Outreach's emails)
//   ImageField         one picture: upload (shrunk here first) or pick an
//                      earlier upload; Remove
//   PhotosField        several pictures (a product's), the first is the cover
//   Switch             an on/off row (Published, In the menu, For sale)
//   shrinkImage()      ≤ 2000px and about ≤ 1.5 MB before it is sent
import { useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { renderMarkdown } from '@starbase/shared/markdown';
import { action, apiGet } from '../api.js';

// Managers and staff edit the site; treasurers only see orders.
export const canEdit = (me) => me?.role === 'manager' || me?.role === 'staff';

export const SITE_KEYS = [['site-overview'], ['site-pages'], ['site-page'], ['site-posts'], ['site-post'], ['site-team'],
  ['site-events'], ['site-media'], ['store-products'], ['store-product'], ['store-orders'], ['campaign-events']];

export function useSiteRefresh() {
  const queryClient = useQueryClient();
  return () => Promise.all(SITE_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

// A new item's editor reopens at its own address after the first save;
// navigate(…, { state: { saved: true } }) keeps "Saved" showing there.
export function useSave() {
  const refresh = useSiteRefresh();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(Boolean(location.state?.saved));
  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await action(name, input);
      await refresh();
      setSaved(true);
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, saved, setError, clearSaved: () => setSaved(false) };
}

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');

export const dollars = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-CA', {
  minimumFractionDigits: Number(cents) % 100 ? 2 : 0, maximumFractionDigits: 2,
})}`;

// ── Pictures ──
const MAX_SIDE = 2000;
const TARGET = 1.5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const loadImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const im = new Image();
  im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
  im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture couldn’t be read')); };
  im.src = url;
});
const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
export const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('That picture couldn’t be read'));
  r.readAsDataURL(blob);
});

export async function shrinkImage(file) {
  if (!TYPES.includes(file.type)) throw new Error('Use a JPG, PNG or WebP picture');
  const im = await loadImage(file);
  const w0 = im.naturalWidth;
  const h0 = im.naturalHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const width = Math.round(w0 * scale);
  const height = Math.round(h0 * scale);
  if (scale === 1 && file.size <= TARGET) return { blob: file, width, height };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  // A PNG keeps its see-through parts if it fits; photos go to JPEG.
  if (file.type === 'image/png') {
    g.drawImage(im, 0, 0, width, height);
    const png = await toBlob(canvas, 'image/png');
    if (png && png.size <= TARGET) return { blob: png, width, height };
  }
  g.fillStyle = '#fff';
  g.fillRect(0, 0, width, height);
  g.drawImage(im, 0, 0, width, height);
  for (const q of [0.86, 0.78, 0.7, 0.6, 0.5]) {
    const jpg = await toBlob(canvas, 'image/jpeg', q);
    if (jpg && jpg.size <= TARGET) return { blob: jpg, width, height };
  }
  throw new Error('This picture is too big — try a smaller one');
}

export async function uploadImage(file, actionName = 'site.media.upload') {
  const { blob, width, height } = await shrinkImage(file);
  const data = await toDataUrl(blob);
  const res = await action(actionName, { data, name: file.name.slice(0, 200), width, height });
  return res.media;
}

function UploadButton({ onUploaded, label = 'Upload picture', className = 'btn ops-tap', upload = uploadImage }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const refresh = useSiteRefresh();
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const media = await upload(file);
      await refresh();
      onUploaded(media);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick} />
      <button type="button" className={className} disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? 'Uploading…' : label}
      </button>
      {error && <span className="error ws-inline-err" role="alert">{error}</span>}
    </>
  );
}

function Library({ onPick, onClose }) {
  const q = useQuery({ queryKey: ['site-media'], queryFn: () => apiGet('/site/media') });
  const list = q.data?.media ?? [];
  return (
    <div className="ws-library">
      {q.isPending && <p className="muted">Loading…</p>}
      {q.isSuccess && !list.length && <p className="muted">No pictures yet.</p>}
      <div className="ws-library__grid">
        {list.map((m) => (
          <button key={m.id} type="button" className="ws-library__pick" onClick={() => { onPick(m); onClose(); }}
            aria-label={`Use ${m.name || 'this picture'}`}>
            <img src={m.url} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}

export function ImageField({ label, value, onChange, hint, wide = false }) {
  const [lib, setLib] = useState(false);
  const id = useId();
  return (
    <div className="field ws-image">
      <span className="ws-label" id={id}>{label}</span>
      {value
        ? <img className={`ws-image__thumb${wide ? ' is-wide' : ''}`} src={`/media/${value}`} alt="" />
        : <div className={`ws-image__empty${wide ? ' is-wide' : ''}`} aria-hidden="true" />}
      <div className="ops-actions" aria-labelledby={id} role="group">
        <UploadButton onUploaded={(m) => onChange(m.id)} label={value ? 'Change' : 'Upload picture'} />
        <button type="button" className="btn btn-quiet ops-tap" onClick={() => setLib((v) => !v)} aria-expanded={lib}>From uploads</button>
        {value && <button type="button" className="btn btn-quiet ops-tap" onClick={() => onChange(null)}>Remove</button>}
      </div>
      {hint && <span className="ops-meta">{hint}</span>}
      {lib && <Library onPick={(m) => onChange(m.id)} onClose={() => setLib(false)} />}
    </div>
  );
}

export function PhotosField({ value, onChange }) {
  const [lib, setLib] = useState(false);
  const add = (m) => onChange([...value.filter((x) => x !== m.id), m.id].slice(0, 8));
  const move = (i, d) => {
    const next = [...value];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  return (
    <div className="field">
      <span className="ws-label">Photos</span>
      {value.length > 0 && (
        <ul className="ws-photos">
          {value.map((id, i) => (
            <li key={id}>
              <img src={`/media/${id}`} alt="" />
              {i === 0 && <span className="chip ops-chip-mark ws-photos__cover">Cover</span>}
              <div className="ws-photos__btns">
                {i > 0 && <button type="button" className="btn btn-quiet" onClick={() => move(i, -1)} aria-label="Move earlier">←</button>}
                <button type="button" className="btn btn-quiet" onClick={() => onChange(value.filter((x) => x !== id))} aria-label="Remove photo">✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {value.length < 8 && (
        <div className="ops-actions">
          <UploadButton onUploaded={add} label="Add photo" />
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setLib((v) => !v)} aria-expanded={lib}>From uploads</button>
        </div>
      )}
      {lib && <Library onPick={add} onClose={() => setLib(false)} />}
    </div>
  );
}

// ── Markdown ──
const TOOLS = [
  { key: 'b', label: 'B', title: 'Bold', wrap: ['**', '**'], fill: 'bold words' },
  { key: 'i', label: 'I', title: 'Italic', wrap: ['*', '*'], fill: 'words' },
  { key: 'h', label: 'H', title: 'Heading', line: '## ', fill: 'Heading' },
  { key: 'link', label: 'Link', title: 'Link', link: true },
  { key: 'list', label: '• List', title: 'List', line: '- ', fill: 'Item' },
];

export function MarkdownField({ id, label, value, onChange, rows = 12, placeholder, upload, links }) {
  const ref = useRef(null);
  const [preview, setPreview] = useState(false);
  const linkMenu = useId();
  const insert = (before, after = '', fill = '') => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const picked = value.slice(start, end) || fill;
    const next = value.slice(0, start) + before + picked + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + picked.length);
    });
  };
  const tool = (t) => {
    if (t.wrap) return insert(t.wrap[0], t.wrap[1], t.fill);
    if (t.link) return insert('[', '](https://)', 'link words');
    // Line tools start a new line when the cursor isn't at one.
    const at = ref.current?.selectionStart ?? value.length;
    const nl = at > 0 && value[at - 1] !== '\n' ? '\n' : '';
    return insert(nl + t.line, '', t.fill);
  };
  return (
    <div className="field ws-md">
      <div className="ws-md__bar">
        <label htmlFor={id} className="ws-label">{label}</label>
        <div className="ws-md__tools" role="toolbar" aria-label="Formatting">
          {!preview && TOOLS.map((t) => (
            <button key={t.key} type="button" className={`ws-md__tool ws-md__tool--${t.key}`} title={t.title} aria-label={t.title} onClick={() => tool(t)}>{t.label}</button>
          ))}
          {!preview && <UploadButton className="ws-md__tool" label="Picture" upload={upload} onUploaded={(m) => insert('\n![', `](/media/${m.id})\n`, 'picture')} />}
          {!preview && links?.length > 0 && (
            // "Link to…": one of the campaign's own pages, as a link at the cursor.
            <select className="ws-md__tool ws-md__links" aria-label="Link to a campaign page" id={linkMenu} value=""
              onChange={(e) => { const l = links[Number(e.target.value)]; if (l) insert('[', `](${l.url})`, l.label); }}>
              <option value="">Link to…</option>
              {links.map((l, i) => <option key={l.url} value={i}>{l.label}</option>)}
            </select>
          )}
          <button type="button" className="ws-md__tool ws-md__preview" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
            {preview ? 'Edit' : 'Preview'}
          </button>
        </div>
      </div>
      {preview
        // eslint-disable-next-line react/no-danger -- the site's own safe renderer: every character is escaped first
        ? <div className="ws-md__preview-body ws-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(value) || '<p class="muted">Nothing yet.</p>' }} />
        : <textarea id={id} ref={ref} className="input ws-md__text" rows={rows} value={value} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export function Switch({ label, checked, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="sv-switch ws-switch" disabled={disabled}
      onClick={() => onChange(!checked)}>
      <span className="sv-switch__track" aria-hidden="true"><span className="sv-switch__dot" /></span>
      <span>{label}</span>
    </button>
  );
}

// "Delete this page? Yes · No", in place.
export function ConfirmDelete({ what, onYes, busy }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button type="button" className="btn btn-quiet ops-tap ws-del" onClick={() => setAsk(true)}>Delete</button>;
  return (
    <span className="ops-confirm">
      <span>Delete {what}?</span>
      <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={onYes}>Yes</button>
      <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(false)}>No</button>
    </span>
  );
}

export function StripeNote({ stripe }) {
  if (!stripe || (stripe.configured && stripe.webhook)) return null;
  return (
    <p className="ws-note" role="note">
      Connect Stripe: set <code>STRIPE_SECRET_KEY</code> / <code>STRIPE_WEBHOOK_SECRET</code>
    </p>
  );
}

// The saved page or post on the site: "View on site" once published, else a
// draft preview only signed-in staff can open (the site's ?preview).
export function SiteLink({ path, published }) {
  const href = `/site${path === '/' ? '/' : path}${published ? '' : '?preview'}`;
  return (
    <a className="btn btn-quiet ops-tap ws-sitelink" href={href} target="_blank" rel="noopener noreferrer"
      title={published ? undefined : 'Shows the last saved version'}>
      {published ? 'View on site ↗' : 'Preview draft ↗'}
    </a>
  );
}
