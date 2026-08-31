/* ═══════════════════════════════════════════════════════════════════════════
   An email about one station names only that station

   Recipients became per-station so that KPFT's general manager is not paged
   about a transmitter in Los Angeles. The MESSAGE BODY was never scoped to
   match: every alert ended with an "ALL STREAMS OVERVIEW" table rendered from
   every stream the monitor watches.

   So a KPFT outage arrived at gm@kpft.org carrying WPFW's, KPFK's and WBAI's
   live listener counts — the same cross-station exposure per-station recipients
   exist to prevent, reintroduced one layer down where nobody looked. Reported by
   the operator from a test message that listed all eight channels.

   The test path had the same hole for a different reason: the panel never sent
   the station, so the server fell back to "every stream" whenever more than one
   station was configured.

   THE RULE: what a message SAYS is scoped the same way as who it is SENT to.
   sendGroupedAlert() already guarantees every entry in one message shares a
   station, so the body has a station to be scoped by.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alertscope-'));
process.env.SEED_FILE = '/nonexistent';

const monitor = require('../monitor');
const store = require('../store');

store.load();
store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: 'streams.example.org:9000' }],
  stations: [
    {
      id: 'kpft', name: 'KPFT Houston', timezone: 'America/Chicago',
      channels: [
        { id: 'kpft-main', name: 'KPFT Main', url: 'https://streams.example.org:9000/live_128' },
        { id: 'kpft-hd2', name: 'KPFT HD2', url: 'https://streams.example.org:9000/HD3_128' },
      ],
    },
    {
      id: 'wpfw', name: 'WPFW Washington DC', timezone: 'America/New_York',
      channels: [{ id: 'wpfw', name: 'WPFW Washington DC', url: 'https://streams.example.org:9000/wpfw_128' }],
    },
    {
      id: 'kpfk', name: 'KPFK Los Angeles', timezone: 'America/Los_Angeles',
      channels: [{ id: 'kpfk', name: 'KPFK Los Angeles', url: 'https://streams.example.org:9000/kpfk_128' }],
    },
  ],
});
monitor.reloadConfig();

const streamOf = (id) => monitor.getStreams().find((s) => s.id === id);

/** The other stations' channel names — none may appear in a KPFT message. */
const FOREIGN = ['WPFW Washington DC', 'KPFK Los Angeles'];

function kpftOutage() {
  return monitor.composeAlert({
    kind: 'down',
    entries: [{
      stream: streamOf('kpft-main'),
      result: { httpStatus: 404, error: null, errorCode: null, responseTime: 120, timings: {} },
      diagnosis: { cause: 'source_disconnected', causeLabel: 'Source disconnected', scope: 'stream', evidence: [], remediation: [] },
      audience: { listenersBefore: 42 },
    }],
    scope: 'stream',
  });
}

test('a KPFT alert names no other station', () => {
  const { html } = kpftOutage();
  for (const name of FOREIGN) {
    assert.equal(html.includes(name), false,
      `a KPFT outage email named ${name} — that station's figures are not KPFT's to receive`);
  }
});

test('it still names KPFT\'s own channels — not fixed by showing nothing', () => {
  const { html } = kpftOutage();
  assert.ok(html.includes('KPFT Main'), 'the failing channel must appear');
  assert.ok(html.includes('KPFT HD2'), "the station's other channels give context and must appear");
});

test('the streams table is scoped directly', () => {
  const kpft = monitor.renderAllStreamsTable('kpft');
  assert.ok(kpft.includes('KPFT Main') && kpft.includes('KPFT HD2'));
  for (const name of FOREIGN) assert.equal(kpft.includes(name), false);

  const wpfw = monitor.renderAllStreamsTable('wpfw');
  assert.ok(wpfw.includes('WPFW Washington DC'));
  assert.equal(wpfw.includes('KPFT Main'), false);
});

test('no station means every stream — the single-station and whole-monitor case', () => {
  // Not an oversight: a single-station install, and any message genuinely about
  // the whole monitor, still want the full table.
  const all = monitor.renderAllStreamsTable();
  assert.ok(all.includes('KPFT Main') && all.includes('WPFW Washington DC') && all.includes('KPFK Los Angeles'));
});

test('a recovery message is scoped too', () => {
  // Recoveries go to the same people and were built by the same composer.
  const { html } = monitor.composeAlert({
    kind: 'recovery',
    entries: [{
      stream: streamOf('kpft-main'),
      result: { httpStatus: 200, error: null, errorCode: null, responseTime: 90, timings: {} },
      diagnosis: { cause: 'recovered', causeLabel: 'Recovered', scope: 'stream', evidence: [], remediation: [] },
      audience: { listenersBefore: 42 },
      durationMs: 240000,
    }],
    scope: 'stream',
  });
  for (const name of FOREIGN) assert.equal(html.includes(name), false);
});
