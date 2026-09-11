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
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
      classList: { add() {}, remove() {} },
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
      streamIdsFor: (id) => id === 'kpfk' ? ['a'] : [],
      getDistinctDevices: (ids) => ({ devices: ids.length }),
      getReturningDevices: (ids) => ({ current: ids.length, comparable: false, reason: 'nothing-recorded' }),
      getDeviceTrend: (ids) => ({ granularity: 'day', buckets: ids.map(() => ({ key: '2026-09-01', devices: 1, families: {}, platforms: {} })) }),
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
