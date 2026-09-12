const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* The dashboard's Recent Incidents shows a handful of rows, newest first. On
   2026-09-12 WPFW's outage was still open while five other stations recovered
   after it began — their recoveries filled the rows and the one thing still
   broken was the one thing not shown. An open outage must be on screen however
   many events came after it, and must not read like history. */

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('  const openIncidents = new Set();');
const endMarker = '    wireIncidentRows(container);\n  }';
const loader = source.slice(start, source.indexOf(endMarker, start) + endMarker.length);

function render(incidents) {
  const container = { innerHTML: '' };
  const ctx = {
    $: () => container,
    escapeHtml: (s) => String(s),
    formatTimestamp: (t) => t,
    renderIncidentDetail: () => '',
    wireIncidentRows: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(loader, ctx);
  ctx.renderIncidents(incidents);
  return container.innerHTML;
}

const at = (mins) => new Date(Date.UTC(2026, 8, 12, 20, 52) + mins * 60000).toISOString();

function scenario(openCount) {
  const open = Array.from({ length: openCount }, (_, i) => ({
    id: `open${i}`, timestamp: at(0), type: 'down', severity: 'outage', ongoing: true,
    durationLabel: '1h 14m', message: `OPEN-${i} is DOWN`,
  }));
  // More later events than the panel has rows.
  const later = Array.from({ length: 12 }, (_, i) => ({
    id: `up${i}`, timestamp: at(10 + i), type: 'up', severity: 'recovery',
    durationLabel: '14m', message: `Station ${i} has RECOVERED`,
  }));
  return [...later, ...open];
}

test('an open outage is shown even when more rows than fit came after it', () => {
  const html = render(scenario(1));
  assert.match(html, /OPEN-0 is DOWN/, 'the open outage was pushed off the panel by later events');
  assert.ok(html.indexOf('OPEN-0') < html.indexOf('RECOVERED'), 'the open outage must lead the list');
});

test('every open outage is shown, even more of them than the row limit', () => {
  const html = render(scenario(10));
  for (let i = 0; i < 10; i++) assert.match(html, new RegExp(`OPEN-${i} is DOWN`));
});

test('an open outage reads as ongoing, not as a finished duration', () => {
  const html = render(scenario(1));
  const row = html.slice(html.indexOf('OPEN-0'), html.indexOf('OPEN-0') + 400);
  assert.match(row, /ONGOING/);
  assert.doesNotMatch(row, /lasted/);
});
