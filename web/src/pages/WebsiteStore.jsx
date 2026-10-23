// Website → Store: the merch for sale. A row per product (photo, price, what's
// left, For sale / Hidden); the editor has name, price, photos, words, sizes
// with how many of each, and For sale. Prices are set here only: Stripe
// charges what Starbase says, so nothing is set up product by product there.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, dollarsToCents } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { ConfirmDelete, MarkdownField, PhotosField, StripeNote, Switch, dollars, slugify, useSave } from '../components/WebsiteBits.jsx';

const leftWords = (p) => {
  if (!p.track_stock) return null;
  if (p.variants.length) {
    const n = p.variants.reduce((a, v) => a + (Number(v.stock) || 0), 0);
    return n ? `${n} left` : 'Sold out';
  }
  return Number(p.stock) ? `${p.stock} left` : 'Sold out';
};

function ProductList({ overview }) {
  const q = useQuery({ queryKey: ['store-products'], queryFn: () => apiGet('/store/products') });
  const list = q.data?.products ?? [];
  return (
    <>
      <div className="ws-subhead">
        <h2>Store</h2>
        <Link className="btn btn-primary ops-tap" to="/website/store/new">New product</Link>
      </div>
      <StripeNote stripe={overview?.stripe} />
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && !list.length && <p className="ops-empty">Nothing for sale yet.</p>}
      <ul className="ops-rows">
        {list.map((p) => (
          <li key={p.id} className="ops-item">
            <Link className="ops-row ws-row-img" to={`/website/store/${p.id}`}>
              {p.images[0] ? <img className="ws-row-thumb is-square" src={`/media/${p.images[0]}`} alt="" loading="lazy" /> : <span className="ws-row-thumb is-square" aria-hidden="true" />}
              <span className="ops-row__main">
                <span className="ops-row__name">{p.name}</span>
                <span className="ops-row__sub">{dollars(p.price_cents)}{leftWords(p) ? ` · ${leftWords(p)}` : ''}</span>
              </span>
              <span className="ops-row__end">
                <span className={`chip ${p.active ? 'chip-ok' : 'ops-chip-muted'}`}>{p.active ? 'For sale' : 'Hidden'}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

const SIZE_PRESETS = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

function ProductEditor({ id }) {
  const navigate = useNavigate();
  const isNew = id === 'new';
  const q = useQuery({ queryKey: ['store-product', id], queryFn: () => apiGet(`/store/products/${id}`), enabled: !isNew });
  const [f, setF] = useState(null);
  const [more, setMore] = useState(false);
  const save = useSave();
  useEffect(() => {
    if (isNew) setF({ name: '', slug: '', price: '', description: '', images: [], variants: [], track_stock: false, stock: '', active: true, position: 100 });
    else if (q.data?.product) {
      const p = q.data.product;
      setF({ ...p, price: (p.price_cents / 100).toFixed(2).replace(/\.00$/, ''), stock: p.stock ?? '', variants: p.variants.map((v) => ({ label: v.label, stock: v.stock ?? '' })) });
    }
  }, [isNew, q.data]);
  if (!isNew && noSignal(q)) return <NoSignal />;
  if (!isNew && q.isError) return <p className="error" role="alert">{q.error.message}</p>;
  if (!f) return <p className="muted">Loading…</p>;
  const set = (k) => (v) => { save.clearSaved(); setF((x) => ({ ...x, [k]: v })); };
  const setVariant = (i, k, v) => set('variants')(f.variants.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  const submit = async (e) => {
    e.preventDefault();
    const cents = dollarsToCents(f.price);
    if (cents == null || cents < 50) { save.setError('Price: at least $0.50'); return; }
    const variants = f.variants.filter((v) => v.label.trim()).map((v) => ({ label: v.label.trim(), stock: f.track_stock ? Number(v.stock) || 0 : null }));
    const input = {
      name: f.name.trim(), price_cents: cents, description: f.description, images: f.images, variants,
      track_stock: !!f.track_stock, stock: f.track_stock && !variants.length ? Number(f.stock) || 0 : null,
      active: !!f.active, position: Number(f.position) || 0,
    };
    if (!isNew) input.id = id;
    if (f.slug && (isNew || f.slug !== q.data.product.slug)) input.slug = f.slug;
    const res = await save.run('store.product.save', input);
    if (res && isNew) navigate(`/website/store/${res.product.id}`, { replace: true, state: { saved: true } });
  };
  const del = async () => {
    if (await save.run('store.product.delete', { id })) navigate('/website/store');
  };
  const missingSizes = SIZE_PRESETS.filter((s) => !f.variants.some((v) => v.label.toLowerCase() === s.toLowerCase()));

  return (
    <form className="ws-editor" onSubmit={submit}>
      <Link className="ops-back" to="/website/store">← Store</Link>
      <div className="form-row">
        <div className="field">
          <label htmlFor="pr-name">Name</label>
          <input id="pr-name" className="input" required maxLength={120} value={f.name} autoFocus={isNew} onChange={(e) => set('name')(e.target.value)} placeholder="Campaign T-shirt" />
        </div>
        <div className="field ws-narrow-field">
          <label htmlFor="pr-price">Price (CAD)</label>
          <input id="pr-price" className="input mono" required inputMode="decimal" value={f.price} onChange={(e) => set('price')(e.target.value)} placeholder="25" />
        </div>
      </div>
      <PhotosField value={f.images} onChange={set('images')} />
      <MarkdownField id="pr-desc" label="Description" rows={5} value={f.description} onChange={set('description')} />

      <div className="field">
        <span className="ws-label">Sizes</span>
        {f.variants.length > 0 && (
          <ul className="ws-sizes">
            {f.variants.map((v, i) => (
              <li key={i}>
                <input className="input" aria-label="Size" maxLength={40} value={v.label} onChange={(e) => setVariant(i, 'label', e.target.value)} />
                {f.track_stock && (
                  <input className="input mono" aria-label={`How many ${v.label || 'of this size'}`} inputMode="numeric" value={v.stock}
                    placeholder="0" onChange={(e) => setVariant(i, 'stock', e.target.value.replace(/[^\d]/g, ''))} />
                )}
                <button type="button" className="btn btn-quiet" aria-label={`Remove ${v.label || 'size'}`} onClick={() => set('variants')(f.variants.filter((_, j) => j !== i))}>✕</button>
              </li>
            ))}
          </ul>
        )}
        <div className="ops-actions ws-size-adds">
          {missingSizes.map((s) => (
            <button key={s} type="button" className="btn btn-quiet ws-size-add" onClick={() => set('variants')([...f.variants, { label: s, stock: '' }])}>+ {s}</button>
          ))}
          <button type="button" className="btn btn-quiet ws-size-add" onClick={() => set('variants')([...f.variants, { label: '', stock: '' }])}>+ Other</button>
        </div>
      </div>
      <Switch label="Count how many are left" checked={!!f.track_stock} onChange={set('track_stock')} />
      {f.track_stock && !f.variants.some((v) => v.label.trim()) && (
        <div className="field ws-narrow-field">
          <label htmlFor="pr-stock">How many</label>
          <input id="pr-stock" className="input mono" inputMode="numeric" value={f.stock} onChange={(e) => set('stock')(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" />
        </div>
      )}
      <Switch label="For sale" checked={!!f.active} onChange={set('active')} />
      <button type="button" className="ot-more disclose disclose--inline ws-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>More details</button>
      {more && (
        <div className="ws-more-body">
          <div className="field">
            <label htmlFor="pr-slug">Link</label>
            <input id="pr-slug" className="input mono" value={f.slug} placeholder={slugify(f.name) || 'product'}
              onChange={(e) => set('slug')(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} />
            <span className="ops-meta">/store/{f.slug || slugify(f.name) || '…'}</span>
          </div>
          <div className="field ws-narrow-field">
            <label htmlFor="pr-pos">Order</label>
            <input id="pr-pos" className="input mono" inputMode="numeric" value={f.position} onChange={(e) => set('position')(e.target.value.replace(/[^\d]/g, ''))} />
          </div>
        </div>
      )}
      {save.error && <p className="error" role="alert">{save.error}</p>}
      <div className="ws-save-row">
        <button type="submit" className="btn btn-primary ops-tap" disabled={save.busy || !f.name.trim()}>{save.busy ? 'Saving…' : 'Save'}</button>
        {save.saved && <span className="ops-done" role="status">Saved</span>}
        <span className="spacer" />
        {!isNew && <ConfirmDelete what="this product" onYes={del} busy={save.busy} />}
      </div>
    </form>
  );
}

export default function WebsiteStore({ id, overview }) {
  return id ? <ProductEditor key={id} id={id} /> : <ProductList overview={overview} />;
}
