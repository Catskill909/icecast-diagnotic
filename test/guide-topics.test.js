/* ═══════════════════════════════════════════════════════════════════════════
   The in-app guide must actually render

   Nothing checked this page. It is one large array of literals with no build
   step, so a stray quote or a missing field fails silently in the browser: the
   nav renders, the topic is blank or absent, and every test still passes.

   It also drifts. The guide is where an operator goes to understand a figure
   they do not believe, so a panel the guide does not describe is a panel that
   gets mistrusted or misread — which is exactly what happened with the
   geography map before it was documented here.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../public/guide.js'), 'utf8');

/** The literal array, evaluated on its own — no DOM needed. */
function topics() {
  const start = src.indexOf('const TOPICS = [');
  assert.ok(start > -1, 'TOPICS array not found');
  const body = src.slice(start, src.indexOf('\n  ];', start) + 5);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${body}; this.out = TOPICS;`, ctx);
  return ctx.out;
}

test('every topic has the fields the renderer reads', () => {
  for (const t of topics()) {
    assert.ok(t.id, `a topic has no id: ${JSON.stringify(t).slice(0, 80)}`);
    assert.ok(t.title, `${t.id}: no title`);
    assert.ok(t.lead, `${t.id}: no lead`);
    assert.ok(Array.isArray(t.body) && t.body.length, `${t.id}: no body`);
    for (const p of t.body) {
      assert.equal(typeof p, 'string', `${t.id}: a body entry is not a string`);
      assert.ok(p.trim().length > 0, `${t.id}: an empty paragraph`);
    }
  }
});

test('topic ids are unique — the nav links to them by id', () => {
  /* Array.from, not .map: the topics come out of a vm context, so .map returns
     an array built with THAT realm's Array.prototype and deepStrictEqual fails
     on the prototype rather than the contents. */
  const ids = Array.from(topics(), (t) => t.id);
  const unique = [...new Set(ids)];
  assert.deepEqual(unique, ids, `duplicate topic id among: ${ids.join(', ')}`);
});

test('no topic body contains an unclosed tag or a stray backtick', () => {
  for (const t of topics()) {
    for (const p of t.body) {
      const open = (p.match(/<(strong|em|code)>/g) || []).length;
      const close = (p.match(/<\/(strong|em|code)>/g) || []).length;
      assert.equal(open, close, `${t.id}: ${open} opening tags, ${close} closing`);
      assert.ok(!p.includes('`'), `${t.id}: a backtick survived into the rendered text`);
    }
  }
});

/* The panels a reader is most likely to disbelieve. Each of these has produced
   a real "why is this number wrong" question; the guide must answer each. */
test('the guide covers the panels that get misread', () => {
  const all = topics();
  const ids = Array.from(all, (t) => t.id);
  for (const id of ['audience', 'geography', 'royalties', 'impact', 'access']) {
    assert.ok(ids.includes(id), `the guide has no "${id}" topic`);
  }

  const geo = all.find((t) => t.id === 'geography');
  const text = geo.body.join(' ');
  // The two-clock distinction is the whole reason this topic exists.
  assert.match(text, /two maps/i, 'the geography topic must explain the two maps');
  assert.match(text, /cannot be filled in backwards/i, 'and why history cannot be backfilled');
  assert.match(text, /state, not your signal area/i, 'and that in-market is a state');

  /* The two gates are fixed by different people, so the guide has to separate
     them or a reader chases the wrong one. */
  const access = all.find((t) => t.id === 'access');
  const at = access.body.join(' ');
  assert.match(at, /Counting <em>how many<\/em> people are\s+listening needs nothing special/,
    'the one-sentence rule must survive edits');
  assert.match(at, /belongs to the SERVER, not to the station/,
    'a station split across two servers is the case that misleads');
  assert.match(at, /different problems/,
    '"sign in" and "needs an admin password" must not be conflated');
});
