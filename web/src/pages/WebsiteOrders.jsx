// Website → Orders: what people bought in the store. Filter chips: To do
// (paid, packed) · Done · Not paid · All. A row is the buyer, what they
// bought and the total; it opens in place to the items, where it goes and
// the next step (Packed → Shipped / Picked up). Refunded and Cancelled sit
// under "More" (the card refund itself is done in Stripe). Treasurers read.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { StripeNote, canEdit, dollars, useSave } from '../components/WebsiteBits.jsx';

const FILTERS = [['open', 'To do'], ['done', 'Done'], ['unpaid', 'Not paid'], ['all', 'All']];
const STATUS = {
  pending: ['Not paid', 'ops-chip-muted'], paid: ['Paid', 'ops-chip-amber'], packed: ['Packed', 'ops-chip-mark'],
  shipped: ['Shipped', 'chip-ok'], picked_up: ['Picked up', 'chip-ok'], refunded: ['Refunded', 'ops-chip-muted'], cancelled: ['Cancelled', 'ops-chip-muted'],
};
const itemsLine = (o) => o.items.map((l) => `${l.qty} × ${l.name}${l.variant ? ` (${l.variant})` : ''}`).join(', ');
const address = (a) => (a ? [a.name, a.line1, a.line2, [a.city, a.state].filter(Boolean).join(' '), a.postal_code, a.country].filter(Boolean).join('\n') : '');
const when = (ts) => (ts ? new Date(ts).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function OrderRow({ o, editor }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [restock, setRestock] = useState(true);
  const save = useSave();
  const [label, tone] = STATUS[o.status] || [o.status, ''];
  const next = o.status === 'paid' ? ['packed', 'Mark packed']
    : o.status === 'packed' ? (o.fulfilment === 'ship' ? ['shipped', 'Mark shipped'] : ['picked_up', 'Mark picked up']) : null;
  const live = ['paid', 'packed', 'shipped', 'picked_up'].includes(o.status);
  const set = (status, extra = {}) => save.run('store.order.update', { id: o.id, status, ...extra });
  return (
    <li className="ops-item" data-open={open || undefined}>
      <button type="button" className="ops-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ops-row__main">
          <span className="ops-row__name">{o.buyer_name || o.email || 'Not paid yet'}</span>
          <span className="ops-row__sub">{itemsLine(o)}</span>
        </span>
        <span className="ops-row__end">
          <span className="ops-row__amt">{dollars(o.paid_cents ?? o.total_cents)}</span>
          <span className={`chip ${tone}`}>{label}</span>
        </span>
      </button>
      {open && (
        <div className="ops-body ws-order">
          <ul className="list-plain">
            {o.items.map((l, i) => (
              <li key={i}><span>{l.qty} × {l.name}{l.variant ? ` (${l.variant})` : ''}</span><span className="mono">{dollars(l.unit_cents * l.qty)}</span></li>
            ))}
            {o.shipping_cents > 0 && <li><span>Shipping</span><span className="mono">{dollars(o.shipping_cents)}</span></li>}
            <li><b>Total</b><b className="mono">{dollars(o.paid_cents ?? o.total_cents)}</b></li>
          </ul>
          <p className="ws-order__where">
            {o.fulfilment === 'ship' ? <><b>Ship to</b><br /><span className="ws-pre">{address(o.ship_address) || '—'}</span></> : <b>Pick up at the campaign office</b>}
          </p>
          <p className="ops-meta">
            {[o.email, o.phone, o.paid_at ? `Paid ${when(o.paid_at)}` : `Started ${when(o.created_at)}`].filter(Boolean).join(' · ')}
          </p>
          {o.note && <p className="ws-note">{o.note}</p>}
          {editor && (
            <>
              {save.error && <p className="error" role="alert">{save.error}</p>}
              <div className="ops-actions">
                {next && <button type="button" className="btn ops-solid ops-tap" disabled={save.busy} onClick={() => set(next[0])}>{next[1]}</button>}
                {o.status !== 'refunded' && o.status !== 'cancelled' && (
                  <button type="button" className="btn btn-quiet ops-tap" aria-expanded={more} onClick={() => setMore((v) => !v)}>More</button>
                )}
              </div>
              {more && (
                <div className="ws-more-body">
                  {live && (
                    <label className="ot-check">
                      <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
                      <span>Put the items back in stock</span>
                    </label>
                  )}
                  <div className="ops-actions">
                    {live && <button type="button" className="btn ops-tap" disabled={save.busy} onClick={() => set('refunded', { restock })}>Refunded</button>}
                    <button type="button" className="btn ops-danger ops-tap" disabled={save.busy} onClick={() => set('cancelled', { restock: live && restock })}>Cancelled</button>
                  </div>
                  {live && <p className="ops-meta">Refund the card in Stripe too.</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default function WebsiteOrders({ me }) {
  const [filter, setFilter] = useState('open');
  const q = useQuery({ queryKey: ['store-orders', filter], queryFn: () => apiGet(`/store/orders?status=${filter}`) });
  const orders = q.data?.orders ?? [];
  const editor = canEdit(me);
  return (
    <>
      <div className="ws-subhead"><h2>Orders</h2></div>
      <p className="ws-hint">Check with your financial agent how merchandise sales are reported.</p>
      <StripeNote stripe={q.data?.stripe} />
      <div className="ops-seg ops-filter" role="group" aria-label="Show">
        {FILTERS.map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
      </div>
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && !orders.length && <p className="ops-empty">{filter === 'open' ? 'Nothing to send.' : 'No orders.'}</p>}
      <ul className="ops-rows">{orders.map((o) => <OrderRow key={o.id} o={o} editor={editor} />)}</ul>
    </>
  );
}
