/* ═══════════════════════════════════════════════════════════════════════════
   Audience statistics

   Pure functions over the /api/listeners payload, deliberately kept out of the
   page so they can be tested in Node. They were once inline in listeners.js,
   where they could not be, and the page shipped reporting a station-wide peak
   of 212 when the real simultaneous peak was 179 — because it added up peaks
   that happened at different moments. That is exactly the class of mistake a
   unit test catches and a screenshot does not.

   Loaded as a plain script in the browser (window.AudienceStats) and required
   directly in tests. No build step, matching the rest of the app.
   ═══════════════════════════════════════════════════════════════════════════ */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudienceStats = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /**
   * Average, peak, floor and peak time for ONE channel's series.
   *
   * `peak` comes from the bucket peaks — each is a real listener count returned
   * by a single check, so it is one true moment and can carry a timestamp.
   * `low` comes from the bucket averages, because the floor of interest is the
   * baseline the channel holds overnight, not its unluckiest single reading.
   */
  function channelStats(series) {
    let sum = 0;
    let count = 0;
    let peak = null;
    let peakAt = null;
    let low = null;

    for (const p of series || []) {
      if (p.avg != null) {
        sum += p.avg;
        count++;
        if (low == null || p.avg < low) low = p.avg;
      }
      if (p.peak != null && (peak == null || p.peak > peak)) {
        peak = p.peak;
        peakAt = p.t;
      }
    }

    return { avg: count ? sum / count : null, peak, peakAt, low, buckets: count };
  }

  /**
   * The station as one audience: every channel's listeners summed per bucket.
   *
   * This is the only honest way to a station-wide maximum. Two channels peaking
   * at different moments do not add up to a moment, so summing their separate
   * peaks reports a figure the station never actually reached. Buckets are
   * aligned across channels by construction — same width, same flooring — so
   * adding them is adding the same instant.
   */
  function stationSeries(seriesByStream, streamIds) {
    const merged = new Map();
    for (const id of streamIds || []) {
      for (const p of (seriesByStream || {})[id] || []) {
        if (p.avg == null) continue;
        merged.set(p.t, (merged.get(p.t) || 0) + p.avg);
      }
    }
    return [...merged.entries()]
      .map(([t, v]) => ({ t, v }))
      .sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  /** Peak, floor and average of a station-wide concurrent series. */
  function stationStats(series) {
    if (!series || !series.length) return { peak: null, peakAt: null, low: null, avg: null };
    let peak = -Infinity;
    let peakAt = null;
    let low = Infinity;
    let sum = 0;
    for (const p of series) {
      if (p.v > peak) { peak = p.v; peakAt = p.t; }
      if (p.v < low) low = p.v;
      sum += p.v;
    }
    return { peak, peakAt, low, avg: sum / series.length };
  }

  /**
   * The current audience against what this hour of the day normally holds.
   *
   * A bare "151 listening" says nothing: 151 is excellent at 3am and poor at
   * 6pm. Returns null rather than a fabricated baseline when no profile exists
   * — an unqualified "0% vs typical" would read as normal when it means unknown.
   */
  function vsTypical(streams, utcHour) {
    let typical = 0;
    let have = false;
    let now = 0;
    for (const s of streams || []) {
      now += s.current || 0;
      const prof = s.hourProfile;
      if (!Array.isArray(prof) || prof[utcHour] == null) continue;
      have = true;
      typical += prof[utcHour];
    }
    if (!have || typical <= 0) return null;
    return { now, typical, changePct: Math.round(((now - typical) / typical) * 1000) / 10 };
  }

  /**
   * Average listeners per mount over a channel's series.
   *
   * Only buckets that actually carry a breakdown are counted. Treating a bucket
   * without one as a row of zeros would drag every mount average toward zero in
   * proportion to how long ago per-mount recording began — which would look
   * like a declining audience rather than missing history.
   */
  function mountStats(series) {
    const acc = new Map();
    let covered = 0;
    let total = 0;
    for (const p of series || []) {
      total++;
      if (!p.byMount) continue;
      covered++;
      for (const [path, v] of Object.entries(p.byMount)) {
        const m = acc.get(path) || { sum: 0, count: 0 };
        m.sum += v;
        m.count++;
        acc.set(path, m);
      }
    }
    const mounts = [...acc].map(([path, m]) => ({ path, avg: m.sum / m.count }));
    mounts.sort((a, b) => b.avg - a.avg);
    return { mounts, covered, total };
  }

  /**
   * A station-wide series grouped into local days.
   *
   * `hours` is that day's contribution to the monthly ATH, which is why the
   * bucket width matters: a bucket holding 40 listeners for fifteen minutes is
   * ten listening hours, not forty. Newest day first.
   */
  function dailyBreakdown(series, bucketMs) {
    const bucketHours = (bucketMs || 60000) / 3600000;
    const byDay = new Map();

    for (const p of series || []) {
      const d = new Date(p.t);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const b = byDay.get(key) || { key, sum: 0, n: 0, peak: -Infinity, low: Infinity };
      b.sum += p.v;
      b.n++;
      if (p.v > b.peak) b.peak = p.v;
      if (p.v < b.low) b.low = p.v;
      byDay.set(key, b);
    }

    return [...byDay.values()]
      .map((b) => ({
        key: b.key,
        avg: b.sum / b.n,
        peak: b.peak,
        low: b.low,
        hours: Math.round(b.sum * bucketHours),
      }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }

  return { channelStats, stationSeries, stationStats, vsTypical, mountStats, dailyBreakdown };
});
