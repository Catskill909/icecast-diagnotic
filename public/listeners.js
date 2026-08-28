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

  /* Statistics live in audience-stats.js so they can be unit-tested in Node.
     They were inline here once, untestable, and the page shipped reporting a
     station peak of 212 where the true simultaneous figure was 179. */
  const A = (typeof window !== 'undefined' && window.AudienceStats) || {};

  const statsFor = (stream) => A.channelStats((data.series || {})[stream.id] || []);

  const stationSeries = () => A.stationSeries(data.series || {}, rows().map((s) => s.id));

  const stationStats = () => A.stationStats(stationSeries());

  const vsTypicalNow = () => A.vsTypical(rows(), new Date().getUTCHours());

  const mountStatsFor = (stream) => A.mountStats((data.series || {})[stream.id] || []);

  /* ── Render ──────────────────────────────────────────────────────────── */

  function render() {
    if (!data || !rows().length) {
      $('#aud-tiles').innerHTML = '<div class="aud-empty">No audience data in this range yet.</div>';
      ['#aud-lines', '#channel-table', '#daily-table', '#mount-breakdown', '#hour-profile'].forEach((s) => {
        const el = $(s);
        if (el) el.innerHTML = '';
      });
      return;
    }
    renderTiles();
    renderAth();
    renderDaily();
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
    const st = stationStats();
    const vs = vsTypicalNow();
    const athMonth = list.reduce((a, s) => a + ((s.ath && s.ath.month && s.ath.month.ath) || 0), 0);

    const tiles = [
      {
        v: now,
        l: 'listening right now',
        // The one figure that says whether right now is going well. 151 is
        // excellent at 3am and poor at 6pm; without the baseline it says
        // neither.
        sub: vs
          ? `${vs.changePct >= 0 ? '▲' : '▼'} ${Math.abs(vs.changePct)}% vs typical for this hour (${fmt(vs.typical)})`
          : null,
        subCls: vs ? (vs.changePct >= 0 ? 'up' : 'down') : null,
      },
      {
        v: fmt(st.avg),
        l: `average listeners, last ${days === 1 ? '24 hours' : days + ' days'}`,
      },
      {
        // A TRUE simultaneous peak, from the summed series — not the sum of
        // each channel's separate high-water mark, which is a total the station
        // never actually reached at any one moment.
        v: st.peak == null ? '—' : Math.round(st.peak),
        l: 'peak at one moment',
        sub: st.peakAt ? fmtWhen(st.peakAt) : null,
      },
      {
        v: st.low == null ? '—' : Math.round(st.low),
        l: 'quietest moment — the floor the station holds',
      },
      {
        v: Number(athMonth).toLocaleString(),
        l: 'listening hours this month (estimated)',
      },
      {
        v: list.length,
        l: `channel${list.length === 1 ? '' : 's'} with audience data`,
      },
    ];

    $('#aud-tiles').innerHTML = tiles.map((t) => `<div class="aud-tile">
      <div class="aud-tile-v">${esc(t.v)}</div>
      <div class="aud-tile-l">${esc(t.l)}</div>
      ${t.sub ? `<div class="aud-tile-sub ${t.subCls || ''}">${esc(t.sub)}</div>` : ''}
    </div>`).join('');
  }

  /**
   * Listeners day by day: average, peak, floor and listening hours.
   *
   * The chart shows the shape; this answers "was Saturday better than Tuesday",
   * which for a station whose weekend is volunteer-programmed is most of the
   * question. Built from the station-wide concurrent series so the peak column
   * is a real moment, consistent with the tile above it.
   */
  function renderDaily() {
    const ser = stationSeries();
    if (!ser.length) { $('#daily-table').innerHTML = ''; return; }

    const days7 = A.dailyBreakdown(ser, data.bucketMs);
    const maxAvg = Math.max(...days7.map((d) => d.avg), 1);

    const body = days7.map((d) => {
      const avg = d.avg;
      const hours = d.hours;
      const dt = new Date(`${d.key}T12:00:00`);
      return `<tr>
        <td>${esc(dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</td>
        <td class="num">${esc(fmt(avg))}</td>
        <td class="num">${esc(Math.round(d.peak))}</td>
        <td class="num">${esc(Math.round(d.low))}</td>
        <td class="num">${esc(hours.toLocaleString())}</td>
        <td class="daybar"><i style="width:${((avg / maxAvg) * 100).toFixed(1)}%"></i></td>
      </tr>`;
    }).join('');

    $('#daily-table').innerHTML =
      `<thead><tr><th>Day</th><th class="num">Average</th><th class="num">Peak</th><th class="num">Low</th><th class="num">Hours</th><th></th></tr></thead>
       <tbody>${body}</tbody>`;
  }

  /**
   * Listening hours, month to date, against the royalty allowance.
   *
   * The bar is the point. "61% of your allowance" says something "8,214 hours"
   * cannot, and the projection is what turns it into a decision: 61% on the 9th
   * is a problem, 61% on the 27th is fine.
   *
   * Every figure here is labelled an estimate, in the panel and not only in a
   * popover. It is derived from polling counts once a minute, and somebody will
   * eventually be tempted to file a royalty return on it.
   */
  function renderAth() {
    const list = rows();
    let anyPartial = false;

    const blocks = list.map((s, i) => {
      const a = s.ath || {};
      const m = a.month || {};
      const w = a.window || {};
      if (m.partial) anyPartial = true;

      const pct = Math.min(100, m.pctOfAllowance || 0);
      const projPct = m.allowance ? Math.min(100, (m.projected / m.allowance) * 100) : 0;
      // Over the allowance is the one state worth shouting about.
      const over = (m.projected || 0) > (m.allowance || Infinity);

      const trend = w.changePct == null
        ? '<span class="ath-trend none" title="Not enough history to compare with the previous period">no comparison yet</span>'
        : `<span class="ath-trend ${w.changePct >= 0 ? 'up' : 'down'}">${w.changePct >= 0 ? '▲' : '▼'} ${esc(Math.abs(w.changePct))}% vs previous ${days === 1 ? '24h' : days + 'd'}</span>`;

      return `<div class="ath-row">
        <div class="ath-head">
          <span class="ath-name"><i class="swatch" style="background:${colorFor(i)}"></i>${esc(s.name)}</span>
          ${trend}
        </div>
        <div class="ath-bar${over ? ' over' : ''}">
          <i class="ath-actual" style="width:${pct.toFixed(1)}%;background:${colorFor(i)}"></i>
          <i class="ath-proj" style="width:${projPct.toFixed(1)}%"></i>
        </div>
        <div class="ath-figures">
          <span><b>${esc(Number(m.ath || 0).toLocaleString())}</b> hours this month${m.partial ? ' <em>(from when monitoring began)</em>' : ''}</span>
          <span class="ath-sep">·</span>
          <span>${esc(m.pctOfAllowance ?? 0)}% of ${esc(Number(m.allowance || 0).toLocaleString())}</span>
          <span class="ath-sep">·</span>
          <span class="${over ? 'ath-over' : ''}">on track for <b>${esc(Number(m.projected || 0).toLocaleString())}</b> by month end</span>
        </div>
      </div>`;
    }).join('');

    $('#ath-panel').innerHTML = blocks
      + `<div class="ath-note">
           <span class="material-symbols-outlined">info</span>
           Estimated from listener counts polled every minute — not a log of individual
           connections. Use as an early warning, not as a filing figure.
           ${anyPartial ? 'Some months are counted only from when monitoring began.' : ''}
         </div>`;

    const tz = (list[0] && list[0].ath && list[0].ath.month && list[0].ath.month.timeZone) || 'UTC';
    $('#ath-hint').textContent = `calendar month · ${tz}`;
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
        <td class="num">${st.peak == null ? '—' : esc(st.peak)}${st.peakAt ? `<span class="peak-when">${esc(fmtWhen(st.peakAt))}</span>` : ''}</td>
        <td class="num">${st.low == null ? '—' : esc(fmt(st.low))}</td>
        <td class="num">${esc(Math.round(share))}%</td>
      </tr>`;
    }).join('');

    $('#channel-table').innerHTML =
      `<thead><tr><th>Channel</th><th class="num">Now</th><th class="num">Average</th><th class="num">Peak</th><th class="num">Low</th><th class="num">Share</th></tr></thead>
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

  /** A peak is only useful with a "when" attached. */
  function fmtWhen(t) {
    const d = new Date(t);
    return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
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
