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
      ['#count-cards', '#aud-lines', '#channel-table', '#daily-table', '#mount-breakdown', '#hour-profile'].forEach((s) => {
        const el = $(s);
        if (el) el.innerHTML = '';
      });
      return;
    }
    renderCounts();
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

  /**
   * Headcounts for today, this week and this month — the page's headline.
   *
   * Peak and average, each against the same elapsed span of the previous
   * period, because "down 10% on last month" is only true if the two spans are
   * comparable. Nine days measured against a full thirty-one would report a
   * collapse every month without fail.
   *
   * A count of DISTINCT people is shown as unavailable rather than omitted.
   * Icecast reports how many connections exist, not who they are, so no polling
   * rate can turn this into "1,800 different people listened". Hiding the card
   * would leave the impression the figure simply was not thought of.
   */
  function renderCounts() {
    const c = (data && data.counts) || null;
    if (!c) { $('#count-cards').innerHTML = ''; return; }

    // ROLLING WINDOWS, and the labels say so literally. "This month" meant
    // month-to-date, which on the 1st is a few hours — shown beside a
    // week-to-date card that was 33 hours old, it read 415 against 1,809 and
    // looked to every reader like the month's data had been lost. A window named
    // for its own length cannot mislead that way, and the three always nest.
    const PERIODS = [
      { key: 'day', label: 'Last 24 hours', vs: 'the 24 hours before' },
      { key: 'week', label: 'Last 7 days', vs: 'the 7 days before' },
      { key: 'month', label: 'Last 30 days', vs: 'the 30 days before' },
    ];

    const delta = (pct, vs, cls) => {
      if (pct == null) return `<span class="cc-delta none">no ${esc(vs)} to compare</span>`;
      const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
      const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '–';
      return `<span class="cc-delta ${dir} ${cls || ''}">${arrow} ${esc(Math.abs(pct))}% vs ${esc(vs)}</span>`;
    };

    // Peak and average carry their own gate, separate from the reach total's.
    // A period longer than the raw-sample window compares a per-minute present
    // against an hourly past, and hourly averaging flattens every spike — so the
    // server levels both sides to hours before dividing. Saying so matters: a
    // reader who is not told will take "at the busiest moment" and the
    // percentage under it as the same kind of number, and they are not.
    const cDelta = (d, key, p) => {
      if (d.concurrencyComparable === false) {
        return `<span class="cc-delta none">not enough comparable history to measure against ${esc(p.vs)}</span>`;
      }
      const out = delta(d.changePct && d.changePct[key], p.vs);
      return d.comparisonResolution === 'hour'
        ? `${out}<span class="cc-basis">compared hour by hour — ${esc(p.vs)} is past the minute-by-minute window</span>`
        : out;
    };

    // A window can reach back further than the recording behind it, and the two
    // figures on a card began on DIFFERENT days — arrivals later than levels,
    // because the early tune-in figures were wrong and were cleared. Unexplained,
    // that is why one row compares and the row beneath it says there is not
    // enough history, which reads as a fault rather than as a start date.
    const since = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // A HEADING THAT STATES A SPAN THE DATA DOES NOT COVER IS NOT FIXABLE BY A
    // FOOTNOTE. "LAST 30 DAYS" over eight days of arrivals is the line that gets
    // read, screenshotted and quoted; the correction under it is read second, if
    // at all. So the heading carries the real span itself whenever recording
    // began inside the window — the same treatment the history page's range pill
    // already gives a monitor younger than its selected range.
    const spanLabel = (p, d, from) => {
      if (!from.arrivals || !d.end) return esc(p.label);
      const days = (Date.parse(d.end) - Date.parse(from.arrivals)) / 86400000;
      if (!isFinite(days) || days <= 0) return esc(p.label);
      const n = days < 10 ? days.toFixed(1) : Math.round(days);
      return `${esc(p.label)}<span class="cc-label-partial"> · only ${esc(n)} days recorded</span>`;
    };
    const recordedNote = (iso, what) => (iso
      ? `<div class="cc-partial">Counted from ${esc(since(iso))} — ${esc(what)} before then were not recorded, so this is a floor, not a total.</div>`
      : '');

    /* CUME — distinct devices reached. Given its own block rather than a line in
       the secondary list, because it answers a different question from
       everything else on the card: the others count listening, this counts
       PEOPLE. It is what underwriting is priced on and what a board asks for,
       and it is the one audience figure that does not rise when the stream
       breaks and everybody reconnects. */
    const cumeRow = (d, p) => {
      const meta = d.individualListenersMeta || {};
      if (d.individualListeners == null) {
        return `<div class="cc-cume pending">
          <div class="cc-cume-v">—</div>
          <div class="cc-cume-l">individual listeners — not recorded for this period yet</div>
        </div>`;
      }
      return `<div class="cc-cume">
        <div class="cc-cume-v">${esc(d.individualListeners.toLocaleString())}</div>
        <div class="cc-cume-l">individual listeners — different devices reached</div>
        ${d.individualListenersComparable === false
          ? '<span class="cc-delta none">not enough recorded history to compare</span>'
          : delta(d.changePct && d.changePct.individualListeners, p.vs, 'strong')}
        ${meta.partial
          ? `<div class="cc-partial">A floor: measuring began ${esc(since(meta.coveredFrom))}, inside this window.</div>`
          : ''}
      </div>`;
    };

    const cards = PERIODS.map((p) => {
      const d = c[p.key] || {};
      const meta = d.totalListenersMeta || {};
      const from = d.recordedFrom || {};

      if (d.totalListeners == null && d.peak == null) {
        return `<div class="count-card">
          <div class="cc-label">${esc(p.label)}</div>
          <div class="cc-total">—</div>
          <div class="cc-sub">no readings yet</div>
        </div>`;
      }

      // TOTAL LISTENERS leads. "How many people listened" is the figure a
      // listener-supported station reports; "how many at once" is a fact about
      // server load. They differ six to nine fold, so leading with the wrong one
      // understates the station by an order of magnitude.
      return `<div class="count-card headline">
        <div class="cc-label">${spanLabel(p, d, from)}</div>
        <div class="cc-total">${d.totalListeners == null ? '—' : esc(d.totalListeners.toLocaleString())}</div>
        <div class="cc-total-l">total listeners — times someone tuned in</div>
        ${d.totalListenersComparable === false
          ? `<span class="cc-delta none">not enough recorded history to compare with ${esc(p.vs)}</span>`
          : delta(d.changePct && d.changePct.totalListeners, p.vs, 'strong')}
        ${recordedNote(from.arrivals, 'arrivals')}
        ${!from.arrivals && meta.hoursMissing ? `<div class="cc-partial">A floor for this period: ${esc(Number(meta.hoursMissing).toLocaleString())} channel-hour(s) predate tune-in recording and are not counted at all.</div>` : ''}
        ${cumeRow(d, p)}
        <div class="cc-secondary">
          ${recordedNote(from.levels, 'audience levels')}
          <div class="cc-sec">
            <span class="cc-sec-v">${d.peak == null ? '—' : esc(d.peak.toLocaleString())}</span>
            <span class="cc-sec-l">at once, at the busiest moment</span>
            ${cDelta(d, 'peak', p)}
          </div>
          <div class="cc-sec">
            <span class="cc-sec-v">${esc(fmt(d.avg))}</span>
            <span class="cc-sec-l">typically listening</span>
            ${cDelta(d, 'avg', p)}
          </div>
        </div>
      </div>`;
    }).join('');

    // The other half of the headline, shown as a headline rather than hidden:
    // one person who tunes in ten times is ten total listeners and ONE
    // individual listener, and a station needs both numbers.
    const gated = Object.values(c.unavailable || {}).map((u) => `<div class="count-card headline unavailable">
      <div class="cc-label">${esc(u.label)}</div>
      <div class="cc-total">—</div>
      <div class="cc-total-l">${esc(u.detail)}</div>
      <div class="cc-unavailable">
        <span class="material-symbols-outlined">lock</span>
        Unavailable for this server — ${esc(u.reason)}.
      </div>
    </div>`).join('');

    $('#count-cards').innerHTML = cards + gated;

    const m = (c.day && c.day.totalListenersMeta) || {};
    // No timezone is named here any more, and that is the point: these windows
    // end now and count backwards, so they are the same span in every zone.
    // Naming a clock would imply a midnight boundary that no longer exists.
    const basis = 'counted back from now — not calendar days, weeks or months';
    $('#counts-hint').textContent = m.floor
      ? `${basis} · a floor — brief overlaps are invisible between checks`
      : basis;
  }

  /**
   * What the floor and the average are measured over, when that is not the
   * whole window.
   *
   * Silence here would be the bug returning in a quieter form: a figure taken
   * over five of a hundred and sixty-nine hours, presented under the label
   * "last 7 days", is still telling the reader something untrue.
   */
  function coverageNote(st) {
    const c = st && st.coverage;
    if (!c || !c.from || c.used >= c.total) return null;
    const since = new Date(c.from).toLocaleString('en-US', {
      weekday: 'short', hour: 'numeric', minute: '2-digit',
    });
    return `over the ${c.used} of ${c.total} periods with all ${rows().length} channels — since ${since}`;
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
        // Say what the figure actually covers. Channels get added over time, and
        // a window reaching back before one existed is not a window in which
        // the station was quieter — it is one in which it was less watched.
        sub: coverageNote(st),
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
        sub: coverageNote(st),
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

  /* ── Who is listening (authenticated) ─────────────────────────────────
     This section is gated while the rest of the page is public, so a signed-out
     visitor must get an EXPLANATION rather than an error or a missing panel. A
     panel that silently disappears teaches nobody that the data exists. */

  function fmtSession(sec) {
    if (sec == null) return '—';
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function bars(obj, total, limit) {
    const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, limit || 8);
    if (!rows.length) return '<div class="muted">No data</div>';
    return rows.map(([label, n]) => {
      const pct = total ? Math.round((n / total) * 100) : 0;
      return `
        <div class="deep-bar-row">
          <div class="deep-bar-label">${esc(label)}</div>
          <div class="deep-bar-track"><div class="deep-bar-fill" style="width:${pct}%"></div></div>
          <div class="deep-bar-val">${n}<span class="deep-bar-pct">${pct}%</span></div>
        </div>`;
    }).join('');
  }

  async function renderDeep() {
    const panel = document.getElementById('deep-panel');
    const hint = document.getElementById('deep-hint');
    if (!panel) return;

    let res;
    try {
      res = await fetch(`/api/listener-detail?days=${days}${scope()}`);
    } catch {
      panel.innerHTML = '<div class="muted">Could not reach the server.</div>';
      return;
    }

    if (res.status === 401 || res.status === 503) {
      // 401 = not signed in. 503 = no admin password configured on the server.
      // Different causes, and the fix differs, so they do not share a message.
      const why = res.status === 401
        ? 'Sign in to see which players, devices and smart speakers the audience uses, and how long people actually listen.'
        : 'No admin password is configured on this server, so protected sections are switched off.';
      panel.innerHTML = `
        <div class="deep-locked">
          <span class="material-symbols-outlined">lock</span>
          <div>
            <div class="deep-locked-title">Sign in to view</div>
            <div class="deep-locked-note">${esc(why)}</div>
          </div>
          ${res.status === 401 ? '<a class="deep-signin" href="/login.html">Sign in</a>' : ''}
        </div>`;
      if (hint) hint.textContent = '';
      return;
    }

    if (!res.ok) { panel.innerHTML = '<div class="muted">Unavailable.</div>'; return; }

    const d = await res.json();
    const mounts = (d.mounts || []).filter((m) => (m.connections || 0) > 0);

    if (!d.credentialedHost) {
      panel.innerHTML = `
        <div class="deep-locked">
          <span class="material-symbols-outlined">key_off</span>
          <div>
            <div class="deep-locked-title">No Icecast admin credential</div>
            <div class="deep-locked-note">This needs an Icecast admin password for the stream's server. Without one the rest of the page is unaffected — only this section depends on it.</div>
          </div>
        </div>`;
      return;
    }

    if (!mounts.length) {
      panel.innerHTML = '<div class="muted">No listener detail collected yet — the first pass runs within a few minutes of startup.</div>';
      return;
    }

    // Live totals across the credentialed host — this instant only.
    let listeners = 0; let bots = 0; let connections = 0;
    for (const m of mounts) {
      listeners += m.listeners || 0; bots += m.bots || 0; connections += m.connections || 0;
    }

    /* The MIX is drawn from the stored period record, not from the live
       snapshot. A snapshot of this minute is a sample of whoever happens to be
       connected; the period record is every device seen across the window, and
       it is the one that answers "what do our listeners use". */
    const per = d.period || {};
    const players = per.players || {};
    const platforms = per.platforms || {};
    const cume = per.devices || 0;
    const rangeName = rangeLabelFor(days).toLowerCase();

    // The longest-running mount's median is the most meaningful single session
    // figure; medians cannot be averaged across mounts, so one is SHOWN rather
    // than a blended number invented from several.
    const busiest = mounts.slice().sort((a, b) => (b.session?.count || 0) - (a.session?.count || 0))[0];

    /* ── How the audience arrives, and why it qualifies everything else ──────
       An aggregator that PROXIES carries an unknown number of listeners behind
       one connection. Every other figure in this panel — the headcount, the
       device mix, the session medians, and the ATH estimate further up the page
       — then understates the real audience by a factor only this number can
       bound. So it is rendered as a QUALIFIER at the top of the section, not as
       one more tile among six, and the copy says plainly that a proxied
       listener is an uncounted one rather than a lost one. Read the other way,
       a station sees a high proxied share as an audience decline. */
    /* SEPARATE WITH A MIDDOT, NOT A COMMA, AND MARK THE COUNT WITH A MULTIPLIER.
       These are company names and company names contain commas — "Google LLC 8,
       Amazon.com, Inc. 8, Fastly, Inc. 6" gives a reader no way to see where one
       network ends and the next begins, and the bare trailing number reads as
       part of the name. Seen on the live page before it was fixed. */
    const nameCounts = (pairs) => pairs.map(([k, v]) => `${k} \u00d7${v}`).join('  \u00b7  ');

    const dist = d.distribution || {};
    const prox = dist.proxied || {};
    const proxPct = prox.connectionShare == null ? null : Math.round(prox.connectionShare * 100);
    const namedAggs = Object.entries(dist.aggregators || {}).sort((a, b) => b[1] - a[1]);
    const relays = Object.entries(dist.relayNetworks || {}).sort((a, b) => b[1] - a[1]);
    const asnLoaded = !!d.geo?.asn?.loaded;

    /* The confidence vocabulary from DEEP-ANALYTICS-PLAN.md §2, rendered so the
       qualification travels WITH the figure rather than sitting in a footnote.
       `floor` is the important one: with no ASN database only aggregators that
       name themselves are caught, so the true share is at least this. */
    const proxQual = prox.confidence === 'floor'
      ? { prefix: 'at least ', note: 'Only services that name themselves are counted — no network database is loaded, so unnamed relays are invisible. The real share is at least this.' }
      : prox.confidence === 'estimated'
        ? { prefix: '', note: 'Estimated. No free database flags hosting providers, so datacenter traffic is identified by network operator name.' }
        : { prefix: '', note: '' };

    const distributionBlock = prox.confidence === 'unavailable' || proxPct == null ? '' : `
      <div class="deep-qualifier${proxPct >= 20 ? ' high' : ''}">
        <div class="deep-qualifier-fig">
          <div class="deep-qualifier-value">${proxQual.prefix}${proxPct}%</div>
          <div class="deep-qualifier-label">of connections arrive via a relay</div>
        </div>
        <div class="deep-qualifier-body">
          <p><strong>A proxied listener is an uncounted listener, not a lost one.</strong>
          An aggregator can carry many people behind a single connection, so every
          headcount on this page &mdash; and the listening-hours estimate above &mdash;
          understates the real audience by an unknown factor. This figure bounds that error;
          it is not an audience decline.</p>
          ${proxQual.note ? `<p class="deep-qualifier-note">${esc(proxQual.note)}</p>` : ''}
          ${namedAggs.length ? `<p class="deep-qualifier-note">Named services: ${esc(nameCounts(namedAggs))}</p>` : ''}
          ${relays.length ? `<p class="deep-qualifier-note">Relay networks: ${esc(nameCounts(relays.slice(0, 4)))}</p>` : ''}
          ${asnLoaded ? '' : '<p class="deep-qualifier-note">Set <code>GEOIP_ASN_DB</code> to a local ASN database to identify unnamed relays. DB-IP ASN Lite is free and needs no account.</p>'}
        </div>
      </div>`;

    /* CC BY REQUIRES this credit wherever the data is shown; it is a licence
       obligation, not a courtesy. Derived from the file actually loaded, so a
       page cannot credit a vendor whose data it is not displaying. */
    const attribution = (d.attribution || []).length
      ? `<div class="deep-attribution">${(d.attribution || []).map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.text)}</a>`).join(' · ')}</div>`
      : '';

    const rows = mounts.map((m) => `
      <tr>
        <td class="mono">${esc(m.mount)}</td>
        <td class="num">${m.listeners}</td>
        <td class="num">${m.bots ? `<span class="deep-bot">${m.bots}</span>` : '—'}</td>
        <td class="num">${fmtSession(m.session?.medianSec)}</td>
        <td class="num">${fmtSession(m.session?.p90Sec)}</td>
        <td class="num">${fmtSession(m.session?.maxSec)}</td>
        <td>${esc(Object.entries(m.players || {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(', ') || '—')}</td>
      </tr>`).join('');

    panel.innerHTML = `
      ${distributionBlock}
      <div class="deep-tiles">
        <div class="deep-tile primary">
          <div class="deep-tile-label">Individual listeners · ${esc(rangeName)}</div>
          <div class="deep-tile-value">${cume ? cume.toLocaleString() : '—'}</div>
          <div class="deep-tile-note">different devices reached${per.partial ? ' — a floor, measuring began inside this window' : ''}</div>
        </div>
        <div class="deep-tile">
          <div class="deep-tile-label">Listening right now</div>
          <div class="deep-tile-value">${listeners}</div>
          <div class="deep-tile-note">${connections} connections, ${bots} machine${bots === 1 ? '' : 's'} excluded</div>
        </div>
        <div class="deep-tile">
          <div class="deep-tile-label">Typical session${busiest ? ` · ${esc(busiest.mount)}` : ''}</div>
          <div class="deep-tile-value">${fmtSession(busiest?.session?.medianSec)}</div>
          <div class="deep-tile-note">median — measured, not estimated</div>
        </div>
        <div class="deep-tile">
          <div class="deep-tile-label">Longest session</div>
          <div class="deep-tile-value">${fmtSession(Math.max(...mounts.map((m) => m.session?.maxSec || 0)) || null)}</div>
          <div class="deep-tile-note">of a real listener, machines removed</div>
        </div>
        <div class="deep-tile">
          <div class="deep-tile-label">Distinct addresses</div>
          <div class="deep-tile-value">${d.distinctAddresses == null ? '—' : d.distinctAddresses}</div>
          <div class="deep-tile-note">connected right now. <strong>Not a headcount</strong> — a household shares one address, and an aggregator can hide hundreds behind one.</div>
        </div>
        <div class="deep-tile">
          <div class="deep-tile-label">Mounts measured</div>
          <div class="deep-tile-value">${mounts.length}</div>
          <div class="deep-tile-note">on ${esc(d.credentialedHost)}</div>
        </div>
      </div>

      <div class="deep-split">
        <div>
          <div class="deep-sub">Player / app · ${esc(rangeName)}</div>
          ${bars(players, cume, 9)}
        </div>
        <div>
          <div class="deep-sub">Platform · ${esc(rangeName)}</div>
          ${bars(platforms, cume, 6)}
        </div>
      </div>

      <div class="deep-sub">Per mount · right now</div>
      <div class="table-scroll">
        <table class="aud-table">
          <thead><tr>
            <th>Mount</th><th class="num">Listeners</th><th class="num">Machines</th>
            <th class="num">Median</th><th class="num">p90</th><th class="num">Longest</th><th>Top players</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${attribution}`;

    if (hint) {
      hint.textContent = d.lastRunAt
        ? `mix over ${rangeName} · session and per-mount figures read ${fmtWhen(d.lastRunAt)}`
        : '';
    }
  }

  /* ── Range echo ───────────────────────────────────────────────────────
     Six sections scroll past below the range selector and every one of them
     obeys it, but by the third a reader cannot tell whether a chart covers a
     day or three months without scrolling back up. So the active range is
     repeated on each section it governs. "Who Is Listening" carries it too now
     that its headline and device mix are measured over the window; the figures
     inside it that remain a reading of this instant say so on their own face,
     because one panel showing two clocks has to label both. */
  function rangeLabelFor(d) {
    if (d <= 1) return 'Last 24 hours';
    if (d <= 7) return 'Last 7 days';
    if (d <= 30) return 'Last 30 days';
    if (d <= 90) return 'Last 90 days';
    return `Last ${Math.round(d)} days`;
  }

  function syncRangeEcho() {
    const bar = document.querySelector('.range-bar');
    if (!bar) return;
    const label = rangeLabelFor(days);
    document.querySelectorAll('.section-title').forEach((t) => {
      // Only the sections BELOW the selector are governed by it.
      const below = bar.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (!below || t.hasAttribute('data-live-section')) return;
      let chip = t.querySelector(':scope > .range-echo');
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'range-echo';
        t.appendChild(chip);
      }
      chip.textContent = label;
    });
  }

  /* ── Boot ────────────────────────────────────────────────────────────── */

  document.getElementById('range-pills').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-pill');
    if (!btn) return;
    document.querySelectorAll('.range-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    days = parseFloat(btn.dataset.days) || 7;
    syncRangeEcho();
    load();
    renderDeep().catch(() => {});
  });

  document.getElementById('export-btn').addEventListener('click', exportCsv);

  (async function boot() {
    await initStationPicker();
    syncRangeEcho();
    await load();
    // Independent of load(): a failure here must not take the public page with
    // it, and it does not move with the date-range pills — it is a live reading.
    renderDeep().catch(() => {});
  })();
})();
