// The Markdown editor a message is written in (Outreach's newsletters,
// blasts and press releases):
//   MarkdownField      a textarea with a small toolbar (bold, italic, heading,
//                      link, list, picture, and "Link to…" for the campaign's
//                      own pages when given `links`) and a Preview that is
//                      exactly the email's renderer (@starbase/shared/markdown);
//                      `upload` is the picture's action (blast.picture)
//   shrinkImage()      ≤ 2000px and about ≤ 1.5 MB before a picture is sent
//   uploadImage()      shrink, then the action; answers { id, url }
//   toDataUrl()        a file as base64, for an attachment
import { useId, useRef, useState } from 'react';
import { renderMarkdown } from '@starbase/shared/markdown';
import { action } from '../api.js';
import '../editor.css';

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

export async function uploadImage(file, actionName = 'blast.picture') {
  const { blob, width, height } = await shrinkImage(file);
  const data = await toDataUrl(blob);
  const res = await action(actionName, { data, name: file.name.slice(0, 200), width, height });
  return res.media;
}


function UploadButton({ onUploaded, label = 'Upload picture', className = 'btn ops-tap', upload = uploadImage }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const media = await upload(file);
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

