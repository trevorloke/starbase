// "Ladders ›" — the way in from Outreach (desk only): a quiet full-width row
// at the foot of every Outreach tab.
import { Link } from 'react-router-dom';
import './ladders-link.css';

export default function LaddersLink() {
  return (
    <Link to="/ladders" className="lad-link">
      <span className="lad-link__main">Ladders</span>
      <span className="lad-link__sub">Automatic emails &amp; follow-ups</span>
      <span className="lad-link__chev" aria-hidden="true">›</span>
    </Link>
  );
}
