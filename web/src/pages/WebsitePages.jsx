// Website → Pages: About, Platform, Contact … and the front page's welcome.
// A row per page (draft or published, in the menu or not); one page opens
// its editor: title, words (Markdown + Preview), Published. Its link,
// picture and menu place sit under "More details".
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { ConfirmDelete, ImageField, MarkdownField, SiteLink, Switch, slugify, useSave } from '../components/WebsiteBits.jsx';

const title = (p) => (p.slug === 'home' ? 'Front page welcome' : p.title);

function PageList() {
  const q = useQuery({ queryKey: ['site-pages'], queryFn: () => apiGet('/site/pages') });
  const pages = q.data?.pages ?? [];
  return (
    <>
      <div className="ws-subhead">
        <h2>Pages</h2>
        <Link className="btn btn-primary ops-tap" to="/website/pages/new">New page</Link>
      </div>
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && !pages.length && <p className="ops-empty">No pages yet.</p>}
      <ul className="ops-rows">
        {pages.map((p) => (
          <li key={p.id} className="ops-item">
            <Link className="ops-row" to={`/website/pages/${p.id}`}>
              <span className="ops-row__main">
                <span className="ops-row__name">{title(p)}</span>
                <span className="ops-row__sub">{p.slug === 'home' ? 'Under the big picture' : `/${p.slug}${p.show_in_nav ? ' · In the menu' : ''}`}</span>
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

function PageEditor({ id }) {
  const navigate = useNavigate();
  const isNew = id === 'new';
  const q = useQuery({ queryKey: ['site-page', id], queryFn: () => apiGet(`/site/pages/${id}`), enabled: !isNew });
  const [f, setF] = useState(null);
  const [more, setMore] = useState(false);
  const save = useSave();
  useEffect(() => {
    if (isNew) setF({ title: '', slug: '', body: '', hero_image: null, show_in_nav: true, nav_order: 50, published: false });
    else if (q.data?.page) setF({ ...q.data.page, slug: q.data.page.slug });
  }, [isNew, q.data]);
  if (!isNew && noSignal(q)) return <NoSignal />;
  if (!isNew && q.isError) return <p className="error" role="alert">{q.error.message}</p>;
  if (!f) return <p className="muted">Loading…</p>;
  const set = (k) => (v) => { save.clearSaved(); setF((x) => ({ ...x, [k]: v })); };
  const home = f.slug === 'home' && !isNew;

  const submit = async (e) => {
    e.preventDefault();
    const input = {
      title: f.title.trim(), body: f.body, hero_image: f.hero_image || null, show_in_nav: !!f.show_in_nav,
      nav_order: Number(f.nav_order) || 0, published: !!f.published,
    };
    if (!isNew) input.id = id;
    if (!home && f.slug && (isNew || f.slug !== q.data.page.slug)) input.slug = f.slug;
    const res = await save.run('site.page.save', input);
    if (res && isNew) navigate(`/website/pages/${res.page.id}`, { replace: true, state: { saved: true } });
  };
  const del = async () => {
    if (await save.run('site.page.delete', { id })) navigate('/website/pages');
  };

  return (
    <form className="ws-editor" onSubmit={submit}>
      <Link className="ops-back" to="/website/pages">← Pages</Link>
      <div className="field">
        <label htmlFor="pg-title">Title</label>
        <input id="pg-title" className="input ws-title-input" required maxLength={120} value={f.title}
          onChange={(e) => set('title')(e.target.value)} placeholder="About" autoFocus={isNew} />
      </div>
      <MarkdownField id="pg-body" label="Words" value={f.body} onChange={set('body')} placeholder="Write here." />
      <Switch label="Published" checked={!!f.published} onChange={set('published')} />

      <button type="button" className="ot-more disclose disclose--inline ws-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>More details</button>
      {more && (
        <div className="ws-more-body">
          {!home && (
            <div className="field">
              <label htmlFor="pg-slug">Link</label>
              <input id="pg-slug" className="input mono" value={f.slug} placeholder={slugify(f.title) || 'about'}
                onChange={(e) => set('slug')(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} />
              <span className="ops-meta">/{f.slug || slugify(f.title) || '…'}</span>
            </div>
          )}
          <ImageField label="Top picture" value={f.hero_image} onChange={set('hero_image')} wide />
          {!home && <Switch label="In the menu" checked={!!f.show_in_nav} onChange={set('show_in_nav')} />}
          {!home && (
            <div className="field ws-narrow-field">
              <label htmlFor="pg-order">Menu position</label>
              <input id="pg-order" className="input mono" inputMode="numeric" value={f.nav_order}
                onChange={(e) => set('nav_order')(e.target.value.replace(/[^\d]/g, ''))} />
              <span className="ops-meta">Lower comes first. Settings → Menu sets the full order.</span>
            </div>
          )}
        </div>
      )}
      {save.error && <p className="error" role="alert">{save.error}</p>}
      <div className="ws-save-row">
        <button type="submit" className="btn btn-primary ops-tap" disabled={save.busy || !f.title.trim()}>{save.busy ? 'Saving…' : 'Save'}</button>
        {save.saved && <span className="ops-done" role="status">Saved</span>}
        {!isNew && q.data?.page && <SiteLink path={q.data.page.slug === 'home' ? '/' : `/${q.data.page.slug}`} published={q.data.page.published || q.data.page.slug === 'home'} />}
        <span className="spacer" />
        {!isNew && <ConfirmDelete what="this page" onYes={del} busy={save.busy} />}
      </div>
    </form>
  );
}

export default function WebsitePages({ id }) {
  return id ? <PageEditor key={id} id={id} /> : <PageList />;
}
