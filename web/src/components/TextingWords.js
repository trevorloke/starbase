// Texting — the first text's fill-ins. The campaign's template stores
// {{first_name}} / {{my_name}} / {{campaign}}; Texting settings shows them as
// "[first name]" / "[your name]" / "[campaign]" with "+ First name",
// "+ Your name" and "+ Campaign" buttons (the ladder email's, FillWords.js),
// and the Calls card fills them in (fillTemplate) before anyone taps Send.
// Plain JS (no JSX) so the server's tests can check the two agree.
import { fillWords } from './FillWords.js';

export const { FILLS, toWords, toCodes, unfilled } = fillWords([
  { key: 'first_name', word: '[first name]', button: '+ First name', typed: /\[\s*first[\s_-]*name\s*\]/gi, hint: /name/i },
  { key: 'my_name', word: '[your name]', button: '+ Your name', typed: /\[\s*(?:your|my)[\s_-]*name\s*\]/gi, hint: /(?:your|my)[\s_-]*name/i, rank: 1 },
  { key: 'campaign', word: '[campaign]', button: '+ Campaign', typed: /\[\s*campaign\s*\]/gi, hint: /camp/i, rank: 2 },
]);

const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// "Hi {{first_name}}, it's {{my_name}} with {{campaign}}." → "Hi Harjit, it's Trevor with Imagine Surrey."
export const fillTemplate = (template, { person, me, campaign }) => String(template || '')
  .replace(/\{\{\s*first_name\s*\}\}/gi, () => first(person?.name))
  .replace(/\{\{\s*my_name\s*\}\}/gi, () => first(me?.user?.name))
  .replace(/\{\{\s*campaign\s*\}\}/gi, () => campaign || me?.workspace?.name || '');
