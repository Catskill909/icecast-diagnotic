/* ═══════════════════════════════════════════════════════════════════════════
   Help on the admin page

   THE GAP THIS CLOSES: the Audience page carried 16 inline popovers and the
   dashboard a 14-topic guide, while /admin.html had NONE — and it is the page
   where a wrong click orphans a channel's history, silences a station's alerts
   or replaces the whole record.

   THE RULE THE CONTENT FOLLOWS: explain the CONSEQUENCE, never restate the
   label. A popover reading "the station's name" is worse than none, because it
   teaches the reader that the help is not worth opening. The page's existing
   confirmations already set that register — they name what SURVIVES rather than
   asking whether you are sure.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');

function adminTopics() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'admin-guide.js'), 'utf8'), ctx);
  /* Array.from, not the vm's own array. deepStrictEqual compares PROTOTYPES, so
     an array built in another realm fails on the prototype rather than on its
     contents — this is the fourth time in this project. */
  return { topics: Array.from(ctx.window.GUIDE_TOPICS || []), icons: ctx.window.GUIDE_ICONS };
}

/* Bodies are template literals, so they carry the source file's indentation as
   real newlines. Match against the prose, not against the wrapping. */
const flat = (parts) => parts.join(' ').replace(/\s+/g, ' ');

// ── The popovers, at the fields where the decision is made ─────────────────

test('the field you cannot change later explains that, at the field', () => {
  const at = html.indexOf('<label>Identifier');
  assert.ok(at > -1);
  const block = html.slice(at, at + 1400);
  assert.match(block, /info-popover/, 'the highest-stakes field on the page must carry help');
  assert.match(block, /cannot change later/i);
  assert.match(block, /not<\/strong> the station/i, 'and must say what it is NOT — people fill it with the name');
  assert.match(block, /start again from zero/i, 'the consequence, stated');
});

test('a blank state is explained as a real answer, not an omission', () => {
  const at = html.indexOf('<label>State');
  const block = html.slice(at, at + 1200);
  assert.match(block, /blank is a real answer/i);
  assert.match(block, /no figure beats a wrong one/i);
});

test('the timezone popover says what actually depends on it', () => {
  const at = html.indexOf('<label>Timezone');
  const block = html.slice(at, at + 1000);
  assert.match(block, /weekly report/i);
  assert.match(block, /day boundary/i);
});

test('no popover merely restates its label', () => {
  /* The failure mode for help text: "Name — the station's name." Each card must
     say something the label does not, so the cards are required to be
     substantial rather than decorative. */
  const cards = [...html.matchAll(/<div class="info-popover-card">([\s\S]*?)<\/div><\/details>/g)];
  assert.ok(cards.length >= 3, `expected the field popovers, found ${cards.length}`);
  for (const [, body] of cards) {
    const words = body.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
    assert.ok(words > 40, `a ${words}-word popover is decoration, not help`);
  }
});

test('the popover works without an icon font, because this page has none', () => {
  assert.ok(!/material-symbols/i.test(html), 'admin loads no icon font');
  assert.match(html, /class="help-btn help-dot"/, 'so the control is a text glyph');
  const css = fs.readFileSync(path.join(PUBLIC, 'help.css'), 'utf8');
  assert.match(css, /\.help-dot/, 'and it is styled');
});

// ── The guide ──────────────────────────────────────────────────────────────

test('the admin page carries the guide modal and a way to open it', () => {
  assert.match(html, /id="help-modal"/);
  assert.match(html, /id="guide-nav"/);
  assert.match(html, /id="guide-content"/);
  assert.match(html, /id="help-btn"/);
});

test('the topics load before the renderer that reads them', () => {
  const topics = html.indexOf('admin-guide.js');
  const renderer = html.indexOf('guide.js?');
  assert.ok(topics > -1 && renderer > -1);
  assert.ok(topics < renderer, 'guide.js reads window.GUIDE_TOPICS at load — order matters');
});

test('one renderer, two audiences — the file is not forked', () => {
  const guide = fs.readFileSync(path.join(PUBLIC, 'guide.js'), 'utf8');
  assert.match(guide, /window\.GUIDE_TOPICS/, 'the renderer takes its topics from the page');
  assert.match(guide, /window\.GUIDE_ICONS === false/, 'and knows when a page has no icon font');
  assert.ok(!fs.existsSync(path.join(PUBLIC, 'admin-guide-render.js')), 'no second renderer');
});

test('every admin topic is complete enough to render', () => {
  const { topics, icons } = adminTopics();
  assert.equal(icons, false, 'this page has no icon font and must say so');
  assert.ok(topics.length >= 4, `expected the admin topics, found ${topics.length}`);
  const ids = Array.from(topics, (t) => t.id);
  assert.deepEqual([...new Set(ids)], ids, 'duplicate topic id');
  for (const t of topics) {
    assert.ok(t.title && t.lead, `${t.id}: missing title or lead`);
    assert.ok(Array.isArray(t.body) && t.body.length, `${t.id}: no body`);
    for (const p of t.body) {
      assert.equal(typeof p, 'string');
      const open = (p.match(/<(strong|em|code)>/g) || []).length;
      const close = (p.match(/<\/(strong|em|code)>/g) || []).length;
      assert.equal(open, close, `${t.id}: ${open} opening tags, ${close} closing`);
      assert.ok(!p.includes('`'), `${t.id}: a backtick survived into rendered text`);
    }
  }
});

test('the guide answers the question this product will generate most', () => {
  /* "Why does WBAI show fewer audience figures than KPFT?" The answer — a
     password belongs to a SERVER, not a station, and KPFA is on two — does not
     fit in a popover, which is why it is a topic. */
  const { topics } = adminTopics();
  const access = topics.find((t) => t.id === 'access');
  assert.ok(access, 'there must be a topic about credentialed figures');
  const text = flat(access.body);
  assert.match(text, /belongs to the SERVER, not to the station/i);
  assert.match(text, /WBAI/, 'named, because the reader is looking at these stations');
  assert.match(text, /KPFA is\s+on BOTH/i, 'including the one that is split');
  assert.match(text, /Nothing is hidden for being unavailable/i);
});

test('the guide explains that removing something keeps its history', () => {
  const { topics } = adminTopics();
  const text = flat(topics.find((t) => t.id === 'removing').body);
  assert.match(text, /record of what happened while it WAS monitored stays/i);
  assert.match(text, /identifier cannot be changed/i);
});

test('the backup topic explains the salt in plain words, without the jargon', () => {
  const { topics } = adminTopics();
  const text = flat(topics.find((t) => t.id === 'backup').body);
  assert.match(text, /scrambled code/i, 'a reader should not need the word "salt"');
  assert.match(text, /every returning listener looks brand new/i, 'the consequence');
  assert.doesNotMatch(text, /deviceSalt|SHA-?256/i, 'implementation names belong in the README');
});
