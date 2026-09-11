/* ═══════════════════════════════════════════════════════════════════════════
   Class names used in markup must exist in a stylesheet

   THE CLASS THIS FILE EXISTS TO PREVENT: a section that renders as raw,
   unstyled HTML because someone invented a class name.

   There is no build step and no framework here, which is deliberate — but it
   means NOTHING checks that a class in the markup is a class in the CSS. A
   typo or an invented name fails silently and only in the browser: the page
   still loads, the tests still pass, and the section appears as bare text with
   a default `<details>` triangle.

   That is exactly what shipped on 2026-09-02. The "Where They Listen" section
   was written with `section-help` and `section-help-body`, copied from memory
   rather than from the page, while every other section uses `info-popover`,
   `help-btn` and `info-popover-card`. Neither invented name existed in any
   stylesheet, so the help panel rendered open and unstyled in production.

   Only STATIC class attributes in the HTML are checked. Classes built in
   JavaScript are out of scope: they are composed at runtime (`step-${n}`) and
   a string match on them would be guesswork.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

/* Names that are not styling hooks. A class used purely as a JavaScript or
   test selector is legitimate and has no business in a stylesheet. */
const NOT_STYLE_HOOKS = new Set([
  'material-symbols-outlined',   // the icon font, loaded from its own sheet

  /* PRE-EXISTING AND HARMLESS. These carry no rule of their own and never
     have; they name a structure rather than hook a style, and the elements are
     laid out by their parents. Listed rather than deleted because removing a
     class from working markup is a bigger risk than an unused name, and listed
     rather than ignored so a NEW dead class still fails this test.

     `info-popover` is the notable one: 13 elements use it and no rule matches
     it. What actually styles those controls is `help-btn` on the <summary>,
     which is why the test below checks for THAT and not for this. */
  'info-popover',
  'ih-stat',
  'heatmap-panel',
  'legend-label',
  'summary-card-uptime',
]);

function cssClassNames() {
  const names = new Set();
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(m[1]);
  }
  return names;
}

function htmlClassUses() {
  const uses = [];
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    for (const m of html.matchAll(/\sclass="([^"{}]*)"/g)) {
      for (const cls of m[1].split(/\s+/).filter(Boolean)) uses.push({ file, cls });
    }
  }
  return uses;
}

test('every class in the markup is defined in a stylesheet', () => {
  const defined = cssClassNames();
  const missing = [];
  for (const { file, cls } of htmlClassUses()) {
    if (NOT_STYLE_HOOKS.has(cls)) continue;
    if (!defined.has(cls)) missing.push(`${file}: .${cls}`);
  }
  assert.deepEqual(
    [...new Set(missing)], [],
    'these classes are used in markup but defined in no stylesheet, so the '
    + 'elements render unstyled — a failure visible only in a browser:\n  '
    + [...new Set(missing)].join('\n  '),
  );
});

/* ── THE GAP THIS TEST CLOSES ───────────────────────────────────────────────
   The test above asks whether a class exists in SOME stylesheet. That is not
   the question a browser asks. A page renders a class unstyled whenever the
   sheet defining it is one the page does not LOAD — and every page here loads a
   different set.

   It passed by luck: admin.html loads only admin.css and happens to define
   everything it uses. The moment a shared component is used there, or a rule
   moves between sheets, the first test stays green and the page breaks. */

/** The stylesheets a page actually links, in order. */
function sheetsFor(html) {
  return [...html.matchAll(/href="([a-z0-9.-]+\.css)[^"]*"/gi)].map((m) => m[1]);
}

function classesIn(cssFiles) {
  const names = new Set();
  for (const file of cssFiles) {
    const full = path.join(PUBLIC, file);
    if (!fs.existsSync(full)) continue;
    for (const m of fs.readFileSync(full, 'utf8').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(m[1]);
  }
  return names;
}

test('every class is defined in a stylesheet THAT PAGE LOADS', () => {
  const problems = [];
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    const available = classesIn(sheetsFor(html));
    for (const m of html.matchAll(/\sclass="([^"{}]*)"/g)) {
      for (const cls of m[1].split(/\s+/).filter(Boolean)) {
        if (NOT_STYLE_HOOKS.has(cls)) continue;
        if (!available.has(cls)) problems.push(`${file} uses .${cls} but does not load a sheet defining it`);
      }
    }
  }
  assert.deepEqual(
    [...new Set(problems)], [],
    'a rule the page cannot reach is the same as no rule at all:\n  '
    + [...new Set(problems)].join('\n  '),
  );
});

test('a shared component is defined ONCE, not copied per page', () => {
  /* Two spellings of the same component drift, and the copy that is not being
     looked at is the one that rots. Named explicitly so a third copy fails
     here rather than being noticed as a visual difference between two pages. */
  const shared = ['info-popover-card', 'guide-overlay', 'guide-card'];
  for (const cls of shared) {
    const files = fs.readdirSync(PUBLIC)
      .filter((f) => f.endsWith('.css'))
      .filter((f) => new RegExp(`\\.${cls}[\\s,{:]`).test(fs.readFileSync(path.join(PUBLIC, f), 'utf8')));
    assert.ok(files.length <= 1, `.${cls} is defined in ${files.length} stylesheets: ${files.join(', ')}`);
  }
});

test('EVERY help panel summary carries the class that styles it', () => {
  /* THE ASSERTION THAT MATTERS, and the one that catches the real bug in both
     the places it occurred.

     A `<summary>` with no styled class renders as the browser's default
     disclosure triangle with the help text beside it — the "▼?" that shipped.
     It is `help-btn` on the SUMMARY that makes it a chip; the `info-popover`
     class on the `<details>` matches no rule at all and styles nothing, which
     is exactly why checking for that instead would have passed while the page
     rendered wrong.

     Found twice: the new geography section used invented class names, and
     history.html's five help buttons had never had the class in the first
     place. Both rendered as raw triangles in production. */
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    for (const block of html.match(/<details[\s\S]*?<\/summary>/g) || []) {
      const summary = /<summary([^>]*)>/.exec(block);
      assert.ok(summary, `${file}: a <details> with no <summary>`);
      assert.match(
        summary[1], /class="[^"]*\bhelp-btn\b/,
        `${file}: this <summary> has no help-btn class, so it renders as a bare `
        + `disclosure triangle with its help text spilled beside it:\n  ${summary[0]}`,
      );
    }
  }
});
