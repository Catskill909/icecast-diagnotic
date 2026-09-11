/* ═══════════════════════════════════════════════════════════════════════════
   Saying which figures need an Icecast admin password, once

   TWO GATES, and they are not the same thing:

     · "Sign in" is about the READER and takes ten seconds;
     · "no admin password for this server" is about the DEPLOYMENT and needs a
       station engineer.

   A single grey box for both sends the first reader looking for the wrong
   person, so they are worded and styled apart.

   THE CASE THAT MATTERS MOST is neither of those. A station carried on TWO
   servers, with a password for one, gets real figures covering PART of itself —
   and presented silently they read as the whole station. On this network that
   is KPFA: one channel on Pacifica's host, one on its own. An understated
   number presented as complete is worse than a missing one, because nobody
   goes looking for it.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../public/listeners.js'), 'utf8');
const start = src.indexOf('  function coverageBand(d) {');
const slice = src.slice(start, src.indexOf('  /* ── When each region listens ──', start));

function render(detailCoverage) {
  const ctx = {
    esc: (x) => String(x == null ? '' : x),
    Array, Object, String,
  };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return { band: ctx.coverageBand({ detailCoverage }), ctx };
}
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const ch = (id, name, host, covered) => ({ id, name, host, covered });

test('a fully covered station says nothing at all', () => {
  const { band } = render({
    channels: [ch('kpft-main', 'KPFT Main', 'streams.pacifica.org:9000', true)],
    covered: 1, total: 1, uncoveredHosts: [],
  });
  assert.equal(band, '', 'there is nothing to explain, so the page stays clean');
});

test('nothing covered explains the split and names the server to ask about', () => {
  const t = text(render({
    channels: [
      ch('wbai-verizon', 'WBAI (Verizon)', 'streaming.wbai.org', false),
      ch('wbai-spectrum', 'WBAI (Spectrum)', 'streaming.wbai.org', false),
    ],
    covered: 0, total: 2, uncoveredHosts: ['streaming.wbai.org'],
  }).band);

  assert.match(t, /Advanced audience data is off/);
  assert.match(t, /streaming\.wbai\.org/, 'naming the server is what makes it actionable');
  assert.match(t, /Counting how many people are listening needs nothing special/,
    'the reader must know the rest of the page is unaffected');
  assert.match(t, /admin/i);
});

test('three channels on one server name that server once, not three times', () => {
  const t = text(render({
    channels: [
      ch('a', 'A', 'streaming.wbai.org', false),
      ch('b', 'B', 'streaming.wbai.org', false),
      ch('c', 'C', 'streaming.wbai.org', false),
    ],
    covered: 0, total: 3, uncoveredHosts: ['streaming.wbai.org'],
  }).band);
  assert.equal((t.match(/streaming\.wbai\.org/g) || []).length, 1, 'one server is one thing to fix');
});

/* ── The KPFA case ───────────────────────────────────────────────────────── */

test('a PARTIALLY covered station says so, and how much', () => {
  const t = text(render({
    channels: [
      ch('kpfa', 'KPFA HiRes Stream', 'streams.pacifica.org:9000', true),
      ch('kpfa-kpfa-berkeley', 'KPFA Berkeley', 'streams.kpfa.org:8443', false),
    ],
    covered: 1, total: 2, uncoveredHosts: ['streams.kpfa.org:8443'],
  }).band);

  assert.match(t, /cover 1 of 2 channels/, 'the figures below describe half the station');
  assert.match(t, /KPFA Berkeley/, 'and it names WHICH half is missing');
  assert.match(t, /streams\.kpfa\.org:8443/);
  assert.match(t, /Everything ABOVE this section covers the whole station/,
    'the listener counts above are complete and must not be doubted along with these');
});

test('the partial case is marked apart from the off case', () => {
  const partial = render({
    channels: [ch('a', 'A', 'h1', true), ch('b', 'B', 'h2', false)],
    covered: 1, total: 2, uncoveredHosts: ['h2'],
  }).band;
  const off = render({
    channels: [ch('b', 'B', 'h2', false)],
    covered: 0, total: 1, uncoveredHosts: ['h2'],
  }).band;

  assert.match(partial, /cov-partial/,
    'a number on screen that should be read differently is not the same as no number');
  assert.doesNotMatch(off, /cov-partial/);
});

test('one missing channel reads as singular, several as plural', () => {
  const one = text(render({
    channels: [ch('a', 'A', 'h1', true), ch('b', 'KPFA Berkeley', 'h2', false)],
    covered: 1, total: 2, uncoveredHosts: ['h2'],
  }).band);
  assert.match(one, /KPFA Berkeley is carried on/);

  const many = text(render({
    channels: [ch('a', 'A', 'h1', true), ch('b', 'B', 'h2', false), ch('c', 'C', 'h2', false)],
    covered: 1, total: 3, uncoveredHosts: ['h2'],
  }).band);
  assert.match(many, /B, C are carried on/);
});

test('an absent or empty coverage block renders nothing rather than guessing', () => {
  assert.equal(render(null).band, '');
  assert.equal(render(undefined).band, '');
  assert.equal(render({ channels: [], covered: 0, total: 0, uncoveredHosts: [] }).band, '');
});

test('it never uses the word that would send a reader to the sign-in page', () => {
  const t = text(render({
    channels: [ch('b', 'B', 'streaming.wbai.org', false)],
    covered: 0, total: 1, uncoveredHosts: ['streaming.wbai.org'],
  }).band);
  assert.doesNotMatch(t, /Sign in/i,
    'the two gates are fixed by different people and must not be confused');
});
