// Fill-ins shown as words. A message stores codes ({{first_name}}, what the
// server or the card fills in); every field and line on screen shows words
// ("[first name]") instead, a "+ First name" button puts one where the
// cursor was, and what's typed as those words is stored as the codes. A {…}
// or [… name] that wouldn't fill in is flagged before saving. Plain JS (no
// JSX) so the server's tests can check it. Ladders (LaddersWords.js) and
// texting's first text (TextingWords.js) each pass their own fill-ins:
//
//   fillWords([{ key: 'first_name', word: '[first name]', button: '+ First name',
//                typed: /\[\s*first[\s_-]*name\s*\]/gi, hint: /name/i }, …])
//   → { FILLS, toWords, toCodes, unfilled }
//
// hint: what a stray "[name]" or "{campaign}" near one looks like, so the
// line points to the right button; rank (default 0): which hint wins when
// several match ("{campaign_name}" is the campaign) — higher first.
export function fillWords(fills) {
  const byRank = [...fills].sort((a, b) => (b.rank || 0) - (a.rank || 0));
  const FILLS = fills.map(({ key, word, button }) => ({ code: `{{${key}}}`, word, button }));
  const WORD = Object.fromEntries(fills.map((f) => [f.key, f.word]));
  const codes = () => new RegExp(`\\{\\{\\s*(${fills.map((f) => f.key).join('|')})\\s*\\}\\}`, 'gi');
  const near = new RegExp(`\\[[^[\\]\\n]{0,40}(?:${fills.map((f) => f.hint.source).join('|')})[^[\\]\\n]{0,40}\\]`, 'i');

  // "Hi {{ first_name }}" → "Hi [first name]".
  const toWords = (text) => String(text ?? '').replace(codes(), (_, k) => WORD[k.toLowerCase()]);
  // "Hi [First name]" (or [first_name], [firstname]) → "Hi {{first_name}}".
  const toCodes = (text) => fills.reduce((t, f) => t.replace(f.typed, `{{${f.key}}}`), String(text ?? ''));
  // "{first_name} won't fill in — use + First name": anything in braces that
  // isn't one of the fill-ins, or a [name …] that isn't one, would go out as
  // typed. Takes the stored text (codes).
  const unfilled = (text) => {
    const rest = String(text || '').replace(codes(), '');
    const m = rest.match(/\{+[^{}\n]{0,40}\}*/) || rest.match(/[^\s{}]{0,40}\}+/) || rest.match(near);
    if (!m) return null;
    const hit = byRank.find((f) => f.hint.test(m[0]));
    const use = hit ? hit.button : FILLS.map((f) => f.button).join(' or ');
    return `${m[0].trim()} won’t fill in — use ${use}`;
  };
  return { FILLS, toWords, toCodes, unfilled };
}
