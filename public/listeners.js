/* ═══════════════════════════════════════════════════════════════════════════
   Audience

   The incident history page answers "what went wrong". This one answers "who is
   listening, and to what" — a different question for a different reader, which
   is why it is a page rather than another panel on that one.

   The section that does not exist anywhere else is BY MOUNT. A channel is
   published at several bitrates, each its own Icecast mount, and every other
   figure in the system sums them. That sum can hold completely steady while one
   variant's audience collapses inside it. On this host /live_64 carries around a
   third of KPFT Main's listeners, so the split is not a detail.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  /* Station scope. Same contract as the history page: the URL wins over the
     remembered choice, so a link to one station always opens that station. */
  let stationId = null;
  try {
    stationId = new URLSearchParams(location.search).get('station')
      || localStorage.getItem('historyStationId')
      || null;
  } catch (e) { /* private mode */ }
  const scope = () => (stationId ? '&stationId=' + encodeURIComponent(stationId) : '');

  let days = 7;
  let data = null;

  // One colour per channel, held stable across every chart and table on the
  // page — a legend that means something different in two places is worse than
  // no legend.
  const PALETTE = ['#7c6aef', '#22c55e', '#38bdf8', '#f59e0b', '#f472b6', '#a78bfa', '#2dd4bf', '#fb7185'];
  const colorFor = (i) => PALETTE[i % PALETTE.length];

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const fmt = (n) => (n == null ? '—' : Math.round(n * 10) / 10);

  /* ── Station picker ──────────────────────────────────────────────────── */

  function reflectStation(stations) {
    const s = stations && stations.find((x) => x.id === stationId);
    const label = s ? s.name : 'All stations';
    const titleEl = document.querySelector('.header-title');
    if (titleEl) titleEl.textContent = label + ' · Audience';
    document.title = label + ' · Audience';

    const url = new URL(location.href);
    if (stationId) url.searchParams.set('station', stationId);
    else url.searchParams.delete('station');
    history.replaceState(null, '', url);
  }

  async function initStationPicker() {
    let stations = [];
    try {
      const r = await fetch('/api/stations/list');
      stations = (await r.json()).stations || [];
    } catch (e) { return; }

    if (stations.length < 2) { reflectStation(stations); return; }

    // A remembered station that has since been removed would scope every figure
    // on the page to nothing, silently. Fall back to all stations.
    if (stationId && !stations.some((s) => s.id === stationId)) stationId = null;

    const sel = $('#station-select');
    const opts = ['<option value="">All stations</option>'];
    for (const s of stations) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;   // textContent, so a station name cannot inject markup
      opts.push(o.outerHTML);
    }
    sel.innerHTML = opts.join('');
    sel.value = stationId || '';
    $('#station-picker').classList.remove('hidden');
    reflectStation(stations);

    sel.addEventListener('change', () => {
      stationId = sel.value || null;
      try {
        if (stationId) localStorage.setItem('historyStationId', stationId);
        else localStorage.removeItem('historyStationId');
      } catch (e) { /* private mode */ }
      reflectStation(stations);
      load();
    });
  }

  /* ── Data ────────────────────────────────────────────────────────────── */

  async function load() {
    try {
      const r = await fetch(`/api/listeners?days=${days}${scope()}`);
      data = r.ok ? await r.json() : null;
    } catch (e) {
      data = null;
    }
    render();
    $('#loading').style.display = 'none';
    $('#audience-view').style.display = '';
  }

  /** Channels that actually have a series in this range. */
  function rows() {
    if (!data || !data.series) return [];
    return (data.streams || []).filter((s) => (data.series[s.id] || []).length);
  }

  /** Average and peak for one channel over the loaded window. */
  function statsFor(stream) {
    const series = (data.series || {})[stream.id] || [];
    let sum = 0;
    let count = 0;
    let peak = null;
    for (const p of series) {
      if (p.avg != null) { sum += p.avg; count++; }
      if (p.peak != null) peak = peak == null ? p.peak : Math.max(peak, p.peak);
    }
    return { avg: count ? sum / count : null, peak, buckets: count };
  }

  /**
   * Average listeners per mount over the window.
   *
   * Only buckets that actually carry a breakdown are counted. Treating a bucket
   * without one as a row of zeros would drag every mount average toward zero in
   * proportion to how long ago the feature was added, which would look like a
   * declining audience rather than missing data.
   */
  function mountStatsFor(stream) {
    const series = (data.series || {})[stream.id] || [];
    const acc = new Map();
    let covered = 0;
    for (const p of series) {
      if (!p.byMount) continue;
      covered++;
      for (const [path, v] of Object.entries(p.byMount)) {
        const m = acc.get(path) || { sum: 0, count: 0 };
        m.sum += v;
        m.count++;
        acc.set(path, m);
      }
    }
    const out = [...acc].map(([path, m]) => ({ path, avg: m.sum / m.count }));
    out.sort((a, b) => b.avg - a.avg);
    return { mounts: out, covered, total: series.length };
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  function render() {
    if (!data || !rows().length) {
      $('#aud-tiles').innerHTML = '<div class="aud-empty">No audience data in this range yet.</div>';
      ['#aud-lines', '#channel-table', '#mount-breakdown', '#hour-profile'].forEach((s) => {
        const el = $(s);
        if (el) el.innerHTML = '';
      });
      return;
    }
    renderTiles();
    renderLines();
    renderChannelTable();
    renderMounts();
    renderHours();
    $('#range-note').textContent =
      `${rows().length} channel${rows().length === 1 ? '' : 's'} · updated ${new Date(data.generatedAt).toLocaleTimeString('en-US')}`;
  }

  function renderTiles() {
    const list = rows();
    const now = list.reduce((a, s) => a + (s.current || 0), 0);
    const avg = list.reduce((a, s) => a + (statsFor(s).avg || 0), 0);
    // Summing per-channel peaks would claim a simultaneous maximum that may
    // never have happened. The peak of the summed series is not recoverable from
    // per-channel buckets either, so this is stated as what it is.
    const peak = list.reduce((a, s) => a + (statsFor(s).peak || 0), 0);

    const tiles = [
      { v: now, l: 'listening right now' },
      { v: fmt(avg), l: `average across the last ${days === 1 ? '24 hours' : days + ' days'}` },
      { v: peak, l: 'sum of each channel’s peak — not one moment' },
      { v: list.length, l: 'channels with audience data' },
    ];
    $('#aud-tiles').innerHTML = tiles
      .map((t) => `<div class="aud-tile"><div class="aud-tile-v">${esc(t.v)}</div><div class="aud-tile-l">${esc(t.l)}</div></div>`)
      .join('');
  }

  /** Every channel on one shared scale, so they can be compared directly. */
  function renderLines() {
    const list = rows();
    const W = 1000;
    const H = 260;
    const PAD_L = 46;
    const PAD_R = 12;
    const PAD_T = 10;
    const PAD_B = 26;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const times = list.flatMap((s) => data.series[s.id].map((p) => new Date(p.t).getTime()));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times) + (data.bucketMs || 0);
    const span = t1 > t0 ? t1 - t0 : 1;
    const x = (t) => PAD_L + ((t - t0) / span) * plotW;

    const maxVal = Math.max(1, ...list.flatMap((s) => data.series[s.id].map((p) => p.avg ?? 0)));
    const yMax = niceCeil(maxVal);
    const y = (v) => PAD_T + plotH - (Math.max(0, v) / yMax) * plotH;

    const parts = [];
    [0, yMax / 2, yMax].forEach((v) => {
      parts.push(`<line class="aud-grid" x1="${PAD_L}" y1="${y(v).toFixed(1)}" x2="${W - PAD_R}" y2="${y(v).toFixed(1)}"/>`);
      parts.push(`<text class="aud-ytick" x="${PAD_L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`);
    });

    list.forEach((stream, i) => {
      const pts = data.series[stream.id]
        .filter((p) => p.avg != null)
        .map((p) => `${x(new Date(p.t).getTime()).toFixed(1)},${y(p.avg).toFixed(1)}`);
      if (pts.length < 2) return;
      parts.push(`<polyline class="aud-line" fill="none" stroke="${colorFor(i)}" points="${pts.join(' ')}"/>`);
    });

    // Time axis: first, middle and last, which is all that fits legibly and all
    // anyone reads off a range they chose themselves.
    [t0, t0 + span / 2, t1].forEach((t, i) => {
      const anchor = i === 0 ? 'start' : i === 2 ? 'end' : 'middle';
      parts.push(`<text class="aud-xtick" x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${esc(fmtTime(t))}</text>`);
    });

    $('#aud-lines').innerHTML =
      `<svg class="aud-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Listeners over time by channel">${parts.join('')}</svg>`;

    $('#aud-lines-legend').innerHTML = list
      .map((s, i) => `<span class="alg"><i class="swatch" style="background:${colorFor(i)}"></i>${esc(s.name)}</span>`)
      .join('');
  }

  function renderChannelTable() {
    const list = rows();
    const totalAvg = list.reduce((a, s) => a + (statsFor(s).avg || 0), 0);
    const body = list.map((s, i) => {
      const st = statsFor(s);
      const share = totalAvg > 0 ? (st.avg || 0) / totalAvg * 100 : 0;
      return `<tr>
        <td><i class="swatch" style="background:${colorFor(i)}"></i>${esc(s.name)}</td>
        <td class="num">${s.current == null ? '—' : esc(s.current)}</td>
        <td class="num">${esc(fmt(st.avg))}</td>
        <td class="num">${st.peak == null ? '—' : esc(st.peak)}</td>
        <td class="num">${esc(Math.round(share))}%</td>
      </tr>`;
    }).join('');

    $('#channel-table').innerHTML =
      `<thead><tr><th>Channel</th><th class="num">Now</th><th class="num">Average</th><th class="num">Peak</th><th class="num">Share</th></tr></thead>
       <tbody>${body}</tbody>`;
  }

  /**
   * The split the rest of the system sums away.
   *
   * Current counts come from the live status record; averages come from the raw
   * sample window. They are labelled separately because they cover different
   * spans, and presenting them as one number would be a quiet lie.
   */
  function renderMounts() {
    const list = rows();
    let anyHistory = false;

    const blocks = list.map((s, i) => {
      const ms = mountStatsFor(s);
      if (ms.covered) anyHistory = true;
      const live = s.mountListeners || {};
      const paths = s.mounts && s.mounts.length
        ? s.mounts
        : ms.mounts.map((m) => m.path);
      const avgByPath = new Map(ms.mounts.map((m) => [m.path, m.avg]));
      const liveTotal = paths.reduce((a, p) => a + (live[p] || 0), 0);

      const bars = paths.map((p, j) => {
        const nowN = live[p];
        const avgN = avgByPath.get(p);
        const share = liveTotal > 0 ? (nowN || 0) / liveTotal * 100 : 0;
        return `<div class="mb-row">
          <code class="mb-path${j === 0 ? ' primary' : ''}">${esc(p)}</code>
          <div class="mb-bar"><i style="width:${share.toFixed(1)}%;background:${colorFor(i)}"></i></div>
          <span class="mb-now">${nowN == null ? '—' : esc(nowN)}</span>
          <span class="mb-avg">${avgN == null ? '—' : esc(fmt(avgN))}</span>
        </div>`;
      }).join('');

      return `<div class="mb-block">
        <div class="mb-head"><i class="swatch" style="background:${colorFor(i)}"></i>${esc(s.name)}
          <span class="mb-cols"><span>now</span><span>avg</span></span>
        </div>
        ${bars}
      </div>`;
    }).join('');

    $('#mount-breakdown').innerHTML = blocks;
    $('#mount-hint').textContent = anyHistory
      ? 'bar shows each mount’s share of the channel right now'
      : 'no per-mount history yet — averages appear as samples accumulate';
  }

  /** Average listeners by hour, summed across channels, in the viewer's timezone. */
  function renderHours() {
    const list = rows();
    const local = new Array(24).fill(0);
    let any = false;

    // The profile is indexed by UTC hour. Shifting by the viewer's current
    // offset is approximate across a DST boundary, which is acceptable for a
    // shape averaged over many days and is stated in the hint rather than
    // hidden.
    const offsetHours = -new Date().getTimezoneOffset() / 60;
    for (const s of list) {
      const prof = s.hourProfile;
      if (!Array.isArray(prof)) continue;
      any = true;
      for (let h = 0; h < 24; h++) {
        const v = prof[h];
        if (v == null) continue;
        const lh = ((Math.round(h + offsetHours) % 24) + 24) % 24;
        local[lh] += v;
      }
    }

    if (!any) {
      $('#hour-profile').innerHTML = '<div class="aud-empty">No hour-of-day profile yet.</div>';
      $('#hour-hint').textContent = '';
      return;
    }

    const max = Math.max(1, ...local);
    const bars = local.map((v, h) => {
      const pct = (v / max) * 100;
      const label = h % 3 === 0 ? `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}` : '';
      return `<div class="hp-col" title="${esc(`${fmt(v)} listeners at ${h}:00 local`)}">
        <i style="height:${pct.toFixed(1)}%"></i>
        <span>${esc(label)}</span>
      </div>`;
    }).join('');

    $('#hour-profile').innerHTML = `<div class="hp">${bars}</div>`;
    $('#hour-hint').textContent = 'your local time · whole retained record';
  }

  /* ── Export ──────────────────────────────────────────────────────────── */

  /**
   * CSV of the loaded series, one row per bucket per channel, with a column per
   * mount. Exported as what is on screen rather than a fresh query, so the file
   * and the page can never disagree.
   */
  function exportCsv() {
    if (!data) return;
    const list = rows();
    const paths = [...new Set(list.flatMap((s) => s.mounts || []))];
    const head = ['timestamp', 'channel', 'avg_listeners', 'peak_listeners', ...paths];
    const lines = [head.join(',')];

    for (const s of list) {
      for (const p of data.series[s.id] || []) {
        const cells = [
          p.t,
          `"${String(s.name).replace(/"/g, '""')}"`,
          p.avg == null ? '' : p.avg,
          p.peak == null ? '' : p.peak,
          ...paths.map((path) => {
            const v = p.byMount && p.byMount[path];
            return v == null ? '' : v;
          }),
        ];
        lines.push(cells.join(','));
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `audience-${stationId || 'all'}-${days}d.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ── Utilities ───────────────────────────────────────────────────────── */

  function niceCeil(v) {
    if (v <= 5) return 5;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.ceil(v / (mag / 2)) * (mag / 2);
  }

  function fmtTime(t) {
    const d = new Date(t);
    return days <= 1
      ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /* ── Boot ────────────────────────────────────────────────────────────── */

  document.getElementById('range-pills').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-pill');
    if (!btn) return;
    document.querySelectorAll('.range-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    days = parseFloat(btn.dataset.days) || 7;
    load();
  });

  document.getElementById('export-btn').addEventListener('click', exportCsv);

  (async function boot() {
    await initStationPicker();
    await load();
  })();
})();
