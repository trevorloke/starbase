// ImagineU — the campaign's training, for every role (GET /api/learn):
// sections of lessons — a note, a document, a video, audio, a picture,
// contacts, a procedure — each with a file or a link, read on the lesson's
// own page and ticked "Done". The desk edits in place (Edit): sections,
// lessons, files (PDF, Office, pictures, audio, short video; big video is a
// link), who may see each lesson (everyone signed in · the desk · public,
// which puts it on the site at /learn/<slug>), and sees who has done what
// (Progress).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { renderMarkdown } from '@starbase/shared/markdown';
import { ApiError, action, apiGet } from '../api.js';
import './imagineu.css';
import '../editor.css';

const DESK = ['manager', 'staff', 'treasurer'];
const KINDS = [
  { key: 'note', label: 'Note', what: 'words — what to know' },
  { key: 'document', label: 'Document', what: 'a PDF, Word, PowerPoint or Excel file' },
  { key: 'video', label: 'Video', what: 'a YouTube or Vimeo link, or a short MP4' },
  { key: 'audio', label: 'Audio', what: 'a recording — MP3, M4A, WAV' },
  { key: 'picture', label: 'Picture', what: 'a map, a poster, a photo' },
  { key: 'contacts', label: 'Contacts', what: 'who to call, and when' },
  { key: 'procedure', label: 'Procedure', what: 'the steps, in order' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.key, k.label]));
const AUDIENCES = [
  { key: 'everyone', label: 'Everyone signed in' },
  { key: 'desk', label: 'The desk only' },
  { key: 'public', label: 'Public — a page anyone can open' },
];
const FILE_MAX = 12 * 1024 * 1024;
const plural = (n, w, many = `${w}s`) => (n === 1 ? w : many);
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.m4a,.wav,.ogg,.mp4,.webm,application/pdf,image/*,audio/*,video/mp4,video/webm';

const embedOf = (link) => {
  const yt = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,20})/i.exec(link || '');
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vm = /^https:\/\/(?:www\.)?vimeo\.com\/(\d{5,12})/i.exec(link || '');
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return null;
};
const toDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('Couldn’t read the file'));
  r.readAsDataURL(file);
});

const useLearn = () => useQuery({ queryKey: ['learn'], queryFn: () => apiGet('/learn'), staleTime: 30_000 });

export default function ImagineU() {
  const { me } = useOutletContext();
  const { id } = useParams();
  const desk = DESK.includes(me?.role);
  if (id === 'progress') return desk ? <Progress /> : <Home me={me} desk={desk} />;
  if (id) return <Lesson id={id} me={me} desk={desk} />;
  return <Home me={me} desk={desk} />;
}

// ── The home: sections and lessons ──
function Home({ desk }) {
  const q = useLearn();
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(null); // 'section' | { section_id } for a lesson
  const headId = useId();
  if (q.isError && !q.data) return <p className="error" role="alert">Couldn’t load ImagineU — {q.error.message}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const d = q.data;
  const groups = [...d.sections, ...(d.unfiled.length ? [{ id: null, title: d.sections.length ? 'More' : '', lessons: d.unfiled }] : [])];
  const empty = d.total === 0;
  return (
    <div className="lu">
      <div className="page-head lu-head">
        <div>
          <span className="eyebrow">Training</span>
          <h1 id={headId}>ImagineU</h1>
        </div>
        {desk && (
          <div className="head-actions lu-tools">
            <Link className="btn btn-quiet" to="/imagineu/progress">Progress</Link>
            <button type="button" className={`btn${edit ? ' btn-primary' : ''}`} aria-pressed={edit} onClick={() => { setEdit((v) => !v); setAdding(null); }}>{edit ? 'Done editing' : 'Edit'}</button>
          </div>
        )}
      </div>
      {!empty && (
        <p className="lu-progress" role="status">
          <span className="lu-bar" aria-hidden="true"><span style={{ width: `${d.total ? Math.round((d.done / d.total) * 100) : 0}%` }} /></span>
          You’ve done <strong className="mono">{d.done}</strong> of {d.total} {plural(d.total, 'lesson')}{desk && d.members ? <span className="muted"> · {d.members} on the campaign</span> : null}
        </p>
      )}
      {empty && !edit && (
        <div className="pp-empty">
          <p>{desk ? 'Nothing here yet. Tap Edit to add the first section and lesson — a welcome note, the door script, a video, who to call.' : 'Nothing here yet — the campaign is putting its training together.'}</p>
        </div>
      )}
      {groups.map((s) => (
        <section key={s.id || 'more'} className="lu-sec" aria-label={s.title || 'Lessons'}>
          {(s.title || edit) && (
            <header className="lu-sec__head">
              <h2 className="lu-sec__h">{s.title || 'Unfiled'}{s.note && <span className="muted lu-sec__note"> · {s.note}</span>}</h2>
              {edit && s.id && <SectionTools section={s} />}
            </header>
          )}
          <ul className="lu-list">
            {s.lessons.map((l) => (
              <li key={l.id}>
                <Link className={`lu-row${l.done ? ' is-done' : ''}${!l.published ? ' is-draft' : ''}`} to={`/imagineu/${l.id}`}>
                  <KindMark kind={l.kind} done={l.done} />
                  <span className="lu-row__main">
                    <span className="lu-row__title">{l.title}{!l.published && <span className="chip lu-chip">Draft</span>}{l.audience === 'desk' && <span className="chip lu-chip">Desk</span>}{l.audience === 'public' && <span className="chip lu-chip">Public</span>}</span>
                    <span className="lu-row__sub">{KIND_LABEL[l.kind]}{l.asset ? ` · ${l.asset.name}` : l.link ? ' · link' : ''}{l.excerpt ? ` · ${l.excerpt}` : ''}</span>
                  </span>
                  {desk && typeof l.done_by === 'number' && <span className="lu-row__n mono" title="How many have done it">{l.done_by}</span>}
                  <span className="today-chev" aria-hidden="true">›</span>
                </Link>
              </li>
            ))}
            {edit && (
              <li className="lu-addrow">
                {adding && adding.section_id === s.id ? (
                  <LessonForm sectionId={s.id} sections={d.sections} onDone={() => setAdding(null)} />
                ) : (
                  <button type="button" className="btn btn-quiet" onClick={() => setAdding({ section_id: s.id })}>+ Add a lesson{s.title ? ` to ${s.title}` : ''}</button>
                )}
              </li>
            )}
          </ul>
        </section>
      ))}
      {edit && (
        <div className="lu-addsec">
          {adding === 'section'
            ? <SectionForm onDone={() => setAdding(null)} />
            : <button type="button" className="btn" onClick={() => setAdding('section')}>+ Add a section</button>}
          {!d.sections.length && adding !== 'section' && !adding && (
            <button type="button" className="btn btn-quiet" onClick={() => setAdding({ section_id: null })}>+ Add a lesson</button>
          )}
          {adding && adding.section_id === null && !d.unfiled.length && <LessonForm sectionId={null} sections={d.sections} onDone={() => setAdding(null)} />}
          {d.public_url && d.sections.concat([{ lessons: d.unfiled }]).some((s) => s.lessons.some((l) => l.audience === 'public')) && (
            <p className="muted lu-note">Public lessons are at <a href={d.public_url} target="_blank" rel="noopener noreferrer">{d.public_url}</a>.</p>
          )}
        </div>
      )}
    </div>
  );
}

function KindMark({ kind, done }) {
  const short = { note: 'N', document: 'D', video: 'V', audio: 'A', picture: 'P', contacts: 'C', procedure: 'S' }[kind] || '?';
  return <span className={`lu-mark lu-mark--${kind}${done ? ' is-done' : ''}`} aria-hidden="true">{done ? '✓' : short}</span>;
}

function useSaver() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (name, input) => {
    setBusy(true); setError(null);
    try {
      const r = await action(name, input);
      await queryClient.invalidateQueries({ queryKey: ['learn'] });
      return r;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No signal — try again');
      return null;
    } finally { setBusy(false); }
  };
  return { run, busy, error };
}

function SectionForm({ section, onDone }) {
  const [title, setTitle] = useState(section?.title || '');
  const [note, setNote] = useState(section?.note || '');
  const { run, busy, error } = useSaver();
  const id = useId();
  const submit = async (e) => {
    e.preventDefault();
    const r = await run('learn.section.save', { id: section?.id, title, note: note || null });
    if (r) onDone();
  };
  return (
    <form className="lu-form" onSubmit={submit}>
      <label htmlFor={`${id}-t`} className="ws-label">Section</label>
      <input id={`${id}-t`} className="input" value={title} maxLength={120} required autoFocus placeholder="Start here" onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor={`${id}-n`} className="ws-label">One line about it (optional)</label>
      <input id={`${id}-n`} className="input" value={note} maxLength={500} placeholder="Your first hour on the campaign" onChange={(e) => setNote(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="lu-form__acts">
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>{section ? 'Save' : 'Add section'}</button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function SectionTools({ section }) {
  const [editing, setEditing] = useState(false);
  const [ask, setAsk] = useState(false);
  const { run, busy } = useSaver();
  if (editing) return <SectionForm section={section} onDone={() => setEditing(false)} />;
  return (
    <span className="lu-sec__tools">
      <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>Rename</button>
      {ask ? (
        <span className="ops-confirm">
          <span>Remove the section? Its lessons stay, unfiled.</span>
          <button type="button" className="btn ops-danger" disabled={busy} onClick={() => run('learn.section.remove', { id: section.id })}>Yes</button>
          <button type="button" className="btn btn-quiet" onClick={() => setAsk(false)}>No</button>
        </span>
      ) : <button type="button" className="btn btn-quiet" onClick={() => setAsk(true)}>Remove</button>}
    </span>
  );
}

// Add or edit a lesson: words, a file, a link, who sees it.
function LessonForm({ lesson, sectionId, sections, onDone, onRemoved }) {
  const [f, setF] = useState(() => ({
    title: lesson?.title || '', kind: lesson?.kind || 'note', body: lesson?.body || '', link: lesson?.link || '',
    section_id: lesson?.section_id ?? sectionId ?? '', audience: lesson?.audience || 'everyone', published: lesson?.published ?? true,
    asset: lesson?.asset || null,
  }));
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [preview, setPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState(null);
  const [ask, setAsk] = useState(false);
  const fileRef = useRef(null);
  const { run, busy, error } = useSaver();
  const id = useId();
  const wantsFile = ['document', 'audio', 'picture', 'video'].includes(f.kind);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > FILE_MAX) { setFileError('That file is over 12 MB. For a long video, link to it on YouTube or Vimeo instead.'); return; }
    setUploading(true); setFileError(null);
    try {
      const data = await toDataUrl(file);
      const r = await action('learn.asset.upload', { data, name: file.name.slice(0, 200) });
      set('asset', r.asset);
      if (r.asset.kind !== f.kind && ['document', 'audio', 'picture', 'video'].includes(r.asset.kind)) set('kind', r.asset.kind);
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : 'Couldn’t upload — check your signal');
    } finally { setUploading(false); }
  };
  const submit = async (e) => {
    e.preventDefault();
    const r = await run('learn.lesson.save', {
      id: lesson?.id, section_id: f.section_id || null, title: f.title, kind: f.kind, body: f.body, link: f.link || null,
      asset_id: f.asset?.id || null, audience: f.audience, published: f.published,
    });
    if (r) onDone(r.lesson);
  };
  return (
    <form className="lu-form lu-form--lesson" onSubmit={submit}>
      <div className="lu-form__row">
        <div className="lu-form__grow">
          <label htmlFor={`${id}-t`} className="ws-label">Title</label>
          <input id={`${id}-t`} className="input" value={f.title} maxLength={160} required autoFocus placeholder="The door script" onChange={(e) => set('title', e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${id}-k`} className="ws-label">What it is</label>
          <select id={`${id}-k`} className="input" value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </div>
      </div>
      <p className="muted lu-form__hint">{KINDS.find((k) => k.key === f.kind)?.what}</p>
      {(wantsFile || f.asset) && (
        <div className="lu-file">
          {f.asset ? (
            <p className="lu-file__cur"><strong>{f.asset.name}</strong> <span className="muted mono">{kb(f.asset.bytes)}</span> <button type="button" className="btn btn-quiet" onClick={() => set('asset', null)}>Remove file</button></p>
          ) : null}
          <input ref={fileRef} type="file" accept={ACCEPT} className="lu-file__input" id={`${id}-f`} onChange={pick} />
          <label htmlFor={`${id}-f`} className={`btn${uploading ? ' is-busy' : ''}`}>{uploading ? 'Uploading…' : f.asset ? 'Replace file' : 'Upload a file'}</label>
          <span className="muted lu-form__hint"> PDF, Word, PowerPoint, Excel, pictures, MP3, M4A, WAV, short MP4 — 12 MB at most.</span>
          {fileError && <p className="error" role="alert">{fileError}</p>}
        </div>
      )}
      {(f.kind === 'video' || f.kind === 'audio' || f.link) && (
        <>
          <label htmlFor={`${id}-l`} className="ws-label">{f.kind === 'video' ? 'Video link (YouTube, Vimeo)' : 'Link (optional)'}</label>
          <input id={`${id}-l`} className="input" type="url" value={f.link} maxLength={500} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => set('link', e.target.value)} />
        </>
      )}
      <div className="ws-md__bar lu-form__bar">
        <label htmlFor={`${id}-b`} className="ws-label">{f.kind === 'procedure' ? 'The steps (one per line, numbered)' : f.kind === 'contacts' ? 'Who to call (one per line)' : 'Words'}</label>
        <button type="button" className="ws-md__tool ws-md__preview" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>{preview ? 'Edit' : 'Preview'}</button>
      </div>
      {preview
        // eslint-disable-next-line react/no-danger -- the site's own safe renderer
        ? <div className="ws-md__preview-body ws-prose lu-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(f.body) || '<p class="muted">Nothing yet.</p>' }} />
        : <textarea id={`${id}-b`} className="input lu-form__text" rows={f.kind === 'note' || f.kind === 'procedure' ? 10 : 5} value={f.body} maxLength={30_000}
          placeholder={f.kind === 'procedure' ? '1. Count the sheets\n2. Hand them to the field director' : f.kind === 'contacts' ? '- Field director — Priya, 604-555-0100\n- The office — 604-555-0101, 9–5' : 'Headings with #, lists with -, **bold**.'}
          onChange={(e) => set('body', e.target.value)} />}
      <div className="lu-form__row">
        <div>
          <label htmlFor={`${id}-s`} className="ws-label">Section</label>
          <select id={`${id}-s`} className="input" value={f.section_id} onChange={(e) => set('section_id', e.target.value)}>
            <option value="">Unfiled</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-a`} className="ws-label">Who sees it</label>
          <select id={`${id}-a`} className="input" value={f.audience} onChange={(e) => set('audience', e.target.value)}>
            {AUDIENCES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </div>
        <label className="lu-check"><input type="checkbox" checked={f.published} onChange={(e) => set('published', e.target.checked)} /> Published</label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="lu-form__acts">
        <button type="submit" className="btn btn-primary" disabled={busy || uploading || !f.title.trim()}>{lesson ? 'Save' : 'Add lesson'}</button>
        <button type="button" className="btn btn-quiet" onClick={() => onDone(null)}>Cancel</button>
        {lesson && (ask ? (
          <span className="ops-confirm">
            <span>Remove this lesson?</span>
            <button type="button" className="btn ops-danger" disabled={busy} onClick={async () => { if (await run('learn.lesson.remove', { id: lesson.id })) onRemoved?.(); }}>Yes</button>
            <button type="button" className="btn btn-quiet" onClick={() => setAsk(false)}>No</button>
          </span>
        ) : <button type="button" className="btn btn-quiet lu-form__remove" onClick={() => setAsk(true)}>Remove</button>)}
      </div>
    </form>
  );
}

// ── One lesson ──
function Lesson({ id, desk }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const home = useLearn();
  const q = useQuery({ queryKey: ['learn', 'lesson', id], queryFn: () => apiGet(`/learn/lessons/${id}`) });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { setEditing(false); }, [id]);
  if (q.isError && !q.data) return <div className="lu"><p className="error" role="alert">{q.error.status === 404 ? 'That lesson isn’t here.' : q.error.message}</p><Link className="btn" to="/imagineu">ImagineU</Link></div>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const l = q.data.lesson;
  const section = home.data?.sections.find((s) => s.id === l.section_id);
  const toggleDone = async () => {
    setBusy(true); setErr(null);
    try {
      await action('learn.done', { lesson_id: l.id, done: !l.done });
      queryClient.setQueryData(['learn', 'lesson', id], (d) => (d ? { lesson: { ...d.lesson, done: !l.done } } : d));
      queryClient.invalidateQueries({ queryKey: ['learn'] });
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'No signal — try again'); } finally { setBusy(false); }
  };
  const embed = embedOf(l.link);
  return (
    <div className="lu lu-lesson">
      <p className="lu-back"><Link to="/imagineu">← ImagineU</Link>{section && <span className="muted"> · {section.title}</span>}</p>
      {editing ? (
        <LessonForm lesson={l} sections={home.data?.sections || []}
          onDone={(saved) => { setEditing(false); if (saved) { queryClient.invalidateQueries({ queryKey: ['learn', 'lesson', id] }); } }}
          onRemoved={() => navigate('/imagineu')} />
      ) : (
        <>
          <div className="page-head lu-head">
            <div>
              <span className="eyebrow">{KIND_LABEL[l.kind]}{!l.published ? ' · Draft' : ''}{l.audience === 'desk' ? ' · The desk only' : l.audience === 'public' ? ' · Public' : ''}</span>
              <h1>{l.title}</h1>
            </div>
            {desk && <div className="head-actions"><button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>Edit</button></div>}
          </div>
          <Media lesson={l} embed={embed} />
          {l.body && (
            // eslint-disable-next-line react/no-danger -- the site's own safe renderer: every character is escaped first
            <div className={`ws-prose lu-prose lu-prose--${l.kind}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(l.body) }} />
          )}
          {!l.body && !l.asset && !l.link && <p className="muted">Nothing here yet.</p>}
          <div className="lu-done">
            <button type="button" className={`btn ${l.done ? 'btn-quiet' : 'btn-primary'} today-tap`} disabled={busy} onClick={toggleDone} aria-pressed={l.done}>
              {l.done ? '✓ Done — undo' : 'Mark as done'}
            </button>
            {err && <span className="error" role="alert">{err}</span>}
            {l.public_url && desk && <a className="muted lu-public" href={l.public_url} target="_blank" rel="noopener noreferrer">Public page ↗</a>}
          </div>
        </>
      )}
    </div>
  );
}

function Media({ lesson: l, embed }) {
  const a = l.asset;
  if (a) {
    if (a.kind === 'picture') return <figure className="lu-media"><img src={a.url} alt={l.title} /></figure>;
    if (a.kind === 'audio') return <div className="lu-media"><audio controls preload="none" src={a.url} /><a className="lu-dl" href={`${a.url}?download=1`}>Download {a.name}</a></div>;
    if (a.kind === 'video') return <div className="lu-media"><video controls preload="metadata" src={a.url} /></div>;
    if (a.content_type === 'application/pdf') {
      return (
        <div className="lu-media lu-media--doc">
          <iframe className="lu-pdf" src={a.url} title={a.name} />
          <p><a className="btn" href={a.url} target="_blank" rel="noopener noreferrer">Open the PDF</a> <a className="lu-dl" href={`${a.url}?download=1`}>Download</a></p>
        </div>
      );
    }
    return <div className="lu-media lu-media--doc"><a className="btn" href={`${a.url}?download=1`}>Download {a.name}</a> <span className="muted mono">{kb(a.bytes)}</span></div>;
  }
  if (embed) return <div className="lu-media lu-video"><iframe src={embed} title={l.title} allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen loading="lazy" /></div>;
  if (l.link) return <p className="lu-media"><a className="btn" href={l.link} target="_blank" rel="noopener noreferrer">Open {l.kind === 'video' ? 'the video' : 'the link'} ↗</a></p>;
  return null;
}

// ── Progress (the desk): who has done what ──
function Progress() {
  const q = useQuery({ queryKey: ['learn', 'progress'], queryFn: () => apiGet('/learn/progress') });
  const [open, setOpen] = useState(null);
  const byId = useMemo(() => new Map((q.data?.lessons || []).map((l) => [l.id, l])), [q.data]);
  if (q.isError && !q.data) return <p className="error" role="alert">{q.error.message}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const { members, lessons } = q.data;
  return (
    <div className="lu">
      <p className="lu-back"><Link to="/imagineu">← ImagineU</Link></p>
      <div className="page-head"><div><span className="eyebrow">ImagineU</span><h1>Progress</h1></div></div>
      {!lessons.length ? <p className="muted">No lessons yet.</p> : (
        <ul className="lu-plist">
          {members.map((m) => {
            const pct = m.of ? Math.round((m.done / m.of) * 100) : 0;
            const isOpen = open === m.id;
            return (
              <li key={m.id}>
                <button type="button" className="lu-prow" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : m.id)}>
                  <span className="lu-prow__main">
                    <span className="lu-prow__name">{m.name} <span className="muted">· {m.role}</span></span>
                    <span className="lu-bar lu-bar--sm" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                  </span>
                  <span className="mono lu-prow__n">{m.done} / {m.of}</span>
                  <span className="today-chev" aria-hidden="true">{isOpen ? '–' : '+'}</span>
                </button>
                {isOpen && (
                  <ul className="lu-pdetail">
                    {lessons.filter((l) => l.published && (m.role !== 'volunteer' || l.audience !== 'desk')).map((l) => (
                      <li key={l.id} className={m.lessons[l.id] ? 'is-done' : ''}>
                        <span aria-hidden="true">{m.lessons[l.id] ? '✓' : '·'}</span> <Link to={`/imagineu/${l.id}`}>{byId.get(l.id)?.title}</Link>
                        {m.lessons[l.id] && <span className="muted mono"> {new Date(m.lessons[l.id]).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
