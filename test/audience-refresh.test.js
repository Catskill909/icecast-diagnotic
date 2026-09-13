const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.AUDIENCE_SOURCE_ROOT || path.join(__dirname, '..');
const turn = () => new Promise((resolve) => setImmediate(resolve));

function page() {
  const elements = new Map();
  function element(id) {
    const classes = new Set();
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; },
    });
    return elements.get(id);
  }
  const pending = [];
  const window = { AudienceStats: {} };
  const context = {
    window, URL, URLSearchParams, console,
    location: { href: 'https://example.test/listeners.html', search: '' },
    history: { replaceState() {} },
    localStorage: { getItem() {}, setItem() {}, removeItem() {} },
    document: {
      querySelector: (id) => id === '.range-bar' ? null : element(id.replace(/^#/, '')),
      querySelectorAll: () => [], getElementById: element,
      createElement: () => ({ outerHTML: '<option></option>' }),
    },
    fetch(url) {
      if (url === '/api/stations/list') return Promise.resolve({ json: async () => ({ stations: [
        { id: 'kpfk', name: 'KPFK' }, { id: 'kpft', name: 'KPFT' },
      ] }) });
      return new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
    },
  };
  let source = fs.readFileSync(path.join(root, 'public/listeners.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.readData = () => data; })();');
  vm.runInNewContext(source, context);
  return { element, pending, window,
    select(value) { element('station-select').value = value; element('station-select').handlers.change(); },
    range(days) { const btn = { dataset: { days }, classList: { add() {} } };
      element('range-pills').handlers.click({ target: { closest: () => btn } }); },
  };
}
function respond(req, payload, status = 200) {
  req.resolve({ ok: status === 200, status, json: async () => payload });
}
const detail = (n) => ({ credentialedHost: 'test.host', period: {
  devices: n, players: { Chrome: n }, platforms: { Android: n },
}, mounts: [{ mount: '/kpfk', host: 'test.host', connections: n, listeners: n }] });

test('station and range changes refresh both APIs, clear old values, and retain the range', async () => {
  const p = page(); await turn();
  for (const r of p.pending.splice(0)) respond(r, r.url.includes('listener-detail') ? detail(4552) : {});
  await turn();
  for (const r of p.pending.splice(0)) respond(r, detail(4552));
  await turn();
  assert.match(p.element('deep-panel').innerHTML, /4552/);
  p.select('kpfk');
  assert.doesNotMatch(p.element('deep-panel').innerHTML, /4552/);
  assert.equal(p.pending.length, 2);
  for (const r of p.pending.splice(0)) {
    assert.match(r.url, /days=7&stationId=kpfk/);
    respond(r, r.url.includes('listener-detail') ? detail(2101) : {});
  }
  await turn(); assert.match(p.element('deep-panel').innerHTML, /2101/);
  p.range('30');
  assert.equal(p.pending.length, 2);
  for (const r of p.pending.splice(0)) { assert.match(r.url, /days=30&stationId=kpfk/); respond(r, {}); }
  await turn(); p.select('');
  assert.equal(p.pending.length, 2);
  for (const r of p.pending.splice(0)) {
    assert.match(r.url, /days=30$/); respond(r, r.url.includes('listener-detail') ? detail(4552) : {});
  }
  await turn(); assert.match(p.element('deep-panel').innerHTML, /4552/);
});

test('late responses and late failures cannot overwrite the newest station', async () => {
  const p = page(); await turn();
  const old = p.pending.splice(0);
  p.select('kpfk');
  for (const r of p.pending.splice(0)) respond(r, r.url.includes('listener-detail') ? detail(2101) : { marker: 'kpfk' });
  await turn();
  for (const r of old) respond(r, r.url.includes('listener-detail') ? detail(4552) : { marker: 'all' });
  await turn();
  assert.equal(p.window.readData().marker, 'kpfk');
  assert.match(p.element('deep-panel').innerHTML, /2101/);
  assert.doesNotMatch(p.element('deep-panel').innerHTML, /4552/);
  p.select('kpft'); const failed = p.pending.splice(0);
  p.select('kpfk');
  for (const r of p.pending.splice(0)) respond(r, r.url.includes('listener-detail') ? detail(2101) : { marker: 'kpfk' });
  await turn(); failed.forEach((r) => r.reject(new Error('offline'))); await turn();
  assert.equal(p.window.readData().marker, 'kpfk');
  assert.match(p.element('deep-panel').innerHTML, /2101/);
});

test('the station-switch modal stays up until BOTH APIs settle, and only the newest switch closes it', async () => {
  const p = page(); await turn();
  for (const r of p.pending.splice(0)) respond(r, r.url.includes('listener-detail') ? detail(4552) : {});
  await turn();
  const open = () => p.element('busy-scrim').classList.contains('show');
  assert.equal(open(), false, 'the first page load uses its own loading screen, not the modal');

  // Summary data first, listener detail last: closing on the first response
  // would uncover a page whose detail panels still say "Loading…".
  p.select('kpfk');
  assert.equal(open(), true);
  assert.match(p.element('busy-title').textContent, /KPFK/);
  const reqs = p.pending.splice(0);
  respond(reqs.find((r) => !r.url.includes('listener-detail')), {});
  await turn();
  assert.equal(open(), true, 'must not close while listener detail is still loading');
  respond(reqs.find((r) => r.url.includes('listener-detail')), detail(2101));
  await turn(); await turn();
  assert.equal(open(), false);

  // A slow switch finishing after a newer one must not close the newer one's modal.
  p.select('kpft'); const slow = p.pending.splice(0);
  p.select(''); const fresh = p.pending.splice(0);
  for (const r of slow) respond(r, r.url.includes('listener-detail') ? detail(1) : {});
  await turn(); await turn();
  assert.equal(open(), true, 'a superseded load closed the modal over a page still loading');
  assert.match(p.element('busy-title').textContent, /all stations/);
  for (const r of fresh) respond(r, r.url.includes('listener-detail') ? detail(4552) : {});
  await turn(); await turn();
  assert.equal(open(), false);

  // A failure is still a settled load: the modal must not trap the page.
  p.select('kpfk');
  p.pending.splice(0).forEach((r) => r.reject(new Error('offline')));
  await turn(); await turn();
  assert.equal(open(), false, 'a failed switch left the page covered');

  // The range buttons reload the same two APIs, so they get the same modal and
  // the same "wait for both" rule.
  p.range('30');
  assert.equal(open(), true);
  assert.match(p.element('busy-title').textContent, /30 days/);
  const rangeReqs = p.pending.splice(0);
  respond(rangeReqs.find((r) => !r.url.includes('listener-detail')), {});
  await turn();
  assert.equal(open(), true, 'a range change closed before listener detail loaded');
  respond(rangeReqs.find((r) => r.url.includes('listener-detail')), detail(3000));
  await turn(); await turn();
  assert.equal(open(), false);
  p.range('1');
  assert.match(p.element('busy-title').textContent, /24 hours/);
});

test('signed-out and empty results clear previous figures including listening hours', async () => {
  const p = page(); await turn();
  for (const r of p.pending.splice(0)) respond(r, r.url.includes('listener-detail') ? detail(4552) : {});
  await turn(); p.element('ath-panel').innerHTML = 'old hours'; p.element('ath-hint').textContent = 'old timezone';
  p.select('kpfk');
  for (const r of p.pending.splice(0)) respond(r, {}, r.url.includes('listener-detail') ? 401 : 200);
  await turn();
  assert.match(p.element('deep-panel').innerHTML, /Sign in/);
  assert.doesNotMatch(p.element('deep-panel').innerHTML, /4552/);
  assert.equal(p.element('ath-panel').innerHTML, '');
  assert.equal(p.element('ath-hint').textContent, '');
});

test('listener-detail scopes mounts, totals, distribution and geography by host plus path', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = server.indexOf("app.get('/api/listener-detail'");
  const end = server.indexOf("app.get('/api/diagnostics'", start);
  let handler;
  const streams = [
    { id: 'a', url: 'https://one.test/shared', mounts: ['/shared', '/low'] },
    { id: 'b', url: 'https://two.test/shared', mounts: ['/shared'] },
  ];
  const mounts = { 'one.test/shared': { connections: 10, listeners: 9, bots: 1, distinctAddresses: 8 },
    'one.test/low': { connections: 5, listeners: 5 },
    'two.test/shared': { connections: 30, listeners: 30 } };
  vm.runInNewContext(server.slice(start, end), {
    URL, Date, Set,
    app: { get(_route, _auth, fn) { handler = fn; } }, auth: { requireAuth() {} },
    stationOf: (req) => req.query.stationId || null,
    diagnose: { channelMountPaths: (s) => s.mounts },
    monitor: {
      getListenerDetail: () => ({ meta: { distinctAddresses: 40 }, mounts }), getStreams: () => streams,
      // 'split' is the KPFA shape: one station, two channels, two servers,
      // and an admin password for only one of them.
      streamIdsFor: (id) => (id === 'kpfk' ? ['a'] : id === 'split' ? ['a', 'b'] : []),
      adminCredsFor: (host) => (host === 'one.test' ? { user: 'u', password: 'p' } : null),
      credentialedHosts: () => ['one.test'],
      getDistinctDevices: (ids) => ({ devices: ids.length }),
      getReturningDevices: (ids) => ({ current: ids.length, comparable: false, reason: 'nothing-recorded' }),
      getDeviceTrend: (ids) => ({ granularity: 'day', buckets: ids.map(() => ({ key: '2026-09-01', devices: 1, families: {}, platforms: {} })) }),
      getRegionHourProfile: (ids, _s, _u, tz) => ({ regions: ids.map(() => ({ key: 'US:TX', hours: new Array(24).fill(0), total: 1 })), timeZone: tz, total: ids.length }),
      stationTz: (id) => (id === 'kpfk' ? 'America/Los_Angeles' : 'UTC'),
      adminHost: () => 'one.test', geoAvailable: () => ({}), geoAttribution: () => ({}), homeRegion: () => 'CA',
    },
    listenerDetail: { mergeAggregates: (rows) => ({
      channels: rows.map((r) => r.key), places: { placed: rows.reduce((n, r) => n + r.listeners, 0) },
    }) },
  });
  function get(query) { let result; handler({ query }, { json(value) { result = value; } }); return result; }
  const selected = get({ stationId: 'kpfk' });
  assert.equal(selected.mounts.length, 2);
  assert.equal(selected.distinctAddresses, null);
  assert.equal(get({}).distinctAddresses, 40);
  assert.equal(get({ stationId: 'kpfk', mount: '/shared' }).distinctAddresses, 8);
  assert.equal(selected.totals.listeners, 14);
  /* Returning vs new travels in the SAME response as the period it describes.
     A second request would let the two panels describe two different moments. */
  assert.ok(selected.returning, 'the route must surface returning-vs-new');
  assert.equal(selected.returning.comparable, false);
  assert.equal(selected.returning.current, 1, 'scoped to the selected station\'s streams');
  assert.ok(selected.trend, 'the route must surface the device trend');
  assert.equal(selected.trend.buckets.length, 1, 'scoped to the selected station\'s streams');
  assert.ok(selected.regionHours, 'the route must surface the daypart profile');
  assert.equal(selected.regionHours.timeZone, 'America/Los_Angeles',
    'the hour is read on the SELECTED station\'s clock, not the deployment\'s');

  /* A station wholly on the credentialed host: nothing to explain. */
  assert.equal(selected.detailCoverage.covered, 1);
  assert.equal(selected.detailCoverage.total, 1);
  /* Array.from, because the handler ran in a vm: deepStrictEqual compares
     prototypes, and an array built in another realm fails on the prototype
     rather than on its contents. */
  assert.deepEqual(Array.from(selected.detailCoverage.uncoveredHosts), []);

  /* THE KPFA CASE. One station, two channels, two servers, a password for one.
     These figures describe HALF the station, and saying nothing understates it
     as a whole one — which nobody goes looking for. */
  const split = get({ stationId: 'split' });
  assert.equal(split.detailCoverage.covered, 1);
  assert.equal(split.detailCoverage.total, 2);
  assert.deepEqual(Array.from(split.detailCoverage.uncoveredHosts), ['two.test']);
  assert.equal(split.detailCoverage.channels.find((c) => c.id === 'b').covered, false);
  assert.equal(selected.totals.connections, 15);
  assert.equal(selected.places.placed, 14);
  assert.equal(selected.distribution.channels.length, 2);
  assert.equal(get({}).totals.listeners, 44);
  assert.equal(get({ stationId: 'unknown' }).mounts.length, 0);
  assert.equal(get({ stationId: 'kpfk', mount: '/shared' }).totals.listeners, 9);
});

test('late JSON bodies cannot replace a newer range', async () => {
  const p = page(); await turn();
  const bodies = [];
  for (const req of p.pending.splice(0)) {
    req.resolve({ ok: true, status: 200, json: () => new Promise((resolve) => bodies.push(() => resolve(
      req.url.includes('listener-detail') ? detail(4552) : { marker: 'old' }
    ))) });
  }
  await turn(); p.range('1');
  for (const req of p.pending.splice(0)) respond(req, req.url.includes('listener-detail') ? detail(150) : { marker: 'new' });
  await turn(); bodies.forEach((resolve) => resolve()); await turn();
  assert.equal(p.window.readData().marker, 'new');
  assert.match(p.element('deep-panel').innerHTML, /last 24 hours/);
  assert.doesNotMatch(p.element('deep-panel').innerHTML, /4552/);
});

test('historical player totals remain visible when the station has no active listeners', async () => {
  const p = page(); await turn();
  for (const req of p.pending.splice(0)) respond(req, req.url.includes('listener-detail')
    ? { ...detail(2101), mounts: [] } : {});
  await turn();
  assert.match(p.element('deep-panel').innerHTML, /2101/);
  assert.doesNotMatch(p.element('deep-panel').innerHTML, /Infinity|NaN/);
});
