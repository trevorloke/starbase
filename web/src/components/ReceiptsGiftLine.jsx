// Money → a gift's detail: "Receipt 2026-0007 · Sent" (tap → the receipt),
// or "No receipt — under $25" when the gift is under the threshold.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { fmtBig } from './ReceiptsBits.jsx';

export default function ReceiptsGiftLine({ giftId }) {
  const q = useQuery({
    queryKey: ['receipts', 'gift', giftId],
    queryFn: () => apiGet(`/receipts/gift/${giftId}`),
    enabled: !!giftId,
  });
  if (!q.data) return null;
  const r = q.data.receipt;
  if (!r) {
    const t = Number(q.data.threshold_cents) || 0;
    return <p className="ops-meta rc-giftline--none">No receipt{t > 0 ? ` — under ${fmtBig(t)}` : ''}</p>;
  }
  return (
    <Link className="rc-giftline" to={`/money/receipts/${r.id}`}>
      <span>Receipt <span className="mono">{r.number}</span> · {r.status.word}</span>
    </Link>
  );
}
