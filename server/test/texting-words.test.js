// The first text's fill-ins (web/src/components/TextingWords.js): Texting
// settings shows "[first name]" / "[your name]" / "[campaign]", never the
// codes, with the ladder email's "+ First name / + Your name / + Campaign"
// buttons; what's stored underneath is the {{…}} codes the Calls card fills
// in — and a first text built from them goes out with nothing left to fill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEMPLATE, hasBlanks, namesCampaign } from '../ext/texting/rules.js';

const W = await import('../../web/src/components/TextingWords.js');
const L = await import('../../web/src/components/LaddersWords.js');

test('the template shows as words; words typed are stored as codes', () => {
  assert.equal(W.toWords(DEFAULT_TEMPLATE), "Hi [first name], it's [your name] with [campaign]. Can we count on your support?");
  assert.equal(W.toCodes(W.toWords(DEFAULT_TEMPLATE)), DEFAULT_TEMPLATE, 'a round trip through the field changes nothing');
  assert.equal(W.toCodes('Hi [First name], [My name] here — [Your Name] from [Campaign]'),
    'Hi {{first_name}}, {{my_name}} here — {{my_name}} from {{campaign}}');
  assert.ok(!/[{}]/.test(W.toWords(DEFAULT_TEMPLATE)), 'no code on screen');
});

test('the buttons are the ladder email\'s, plus "+ Your name"; what they put in is what the card fills', () => {
  assert.deepEqual(W.FILLS.map((f) => f.button), ['+ First name', '+ Your name', '+ Campaign']);
  assert.deepEqual(L.FILLS.map((f) => f.button), ['+ First name', '+ Campaign'], 'ladders keep theirs');
  assert.ok(W.FILLS.every((f) => !/[{}]/.test(f.word) && !/[{}]/.test(f.button)));
  const [first, mine, campaign] = W.FILLS;
  const stored = W.toCodes(`Hi ${first.word}, it's ${mine.word} with ${campaign.word}.`);
  assert.equal(stored, "Hi {{first_name}}, it's {{my_name}} with {{campaign}}.");
  assert.equal(W.unfilled(stored), null);
  const body = W.fillTemplate(stored, { person: { name: 'Harjit Example' }, me: { user: { name: 'Trevor Example' } }, campaign: 'Imagine Surrey' });
  assert.equal(body, "Hi Harjit, it's Trevor with Imagine Surrey.");
  assert.ok(!hasBlanks(body) && namesCampaign(body, 'Imagine Surrey'), 'the server takes it as a first text');
  assert.equal(W.fillTemplate('Hi {{ First_Name }} — $& {{campaign}}', { person: { name: 'Ana' }, campaign: 'Imagine Surrey' }),
    'Hi Ana — $& Imagine Surrey', 'spaced codes fill in; nothing in a name is read as a pattern');
});

test('anything that would go out as typed is flagged, pointing to the right button', () => {
  assert.equal(W.unfilled('Hi {first_name}'), '{first_name} won’t fill in — use + First name');
  assert.equal(W.unfilled('From {{campagin}}'), '{{campagin}} won’t fill in — use + Campaign');
  assert.equal(W.unfilled('It’s {my_name}'), '{my_name} won’t fill in — use + Your name');
  assert.equal(W.unfilled('Hi [name]'), '[name] won’t fill in — use + First name');
  assert.equal(W.unfilled(DEFAULT_TEMPLATE), null);
  assert.equal(W.unfilled('See the [map] below'), null);
  // The ladders' check is unchanged by the shared code underneath.
  assert.equal(L.unfilled('Thanks, {first_name}'), '{first_name} won’t fill in — use + First name');
  assert.equal(L.unfilled('From {{campagin}}'), '{{campagin}} won’t fill in — use + Campaign');
  assert.equal(L.unfilled('Hi {{my_name}}'), '{{my_name}} won’t fill in — use + First name', 'ladders have no "your name"');
});
