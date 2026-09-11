const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* The dashboard's uptime tile is the third place this codebase has had the same
   defect: an async handler that decides what to paint by reading the CURRENT
   selection after its await, instead of the selection that asked for the data.
   History and Audience were fixed; this exercises the class here, on both the
   success and the failure path — the failure path is where it survived. */

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const loader = source.slice(
  source.indexOf('  let uptimeFetchToken = 0;'),
  source.indexOf('  function setupUptimeRangePills() {'),
);

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const pending = [];
  const painted = [];
  const ctx = {
    console: { error: () => {} },
    uptimeRangeDays: 1,
    UPTIME_RANGE_LABELS: { 1: 'last 24 hours', 7: 'last 7 days', 30: 'last 30 days' },
    applyUptimeValue: (value, opts) => painted.push({ value, detail: (opts || {}).detail }),
    coverageLabel: (d) => `${d} days`,
    calculate24hUptime: () => 99.9,
    fetch: (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
  };
  vm.createContext(ctx);
  vm.runInContext(loader, ctx);
  return { ctx, pending, painted };
}

const ok = (req, body) => req.resolve({ json: async () => body });

test('the request describes the range that asked for it, not a later one', async () => {
  const h = harness();
  h.ctx.uptimeRangeDays = 7;
  h.ctx.refreshUptimeTile();
  const [req] = h.pending.splice(0);
  h.ctx.uptimeRangeDays = 1;          // the reader clicks 24h while 7d is in flight
  assert.match(req.url, /days=7$/);
});

test('a superseded successful response cannot repaint the tile', async () => {
  const h = harness();
  h.ctx.uptimeRangeDays = 7;
  const stale = h.ctx.refreshUptimeTile();
  const [staleReq] = h.pending.splice(0);

  h.ctx.uptimeRangeDays = 1;
  const latest = h.ctx.refreshUptimeTile();
  const [latestReq] = h.pending.splice(0);

  ok(latestReq, { uptime: 98, coverageDays: 1 });
  await latest;
  ok(staleReq, { uptime: 42, coverageDays: 7 });
  await stale;

  assert.equal(h.painted.length, 1);
  assert.equal(h.painted[0].value, 98);
  assert.match(h.painted[0].detail, /last 24 hours/);
});

test('a superseded FAILED response cannot repaint the tile with the local fallback', async () => {
  const h = harness();
  h.ctx.uptimeRangeDays = 7;
  const stale = h.ctx.refreshUptimeTile();
  const [staleReq] = h.pending.splice(0);

  h.ctx.uptimeRangeDays = 1;          // now 24h is selected, so the old catch used to fire
  const latest = h.ctx.refreshUptimeTile();
  const [latestReq] = h.pending.splice(0);

  ok(latestReq, { uptime: 98, coverageDays: 1 });
  await latest;
  staleReq.reject(new Error('network down'));
  await stale;
  await tick();

  assert.equal(h.painted.length, 1, 'the stale 7-day failure must not overwrite the live 24-hour figure');
  assert.equal(h.painted[0].value, 98);
});

test('the fallback still runs when the 24-hour request itself fails', async () => {
  const h = harness();
  h.ctx.uptimeRangeDays = 1;
  const job = h.ctx.refreshUptimeTile();
  const [req] = h.pending.splice(0);
  req.reject(new Error('network down'));
  await job;

  assert.equal(h.painted.length, 1);
  assert.equal(h.painted[0].value, 99.9);
  assert.match(h.painted[0].detail, /last 24 hours/);
});

test('a partial-coverage answer is judged against its own range', async () => {
  const h = harness();
  h.ctx.uptimeRangeDays = 30;
  const job = h.ctx.refreshUptimeTile();
  const [req] = h.pending.splice(0);
  h.ctx.uptimeRangeDays = 1;          // mutate mid-flight; the verdict must ignore this
  ok(req, { uptime: 97, coverageDays: 12 });
  await job;

  assert.equal(h.painted.length, 1);
  assert.match(h.painted[0].detail, /Partial/, '12 of 30 days is partial, even though it exceeds 1 day');
});
