/* ═══════════════════════════════════════════════════════════════════════════
   Device records — SQLite storage for cume

   WHY THIS IS THE ONE THING THAT MOVED FIRST. Every other store in this app is
   bounded: samples compact after 7 days, events are capped at MAX_EVENTS. The
   device record is bounded by NOTHING — it is permanent by design, because a
   station's reach three years ago is the baseline every growth claim is
   measured against, and it grows with the AUDIENCE rather than with time or
   station count. It is the only table that gets bigger when the product
   succeeds.

   MEASURED, one year of the Pacifica network (429k rows, 59k distinct people):

     JSON, held in memory      16.7 MB resident   year query  30 ms
     SQLite, on disk           ~0 MB resident     year query 243 ms
                                                  24h/7d/30d  19/20/28 ms

   So this trades RAM for a slower ANNUAL query, and leaves the everyday windows
   the page actually loads untouched. At today's scale that is a 17 MB saving
   nobody would notice; at 33 affiliates over a decade the JSON path is roughly
   a gigabyte resident, which is the wall this exists to avoid. The everyday
   queries stay fast either way — only the yearly report pays, and 243 ms is
   nothing for a report.

   THREE TIERS, same as before, and the last is permanent:
     0  hour   — exact cume for any window
     1  day    — exact for any day range
     2  month  — kept for ever

   Resolution ages out; the listener never does. A union is order-free and
   idempotent, which is what makes folding a tier into the next lossless — an
   average could not survive it, which is why samples are tiered differently.

   REQUIRES NODE 22.5+ for `node:sqlite`. There is no fallback path on purpose:
   two storage engines behind one interface is two sets of behaviour to keep in
   agreement, and the one that is not exercised is the one that rots.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    'node:sqlite is unavailable — this needs Node 22.5 or newer (the container runs Node 24). '
    + `Running ${process.version}.`,
  );
}

const TIER = { hour: 0, day: 1, month: 2 };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Start and end of the bucket a timestamp falls in, for a tier. */
function bucketRange(tier, ts) {
  const d = new Date(ts);
  if (tier === TIER.hour) {
    d.setUTCMinutes(0, 0, 0);
    return [d.getTime(), d.getTime() + HOUR_MS];
  }
  if (tier === TIER.day) {
    d.setUTCHours(0, 0, 0, 0);
    return [d.getTime(), d.getTime() + DAY_MS];
  }
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return [d.getTime(), end.getTime()];
}

class DeviceStore {
  #byArity = new Map();

  constructor(file) {
    this.file = file;
    const dir = path.dirname(file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(file);
    this.db.exec(`
      -- WAL so a read during a write does not block, and a crash mid-write
      -- cannot leave a torn file. This record is permanent; losing it to an
      -- unclean shutdown is not an acceptable failure mode.
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous  = NORMAL;

      CREATE TABLE IF NOT EXISTS devices (
        stream_id TEXT    NOT NULL,
        tier      INTEGER NOT NULL,
        start_ms  INTEGER NOT NULL,
        end_ms    INTEGER NOT NULL,
        device    TEXT    NOT NULL,
        cls       TEXT    NOT NULL,
        /* WHERE, at the coarsest useful grain, so the map can answer for a
           WINDOW and not only for this instant. Icecast reports where its
           current listeners are and keeps none of it, so a 30-day map can only
           exist if the place is written down beside the device as it is seen.

           One compact token, because it is one value per device per bucket and
           the table is the one that grows with the audience:
             ''       never recorded — every row written before this column
             '-'      relay or datacenter, excluded from the map by the same
                      rule the live panel uses
             '?'      could not be placed
             'US:MD'  placed, with a state that cleared the centroid guard
             'US:'    placed in the US, state withheld by that guard
             'GB:'    placed, non-US — country resolution only, by design

           Never a city and never a coordinate, exactly as the live panel. */
        place     TEXT    NOT NULL DEFAULT '',
        PRIMARY KEY (stream_id, tier, start_ms, device)
      ) WITHOUT ROWID;

      -- The PK covers per-stream lookups. This one carries the cross-stream
      -- window scan, which is what every cume query actually is.
      CREATE INDEX IF NOT EXISTS idx_devices_window ON devices(start_ms, end_ms);

      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);

    /* An existing deployment has a `devices` table without `place`, and this
       record is permanent — it cannot be dropped and rebuilt. ALTER TABLE ADD
       COLUMN is O(1) in SQLite and leaves every existing row at '', which is
       exactly right: those listeners were real and their location was never
       recorded, which is a different thing from being unplaceable. */
    const columns = this.db.prepare('PRAGMA table_info(devices)').all();
    if (!columns.some((c) => c.name === 'place')) {
      this.db.exec("ALTER TABLE devices ADD COLUMN place TEXT NOT NULL DEFAULT ''");
    }

    this.stmt = {
      insert: this.db.prepare(
        'INSERT OR IGNORE INTO devices (stream_id, tier, start_ms, end_ms, device, cls, place) VALUES (?,?,?,?,?,?,?)',
      ),
      earliestAll: this.db.prepare(
        'SELECT MIN(start_ms) AS t FROM devices WHERE start_ms < ? AND end_ms > ?',
      ),
      olderThan: this.db.prepare(
        'SELECT stream_id, start_ms, device, cls, place FROM devices WHERE tier = ? AND end_ms <= ?',
      ),
      deleteTierBefore: this.db.prepare('DELETE FROM devices WHERE tier = ? AND end_ms <= ?'),
      deleteMonthsBefore: this.db.prepare('DELETE FROM devices WHERE tier = 2 AND end_ms <= ?'),
      months: this.db.prepare(
        'SELECT DISTINCT start_ms FROM devices ORDER BY start_ms',
      ),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM devices'),
      byTier: this.db.prepare('SELECT tier, COUNT(*) AS n FROM devices GROUP BY tier'),
    };
  }

  /* THE STREAM FILTER HAS TO BE IN THE SQL, not applied afterwards.
     GROUP BY device collapses rows across channels, so filtering the RESULT
     cannot tell whose devices they were — the first version of this did exactly
     that and every station reported the whole network's cume.

     A parameterised IN(...) needs one statement per list length, so they are
     prepared on demand and cached by arity. There are a handful of distinct
     arities in practice (one station, one channel, all channels). */
  #distinctStmt(n) {
    if (!this.#byArity.has(n)) {
      const holes = new Array(n).fill('?').join(',');
      this.#byArity.set(n, {
        distinct: this.db.prepare(`
          SELECT device, MIN(cls) AS cls, MAX(place) AS place
          FROM devices
          WHERE stream_id IN (${holes}) AND start_ms < ? AND end_ms > ?
          GROUP BY device
        `),
        earliest: this.db.prepare(`
          SELECT MIN(start_ms) AS t
          FROM devices
          WHERE stream_id IN (${holes}) AND start_ms < ? AND end_ms > ?
        `),
        /* When LOCATION recording began, which is a different date from when
           device recording began and must not be read as the same one. The
           device record is years old; `place` starts the day it ships and can
           never be backfilled. Reporting the former as the latter tells a
           reader the map has seven days behind it when it has minutes. */
        placesEarliest: this.db.prepare(`
          SELECT MIN(start_ms) AS t
          FROM devices
          WHERE stream_id IN (${holes}) AND start_ms < ? AND end_ms > ? AND place != ''
        `),
      });
    }
    return this.#byArity.get(n);
  }

  /**
   * Record devices seen on one channel at one moment, into the hour tier.
   * Re-recording the same device in the same hour is free — the primary key
   * makes it a no-op, which is what lets a five-minute poll be idempotent.
   */
  recordDevices(streamId, ts, entries) {
    if (!streamId || !Array.isArray(entries) || !entries.length) return;
    const [start, end] = bucketRange(TIER.hour, ts);
    this.db.exec('BEGIN');
    try {
      for (const e of entries) {
        if (!e || !e.id) continue;
        this.stmt.insert.run(streamId, TIER.hour, start, end, e.id, e.cls || '', e.place || '');
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Cume — distinct devices across a window, with the mix that composes it.
   *
   * All three tiers are unioned by the same query, so a window spanning a tier
   * boundary counts a device that appears in both exactly once.
   */
  getDistinctDevices(streamIds, sinceMs, untilMs = Date.now()) {
    const ids = (Array.isArray(streamIds) ? streamIds : [streamIds]).filter(Boolean);
    // No channels means no audience, not the whole network's.
    if (!ids.length) {
      return { devices: 0, players: {}, platforms: {}, coveredFrom: null, partial: true };
    }

    const st = this.#distinctStmt(ids.length);
    const args = [...ids, untilMs, sinceMs];
    const rows = st.distinct.all(...args);

    const players = {};
    const platforms = {};
    /* The SAME shape the live panel publishes, so one renderer draws both and
       the two views cannot drift apart in how they count. */
    const places = {
      countries: {}, usStates: {},
      placed: 0, relays: 0, unplaced: 0, stateWithheld: 0,
      reasons: {},
      // Devices carrying no geography at all: seen before the column existed.
      // Held apart from `unplaced` because "we did not record it" and "we could
      // not place them" would otherwise average into one misleading figure.
      unrecorded: 0,
    };
    let devices = 0;

    // GROUP BY device already made these unique across the requested channels —
    // someone listening to two of a station's streams is one person.
    for (const r of rows) {
      devices += 1;
      const [fam, plat] = String(r.cls || '').split('|');
      if (fam) players[fam] = (players[fam] || 0) + 1;
      if (plat) platforms[plat] = (platforms[plat] || 0) + 1;

      /* MAX(place), not MIN, is what the query above selects. One device can
         hold rows on several channels, and the tokens sort so that the most
         informative one wins: 'US:MD' > '?' > '-' > ''. A listener placed on
         any channel is placed, and only a device placed NOWHERE falls back. */
      const place = String(r.place || '');
      if (place === '') { places.unrecorded += 1; continue; }
      if (place === '-') { places.relays += 1; continue; }
      if (place === '?') { places.unplaced += 1; places.reasons.unknown = (places.reasons.unknown || 0) + 1; continue; }

      const [country, region] = place.split(':');
      if (!country) { places.unplaced += 1; continue; }
      places.placed += 1;
      places.countries[country] = (places.countries[country] || 0) + 1;
      if (country === 'US') {
        if (region) places.usStates[region] = (places.usStates[region] || 0) + 1;
        else {
          places.stateWithheld += 1;
          places.reasons['no-region'] = (places.reasons['no-region'] || 0) + 1;
        }
      }
    }

    const e = st.earliest.get(...args);
    const earliest = e && e.t != null ? e.t : null;

    const pe = st.placesEarliest.get(...args);
    places.coveredFrom = pe && pe.t != null ? new Date(pe.t).toISOString() : null;

    return {
      devices,
      players,
      platforms,
      places,
      coveredFrom: earliest == null ? null : new Date(earliest).toISOString(),
      // True when the window reaches back further than anything recorded, so a
      // caller can say "since we started measuring" rather than quoting a short
      // period as though it were a whole month.
      partial: earliest == null ? true : earliest > sinceMs + HOUR_MS,
    };
  }

  /** Fold hours into days into months. Resolution ages out; devices do not. */
  compactDevices(now, { hourRetentionH, dayRetentionDays, monthRetention }) {
    const foldInto = (fromTier, toTier, cutoff) => {
      const rows = this.stmt.olderThan.all(fromTier, cutoff);
      if (!rows.length) return;
      this.db.exec('BEGIN');
      try {
        for (const r of rows) {
          const [s, e] = bucketRange(toTier, r.start_ms);
          // `place` travels with the device. Dropped here, the map would work
          // for 24 hours and go blank at 30 days — with nothing to show why.
          this.stmt.insert.run(r.stream_id, toTier, s, e, r.device, r.cls, r.place);
        }
        this.stmt.deleteTierBefore.run(fromTier, cutoff);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };

    foldInto(TIER.hour, TIER.day, now - hourRetentionH * HOUR_MS);
    foldInto(TIER.day, TIER.month, now - dayRetentionDays * DAY_MS);

    // Months are permanent unless a deployment explicitly asks to forget.
    if (monthRetention > 0) {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - monthRetention);
      this.stmt.deleteMonthsBefore.run(d.getTime());
    }
  }

  /** Every calendar month that holds data, oldest first, as YYYY-MM. */
  monthKeys() {
    const out = new Set();
    for (const r of this.stmt.months.all()) {
      out.add(new Date(r.start_ms).toISOString().slice(0, 7));
    }
    return [...out].sort();
  }

  getMeta(key) {
    const r = this.stmt.getMeta.get(key);
    return r ? r.value : undefined;
  }

  setMeta(key, value) {
    this.stmt.setMeta.run(key, String(value));
    return value;
  }

  rowCount() { return this.stmt.count.get().n; }

  /** Rows per tier — how compaction is actually behaving, for tests and stats. */
  tierCounts() {
    const out = { hour: 0, day: 0, month: 0 };
    for (const r of this.stmt.byTier.all()) {
      out[['hour', 'day', 'month'][r.tier]] = r.n;
    }
    return out;
  }

  /** Test seam. Empties the table without touching the file or the schema. */
  reset() { this.db.exec('DELETE FROM devices'); }

  sizeBytes() {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try { total += fs.statSync(this.file + suffix).size; } catch { /* absent */ }
    }
    return total;
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

module.exports = { DeviceStore, TIER, bucketRange };
