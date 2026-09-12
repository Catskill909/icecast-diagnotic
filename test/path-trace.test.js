/* ═══════════════════════════════════════════════════════════════════════════
   Route traces: where between the monitor and a server the traffic stops

   2026-09-12: the monitor could not reach streams.pacifica.org for 14 minutes
   while the stations played for everyone else, and nothing recorded the route —
   so "which network failed" could only be guessed. These tests pin the parser,
   the "where did it stop" summary, and the scheduling: a trace once a server has
   missed two checks, repeated at most every 10 minutes and 3 times per episode,
   a daily baseline while healthy, never blocking a cycle, and every trace linked
   to the open incidents on that server.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pathtrace-'));
process.env.SEED_FILE = '/nonexistent';

const pathTrace = require('../path-trace');
const store = require('../store');
const monitor = require('../monitor');

store.load();

/** Real mtr --json shape. Hops 5–6 never answered: the path died after hop 4. */
const DIES_AT_HOP_4 = JSON.stringify({ report: { mtr: { dst: '68.168.105.107', tests: 5 }, hubs: [
  { count: 1, host: '144.126.148.1', 'Loss%': 0, Snt: 5, Avg: 0.4, Best: 0.3, Wrst: 0.6 },
  { count: 2, host: '62.141.47.1', 'Loss%': 0, Snt: 5, Avg: 1.1, Best: 0.9, Wrst: 1.4 },
  { count: 3, host: '64.125.199.194', 'Loss%': 20, Snt: 5, Avg: 38.2, Best: 35.0, Wrst: 44.1 },
  { count: 4, host: '216.55.160.12', 'Loss%': 60, Snt: 5, Avg: 81.0, Best: 79.9, Wrst: 83.5 },
  { count: 5, host: '???', 'Loss%': 100, Snt: 5, Avg: 0, Best: 0, Wrst: 0 },
  { count: 6, host: '???', 'Loss%': 100, Snt: 5, Avg: 0, Best: 0, Wrst: 0 },
] } });

/** Team Cymru answers for the fixture addresses — no real DNS in tests. */
const CYMRU = {
  '1.148.126.144.origin.asn.cymru.com': '40021 | 144.126.148.0/22 | US | arin | 2021-03-16',
  '1.47.141.62.origin.asn.cymru.com': '40021 | 62.141.47.0/24 | US | arin | 2021-03-16',
  '194.199.125.64.origin.asn.cymru.com': '6461 | 64.125.0.0/16 | US | arin | 2000-01-01',
  '12.160.55.216.origin.asn.cymru.com': '18501 | 216.55.160.0/24 | US | arin | 2024-08-09',
  '107.105.168.68.origin.asn.cymru.com': '18501 | 68.168.105.0/24 | US | arin | 2024-08-09',
  'AS40021.asn.cymru.com': '40021 | US | arin | 2023-05-16 | CONTABO-40021 - Contabo Inc., US',
  'AS6461.asn.cymru.com': '6461 | US | arin | 2000-01-01 | ZAYO-6461 - Zayo Bandwidth, US',
  'AS18501.asn.cymru.com': '18501 | US | arin | 2024-08-09 | JOESD-18501 - CyberCloud Professionals LLC, US',
};
const FAKE_CYMRU = async (name) => { if (!CYMRU[name]) throw new Error('ENOTFOUND'); return [[CYMRU[name]]]; };

test('names whose network the break is in: the server\'s, the monitor\'s, or transit between', async () => {
  pathTrace._clearAsnCache();
  const mk = (lastIp) => ({ ok: true, reachedTarget: false, target: '68.168.105.107',
    hops: [{ hop: 1, host: '144.126.148.1', lossPct: 0 }, { hop: 2, host: lastIp, lossPct: 50 }, { hop: 3, host: '???', lossPct: 100 }],
    lastAnsweringHop: { hop: 2, host: lastIp } });
  const inTarget = await pathTrace.annotateNetworks(mk('216.55.160.12'), { resolveTxt: FAKE_CYMRU });
  const inSource = await pathTrace.annotateNetworks(mk('62.141.47.1'), { resolveTxt: FAKE_CYMRU });
  const inTransit = await pathTrace.annotateNetworks(mk('64.125.199.194'), { resolveTxt: FAKE_CYMRU });
  assert.strictEqual(inTarget.stopsIn, 'target');
  assert.strictEqual(inSource.stopsIn, 'source');
  assert.strictEqual(inTransit.stopsIn, 'transit');
  assert.match(pathTrace.networkLabel(inTransit.lastAnsweringHop.network), /Zayo.*AS6461/);
  assert.strictEqual(await pathTrace.lookupNetwork('10.0.0.1', { resolveTxt: FAKE_CYMRU }), null, 'private addresses have no owner to look up');
});

test('parses mtr JSON and names the last hop that answered', () => {
  const hops = pathTrace.parseMtrJson(DIES_AT_HOP_4);
  assert.strictEqual(hops.length, 6);
  const sum = pathTrace.summarise(hops, '68.168.105.107');
  assert.strictEqual(sum.reachedTarget, false);
  assert.deepStrictEqual(sum.lastAnsweringHop, { hop: 4, host: '216.55.160.12', lossPct: 60, avgMs: 81.0 });
});

test('a trace whose final hop is the server counts as reaching it', () => {
  const hops = pathTrace.parseMtrJson(JSON.stringify({ report: { hubs: [
    { count: 1, host: '144.126.148.1', 'Loss%': 0 }, { count: 2, host: '68.168.105.107', 'Loss%': 0, Avg: 80 },
  ] } }));
  assert.strictEqual(pathTrace.summarise(hops, '68.168.105.107').reachedTarget, true);
});

test('runTrace uses TCP to the stream port and never throws — a missing tool is a record', async () => {
  let args;
  const ok = await pathTrace.runTrace('streams.pacifica.org:9000', {
    reason: 'unreachable', resolvedIp: '68.168.105.107', resolveTxt: FAKE_CYMRU,
    run: (cmd, a, _o, cb) => { args = [cmd, ...a]; cb(null, DIES_AT_HOP_4, ''); },
  });
  assert.ok(args.includes('--tcp') && args[args.indexOf('--port') + 1] === '9000', `mtr must trace TCP to port 9000: ${args}`);
  assert.strictEqual(args.at(-1), '68.168.105.107', 'trace the address the probe actually used');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.lastAnsweringHop.hop, 4);

  // Who owns the hop where it stopped — hop 4 is inside the server's own network.
  assert.strictEqual(ok.lastAnsweringHop.network.asn, 18501);
  assert.strictEqual(ok.stopsIn, 'target', 'a trace dying inside the server\'s network must say so');
  assert.match(pathTrace.networkLabel(ok.targetNetwork), /CyberCloud/);

  const missing = await pathTrace.runTrace('streams.pacifica.org:9000', {
    run: (_c, _a, _o, cb) => { const e = new Error('spawn mtr ENOENT'); e.code = 'ENOENT'; cb(e, '', ''); },
  });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /not installed/);
});

// ── Scheduling ──────────────────────────────────────────────────────────────

const HOST = 'streams.example.org:9000';
const MIN = 60000;
const T0 = Date.UTC(2026, 8, 12, 20, 52);
const at = (m) => new Date(T0 + m * MIN).toISOString();
const snapAt = (reachable) => ({ servers: [{ host: HOST, reachable, timings: { ip: '68.168.105.107' } }] });

store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: HOST, statusUrl: `https://${HOST}/status-json.xsl` }],
  stations: [{ id: 'st', name: 'St', timezone: 'UTC', alerts: { enabled: false, recipients: [] },
    channels: [{ id: 'ch', name: 'Ch', url: `https://${HOST}/ch_128`, mounts: ['/ch_128'] }] }],
});
monitor.reloadConfig();

test('traces after two misses, repeats every 10 minutes at most 3 times, baselines daily, links to open incidents', async () => {
  const calls = [];
  monitor._resetTraceState();
  monitor._setTraceRunner(async (host, { reason, resolvedIp }) => {
    calls.push({ reason, resolvedIp });
    return { host, reason, startedAt: new Date().toISOString(), ok: true, hops: [], reachedTarget: false };
  });

  // Healthy at start: no baseline on record → one baseline.
  await Promise.all(monitor._scheduleTraces(snapAt(true), at(0)));
  assert.deepStrictEqual(calls.map((c) => c.reason), ['baseline']);

  const open = store.addEvent({ timestamp: at(1), streamId: 'ch', streamName: 'Ch', type: 'down', severity: 'brief_outage' });

  // Unreachable for 45 minutes.
  for (let m = 1; m <= 45; m++) await Promise.all(monitor._scheduleTraces(snapAt(false), at(m)));
  const failing = calls.filter((c) => c.reason === 'unreachable');
  assert.strictEqual(failing.length, 3, `expected 3 traces in a 45-minute outage, got ${failing.length}`);
  assert.strictEqual(failing[0].resolvedIp, '68.168.105.107');

  const linked = store.getEvents({ streamId: 'ch' }).events.find((e) => e.id === open.id);
  assert.strictEqual((linked.pathTraceIds || []).length, 3, 'traces taken during the incident must be linked to it');

  // Healthy again the same day: the baseline is fresh, so no new one.
  await Promise.all(monitor._scheduleTraces(snapAt(true), at(46)));
  assert.strictEqual(calls.filter((c) => c.reason === 'baseline').length, 1);

  monitor._setTraceRunner(null);
});

test('a trace in progress never blocks the check cycle', async () => {
  monitor._resetTraceState();
  let release;
  monitor._setTraceRunner(() => new Promise((r) => { release = r; }));
  const t = Date.now();
  monitor._scheduleTraces(snapAt(false), at(100));            // first miss
  const jobs = monitor._scheduleTraces(snapAt(false), at(112)); // second miss → trace starts
  assert.ok(Date.now() - t < 50, 'scheduling waited on the trace');
  assert.strictEqual(jobs.length, 1, 'the trace should have started');
  const again = monitor._scheduleTraces(snapAt(false), at(124));
  assert.strictEqual(again.length, 0, 'a second trace started while the first was still running');
  release?.({ host: HOST, reason: 'unreachable', startedAt: at(101), ok: false, error: 'x' });
  monitor._setTraceRunner(null);
});
