// Ladders — the words a step is shown in. An email or a follow-up stores
// {{first_name}} / {{campaign}} (what the server fills in); every field and
// line on screen shows "[first name]" / "[campaign]" instead, and what's
// typed as those words is stored as the codes underneath. Plain JS (no JSX)
// so the server's tests can check it against the server's own fill-in.
// The words, buttons and the won't-fill-in check: FillWords.js.
import { fillWords } from './FillWords.js';

const words = fillWords([
  { key: 'first_name', word: '[first name]', button: '+ First name', typed: /\[\s*first[\s_-]*name\s*\]/gi, hint: /name/i },
  { key: 'campaign', word: '[campaign]', button: '+ Campaign', typed: /\[\s*campaign\s*\]/gi, hint: /camp/i, rank: 1 },
]);
export const { FILLS, toWords, toCodes, unfilled } = words;

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const waitWords = (s) => plural(Number(s.n) || 0, s.unit === 'hours' ? 'hour' : 'day');

// One step as one line: "Wait 1 day", "Email · Thanks, [first name]".
export const stepLine = (s) => {
  if (!s) return '';
  if (s.kind === 'wait') return `Wait ${waitWords(s)}`;
  if (s.kind === 'email') return `Email · ${toWords(s.subject)}`;
  if (s.kind === 'tag') return `Tag · ${s.tag}`;
  if (s.kind === 'untag') return `Remove tag · ${s.tag}`;
  if (s.kind === 'followup') return `Follow-up · ${toWords(s.text)}`;
  return 'Stop';
};

// Under an email card: who it can reach, and how many said yes so far.
export const emailWho = (n) => `Goes only to people who said yes to email · ${
  Number.isFinite(n) ? `${plural(n, 'person', 'people')} said yes` : '…'}`;
