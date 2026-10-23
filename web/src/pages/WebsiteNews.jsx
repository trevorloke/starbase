// Website → News: posts, newest first. A row says its date and Published /
// Draft (and Pinned); the editor has title, date, summary, cover picture,
// words, Published and Pin to the front page. The link is under More details.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, todayISO } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { ConfirmDelete, ImageField, MarkdownField, Switch, slugify, useSave } from '../components/WebsiteBits.jsx';

const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function PostList() {
  const q = useQuery({ queryKey: ['site-posts'], queryFn: () => apiGet('/site/posts') });
  const posts = q.data?.posts ?? [];
  return (
    <>
      <div className="ws-subhead">
        <h2>News</h2>
        <Link className="btn btn-primary ops-tap" to="/website/news/new">New post</Link>
      </div>
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && !posts.length && <p className="ops-empty">No news yet.</p>}
      <ul className="ops-rows">
        {posts.map((p) => (
          <li key={p.id} className="ops-item">
            <Link className="ops-row ws-row-img" to={`/website/news/${p.id}`}>
              {p.cover_image ? <img className="ws-row-thumb" src={`/media/${p.cover_image}`} alt="" loading="lazy" /> : <span className="ws-row-thumb" aria-hidden="true" />}
              <span className="ops-row__main">
                <span className="ops-row__name">{p.title}</span>
                <span className="ops-row__sub">{day(p.date)}{p.pinned ? ' · Pinned' : ''}</span>
              </span>
              <span className="ops-row__end">
                <span className={`chip ${p.published ? 'chip-ok' : 'ops-chip-muted'}`}>{p.published ? 'Published' : 'Draft'}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function PostEditor({ id }) {
  const navigate = useNavigate();
  const isNew = id === 'new';
  const q = useQuery({ queryKey: ['site-post', id], queryFn: () => apiGet(`/site/posts/${id}`), enabled: !isNew });
  const [f, setF] = useState(null);
  const [more, setMore] = useState(false);
  const save = useSave();
  useEffect(() => {
    if (isNew) setF({ title: '', slug: '', date: todayISO(), summary: '', body: '', cover_image: null, published: false, pinned: false });
    else if (q.data?.post) setF(q.data.post);
  }, [isNew, q.data]);
  if (!isNew && noSignal(q)) return <NoSignal />;
  if (!isNew && q.isError) return <p className="error" role="alert">{q.error.message}</p>;
  if (!f) return <p className="muted">Loading…</p>;
  const set = (k) => (v) => { save.clearSaved(); setF((x) => ({ ...x, [k]: v })); };

  const submit = async (e) => {
    e.preventDefault();
    const input = {
      title: f.title.trim(), date: f.date, summary: f.summary.trim(), body: f.body, cover_image: f.cover_image || null,
      published: !!f.published, pinned: !!f.pinned,
    };
    if (!isNew) input.id = id;
    if (f.slug && (isNew || f.slug !== q.data.post.slug)) input.slug = f.slug;
    const res = await save.run('site.post.save', input);
    if (res && isNew) navigate(`/website/news/${res.post.id}`, { replace: true, state: { saved: true } });
  };
  const del = async () => {
    if (await save.run('site.post.delete', { id })) navigate('/website/news');
  };

  return (
    <form className="ws-editor" onSubmit={submit}>
      <Link className="ops-back" to="/website/news">← News</Link>
      <div className="field">
        <label htmlFor="ps-title">Title</label>
        <input id="ps-title" className="input ws-title-input" required maxLength={160} value={f.title} autoFocus={isNew}
          onChange={(e) => set('title')(e.target.value)} placeholder="What happened" />
      </div>
      <div className="form-row">
        <div className="field ws-narrow-field">
          <label htmlFor="ps-date">Date</label>
          <input id="ps-date" className="input mono" type="date" required value={f.date} onChange={(e) => set('date')(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="ps-sum">Summary</label>
        <textarea id="ps-sum" className="input" rows={2} maxLength={400} value={f.summary}
          onChange={(e) => set('summary')(e.target.value)} placeholder="One or two lines for the news card." />
      </div>
      <ImageField label="Cover picture" value={f.cover_image} onChange={set('cover_image')} wide />
      <MarkdownField id="ps-body" label="Words" value={f.body} onChange={set('body')} />
      <div className="ws-switches">
        <Switch label="Published" checked={!!f.published} onChange={set('published')} />
        <Switch label="Pin to the front page" checked={!!f.pinned} onChange={set('pinned')} />
      </div>
      <button type="button" className="ot-more disclose disclose--inline ws-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>More details</button>
      {more && (
        <div className="ws-more-body">
          <div className="field">
            <label htmlFor="ps-slug">Link</label>
            <input id="ps-slug" className="input mono" value={f.slug} placeholder={slugify(f.title) || 'news-post'}
              onChange={(e) => set('slug')(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} />
            <span className="ops-meta">/news/{f.slug || slugify(f.title) || '…'}</span>
          </div>
        </div>
      )}
      {save.error && <p className="error" role="alert">{save.error}</p>}
      <div className="ws-save-row">
        <button type="submit" className="btn btn-primary ops-tap" disabled={save.busy || !f.title.trim()}>{save.busy ? 'Saving…' : 'Save'}</button>
        {save.saved && <span className="ops-done" role="status">Saved</span>}
        <span className="spacer" />
        {!isNew && <ConfirmDelete what="this post" onYes={del} busy={save.busy} />}
      </div>
    </form>
  );
}

export default function WebsiteNews({ id }) {
  return id ? <PostEditor key={id} id={id} /> : <PostList />;
}
