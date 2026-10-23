// The words a ladder step is shown in (web/src/components/LaddersWords.js):
// the builder's fields and the step lines say "[first name]" / "[campaign]",
// never the codes, while what's stored underneath stays {{first_name}} /
// {{campaign}} — the very text the server fills in. The email card's number
// has a noun ("67 people said yes").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillIn } from '../ext/ladders/shape.js';

const W = await import('../../web/src/components/LaddersWords.js');

test('codes show as words; words typed are stored as codes', () => {
  assert.equal(W.toWords('Thanks for signing, {{first_name}}'), 'Thanks for signing, [first name]');
  assert.equal(W.toWords('Hi {{ First_Name }} — {{campaign}}'), 'Hi [first name] — [campaign]');
  assert.equal(W.toCodes('Thanks for signing, [first name]'), 'Thanks for signing, {{first_name}}');
  for (const typed of ['[First name]', '[first_name]', '[firstname]', '[ First Name ]']) {
    assert.equal(W.toCodes(`Call ${typed}`), 'Call {{first_name}}', typed);
  }
  assert.equal(W.toCodes('— [Campaign]'), '— {{campaign}}');
  // A round trip through the field changes nothing that was stored.
  for (const stored of ['Thanks, {{first_name}}', 'Thank you for signing for 72 Ave. — {{campaign}}', 'Plain words', '']) {
    assert.equal(W.toCodes(W.toWords(stored)), stored);
  }
  assert.equal(W.toWords(undefined), '');
});

test('what the "+ First name" / "+ Campaign" buttons put in is what the server fills', () => {
  const [first, campaign] = W.FILLS;
  assert.deepEqual([first.button, campaign.button], ['+ First name', '+ Campaign']);
  assert.ok(W.FILLS.every((f) => !/[{}]/.test(f.word) && !/[{}]/.test(f.button)), 'no code on a button or in a field');
  const stored = W.toCodes(`Thanks, ${first.word} — ${campaign.word}`);
  assert.equal(stored, 'Thanks, {{first_name}} — {{campaign}}');
  assert.equal(fillIn(stored, { person: { name: 'Ana Souza' }, campaign: 'Imagine Surrey' }), 'Thanks, Ana — Imagine Surrey');
  assert.equal(W.unfilled(stored), null);
});

test('step lines read in words, not codes', () => {
  assert.equal(W.stepLine({ kind: 'email', subject: 'Thanks for signing, {{first_name}}' }), 'Email · Thanks for signing, [first name]');
  assert.equal(W.stepLine({ kind: 'followup', text: 'Call {{first_name}} to say thanks' }), 'Follow-up · Call [first name] to say thanks');
  assert.equal(W.stepLine({ kind: 'wait', n: 1, unit: 'days' }), 'Wait 1 day');
  assert.equal(W.stepLine({ kind: 'wait', n: 3, unit: 'hours' }), 'Wait 3 hours');
  assert.equal(W.stepLine({ kind: 'tag', tag: 'thanked' }), 'Tag · thanked');
  assert.equal(W.stepLine({ kind: 'stop' }), 'Stop');
});

test('anything that would go out as typed is flagged', () => {
  assert.equal(W.unfilled('Thanks, {first_name}'), '{first_name} won’t fill in — use + First name');
  assert.equal(W.unfilled('From {{campagin}}'), '{{campagin}} won’t fill in — use + Campaign');
  assert.equal(W.unfilled('Hi [name]'), '[name] won’t fill in — use + First name');
  assert.equal(W.unfilled('Hi {{ first_name }}, from {{campaign}}'), null);
  assert.equal(W.unfilled('See the [map] below'), null);
});

test('the email card\'s number says what it counts', () => {
  assert.equal(W.emailWho(67), 'Goes only to people who said yes to email · 67 people said yes');
  assert.equal(W.emailWho(1), 'Goes only to people who said yes to email · 1 person said yes');
  assert.equal(W.emailWho(0), 'Goes only to people who said yes to email · 0 people said yes');
  assert.equal(W.emailWho(undefined), 'Goes only to people who said yes to email · …');
});
