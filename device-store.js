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

      /* WHEN each region listens, kept for ever.

         The hour-of-day question cannot be answered from the device table for
         longer than DEVICE_HOUR_RETENTION_H (48h by default), because after
         that a device's timestamp IS its day. Two days cannot tell a weekday
         from a weekend — on this station's own record weekends average 69-78
         against 43-47 on Monday and Tuesday — so a profile built from them
         could be wrong by more than half depending which two days it caught.

         Dayparts are how radio is scheduled and sold, so the answer is frozen
         at the moment the exact data still exists, exactly as tune-ins are
         frozen onto an hour's rollup as samples compact. It is an AGGREGATE,
         a few hundred rows a day rather than one per listener.

         The devices column counts distinct devices in that region, hour and day.
         It CANNOT be summed across days into a count of people — the same
         listener recurs — so it measures listening presence, and the page says
         so. */
      CREATE TABLE IF NOT EXISTS region_hours (
        stream_id TEXT    NOT NULL,
        day_ms    INTEGER NOT NULL,
        hour      INTEGER NOT NULL,
        region    TEXT    NOT NULL,
        devices   INTEGER NOT NULL,
        PRIMARY KEY (stream_id, day_ms, hour, region)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_region_hours_day ON region_hours(day_ms);

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
      /* Written as the hour tier folds, so it is computed from exact per-hour
         rows. ON CONFLICT adds rather than replaces: a channel's bitrate
         variants fold in separate passes and both belong to the same hour. */
      regionHourAdd: this.db.prepare(`
        INSERT INTO region_hours (stream_id, day_ms, hour, region, devices)
        VALUES (?,?,?,?,?)
        ON CONFLICT(stream_id, day_ms, hour, region)
        DO UPDATE SET devices = devices + excluded.devices
      `),
      /* The exact per-hour rows about to be folded away, already grouped.
         DISTINCT device so one listener present for the whole hour counts once,
         and so a device on two of a station's channels is not counted twice —
         the GROUP BY keeps stream_id, and the read sums across the station's
         own streams only. */
      regionHourSource: this.db.prepare(`
        SELECT stream_id, start_ms, place, COUNT(DISTINCT device) AS n
        FROM devices
        WHERE tier = 0 AND end_ms <= ? AND place <> '' AND place <> '-' AND place <> '?'
        GROUP BY stream_id, start_ms, place
      `),
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
        /* Devices present in BOTH windows. INTERSECT, not a join: the row
           granularity differs between tiers, so joining would multiply a device
           by however many buckets it happens to occupy on each side. */
        returning: this.db.prepare(`
          SELECT COUNT(*) AS n FROM (
            SELECT DISTINCT device FROM devices
            WHERE stream_id IN (${holes}) AND start_ms < ? AND end_ms > ?
            INTERSECT
            SELECT DISTINCT device FROM devices
            WHERE stream_id IN (${holes}) AND start_ms < ? AND end_ms > ?
          )
        `),
        /* Rows whose bucket is COARSER than a day anywhere near these windows.
           A month bucket cannot be split across a 30-day boundary: the device
           lands in both periods and reads as loyal. */
        coarseRows: this.db.prepare(`
          SELECT COUNT(*) AS n FROM devices
          WHERE stream_id IN (${holes}) AND tier = 2 AND start_ms < ? AND end_ms > ?
        `),
        /* The distribution of distinct devices per time bucket.

           `cls` is deterministic for a device — it is part of what the device
           hash is made from — so a device has exactly one, and summing the
           classes in a bucket gives the bucket's distinct device count. The
           bucket format is bound, not interpolated, so the caller cannot
           reach the SQL. */
        trend: this.db.prepare(`
          SELECT strftime(?, start_ms / 1000, 'unixepoch') AS b,
                 cls, COUNT(DISTINCT device) AS n
          FROM devices
          WHERE stream_id IN (${holes}) AND start_ms < ? AND end_ms > ?
          GROUP BY b, cls
          ORDER BY b
        `),
        countDistinct: this.db.prepare(`
          SELECT COUNT(DISTINCT device) AS n
          FROM devices
          WHERE stream_id IN (${holes}) AND start_ms < ? AND end_ms > ?
        `),
        /* When recording began for THESE channels, unbounded by any window.
           This is what says whether an earlier window can be compared at all:
           a window that predates the first row is not a quiet period, it is a
           period nobody watched. */
        earliestEver: this.db.prepare(`
          SELECT MIN(start_ms) AS t FROM devices WHERE stream_id IN (${holes})
        `),
        /* THE STREAM FILTER IS IN THE SQL, as it must be everywhere here. */
        regionHoursFrozen: this.db.prepare(`
          SELECT region, day_ms, hour, SUM(devices) AS n
          FROM region_hours
          WHERE stream_id IN (${holes}) AND day_ms >= ? AND day_ms < ?
          GROUP BY region, day_ms, hour
        `),
        /* The hours not yet frozen — the live tail the aggregate has not
           reached. Read from `devices` at hour resolution, which is exactly
           what it still has for these. */
        regionHoursLive: this.db.prepare(`
          SELECT place, start_ms, COUNT(DISTINCT device) AS n
          FROM devices
          WHERE stream_id IN (${holes}) AND tier = 0
            AND start_ms < ? AND end_ms > ?
            AND place <> '' AND place <> '-' AND place <> '?'
          GROUP BY place, start_ms
        `),
        regionHoursSince: this.db.prepare(`
          SELECT MIN(day_ms) AS t FROM region_hours WHERE stream_id IN (${holes})
        `),
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
      // The SAME shape as a real answer, `places` included. Returning a
      // narrower object here makes every caller test for a key that is missing
      // in exactly one case, which is how the one case stops being handled.
      return {
        devices: 0, players: {}, platforms: {}, coveredFrom: null, partial: true,
        places: {
          countries: {}, usStates: {}, usCities: {},
          placed: 0, relays: 0, unplaced: 0, stateWithheld: 0, cityWithheld: 0,
          unrecorded: 0, reasons: {}, coveredFrom: null,
        },
      };
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
      // "TX/Houston" — a bare city name would merge the Houston in Alaska.
      usCities: {},
      cityWithheld: 0,
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

      // 'US:TX:Houston'. Tokens written before the city existed have two
      // segments and simply yield no city, which is exactly right for them.
      const [country, region, city] = place.split(':');
      if (!country) { places.unplaced += 1; continue; }
      places.placed += 1;
      places.countries[country] = (places.countries[country] || 0) + 1;
      if (country === 'US') {
        if (region) {
          places.usStates[region] = (places.usStates[region] || 0) + 1;
          if (city) {
            const key = `${region}/${city}`;
            places.usCities[key] = (places.usCities[key] || 0) + 1;
          } else {
            places.cityWithheld += 1;
          }
        } else {
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

  /**
   * Returning vs new listeners — how many of this period's audience were also
   * here in the period before it.
   *
   * WHY THE COMPARISON IS WITHHELD RATHER THAN ESTIMATED. The earlier window is
   * half of this figure, and if the monitor was not running through all of it
   * the devices that WERE there simply are not recorded. Every one of them then
   * counts as new, so a recording gap renders as a surge of first-time
   * listeners — the most flattering possible misreading, on the one metric a
   * station would take to a funder. `comparable: false` returns nulls, never
   * zeros: "we cannot say" and "nobody came back" are different sentences.
   *
   * WHAT IT IS A FLOOR OF. A device is a salted hash of IP and user agent, so a
   * listener whose address changed between the two periods — any mobile
   * connection, many domestic ones — reads as new. Real loyalty is therefore
   * HIGHER than this number, never lower, and the page has to say so.
   */
  getReturningDevices(streamIds, sinceMs, untilMs = Date.now()) {
    const ids = (Array.isArray(streamIds) ? streamIds : [streamIds]).filter(Boolean);

    /* SNAPPED TO WHOLE DAYS, and this is not cosmetic.

       Buckets age from hours into days into months, so within a day or two of
       history a device's timestamp IS its day. A window boundary at 09:47 falls
       inside a day bucket, and the device in it belongs to both periods — it
       reads as a returning listener on the strength of one morning. Whole days
       align with the buckets and the straddle cannot happen.

       It is also the question actually being asked: a report compares this week
       with last week, not the 168 hours ending at breakfast. */
    const untilDay = Math.floor(untilMs / DAY_MS) * DAY_MS;
    const days = Math.max(1, Math.round((untilMs - sinceMs) / DAY_MS));
    const sinceDay = untilDay - days * DAY_MS;
    sinceMs = sinceDay;
    untilMs = untilDay;
    const windowMs = untilMs - sinceMs;
    const blank = {
      windowMs, days, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(),
      current: 0, returning: null, newListeners: null, previous: null,
      returningShare: null, comparable: false, reason: 'no-channels',
      coveredFrom: null, previousFrom: new Date(sinceMs - windowMs).toISOString(),
    };
    if (!ids.length || !windowMs) return blank;

    const st = this.#distinctStmt(ids.length);
    const prevUntil = sinceMs;
    const prevSince = sinceMs - windowMs;

    const current = st.countDistinct.get(...ids, untilMs, sinceMs)?.n || 0;

    const ever = st.earliestEver.get(...ids)?.t ?? null;
    const coveredFrom = ever == null ? null : new Date(ever).toISOString();

    /* An hour of slack, the same tolerance `getDistinctDevices` uses for
       `partial`: recording that began a few minutes into a window covers it for
       every practical purpose, and demanding the exact millisecond would
       withhold a sound figure for ever. */
    if (ever == null || ever > prevSince + HOUR_MS) {
      return {
        ...blank, current, coveredFrom,
        reason: ever == null ? 'nothing-recorded' : 'earlier-period-not-recorded',
      };
    }

    /* Month buckets cannot be divided by a 30- or 90-day boundary however the
       window is snapped, so a comparison reaching them is withheld rather than
       reported with both periods claiming the same listeners. */
    if (st.coarseRows.get(...ids, untilMs, prevSince)?.n) {
      return {
        ...blank, current, coveredFrom,
        windowMs, previousFrom: new Date(prevSince).toISOString(),
        reason: 'resolution-too-coarse',
      };
    }

    const returning = st.returning.get(
      ...ids, untilMs, sinceMs,
      ...ids, prevUntil, prevSince,
    )?.n || 0;
    const previous = st.countDistinct.get(...ids, prevUntil, prevSince)?.n || 0;

    return {
      windowMs,
      days,
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      current,
      returning,
      // Never negative: INTERSECT counts a subset of the current window.
      newListeners: current - returning,
      previous,
      returningShare: current ? returning / current : null,
      comparable: true,
      reason: null,
      coveredFrom,
      previousFrom: new Date(prevSince).toISOString(),
    };
  }

  /**
   * How the player and platform mix moved over time.
   *
   * Needs nothing that is not already stored: `cls` has been written per device
   * per bucket since cume shipped and has never been read as a series.
   *
   * THE BUCKET SIZE IS CHOSEN BY THE DATA, NOT BY THE CALLER. Records age from
   * hours into days into calendar months, and a month-tier row carries the
   * month's start as its timestamp. Bucketed by DAY, every one of those devices
   * would land on the 1st — a year of listening rendered as twelve enormous
   * spikes with empty space between them, which looks like a finding rather
   * than an artefact. So a range that reaches month-tier data is reported
   * monthly, and the granularity is returned so the page can say which.
   *
   * The final bucket is marked incomplete when it has not finished yet, because
   * "this month so far" against eleven whole months is a decline that did not
   * happen.
   */
  getDeviceTrend(streamIds, sinceMs, untilMs = Date.now()) {
    const ids = (Array.isArray(streamIds) ? streamIds : [streamIds]).filter(Boolean);
    if (!ids.length) {
      return { granularity: 'day', buckets: [], reason: 'no-channels' };
    }

    const st = this.#distinctStmt(ids.length);
    const monthly = (st.coarseRows.get(...ids, untilMs, sinceMs)?.n || 0) > 0;
    const granularity = monthly ? 'month' : 'day';

    const rows = st.trend.all(
      monthly ? '%Y-%m' : '%Y-%m-%d',
      ...ids, untilMs, sinceMs,
    );

    const byKey = new Map();
    for (const r of rows) {
      if (!byKey.has(r.b)) byKey.set(r.b, { key: r.b, devices: 0, families: {}, platforms: {} });
      const bucket = byKey.get(r.b);
      const [family, platform] = String(r.cls || '').split('|');
      const n = r.n || 0;
      bucket.devices += n;
      if (family) bucket.families[family] = (bucket.families[family] || 0) + n;
      if (platform) bucket.platforms[platform] = (bucket.platforms[platform] || 0) + n;
    }

    /* Completeness is judged against the REQUESTED end, not the wall clock.
       Reading Date.now() here ignores the caller's clock, which makes every
       figure untestable at a fixed time and quietly wrong for any query that
       does not end at this instant. */
    const buckets = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const b of buckets) {
      const start = monthly
        ? Date.parse(`${b.key}-01T00:00:00Z`)
        : Date.parse(`${b.key}T00:00:00Z`);
      const end = monthly
        ? Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1)
        : start + DAY_MS;
      b.start = new Date(start).toISOString();
      b.end = new Date(end).toISOString();
      // A bucket still running is not a smaller bucket.
      b.complete = end <= untilMs;
    }

    return { granularity, buckets, reason: null };
  }

  /**
   * Freeze region × hour-of-day counts for the hour rows about to be folded.
   *
   * Idempotent by construction only if it never sees the same hour twice — and
   * it does not, because the rows it reads are deleted by the fold immediately
   * after, inside the same compaction pass. The INSERT adds rather than
   * replaces so a channel's variants, which fold as separate rows, accumulate
   * into the one hour they share.
   */
  /**
   * When each region listens, by hour of day, on the STATION'S OWN CLOCK.
   *
   * WHY THE STATION'S CLOCK AND NOT THE LISTENER'S. The question a schedule is
   * built from is "who is listening during Morning Edition", and a programme
   * airs on the station's clock. The region is the breakdown, not the clock.
   * Asking instead whether New Yorkers tune in at their own 8am needs a
   * state → timezone table, is ambiguous for the states that span two, and
   * answers a different and more speculative question.
   *
   * Stored in UTC and converted here, per DAY, so the hour survives a daylight
   * saving change. Applying one offset to a month would put an hour of October
   * in the wrong column.
   *
   * TWO SOURCES, AND THEY CANNOT OVERLAP. Frozen aggregate rows exist only for
   * hours that have already been folded out of `devices`, and the fold deletes
   * them in the same pass. So the live tail and the frozen record are disjoint
   * by construction and can simply be added.
   */
  getRegionHourProfile(streamIds, sinceMs, untilMs = Date.now(), timeZone = 'UTC') {
    const ids = (Array.isArray(streamIds) ? streamIds : [streamIds]).filter(Boolean);
    const empty = { regions: [], hours: 24, timeZone, coveredFrom: null, total: 0, reason: 'no-channels' };
    if (!ids.length) return empty;

    const st = this.#distinctStmt(ids.length);

    /* One formatter, and a cache keyed by the UTC instant's hour slot. A month
       of a busy network is tens of thousands of rows but only days x 24
       distinct instants, so this turns an Intl call per row into one per hour
       actually present. */
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false });
    } catch {
      // An unrecognised zone must not lose the data; fall back and say so.
      fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', hour12: false });
      timeZone = 'UTC';
    }
    const localHourCache = new Map();
    const localHour = (utcMs) => {
      if (!localHourCache.has(utcMs)) {
        // "24" is midnight in some locales' hourCycle; normalise it to 0.
        const h = parseInt(fmt.format(new Date(utcMs)), 10) % 24;
        localHourCache.set(utcMs, Number.isFinite(h) ? h : 0);
      }
      return localHourCache.get(utcMs);
    };

    const byRegion = new Map();
    const add = (region, hour, n) => {
      if (!byRegion.has(region)) byRegion.set(region, new Array(24).fill(0));
      byRegion.get(region)[hour] += n;
    };

    const dayFrom = Math.floor(sinceMs / DAY_MS) * DAY_MS;
    for (const r of st.regionHoursFrozen.all(...ids, dayFrom, untilMs)) {
      add(r.region, localHour(r.day_ms + r.hour * HOUR_MS), r.n || 0);
    }
    for (const r of st.regionHoursLive.all(...ids, untilMs, sinceMs)) {
      const [country, region] = String(r.place || '').split(':');
      const key = country === 'US' ? (region ? `US:${region}` : 'US:') : `${country}:`;
      add(key, localHour(r.start_ms), r.n || 0);
    }

    const regions = [...byRegion.entries()]
      .map(([key, hours]) => ({
        key,
        country: key.split(':')[0],
        region: key.split(':')[1] || null,
        hours,
        total: hours.reduce((a, n) => a + n, 0),
      }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);

    const frozenFrom = st.regionHoursSince.get(...ids)?.t ?? null;
    return {
      regions,
      hours: 24,
      timeZone,
      // When the hour-of-day record begins. It cannot be backfilled: before
      // this, the hour had already been compacted away.
      coveredFrom: frozenFrom == null ? null : new Date(frozenFrom).toISOString(),
      total: regions.reduce((a, r) => a + r.total, 0),
      reason: null,
    };
  }

  #freezeRegionHours(cutoff) {
    const rows = this.stmt.regionHourSource.all(cutoff);
    if (!rows.length) return;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const [country, region] = String(r.place || '').split(':');
        // US states carry the state; everywhere else is reported by country,
        // which is the same resolution the map publishes.
        const key = country === 'US' ? (region ? `US:${region}` : 'US:') : `${country}:`;
        const d = new Date(r.start_ms);
        const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        this.stmt.regionHourAdd.run(r.stream_id, dayMs, d.getUTCHours(), key, r.n || 0);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

    /* FREEZE BEFORE FOLDING. After this line the hour is gone: a device's
       bucket becomes its whole day and the hour-of-day question becomes
       unanswerable for ever. Same reasoning as freezing tune-ins onto an
       hour's rollup as samples compact — the resolution is unrecoverable
       afterwards, so the aggregate has to be taken while it still exists. */
    this.#freezeRegionHours(now - hourRetentionH * HOUR_MS);

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
