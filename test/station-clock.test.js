/* ═══════════════════════════════════════════════════════════════════════════
   Every station is reported on its own clock

   STATION_TZ dates from the single-station install, where "the station's
   timezone" was unambiguous. The monitor now watches five stations across three
   timezones, and the constant was still being used for anything with a date on
   it:

     · the daily audience buckets, so WPFW's chart was cut on Houston midnights
     · the detection time in an alert email, so a Los Angeles outage was
       timestamped in Central time with nothing to say so
     · every date in the weekly roundup
     · and an outage list that appended a HARDCODED "CT" — a false statement on
       four of the five stations

   This is the same fault the listener counts carried: one clock's calendar
   presented as everyone's. It is worth its own test file because the failure is
   invisible — the times look completely reasonable, they are just wrong by one
   to three hours for most of the network.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stationclock-'));
process.env.SEED_FILE = '/nonexistent';
// Deliberately Chicago, the historical default — every assertion below must
// hold in spite of it, not because of it.
process.env.STATION_TZ = 'America/Chicago';

const monitor = require('../monitor');
const store = require('../store');

store.load();
store.setStationConfig({
  version: 1,
  hosts: [{ id: 'h', host: 'streams.example.org:9000' }],
  stations: [
    {
      id: 'kpft', name: 'KPFT Houston', timezone: 'America/Chicago',
      channels: [{ id: 'kpft-main', name: 'KPFT Main', url: 'https://streams.example.org:9000/live_128' }],
    },
    {
      id: 'kpfk', name: 'KPFK Los Angeles', timezone: 'America/Los_Angeles',
      channels: [{ id: 'kpfk', name: 'KPFK Los Angeles', url: 'https://streams.example.org:9000/kpfk_128' }],
    },
    {
      id: 'wpfw', name: 'WPFW Washington DC', timezone: 'America/New_York',
      channels: [{ id: 'wpfw', name: 'WPFW Washington DC', url: 'https://streams.example.org:9000/wpfw_128' }],
    },
  ],
});
monitor.reloadConfig();

const streamOf = (id) => monitor.getStreams().find((s) => s.id === id);

test('each station resolves to its own timezone, not the global default', () => {
  assert.equal(monitor.stationTz('kpft'), 'America/Chicago');
  assert.equal(monitor.stationTz('kpfk'), 'America/Los_Angeles');
  assert.equal(monitor.stationTz('wpfw'), 'America/New_York');
});

test('with several stations in scope no single clock is claimed', () => {
  // Naming one station's midnight for a network spanning three timezones is
  // the exact move that made "All stations · This month" mean 38 minutes.
  assert.equal(monitor.stationTz(null), 'UTC');
});

test('the daily incident calendar is cut on the station\'s own midnight', () => {
  // ONE INSTANT, TWO DATES. 06:30 UTC is 1:30am in Houston and 11:30pm the
  // PREVIOUS day in Los Angeles. Cutting both on Houston's midnight files the
  // Los Angeles outage under a day it did not happen on.
  const at = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  at.setUTCHours(6, 30, 0, 0);
  const iso = at.toISOString();

  for (const streamId of ['kpft-main', 'kpfk']) {
    store.addEvent({
      timestamp: iso,
      streamId,
      streamName: streamId,
      severity: 'outage',
      durationMs: 60000,
      resolvedAt: new Date(at.getTime() + 60000).toISOString(),
    });
  }

  const houston = monitor.getDailyBuckets(30, 'kpft').filter((d) => d.total > 0);
  const angeles = monitor.getDailyBuckets(30, 'kpfk').filter((d) => d.total > 0);
  assert.equal(houston.length, 1, 'Houston filed exactly one incident day');
  assert.equal(angeles.length, 1, 'Los Angeles filed exactly one incident day');

  const utcDay = iso.slice(0, 10);
  const prevDay = new Date(at.getTime() - 24 * 3600e3).toISOString().slice(0, 10);
  assert.equal(houston[0].day, utcDay, 'Houston: 1:30am, still the same date');
  assert.equal(angeles[0].day, prevDay, 'Los Angeles: 11:30pm, still the day before');
  assert.notEqual(houston[0].day, angeles[0].day, 'one instant, two station dates');
});

test('an alert is timestamped in the clock of the station it is about', () => {
  const msg = monitor.composeAlert({
    kind: 'down',
    entries: [{
      stream: streamOf('kpfk'),
      result: { httpStatus: 404, error: null, errorCode: null, responseTime: 120, timings: {} },
      diagnosis: { cause: 'source_disconnected', causeLabel: 'Source disconnected', scope: 'stream', evidence: [], remediation: [] },
    }],
    scope: { stationId: 'kpfk' },
  });

  // The zone is named in the message, so "2:00 PM" can never be read as the
  // reader's own time or as Houston's.
  assert.match(msg.html, /\b(PDT|PST)\b/, 'a Los Angeles alert must carry a Pacific zone label');
  assert.doesNotMatch(msg.html, /\b(CDT|CST)\b/, 'and must not be stamped in Central time');
});

test('the roundup stamps outage times with the station\'s zone, not a literal CT', () => {
  // The bug in its exact original form: the string " CT " was CONCATENATED onto
  // every outage time in the notable list, on every station's report. It is not
  // a formatting slip — it asserts a timezone, and it was false for four of the
  // five stations. A bare "CT" is also invisible to a check for "CDT".
  const at = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  store.addEvent({
    timestamp: at,
    streamId: 'kpfk',
    streamName: 'KPFK Los Angeles',
    severity: 'outage',
    durationMs: 20 * 60 * 1000,
    durationLabel: '20m',
    resolvedAt: new Date(Date.parse(at) + 20 * 60 * 1000).toISOString(),
    listenersBefore: 240,
    audience: { listenerImpact: 'confirmed', listenerMinutesLost: 4800 },
    diagnosis: { listenerImpact: 'confirmed', causeLabel: 'Source disconnected' },
  });

  const { html } = monitor.previewWeeklyRoundup(7 * 24 * 60 * 60 * 1000, 'kpfk');

  assert.match(html, /KPFK Los Angeles/, 'the outage reached the notable list');
  assert.match(html, /\b(PDT|PST)\b/, 'a Los Angeles outage carries a Pacific zone');
  assert.doesNotMatch(html, /\sCT\s/, 'and is never stamped with a hardcoded Central label');
  assert.doesNotMatch(html, /\b(CDT|CST)\b/, 'nor with Central time at all');
});
