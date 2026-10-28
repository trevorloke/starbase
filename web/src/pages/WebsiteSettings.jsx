// Website → Settings: the site's words, colours, links and store options,
// in plain groups with one Save. The "Authorized by" line is marked needed —
// BC election advertising carries one; the campaign writes its own words.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, dollarsToCents } from '../api.js';
import { ImageField, Switch, useSave } from '../components/WebsiteBits.jsx';
import { SOCIALS } from './WebsiteTeam.jsx';

const SECTIONS = [['news', 'News'], ['events', 'Events'], ['team', 'Team'], ['store', 'Store']];
const HEX = /^#[0-9a-fA-F]{6}$/;

function Colour({ id, label, value, onChange }) {
  return (
    <div className="field ws-colour">
      <label htmlFor={id}>{label}</label>
      <div className="ws-colour__row">
        <input type="color" aria-label={`${label} picker`} value={HEX.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
        <input id={id} className={`input mono${HEX.test(value) ? '' : ' ws-bad'}`} value={value} maxLength={7} onChange={(e) => onChange(e.target.value.trim())} />
      </div>
    </div>
  );
}

// The menu, in order: the site's sections and the pages set to show in it.
function MenuOrder({ order, hidden, onOrder, onHidden }) {
  const pages = useQuery({ queryKey: ['site-pages'], queryFn: () => apiGet('/site/pages') });
  const items = [
    ...SECTIONS.map(([k, label]) => ({ key: k, label, section: true })),
    ...(pages.data?.pages ?? []).filter((p) => p.slug !== 'home' && p.show_in_nav)
      .map((p) => ({ key: `page:${p.slug}`, label: p.title, draft: !p.published })),
  ];
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? 1000 : i; };
  const sorted = [...items].sort((a, b) => rank(a.key) - rank(b.key));
  const move = (i, d) => {
    const keys = sorted.map((x) => x.key);
    const [k] = keys.splice(i, 1);
    keys.splice(i + d, 0, k);
    onOrder(keys);
  };
  return (
    <ol className="ws-menu">
      {sorted.map((it, i) => (
        <li key={it.key}>
          <span className="ws-menu__name">{it.label}{it.draft && <span className="chip ops-chip-muted">Draft</span>}</span>
          {it.section && (
            <label className="ot-check ws-menu__show">
              <input type="checkbox" checked={!hidden.includes(it.key)} onChange={(e) => onHidden(e.target.checked ? hidden.filter((h) => h !== it.key) : [...hidden, it.key])} />
              <span>Show</span>
            </label>
          )}
          <button type="button" className="btn btn-quiet" disabled={i === 0} aria-label={`Move ${it.label} up`} onClick={() => move(i, -1)}>↑</button>
          <button type="button" className="btn btn-quiet" disabled={i === sorted.length - 1} aria-label={`Move ${it.label} down`} onClick={() => move(i, 1)}>↓</button>
        </li>
      ))}
    </ol>
  );
}

export default function WebsiteSettings({ overview }) {
  const [f, setF] = useState(null);
  const save = useSave();
  useEffect(() => {
    if (overview?.settings && !f) {
      const s = overview.settings;
      setF({ ...s, socials: { ...s.socials }, shipping_fee: (s.shipping_cents / 100).toFixed(2).replace(/\.00$/, ''), membership_fee: ((s.membership_fee_cents || 0) / 100).toFixed(2).replace(/\.00$/, '') });
    }
  }, [overview, f]);
  // Arriving from "Add the Authorized by line": scroll to it.
  useEffect(() => {
    if (f && window.location.hash === '#authorized') document.getElementById('authorized')?.scrollIntoView({ block: 'center' });
  }, [f]);
  if (!f) return <p className="muted">Loading…</p>;
  const set = (k) => (v) => { save.clearSaved(); setF((x) => ({ ...x, [k]: v })); };
  const text = (k, label, props = {}) => (
    <div className="field">
      <label htmlFor={`st-${k}`}>{label}</label>
      <input id={`st-${k}`} className="input" value={f[k] || ''} onChange={(e) => set(k)(e.target.value)} {...props} />
    </div>
  );

  const submit = async (e) => {
    e.preventDefault();
    if (!HEX.test(f.primary) || !HEX.test(f.accent)) { save.setError('Colours look like #003979'); return; }
    const fee = dollarsToCents(f.shipping_fee || '0');
    if (fee == null) { save.setError('Shipping fee: a dollar amount'); return; }
    const memberFee = dollarsToCents(f.membership_fee || '0');
    if (memberFee == null) { save.setError('Membership fee: a dollar amount'); return; }
    await save.run('site.settings.save', {
      title: f.title.trim(), tagline: f.tagline.trim(), seo_description: f.seo_description.trim(),
      hero_headline: f.hero_headline.trim(), hero_text: f.hero_text.trim(), hero_image: f.hero_image || null,
      logo: f.logo || null, mark: f.mark || null,
      donate_label: f.donate_label.trim() || 'Donate', involved_label: f.involved_label.trim() || 'Get involved',
      primary: f.primary, accent: f.accent, contact_email: f.contact_email.trim(), contact_phone: f.contact_phone.trim(),
      socials: Object.fromEntries(SOCIALS.map(([k]) => [k, (f.socials[k] || '').trim()])),
      authorized_by: f.authorized_by.trim(), nav_order: f.nav_order, hidden_sections: f.hidden_sections,
      shipping: !!f.shipping, shipping_cents: fee, pickup: !!f.pickup, pickup_note: f.pickup_note.trim(),
      membership_fee_cents: memberFee,
    });
  };

  return (
    <form className="ws-editor ws-settings" onSubmit={submit}>
      <section className="card ws-group">
        <h2>The site</h2>
        {text('title', 'Site name', { maxLength: 80, placeholder: overview.settings.site_title })}
        {text('tagline', 'Tagline', { maxLength: 160 })}
        <ImageField label="Logo" value={f.logo} onChange={set('logo')} hint="The full-colour logo, a PNG with a transparent background, for the white header. The supplied one is in until you change it." />
        <ImageField label="Star device" value={f.mark} onChange={set('mark')} hint="The star on its own, PNG with a transparent background: the browser tab. The supplied one is in until you change it." />
        <div className="field">
          <label htmlFor="st-seo">Search description</label>
          <textarea id="st-seo" className="input" rows={2} maxLength={300} value={f.seo_description} onChange={(e) => set('seo_description')(e.target.value)} />
          <span className="ops-meta">What Google shows under the site’s name.</span>
        </div>
      </section>

      <section className="card ws-group">
        <h2>Front page</h2>
        {text('hero_headline', 'Headline', { maxLength: 140, placeholder: overview.settings.site_title })}
        <div className="field">
          <label htmlFor="st-hero-text">Line under it</label>
          <textarea id="st-hero-text" className="input" rows={2} maxLength={400} value={f.hero_text} onChange={(e) => set('hero_text')(e.target.value)} />
        </div>
        <ImageField label="Big picture" value={f.hero_image} onChange={set('hero_image')} wide hint="A wide photo, at least 1600px across." />
        <div className="form-row">
          {text('donate_label', 'Donate button', { maxLength: 30 })}
          {text('involved_label', 'Second button', { maxLength: 30 })}
        </div>
      </section>

      <section className="card ws-group" id="authorized">
        <h2>Authorized by <span className="chip chip-warn">Needed</span></h2>
        <div className="field">
          <label htmlFor="st-auth" className="ws-sr">Authorized by line</label>
          <input id="st-auth" className={`input${f.authorized_by.trim() ? '' : ' ws-bad'}`} maxLength={300} value={f.authorized_by}
            onChange={(e) => set('authorized_by')(e.target.value)} placeholder="Authorized by …" />
          <span className="ops-meta">BC election ads carry this line — ask your financial agent for the exact words.</span>
        </div>
      </section>

      <section className="card ws-group">
        <h2>Colours</h2>
        <div className="form-row">
          <Colour id="st-primary" label="Main colour" value={f.primary} onChange={set('primary')} />
          <Colour id="st-accent" label="Accent colour" value={f.accent} onChange={set('accent')} />
        </div>
        <div className="ws-swatch" style={{ background: HEX.test(f.primary) ? f.primary : '#003979' }}>
          <span>{f.title || overview.settings.site_title}</span>
          <span className="ws-swatch__btn" style={{ background: HEX.test(f.accent) ? f.accent : '#c8151b' }}>Button</span>
        </div>
      </section>

      <section className="card ws-group">
        <h2>Contact and social</h2>
        <div className="form-row">
          {text('contact_email', 'Email', { type: 'email', maxLength: 320 })}
          {text('contact_phone', 'Phone', { type: 'tel', maxLength: 40 })}
        </div>
        <div className="ws-socials">
          {SOCIALS.map(([k, label]) => (
            <div className="field" key={k}>
              <label htmlFor={`st-s-${k}`}>{label}</label>
              <input id={`st-s-${k}`} className="input" type="url" inputMode="url" placeholder="https://" value={f.socials[k] || ''}
                onChange={(e) => set('socials')({ ...f.socials, [k]: e.target.value })} />
            </div>
          ))}
        </div>
      </section>

      <section className="card ws-group">
        <h2>Menu</h2>
        <MenuOrder order={f.nav_order || []} hidden={f.hidden_sections || []} onOrder={set('nav_order')} onHidden={set('hidden_sections')} />
        <span className="ops-meta">A section shows once it has something in it.</span>
      </section>

      <section className="card ws-group">
        <h2>Store</h2>
        <Switch label="Ship orders" checked={!!f.shipping} onChange={set('shipping')} />
        {f.shipping && (
          <div className="field ws-narrow-field">
            <label htmlFor="st-fee">Shipping fee (CAD)</label>
            <input id="st-fee" className="input mono" inputMode="decimal" value={f.shipping_fee} onChange={(e) => set('shipping_fee')(e.target.value)} />
          </div>
        )}
        <Switch label="Pick up at the campaign office" checked={!!f.pickup} onChange={set('pickup')} />
        {f.pickup && text('pickup_note', 'Pick-up note', { maxLength: 300, placeholder: 'Free' })}
        <p className="ops-meta">{overview.stripe.configured ? 'Card payments: Stripe is connected.' : 'Connect Stripe: set STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET'}</p>
      </section>

      <section className="card ws-group">
        <h2>Membership</h2>
        <div className="field ws-narrow-field">
          <label htmlFor="st-mfee">Yearly fee (CAD)</label>
          <input id="st-mfee" className="input mono" inputMode="decimal" value={f.membership_fee} onChange={(e) => set('membership_fee')(e.target.value)} />
          <span className="ops-meta">0 for free membership. A fee counts as a contribution under BC law: it goes through Donations like any gift, and the membership turns active when it’s paid. Members must be 14 or older.</span>
        </div>
      </section>

      {save.error && <p className="error" role="alert">{save.error}</p>}
      <div className="ws-save-row ws-save-sticky">
        <button type="submit" className="btn btn-primary ops-tap" disabled={save.busy}>{save.busy ? 'Saving…' : 'Save settings'}</button>
        {save.saved && <span className="ops-done" role="status">Saved</span>}
      </div>
    </form>
  );
}
