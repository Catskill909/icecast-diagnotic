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
  let loadVersion = 0;

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
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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
    const version = ++loadVersion;
    // Clear the previous selection before any request can finish. Both APIs
    // refresh together, but a protected-panel failure must not hide public data.
    data = null;
    render();
    $('#aud-tiles').innerHTML = '<div class="aud-empty">Loading audience data…</div>';
    $('#range-note').textContent = 'Updating…';
    renderDeep(version).catch(() => {
      if (version !== loadVersion) return;
      const panel = $('#deep-panel');
      if (panel) panel.innerHTML = '<div class="muted">Could not load listener detail.</div>';
      blankGeo('Could not load listener detail.');
    });
    let next;
    try {
      const r = await fetch(`/api/listeners?days=${days}${scope()}`);
      next = r.ok ? await r.json() : null;
    } catch (e) {
      next = null;
    }
    if (version !== loadVersion) return;
    data = next;
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
      ['#count-cards', '#aud-lines', '#channel-table', '#daily-table', '#mount-breakdown', '#hour-profile', '#ath-panel'].forEach((s) => {
        const el = $(s);
        if (el) el.innerHTML = '';
      });
      $('#ath-hint').textContent = '';
      $('#range-note').textContent = '';
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

  /* A TRUNCATED LIST HAS TO SAY SO.

     This showed the top nine players and silently dropped the rest, so a
     station whose audience uses ten kinds of app saw the tenth simply not
     exist — reported as "iOS app is not showing for KPFK, but the other
     stations have it". It is the same failure this page has had to fix
     repeatedly: an absent figure is indistinguishable from a zero one.

     It also breaks the arithmetic on screen. The percentages are shares of the
     whole audience, so a reader adding the visible rows finds they fall short
     of 100% with nothing to explain the gap.

     So the remainder is drawn as its own row: how many were left out, and how
     many listeners they account for between them. */
  /* THE REMAINDER ROW IS THE EXPANDER, rather than a separate "show all"
     control somewhere else.

     It is already saying "3 more" — the number a reader wants is one click from
     the place they noticed it was missing, with no modal, no second page and no
     control at all when nothing is hidden. A list that fits shows no affordance
     because there is nothing behind it.

     The tail stays COLLAPSED by default. Most of it is one-listener entries,
     and a panel that opens with thirty rows of noise is a panel nobody scans —
     which is how the truncation got there in the first place. */
  let barSeq = 0;

  function moreRow(hiddenCount, hiddenListeners, total, hiddenRowsHtml, why) {
    if (hiddenCount <= 0) return '';
    const pct = total ? Math.round((hiddenListeners / total) * 100) : 0;
    const id = `bar-rest-${barSeq += 1}`;
    const expandable = Boolean(hiddenRowsHtml);
    return `
      <div class="deep-bar-row deep-bar-rest${expandable ? ' is-toggle' : ''}"
           ${expandable ? `data-bar-toggle="${id}" role="button" tabindex="0"
           aria-expanded="false" aria-controls="${id}"
           title="Show the remaining ${hiddenCount}"` : ''}>
        <div class="deep-bar-label">${expandable ? '<span class="bar-caret">▸</span> ' : ''}${hiddenCount} more${why ? `, ${esc(why)}` : ''}</div>
        <div class="deep-bar-track"><div class="deep-bar-fill" style="width:${pct}%"></div></div>
        <div class="deep-bar-val">${hiddenListeners}<span class="deep-bar-pct">${pct}%</span></div>
      </div>
      ${expandable ? `<div class="deep-bar-hidden" id="${id}" hidden>${hiddenRowsHtml}</div>` : ''}`;
  }

  /* WHERE TO CUT A RANKED LIST: by SHARE, not by a fixed count.

     Twelve was arbitrary, and arbitrary cuts land in the wrong place for some
     stations and not others. On KPFK the twelfth entry was 1% and the collapsed
     tail was 6% — so the hidden group outranked three of the rows above it,
     which reads oddly and is a fair thing for a reader to query.

     A threshold adapts instead: a station with five players shows five, and one
     with twenty meaningful ones shows twenty. The remainder then MEANS
     something — "each under 1%" — rather than "whatever did not fit". The
     ceiling exists only so a pathological tail cannot fill the panel. */
  const BAR_MIN_SHARE = 0.01;
  const BAR_MAX_ROWS = 20;

  function bars(obj, total, limit) {
    const all = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    const floor = total ? total * BAR_MIN_SHARE : 0;
    const significant = all.filter(([, n]) => n >= floor).length;
    /* A numeric `limit` is still honoured as a FLOOR on how many to show, so a
       caller that wants at least six platforms still gets them even when only
       three clear the threshold. */
    const keep = Math.min(BAR_MAX_ROWS, Math.max(significant, limit || 0, 1));
    const shown = all.slice(0, keep);
    if (!shown.length) return '<div class="muted">No data</div>';
    const hidden = all.slice(shown.length);
    const row = ([label, n]) => {
      const pct = total ? Math.round((n / total) * 100) : 0;
      return `
        <div class="deep-bar-row">
          <div class="deep-bar-label">${esc(label)}</div>
          <div class="deep-bar-track"><div class="deep-bar-fill" style="width:${pct}%"></div></div>
          <div class="deep-bar-val">${n}<span class="deep-bar-pct">${pct}%</span></div>
        </div>`;
    };
    /* Named by WHY they are hidden when that is true of all of them, because
       "each under 1%" answers the question the row provokes — is there anything
       in there I should have seen? */
    const allBelow = hidden.length > 0 && hidden.every(([, n]) => n < floor);
    return shown.map(row).join('')
      + moreRow(hidden.length, hidden.reduce((a, [, n]) => a + n, 0), total,
        hidden.map(row).join(''), allBelow ? 'each under 1%' : null);
  }

  /* Returning vs new listeners.

     WHY THIS IS TWO TILES AND NOT ONE RATIO. "62% came back" and "1,300 people
     found us this week" are different questions — retention and growth — and a
     station acts on them differently. A single share hides the second one
     entirely: a period can hold its regulars and reach nobody new, and the
     percentage goes UP.

     WHY IT IS EVER BLANK. The earlier period is half of the figure, and if the
     monitor was not running through it the listeners who were there are simply
     not recorded — every one of them then counts as new. The store withholds
     rather than guess; the tile says which reason, because "we could not
     measure it" and "nobody came back" must not look the same. */
  const RETURNING_BLANK = {
    'nothing-recorded': 'No listener history has been recorded yet.',
    'earlier-period-not-recorded': 'Needs the period before this one as well, and measuring had not started then.',
    'resolution-too-coarse': 'Records this old are kept by calendar month, which cannot be divided across this period without counting the same listener in both halves.',
    'no-channels': 'No channels in this selection.',
  };

  function returningTiles(d) {
    const r = d.returning;
    if (!r) return '';
    const span = plural(r.days || 0, 'day', 'days');

    if (!r.comparable) {
      const why = RETURNING_BLANK[r.reason] || 'Not available for this selection.';
      return `
        <div class="deep-tile">
          <div class="deep-tile-label">Came back</div>
          <div class="deep-tile-value">—</div>
          <div class="deep-tile-note">${esc(why)}</div>
        </div>`;
    }

    const pct = r.returningShare == null ? null : Math.round(r.returningShare * 100);
    return `
      <div class="deep-tile">
        <div class="deep-tile-label">Came back</div>
        <div class="deep-tile-value">${pct == null ? '—' : pct + '%'}</div>
        <div class="deep-tile-note">${r.returning.toLocaleString()} of
          ${r.current.toLocaleString()} also listened in the previous ${esc(span)}.
          <strong>A floor</strong> — a listener whose connection changed address
          in between reads as a new one, so real loyalty is higher, never lower.</div>
      </div>
      <div class="deep-tile">
        <div class="deep-tile-label">First time</div>
        <div class="deep-tile-value">${r.newListeners.toLocaleString()}</div>
        <div class="deep-tile-note">not seen in the previous ${esc(span)},
          when ${r.previous.toLocaleString()} listened. Whole days, so today is
          counted once it ends.</div>
      </div>`;
  }

  /* ── How they listen, over time ──────────────────────────────────────────
     The mix above is a snapshot; this is the same thing as a series, which is
     the form a platform decision is actually made from. Grouped by KIND rather
     than by player, because "smart speakers went from 8% to 22%" is a sentence
     somebody can act on and "Sonos 4%, Alexa 3%, Chromecast 1%" is not. */
  const KIND_LABELS = {
    'app': 'Phone / tablet app',
    'smart-speaker': 'Smart speaker',
    'desktop-player': 'Desktop player',
    'tv': 'TV / streaming box',
    'aggregator': 'Aggregator',
    'library': 'Script / library',
    'unknown': 'Unidentified',
  };
  // Stable per kind, so a colour means the same thing in the bars and the legend.
  const KIND_ORDER = ['app', 'smart-speaker', 'desktop-player', 'tv', 'aggregator', 'library', 'unknown'];
  const kindLabel = (k) => KIND_LABELS[k] || String(k || '').replace(/-/g, ' ');

  function trendBlock(d) {
    const t = d.trend;
    if (!t || !Array.isArray(t.buckets)) return '';

    /* Only FINISHED buckets. A period still running is not a smaller period,
       and the last column falling off a cliff is the most convincing wrong
       chart this page could draw. */
    const buckets = t.buckets.filter((b) => b.complete);
    const unit = t.granularity === 'month' ? 'months' : 'days';

    if (buckets.length < 3) {
      return `
        <div class="deep-sub">How they listen · over time</div>
        <div class="geo-note-line">Not enough finished ${esc(unit)} in this range to
          show a trend yet. It needs at least three, and a longer range gives a
          clearer one.</div>`;
    }

    // Kinds actually present, in the fixed order, so colours stay put.
    const present = KIND_ORDER.filter((k) => buckets.some((b) => (b.kinds || {})[k]));
    for (const b of buckets) {
      for (const k of Object.keys(b.kinds || {})) if (!present.includes(k)) present.push(k);
    }

    const share = (b, k) => (b.devices ? ((b.kinds || {})[k] || 0) / b.devices : 0);
    const fmtKey = (b) => {
      const dt = new Date(b.start);
      return t.granularity === 'month'
        ? dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
        : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    };

    const first = buckets[0];
    const last = buckets[buckets.length - 1];
    /* The headline is the kind that MOVED most, not the biggest one — the
       largest category is usually the least interesting news. */
    let moved = null;
    for (const k of present) {
      const delta = share(last, k) - share(first, k);
      if (!moved) { moved = { kind: k, delta }; continue; }
      const bigger = Math.abs(delta) - Math.abs(moved.delta);
      /* Ties go to the one that ROSE. In a mix of two categories every delta is
         the mirror of the other, so a tie is the normal case rather than an
         edge one — and "phone apps fell from 90% to 70%" and "smart speakers
         grew from 10% to 30%" are the same fact told as a loss or as a finding.
         The second is the one somebody can act on.

         TIED MEANS TIED ON SCREEN, not bit-for-bit. 0.7 - 0.9 is
         -0.20000000000000007 and 0.3 - 0.1 is 0.19999999999999998, so an exact
         comparison hands the headline to whichever mirror image carries the
         larger rounding error. Half a percentage point is below what the panel
         prints, so two moves inside it are indistinguishable to the reader. */
      if (bigger > 0.005) moved = { kind: k, delta };
      else if (bigger > -0.005 && delta > moved.delta) moved = { kind: k, delta };
    }
    const headline = moved && Math.abs(moved.delta) >= 0.01
      ? `<div class="trend-headline"><strong>${esc(kindLabel(moved.kind))}</strong>
           went from ${Math.round(share(first, moved.kind) * 100)}% to
           ${Math.round(share(last, moved.kind) * 100)}% of listeners between
           ${esc(fmtKey(first))} and ${esc(fmtKey(last))}.</div>`
      : `<div class="trend-headline">The mix has held steady across this range.</div>`;

    const columns = buckets.map((b) => {
      const segs = present.map((k) => {
        const pct = share(b, k) * 100;
        return pct <= 0 ? '' : `<div class="trend-seg kind-${esc(k)}" style="height:${pct}%"></div>`;
      }).join('');
      const detail = present
        .filter((k) => (b.kinds || {})[k])
        .map((k) => `${kindLabel(k)} ${Math.round(share(b, k) * 100)}%`)
        .join(', ');
      return `<div class="trend-col" title="${esc(fmtKey(b))} — ${esc(plural(b.devices, 'listener', 'listeners'))}: ${esc(detail)}">${segs}</div>`;
    }).join('');

    return `
      <div class="deep-sub">How they listen · over time</div>
      ${headline}
      <div class="trend">
        <div class="trend-cols">${columns}</div>
        <div class="trend-axis"><span>${esc(fmtKey(first))}</span><span>${esc(fmtKey(last))}</span></div>
        <div class="trend-legend">
          ${present.map((k) => `<span><i class="kind-${esc(k)}"></i>${esc(kindLabel(k))}</span>`).join('')}
        </div>
        <div class="trend-note">Share of the distinct listeners counted in each
          ${esc(t.granularity)}. ${t.granularity === 'month'
            ? 'Shown by month because records this old are kept by calendar month — bucketing them by day would put a whole month of listening on the 1st.'
            : 'Shown by day. Longer ranges switch to months as older records are compacted.'}</div>
      </div>`;
  }

  /* ── Which channels these figures cover ──────────────────────────────────
     TWO DIFFERENT GATES, and they must never look alike. "Sign in" is about
     the READER and takes ten seconds. "No admin password for this server" is
     about the DEPLOYMENT and needs a station engineer. A single grey box for
     both sends the first reader looking for the wrong person.

     Said ONCE, at the top of the section, and never repeated per panel — the
     alternative is a page of apologies that a reader learns to scroll past.
     Individual figures carry a small key instead. */
  function coverageBand(d) {
    const c = d.detailCoverage;
    if (!c || !c.total) return '';
    if (c.covered === c.total) return '';        // nothing to explain

    const hosts = (c.uncoveredHosts || []).map((h) => `<code>${esc(h)}</code>`).join(', ');
    const missing = (c.channels || []).filter((x) => !x.covered).map((x) => x.name || x.id);

    /* THE PARTIAL CASE IS THE DANGEROUS ONE. A station carried on two servers
       gets real figures covering part of itself, which reads as the whole
       station. KPFA is exactly this: one channel on Pacifica's host and one on
       its own. Saying nothing understates the station and nobody goes looking. */
    if (c.covered > 0) {
      return `
        <div class="cov-band cov-partial">
          <span class="material-symbols-outlined">key_off</span>
          <div>
            <div class="cov-title">These figures cover ${c.covered} of ${c.total} channels</div>
            <div class="cov-note">${esc(missing.join(', '))}
              ${missing.length === 1 ? 'is' : 'are'} carried on ${hosts}, which this
              monitor has no Icecast admin password for — so nothing below counts
              ${missing.length === 1 ? 'its' : 'their'} listeners. Everything ABOVE this
              section covers the whole station.</div>
          </div>
        </div>`;
    }

    return `
      <div class="cov-band">
        <span class="material-symbols-outlined">key_off</span>
        <div>
          <div class="cov-title">Advanced audience data is off for this selection</div>
          <div class="cov-note">Counting how many people are listening needs nothing
            special, and every figure above this section is unaffected. Telling one
            listener from another — individual listeners, players, devices, session
            length and geography — needs an Icecast <strong>admin</strong> password for
            ${hosts}. Ask whoever runs that server; it is entered once, per server.</div>
        </div>
      </div>`;
  }

  /* The gated figures, present and empty.

     An affiliate whose server has no admin password is the COMMON case, not an
     edge one, and a page that simply omits these teaches them nothing about
     what the tool does or what would switch it on. Present and empty is a
     different message from absent: it names the figure, shows a key, and the
     band above says who to ask. */
  const GATED_FIGURES = [
    ['Individual listeners', 'how many different people, not how many tune-ins'],
    ['Came back', 'how many of them listened in the period before'],
    ['First time', 'how many were new'],
    ['Player / app · platform', 'what people listen with, and how that moves'],
    ['Session length', 'how long people actually stay'],
    ['Where they listen', 'which states and countries, and when each one listens'],
  ];

  const lockedTiles = () => `
    <div class="deep-tiles">
      ${GATED_FIGURES.map(([label, note]) => `
        <div class="deep-tile locked">
          <div class="deep-tile-label">${esc(label)}
            <span class="material-symbols-outlined cov-key" title="Needs an Icecast admin password">key_off</span>
          </div>
          <div class="deep-tile-value">—</div>
          <div class="deep-tile-note">${esc(note)}</div>
        </div>`).join('')}
    </div>`;

  /* ── How long they listened, over the period ─────────────────────────────
     The live tiles above answer "how long have the people connected RIGHT NOW
     been connected", which is a different question and a much smaller sample.
     This is the engagement figure a manager actually watches: reach says how
     many, this says whether they stayed.

     EACH LISTENER COUNTED ONCE, at their longest session in the period. The
     obvious alternative — tally what each reading sees and add it up — is
     length-biased: a six-hour session appears in seventy-two readings and a
     two-minute one in at most one, so the audience would look far more engaged
     than it is, and the error would grow with the very thing being measured. */
  function sessionBlock(d) {
    const sess = d.period?.sessions;
    if (!sess || !Array.isArray(sess.labelled)) return '';
    if (!sess.measured) {
      return sess.notRecorded
        ? `<div class="deep-sub">Session length · ${esc(rangeLabelFor(days))}</div>
           <div class="geo-note-line">No session lengths recorded in this period.
             ${sess.notRecorded} ${sess.notRecorded === 1 ? 'listener was' : 'listeners were'}
             counted without one, because the streaming server reported no connection
             time for them.</div>`
        : '';
    }

    const rows = sess.labelled.map((b) => {
      const share = sess.measured ? Math.round((b.listeners / sess.measured) * 100) : 0;
      return `
        <div class="deep-bar-row">
          <div class="deep-bar-label">${esc(b.label)}</div>
          <div class="deep-bar-track"><div class="deep-bar-fill" style="width:${share}%"></div></div>
          <div class="deep-bar-val">${b.listeners.toLocaleString()}<span class="deep-bar-pct">${share}%</span></div>
        </div>`;
    }).join('');

    return `
      <div class="deep-sub">Session length · ${esc(rangeLabelFor(days))}</div>
      ${rows}
      <div class="geo-note-line">Each listener counted <strong>once</strong>, at their
        longest session in this period \u2014 so somebody who listened every day is one
        row here, not seven. ${sess.notRecorded
    ? `<strong>${sess.notRecorded}</strong> more had no connection time reported and
           ${sess.notRecorded === 1 ? 'is' : 'are'} left out rather than counted as short.`
    : ''} Connection time comes from the streaming server itself, not from
        guessing between checks.</div>`;
  }

  /* ── When each region listens ─────────────────────────────────────────────
     The daypart question, which is how radio is scheduled and sold.

     EACH ROW IS NORMALISED TO ITS OWN PEAK. Drawn on a shared scale the home
     state fills every row and the others render as empty strips, which answers
     "which state is biggest" — a question the map above already answers — and
     hides the one being asked here, which is WHEN. The size of each region is
     carried as a number beside it instead. */
  const hourLabel = (h) => (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`);

  function regionHoursBlock(d) {
    const rh = d.regionHours;
    if (!rh || !Array.isArray(rh.regions) || !rh.regions.length) {
      return `
        <div class="deep-sub">When each region listens</div>
        <div class="geo-note-line">No hour-of-day record for this selection yet.
          It is written as listening is measured and cannot be filled in
          backwards, so it begins when recording starts.</div>`;
    }

    const zone = rh.timeZone === 'UTC' ? 'UTC' : rh.timeZone.split('/').pop().replace(/_/g, ' ');
    const shownRegions = rh.regions.slice(0, 8);
    const hiddenRegions = rh.regions.slice(8);
    const rows = shownRegions.map((r) => {
      const peakN = Math.max(...r.hours);
      const peakHour = r.hours.indexOf(peakN);
      const name = r.region
        ? ((window.GeoMap && GeoMap.STATE_NAMES && GeoMap.STATE_NAMES[r.region]) || r.region)
        : r.country;
      const cells = r.hours.map((n, h) => {
        // Five steps, matching the map's legend, so intensity means the same
        // thing in both places.
        const step = n <= 0 ? 0 : Math.max(1, Math.ceil((n / peakN) * 5));
        return `<i class="rh-cell step-${step}" title="${esc(name)} · ${esc(hourLabel(h))} — ${esc(plural(n, 'listener', 'listeners'))}"></i>`;
      }).join('');
      return `
        <div class="rh-row">
          <div class="rh-name">${esc(name)}</div>
          <div class="rh-cells">${cells}</div>
          <div class="rh-peak">peak ${esc(hourLabel(peakHour))}</div>
          <div class="rh-total">${r.total.toLocaleString()}</div>
        </div>`;
    }).join('');

    const from = rh.coveredFrom
      ? `Recording of the hour began ${new Date(rh.coveredFrom).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. `
      : '';

    return `
      <div class="deep-sub">When each region listens · ${esc(zone)} time</div>
      <div class="rh">
        <div class="rh-row rh-head">
          <div class="rh-name"></div>
          <div class="rh-cells rh-scale">
            ${[0, 6, 12, 18].map((h) => `<span>${esc(hourLabel(h))}</span>`).join('')}
          </div>
          <div class="rh-peak"></div>
          <div class="rh-total">listeners</div>
        </div>
        ${rows}
        ${hiddenRegions.length
    ? `<div class="rh-row rh-rest"><div class="rh-name">${hiddenRegions.length} more</div>
         <div class="rh-cells"></div><div class="rh-peak"></div>
         <div class="rh-total">${hiddenRegions.reduce((a, r) => a + r.total, 0).toLocaleString()}</div></div>`
    : ''}
        <div class="rh-note">Each row is shaded against <strong>its own</strong> busiest
          hour, so a smaller region's pattern is visible rather than flattened by the
          largest one; the count beside it is the size. Hours are the
          <strong>station's</strong> — a programme airs on the station's clock, so that
          is what a daypart is read against. ${esc(from)}It cannot be filled in
          backwards: before recording started, the hour had already been compacted away.
          A listener present across several hours counts in each of them, so this
          measures <strong>when listening happens</strong> and is not a count of people.</div>
      </div>`;
  }

  async function renderDeep(version) {
    const panel = document.getElementById('deep-panel');
    const hint = document.getElementById('deep-hint');
    if (!panel) return;
    panel.innerHTML = '<div class="muted">Loading listener detail…</div>';
    if (hint) hint.textContent = '';
    blankGeo('Loading listener detail…');

    let res;
    try {
      res = await fetch(`/api/listener-detail?days=${days}${scope()}`);
    } catch {
      if (version !== loadVersion) return;
      panel.innerHTML = '<div class="muted">Could not reach the server.</div>';
      blankGeo('Could not reach the server.');
      return;
    }

    if (version !== loadVersion) return;
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
          ${res.status === 401 ? `<a class="deep-signin" href="/login.html?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a>` : ''}
        </div>`;
      if (hint) hint.textContent = '';
      blankGeo(res.status === 401 ? 'Sign in to see where the audience is.' : 'Protected sections are switched off.');
      return;
    }

    if (!res.ok) {
      panel.innerHTML = '<div class="muted">Unavailable.</div>';
      blankGeo('Unavailable.');
      return;
    }

    const d = await res.json();
    if (version !== loadVersion) return;
    // ONE PAYLOAD, TWO SECTIONS. Both are drawn from this single response so a
    // map and the headcounts beside it cannot come from two different fetches.
    renderGeo(d).catch(() => {});
    const mounts = (d.mounts || []).filter((m) => (m.connections || 0) > 0);

    /* SHOWN, MARKED UNAVAILABLE — NEVER HIDDEN, which is what
       docs/ADMIN-ACCESS-SCOPE.md §4.1 already decided and what this code did
       not do: it replaced the whole section with one box and returned, so a
       reader on an uncredentialed station never learned the product could do
       any of it. A figure that is present and empty teaches what is missing
       and what would switch it on; a figure that is absent teaches nothing. */
    if (!mounts.length && !d.period?.devices) {
      const band = coverageBand(d);
      panel.innerHTML = band
        ? band + lockedTiles()
        : '<div class="muted">No listener detail available for this selection yet.</div>';
      if (hint) hint.textContent = '';
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
      ${coverageBand(d)}
      ${distributionBlock}
      <div class="deep-tiles">
        <div class="deep-tile primary">
          <div class="deep-tile-label">Individual listeners · ${esc(rangeName)}</div>
          <div class="deep-tile-value">${cume ? cume.toLocaleString() : '—'}</div>
          <div class="deep-tile-note">different devices reached${per.partial ? ' — a floor, measuring began inside this window' : ''}</div>
        </div>
        ${returningTiles(d)}
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
          <div class="deep-tile-value">${fmtSession(Math.max(0, ...mounts.map((m) => m.session?.maxSec || 0)) || null)}</div>
          <div class="deep-tile-note">of a real listener, machines removed</div>
        </div>
        <div class="deep-tile">
          <div class="deep-tile-label">Distinct addresses</div>
          <div class="deep-tile-value">${d.distinctAddresses == null ? '—' : d.distinctAddresses}</div>
          <div class="deep-tile-note">${d.distinctAddresses == null ? 'A distinct address total is not available for this selection.' : 'connected right now.'} <strong>Not a headcount</strong> — a household shares one address, and an aggregator can hide hundreds behind one.</div>
        </div>
        <div class="deep-tile">
          <div class="deep-tile-label">Mounts measured</div>
          <div class="deep-tile-value">${mounts.length}</div>
          <div class="deep-tile-note">on ${(d.credentialedHosts || []).length > 1
            ? esc(`${d.credentialedHosts.length} servers`)
            : esc(d.credentialedHost || '—')}</div>
        </div>
      </div>

      <div class="deep-split">
        <div>
          <div class="deep-sub">Player / app · ${esc(rangeName)}</div>
          ${/* Twelve, not nine. A real station's mix is longer than the list
                was: KPFK's iOS audience sat at tenth and was therefore not on
                the page at all. The remainder row below makes any truncation
                honest, but a category a station would act on should be visible
                without arithmetic. */ ''}
          ${bars(players, cume, 12)}
        </div>
        <div>
          <div class="deep-sub">Platform · ${esc(rangeName)}</div>
          ${bars(platforms, cume, 6)}
        </div>
      </div>

      ${sessionBlock(d)}

      ${trendBlock(d)}

      ${regionHoursBlock(d)}

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

  /* Every early return in renderDeep must also clear this panel. Leaving the
     last successful map on screen after a sign-out would show one reader's
     audience to the next. */
  function blankGeo(msg) {
    const panel = document.getElementById('geo-panel');
    const hint = document.getElementById('geo-hint');
    if (panel) panel.innerHTML = `<div class="muted">${esc(msg)}</div>`;
    if (hint) hint.textContent = '';
  }

  /* ── Where They Listen ────────────────────────────────────────────────
     Reads the SAME payload as renderDeep — /api/listener-detail carries the
     places block — so the map and the audience figures beside it can never
     describe two different moments. */
  /* WHICH MAP. "period" counts distinct people across the selected range;
     "live" counts connections open this second. The period map is the figure a
     general manager actually reports, so it leads — but it can only draw what
     has been recorded since geography started being stored, and before that
     there is nothing to show. The choice is remembered per reader. */
  let geoMode = 'period';
  try { geoMode = localStorage.getItem('geoMode') === 'live' ? 'live' : 'period'; } catch (e) { /* private mode */ }
  let lastDetail = null;

  /**
   * How much of the selected window the location record actually covers.
   *
   * THIS IS WHAT RETIRES THE EXPLANATORY NOTICE. Geography is written down from
   * the day the column shipped and cannot be backfilled, so for the first weeks
   * the map is honestly incomplete. Rather than a banner somebody must remember
   * to delete before a network rollout, the notice is derived: once every
   * listener in the window carries a location there is nothing left to explain
   * and it stops being rendered.
   *
   * `places.coveredFrom` is when LOCATION recording began, NOT `period
   * .coveredFrom`, which is when DEVICE recording began. Reading the second as
   * the first produced "recorded for 7 days of the last 7 days, so this map
   * covers part of the period" — a sentence that argues with itself, on a
   * panel whose entire job that week was to explain why a number was small.
   */
  function geoCoverage(d) {
    const period = d.period || {};
    const places = period.places || {};
    const windowDays = period.days || days;

    const from = places.coveredFrom ? new Date(places.coveredFrom) : null;
    const daysLocated = from ? Math.max(0, (Date.now() - from.getTime()) / 86400000) : 0;

    const located = places.placed || 0;
    const relays = places.relays || 0;
    const unplaced = places.unplaced || 0;
    // People counted in this window before there was anywhere to put a location.
    const unrecorded = places.unrecorded || 0;

    return {
      windowDays, from, daysLocated, located, unrecorded,
      known: located + relays + unplaced,
      total: located + relays + unplaced + unrecorded,
      // Nothing to draw: every device in the window predates the location record.
      empty: located === 0,
      /* Some of this window has locations behind it and some does not. Driven by
         the devices themselves rather than by a date arithmetic: as the old rows
         age out of the range this reaches zero and the notice retires, with no
         clock to get wrong. */
      partial: located > 0 && unrecorded > 0,
    };
  }


  async function renderGeo(d) {
    const panel = document.getElementById('geo-panel');
    const hint = document.getElementById('geo-hint');
    if (!panel || !window.GeoMap) return;
    lastDetail = d;

    const cov = geoCoverage(d);
    // Asking for the window map before any of it was recorded would draw an
    // empty country. Fall back to live and say why, rather than showing nothing.
    const usePeriod = geoMode === 'period' && !cov.empty;
    const places = usePeriod ? (d.period.places || {}) : (d.places || {});
    const rangeName = rangeLabelFor(days);

    // A person and a connection are not the same unit, and the map means
    // something different depending on which one it is counting.
    const unit = usePeriod
      ? { one: 'person', many: 'people', noun: 'listeners' }
      : { one: 'connection', many: 'connections', noun: 'connections' };

    /* One LINE here, not the band again. The band is said once, higher up; a
       reader who has scrolled this far still needs to know why the map is empty,
       and "no located connections yet" would read as data that is on its way. */
    const detailCov = d.detailCoverage;
    if (detailCov && detailCov.total && detailCov.covered === 0) {
      panel.innerHTML = `<div class="geo-note-line">
        Where listeners are needs an Icecast <strong>admin</strong> password for
        ${(detailCov.uncoveredHosts || []).map((h) => `<code>${esc(h)}</code>`).join(', ')}.
        See the note in <strong>Who Is Listening</strong> above.</div>`;
      if (hint) hint.textContent = '';
      return;
    }

    const ready = GeoMap.readiness(places, d.geo);
    const market = GeoMap.inMarket(places);
    const countryRows = GeoMap.countries(places);

    const toggle = `
      <div class="geo-modes" role="group" aria-label="What the map counts">
        <button type="button" class="geo-mode${usePeriod ? ' active' : ''}"
                data-geo-mode="period"${cov.empty ? ' disabled' : ''}>${esc(rangeName)}</button>
        <button type="button" class="geo-mode${usePeriod ? '' : ' active'}"
                data-geo-mode="live">Right now</button>
        <span class="geo-mode-note">${usePeriod
          ? 'distinct people who listened in this period'
          : 'connections open at this moment'}</span>
      </div>`;

    let notice = '';
    if (cov.empty) {
      notice = `<div class="geo-notice">
          <span class="material-symbols-outlined">schedule</span>
          <div><strong>Location history is still being collected.</strong>
            Where listeners are can only be counted from the day the app started
            recording it, and it cannot be filled in backwards. Until then this
            panel shows who is connected right now.</div>
        </div>`;
    } else if (cov.partial) {
      /* STATE THE REAL REASON AND THE REAL NUMBERS. The question this notice
         exists to answer is "why is this number so much smaller than the one
         above it", and the answer is a count, not a date. */
      const started = cov.daysLocated < 1
        ? 'less than a day ago'
        : `${plural(Math.floor(cov.daysLocated), 'day', 'days')} ago`;
      notice = `<div class="geo-notice">
          <span class="material-symbols-outlined">hourglass_top</span>
          <div><strong>Still filling in.</strong>
            ${esc(plural(cov.known, 'person', 'people'))} of ${cov.total} in this
            period were counted after location recording began
            (${esc(started)}). The other ${cov.unrecorded} were counted before
            it, and that cannot be filled in backwards. The map grows on its own
            and this notice disappears once everyone in the range is covered.</div>
        </div>`;
    }

    const foot = `
      <div class="geo-foot">
        <span><strong>${places.placed || 0}</strong> ${unit.many} located</span>
        <span><strong>${places.relays || 0}</strong> relays excluded</span>
        <span><strong>${places.unplaced || 0}</strong> could not be placed</span>
      </div>`;

    // The map, or the reason there isn't one — never a blank grid, which would
    // read as an audience that exists nowhere.
    const mapBlock = ready.ok
      ? `<div class="geo-grid" role="img" aria-label="${usePeriod ? 'Listeners' : 'Connections'} by US state">
           ${GeoMap.tiles(places).map((t) => `
             <div class="geo-tile step-${t.step}${t.code === market.home ? ' home' : ''}"
                  style="grid-column:${t.col + 1};grid-row:${t.row + 1}"
                  title="${esc(t.name)} — ${plural(t.listeners, unit.one, unit.many)}">
               <span class="geo-tile-code">${t.code}</span>
               ${t.listeners ? `<span class="geo-tile-n">${t.listeners}</span>` : ''}
             </div>`).join('')}
         </div>
         <div class="geo-legend">
           <span>fewer</span>
           ${[1, 2, 3, 4, 5].map((n) => `<i class="step-${n}"></i>`).join('')}
           <span>more</span>
         </div>`
      : `<div class="geo-blocked">
           <span class="material-symbols-outlined">public_off</span>
           <div>
             <div class="geo-blocked-title">${esc(ready.title)}</div>
             <div class="geo-blocked-note">${esc(ready.note)}</div>
           </div>
         </div>`;

    /* The headline. Stated as a STATE share and never as "in our coverage
       area": the licence area is a metro, this is a whole state, and the gap
       between them is real listeners in Dallas. */
    const marketBlock = market.available
      ? `<div class="geo-tiles">
           <div class="deep-tile primary">
             <div class="deep-tile-label">In ${esc(market.homeName)}</div>
             <div class="deep-tile-value">${Math.round(market.share * 100)}%</div>
             <div class="deep-tile-note">${market.inside} of ${market.usPlaced} located US ${esc(unit.many)}.
               <strong>A state, not a signal area</strong> — a listener across the state counts as inside.</div>
           </div>
           <div class="deep-tile">
             <div class="deep-tile-label">Outside ${esc(market.home)}</div>
             <div class="deep-tile-value">${market.outside}</div>
             <div class="deep-tile-note">US ${esc(unit.noun)} the broadcast signal never reaches</div>
           </div>
         </div>`
      : `<div class="geo-note-line">${
        market.reason === 'no-home-region'
          /* Names the station, because the fix is per-station now. A single
             deployment-wide STATION_REGION reported every station's in-market
             share against one state — WPFW's Washington audience came back as
             "0% in Texas", which is worse than no figure at all. */
          ? 'Set this station\u2019s state in the admin panel (e.g. <code>DC</code>) to see how much of its audience is outside the signal area.'
          : 'No US states located in this window.'
      }</div>`;

    /* METRO, which is the resolution a licence actually covers.

       The state map above counts everyone in Texas, so it reports Greater
       Houston's audience as the state's — the in-market figure reads high and
       "outside our signal area", the number that justifies streaming to a
       board, reads low. This is the list that tells them apart.

       Shares are of LOCATED US listeners, the same denominator the in-market
       tile uses, so the two can be read together. */
    const cityRows = Object.entries(places.usCities || {})
      .map(([key, n]) => {
        const [st, ...rest] = key.split('/');
        return { st, name: rest.join('/'), n };
      })
      .filter((c) => c.name && c.n > 0)
      .sort((a, b) => b.n - a.n);
    const cityShown = cityRows.slice(0, 8);
    const cityHidden = cityRows.slice(8);

    const usPlaced = Object.entries(places.usStates || {}).reduce((a, [, n]) => a + n, 0);
    const cityBlock = cityShown.length
      ? `<div class="deep-sub">Metro area</div>
         ${cityShown.map((c) => {
        const share = usPlaced ? Math.round((c.n / usPlaced) * 100) : 0;
        return `
           <div class="deep-bar-row">
             <div class="deep-bar-label">${esc(c.name)}, ${esc(c.st)}</div>
             <div class="deep-bar-track"><div class="deep-bar-fill" style="width:${share}%"></div></div>
             <div class="deep-bar-val">${c.n}<span class="deep-bar-pct">${share}%</span></div>
           </div>`;
      }).join('')}
         ${moreRow(cityHidden.length, cityHidden.reduce((a, c) => a + c.n, 0), usPlaced,
        cityHidden.map((c) => {
          const share = usPlaced ? Math.round((c.n / usPlaced) * 100) : 0;
          return `
             <div class="deep-bar-row">
               <div class="deep-bar-label">${esc(c.name)}, ${esc(c.st)}</div>
               <div class="deep-bar-track"><div class="deep-bar-fill" style="width:${share}%"></div></div>
               <div class="deep-bar-val">${c.n}<span class="deep-bar-pct">${share}%</span></div>
             </div>`;
        }).join(''))}
         <div class="geo-note-line">Share of located US ${esc(unit.many)}, the same
           denominator as the in-market figure above &mdash; so a metro can be read
           against its state. ${places.cityWithheld
    ? `<strong>${places.cityWithheld}</strong> more ${places.cityWithheld === 1 ? 'was' : 'were'}
              precise enough to place in a state but not in a metro, and ${places.cityWithheld === 1 ? 'is' : 'are'}
              counted in the state map and not here.`
    : ''}</div>`
      : (places.cityWithheld
        ? `<div class="deep-sub">Metro area</div>
           <div class="geo-note-line">No ${esc(unit.many)} could be placed to a metro in
             this selection. ${places.cityWithheld} were precise enough for a state but not
             for a city &mdash; a metro is a much smaller claim, so it takes a much better
             record, and naming one on weaker evidence would put listeners in the wrong
             city.</div>`
        : '');

    const countryBlock = countryRows.length
      ? `<div class="deep-sub">Country</div>
         ${countryRows.map((c) => `
           <div class="deep-bar-row">
             <div class="deep-bar-label">${esc(c.code)}</div>
             <div class="deep-bar-track"><div class="deep-bar-fill" style="width:${Math.round(c.share * 100)}%"></div></div>
             <div class="deep-bar-val">${c.listeners}<span class="deep-bar-pct">${Math.round(c.share * 100)}%</span></div>
           </div>`).join('')}
         ${(() => {
        /* GeoMap.countries() returns only the rows it kept, so the remainder is
           counted here from the full set rather than inferred from the page. */
        const every = Object.entries(places.countries || {});
        const total = every.reduce((a, [, n]) => a + n, 0);
        const shownTotal = countryRows.reduce((a, c) => a + c.listeners, 0);
        return moreRow(every.length - countryRows.length, total - shownTotal, total);
      })()}`
      : '';

    const attribution = (d.attribution || []).length
      ? `<div class="deep-attribution">${(d.attribution || []).map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.text)}</a>`).join(' \u00b7 ')}</div>`
      : '';

    panel.innerHTML = toggle + notice + marketBlock + mapBlock + foot + cityBlock + countryBlock + attribution;

    // NAME THE CLOCK. This section is the one panel below the range selector
    // that does not simply obey it, so a reader comparing it with the figures
    // above is otherwise left to conclude the geography is missing listeners.
    if (hint) {
      hint.textContent = usePeriod
        ? `${rangeName.toLowerCase()} \u00b7 distinct listeners`
        : (d.lastRunAt ? `connected right now \u00b7 read ${fmtWhen(d.lastRunAt)}` : 'connected right now');
    }
  }

  /* Delegated on the PANEL, not on the document: the panel rewrites its own
     markup on every render, so a handler bound to the buttons themselves would
     die with them, while one bound to the container survives `innerHTML`.
     Redrawing uses the payload already in hand — switching what the map counts
     is a change of view, not a new request. */
  /* Delegated on the panels, which persist across their own re-renders. The
     rows themselves are replaced on every load, so a handler bound to them
     would die with them. Keyboard too: the row is a button in all but tag. */
  function wireBarToggles(container) {
    if (!container) return;
    const toggle = (btn) => {
      const body = document.getElementById(btn.dataset.barToggle);
      if (!body) return;
      const open = !body.hidden;
      body.hidden = open;
      btn.setAttribute('aria-expanded', String(!open));
      btn.classList.toggle('is-open', !open);
      const caret = btn.querySelector('.bar-caret');
      if (caret) caret.textContent = open ? '\u25B8' : '\u25BE';
    };
    container.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-bar-toggle]');
      if (btn) toggle(btn);
    });
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const btn = e.target && e.target.closest && e.target.closest('[data-bar-toggle]');
      if (!btn) return;
      e.preventDefault();
      toggle(btn);
    });
  }
  wireBarToggles(document.getElementById('deep-panel'));
  wireBarToggles(document.getElementById('geo-panel'));

  const geoPanelEl = document.getElementById('geo-panel');
  if (geoPanelEl) {
    geoPanelEl.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-geo-mode]');
      if (!btn || btn.disabled) return;
      geoMode = btn.dataset.geoMode === 'live' ? 'live' : 'period';
      try { localStorage.setItem('geoMode', geoMode); } catch (err) { /* private mode */ }
      if (lastDetail) renderGeo(lastDetail).catch(() => {});
    });
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
  });

  document.getElementById('export-btn').addEventListener('click', exportCsv);

  (async function boot() {
    await initStationPicker();
    syncRangeEcho();
    await load();
  })();
})();
