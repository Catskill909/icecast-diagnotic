/* ═══════════════════════════════════════════════════════════════════════════
   KPFT Stream Monitor — Incident History
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const PAGE_SIZE = 60;

  let allEvents = [];      // everything fetched for the current range
  let filtered = [];       // after client-side filters
  let rendered = 0;
  let stats = null;
  let streams = [];
  let openIds = new Set(); // survive re-renders
  let dayFilter = null;    // set by clicking a heatmap cell
  let lastUptime = null;   // last /api/uptime payload, re-read on filter changes
  let lastRangeIsAllTime = false;
  let lastListeners = null;
  let lastRollup = null;   // server-computed period totals + narrative

  // 'blip' is the retired severity — stored history still carries it, so it has
  // to keep rendering. New events split it in two, because a vanished mount and
  // a failed probe against a healthy mount are not the same thing.
  const SEVERITY_META = {
    outage:       { icon: 'error',        label: 'Outage' },
    brief_outage: { icon: 'bolt',         label: 'Brief Outage' },
    probe_error:  { icon: 'sensors_off',  label: 'Probe Anomaly' },
    blip:         { icon: 'bolt',         label: 'Blip (legacy)' },
    dead_air:     { icon: 'volume_off',   label: 'Dead Air' },
    recovery:     { icon: 'check_circle', label: 'Recovered' },
  };

  // ── Boot ────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      await reload();
      $('#loading').style.display = 'none';
      $('#history-view').style.display = 'block';
      wireControls();
    } catch (err) {
      console.error('Boot failed:', err);
      $('#loading .loading-text').textContent = 'Failed to load history. Retrying…';
      setTimeout(boot, 5000);
    }
  }

  function rangeDays() {
    const v = $('#f-range').value;
    return v === 'all' ? 3650 : parseInt(v, 10);
  }

  async function reload() {
    const days = rangeDays();
    const isAllTime = $('#f-range').value === 'all';
    const [statsRes, eventsRes, uptimeRes] = await Promise.all([
      fetch(`/api/stats?days=${days}`).then((r) => r.json()),
      fetch(`/api/events?days=${days}&limit=2000`).then((r) => r.json()),
      // Supplementary — the incident record must never depend on it. A monitor
      // mid-deploy serves the new page from a process that lacks this route,
      // and a rejection here would take every summary tile, the heatmap and
      // the timeline down with it.
      fetch(`/api/uptime?days=${days}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    stats = statsRes;
    allEvents = eventsRes.events || [];
    streams = statsRes.streams || [];

    lastUptime = uptimeRes;
    lastRangeIsAllTime = isAllTime;

    // Same defensive contract as /api/uptime: audience is supplementary, and a
    // monitor mid-deploy may serve this page from a process without the route.
    [lastListeners, lastRollup] = await Promise.all([
      fetch(`/api/listeners?days=${days}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/rollup?days=${days}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    populateStreamFilter();
    populateCauseFilter();
    renderStorage();
    syncRangePills();
    renderOverviewRange();
    renderImpactHero();
    renderRoundup();
    renderAudience();
    renderHeatmap();
    renderCauses();
    applyFilters();
  }

  // ── Period control ──────────────────────────────────────────────────────
  const RANGE_LABELS = {
    1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days',
    90: 'Last 90 days', 365: 'Last year', all: 'All time',
  };

  /** Keep the header pills and the timeline dropdown showing one truth. */
  function syncRangePills() {
    const current = $('#f-range').value;
    document.querySelectorAll('#history-range-pills .range-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.days === current);
    });
  }

  /** States the window the tiles cover, in plain dates. */
  function renderOverviewRange() {
    const el = $('#overview-range');
    if (!el) return;
    const value = $('#f-range').value;
    const label = RANGE_LABELS[value] || `Last ${value} days`;
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const end = new Date();
    let startText;
    if (value === 'all') {
      const oldest = stats?.storage?.oldestEvent;
      startText = oldest ? fmt(new Date(oldest)) : null;
    } else {
      const start = new Date(end);
      start.setDate(start.getDate() - (parseInt(value, 10) - 1));
      startText = fmt(start);
    }

    el.textContent = startText ? `${label} · ${startText} – ${fmt(end)}` : label;
  }

  /**
   * The headline: what the audience lost.
   *
   * Period-scoped rather than filter-scoped, like the Listening Lost tile it
   * summarises — the figures come from each event's frozen audience block, and
   * quietly restating a subtotal under the same words would make it a different
   * number wearing the same label.
   */
  function renderImpactHero() {
    const hero = $('#impact-hero');
    if (!hero || !lastRollup) { if (hero) hero.style.display = 'none'; return; }

    const r = lastRollup;
    const a = r.audience || {};
    if (a.lostSharePercent == null && !a.listenerHoursLost) { hero.style.display = 'none'; return; }
    hero.style.display = 'block';

    const top = r.topIncidents || [];
    const peak = a.peakListenersAffected || 0;
    const clean = !r.counts?.listenerAffecting;
    hero.classList.toggle('clean', clean);

    // PEOPLE ONLY in this block. No duration appears anywhere near it — a
    // headcount and a clock time formatted alike, side by side, is what made
    // the whole page unreadable.
    $('#ih-value').textContent = clean ? 'None' : peak.toLocaleString();
    $('#ih-incidents-count').textContent = r.counts?.significant ?? 0;
    $('#ih-streams').textContent = r.counts?.streamsAffected ?? 0;
    // Attribute the peak to the failure it actually came from — which is rarely
    // the longest one, because the longest outage often hits a quiet daypart.
    $('#ih-sub').textContent = clean
      ? 'Every stream served audio for the whole period.'
      : `at the worst single moment${a.peakListenersStream ? ` — ${a.peakListenersStream}` : ''}${
        a.peakListenersAt
          ? ` on ${new Date(a.peakListenersAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
          : ''}`;

    renderVolumeLine();

    // Name the incidents. This is the part an engineer acts on and the part a
    // manager remembers; a total on its own gives neither of them anything.
    const host = $('#ih-incidents');
    if (!host) return;
    if (!top.length) {
      host.innerHTML = r.otherIncidents?.count
        ? `<div class="ih-rest">${r.otherIncidents.count} brief interruption${r.otherIncidents.count === 1 ? '' : 's'}, none longer than ${fmtDuration(r.otherIncidents.longestMs)}.</div>`
        : '';
      return;
    }

    // Whose equipment failed. The single most useful fact when this record
    // goes to Pacifica: an 18-hour HD2 dropout while Icecast served 11 other
    // mounts is a KPFT studio fault, and calling it "the server was down" is
    // both wrong and embarrassing.
    const FAULT = {
      kpft: { label: 'KPFT equipment', cls: 'kpft' },
      pacifica: { label: 'Pacifica server', cls: 'pacifica' },
      unknown: { label: 'cause unclear', cls: 'unknown' },
    };

    const rows = top.map((i) => {
      const when = new Date(i.timestamp).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const f = FAULT[i.fault] || FAULT.unknown;
      const heads = i.listenersTunedIn
        ? `${i.listenersTunedIn} listener${i.listenersTunedIn === 1 ? '' : 's'}`
        : 'no one listening';
      return `
        <div class="ih-row">
          <span class="ih-when">${esc(when)}</span>
          <span class="ih-streams">${esc(i.streams.join(' + '))} off air</span>
          <span class="ih-dur">${esc(fmtDuration(i.durationMs))}</span>
          <span class="ih-cause">${esc(i.cause || 'cause not diagnosed')}
            <span class="ih-fault ${f.cls}">${esc(f.label)}</span>
          </span>
          <span class="ih-cost">${esc(heads)}</span>
        </div>`;
    }).join('');

    const rest = r.otherIncidents?.count
      ? `<div class="ih-rest">${r.otherIncidents.count} further interruption${r.otherIncidents.count === 1 ? '' : 's'}${
        r.otherIncidents.longestMs ? `, none longer than ${fmtDuration(r.otherIncidents.longestMs)}` : ''}.</div>`
      : '';

    host.innerHTML = rows + rest;
  }

  /**
   * Audience volume — kept, but quarantined.
   *
   * Listener-hours is a legitimate broadcast measure and the engineer and the
   * GM may both want it. It is ruinous next to a clock duration: "3h 35m" and
   * "100.9 l-hrs" in one row invite the reader to treat them as the same unit,
   * and the second is always the larger. So it lives alone, spelled out in
   * full, and always beside the total it is a fraction of.
   */
  function renderVolumeLine() {
    const el = $('#volume-line');
    if (!el || !lastRollup) return;

    const a = lastRollup.audience || {};
    if (a.listenerHoursLost == null) { el.style.display = 'none'; return; }
    el.style.display = '';

    if (!a.listenerMinutesLost) {
      el.innerHTML = '<span class="vl-clean">No listening was lost in this period.</span>';
      return;
    }

    const deliveredTotal = (a.listenerHoursDelivered || 0) + a.listenerHoursLost;
    el.innerHTML =
      `<span class="vl-value">${a.listenerHoursLost.toLocaleString()}</span>` +
      `<span class="vl-unit">listener-hours lost</span>` +
      `<span class="vl-of">out of ${deliveredTotal.toLocaleString()} that would otherwise have been heard` +
      (a.lostSharePercent != null ? ` — <strong>${a.lostSharePercent}%</strong>` : '') +
      `</span>`;
  }

  // ── Period roundup ──────────────────────────────────────────────────────
  /**
   * The period in one sentence, above the tiles that break it down.
   *
   * The sentence itself is composed SERVER-side and used verbatim — the weekly
   * roundup email sends the same string, so the dashboard and the inbox cannot
   * describe the same week differently. This function only decides how it looks.
   *
   * It describes the selected PERIOD, not the filtered timeline: the audience
   * cost comes from each event's frozen impact block and is a whole-period
   * figure, so quietly restating it as a subtotal whenever a filter is on would
   * make it a different number with the same label. When a stream is selected,
   * that stream's own figures are added on their own line instead.
   */
  function renderRoundup() {
    const wrap = $('#overview-summary');
    if (!wrap) return;

    const r = lastRollup;
    if (!r || !r.narrative) { wrap.style.display = 'none'; return; }

    const clean = r.counts.outages === 0 && r.counts.deadAir === 0;
    wrap.style.display = 'flex';
    wrap.classList.toggle('clean', clean);
    $('#os-icon').innerHTML =
      `<span class="material-symbols-outlined">${clean ? 'check_circle' : 'summarize'}</span>`;
    $('#os-headline').textContent = `${r.narrative.period} — ${r.narrative.headline}`;
    $('#os-detail').textContent = r.narrative.detail;
    renderRoundupScope();
  }

  /** Per-stream figures, shown only while a stream filter is narrowing the view. */
  function renderRoundupScope() {
    const el = $('#os-scope');
    if (!el || !lastRollup) return;

    const streamId = $('#f-stream').value;
    const s = streamId && lastRollup.perStream.find((x) => x.id === streamId);
    if (!s) { el.style.display = 'none'; return; }

    const faults = s.outages + s.deadAir;
    const bits = [
      `${faults} confirmed outage${faults === 1 ? '' : 's'}`,
      s.uptime != null ? `${s.uptime}% uptime` : null,
      s.downtimeMs ? `${fmtDuration(s.downtimeMs)} down` : null,
      s.avgListeners != null ? `avg ${s.avgListeners} listeners` : null,
    ].filter(Boolean);

    el.style.display = '';
    el.textContent = `${s.name} alone: ${bits.join(' · ')}`;
  }

  // ── Uptime tile ─────────────────────────────────────────────────────────
  function coverageLabel(coverageDays) {
    if (!coverageDays) return '0h';
    if (coverageDays < 1) return `${Math.max(1, Math.round(coverageDays * 24))}h`;
    return `${coverageDays < 10 ? coverageDays.toFixed(1) : Math.round(coverageDays)}d`;
  }

  /**
   * Reads from the last fetch rather than taking arguments, so it can be
   * re-run whenever the stream filter changes without another round trip —
   * otherwise this tile would keep reporting every stream while its five
   * neighbours narrowed to one.
   */
  function renderUptimeStat() {
    const valueEl = $('#stat-uptime');
    const detailEl = $('#stat-uptime-detail');
    if (!valueEl || !detailEl) return;

    const streamId = $('#f-stream').value;
    // Audio uptime — probe-only failures are not charged to the station. The
    // rollup carries it per stream, so a stream filter narrows it without
    // falling back to the sample-based figure and silently changing meaning.
    const perStream = streamId ? lastRollup?.perStream?.find((s) => s.id === streamId) : null;
    const percent = streamId ? perStream?.uptime : lastRollup?.uptime ?? lastUptime?.uptime;
    const scope = streamId
      ? (streams.find((s) => s.id === streamId)?.name || streamId)
      : 'across all streams';

    if (percent == null) {
      valueEl.textContent = '—';
      valueEl.className = 'summary-value neutral';
      detailEl.textContent = !streamId && !lastUptime
        ? 'Uptime unavailable'
        : 'Collecting data — check back soon';
      detailEl.className = 'summary-detail partial';
      return;
    }

    valueEl.textContent = `${percent}%`;
    valueEl.className = percent >= 99 ? 'summary-value up' : percent >= 95 ? 'summary-value neutral' : 'summary-value down';

    // Coverage is a property of the monitor's lifetime, not of the selected
    // stream, so the shortfall warning applies either way.
    const partial = !lastRangeIsAllTime && lastUptime
      && lastUptime.coverageDays < lastUptime.days * 0.95;
    // Say that this excludes probe-only failures, otherwise it reads as the
    // same number the dashboard used to show and quietly means something else.
    const basis = `${scope} · excludes probe-only failures`;
    if (partial) {
      detailEl.textContent = `${basis} · partial, only ${coverageLabel(lastUptime.coverageDays)} collected`;
      detailEl.className = 'summary-detail partial';
    } else {
      detailEl.textContent = basis;
      detailEl.className = 'summary-detail';
    }
  }

  // ── Filter option population ────────────────────────────────────────────
  function populateStreamFilter() {
    const sel = $('#f-stream');
    const current = sel.value;
    sel.innerHTML = '<option value="">All streams</option>' +
      streams.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    sel.value = current;
  }

  function populateCauseFilter() {
    const sel = $('#f-cause');
    const current = sel.value;
    const causes = new Map();
    allEvents.forEach((e) => {
      if (e.diagnosis?.cause) causes.set(e.diagnosis.cause, e.diagnosis.causeLabel);
    });
    sel.innerHTML = '<option value="">Any cause</option>' +
      [...causes.entries()].map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    sel.value = current;
  }

  function renderStorage() {
    const s = stats.storage || {};
    const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    $('#storage-text').textContent = `${s.eventCount || 0} events · ${kb((s.eventsBytes || 0) + (s.samplesBytes || 0))}`;
    $('#retention-note').textContent = s.oldestEvent
      ? `Permanent record since ${new Date(s.oldestEvent).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
      : 'Complete permanent record';
  }

  // ── Heatmap ─────────────────────────────────────────────────────────────
  function renderHeatmap() {
    const el = $('#heatmap');
    const days = Math.min(rangeDays(), 371);
    const byDay = new Map((stats.daily || []).map((d) => [d.day, d]));

    // Column-major grid, one column per week, aligned so each row is a weekday.
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));

    const cells = [];
    const pad = start.getDay();
    // Pad so the first column starts on Sunday.
    for (let i = 0; i < pad; i++) {
      cells.push('<div class="hm-cell placeholder"></div>');
    }

    // Month labels, each spanning the weeks it covers.
    const monthSpans = [];
    let cellIndex = pad;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const col = Math.floor(cellIndex / 7);
      const m = d.getMonth();
      const last = monthSpans[monthSpans.length - 1];
      if (!last || last.month !== m) {
        monthSpans.push({ month: m, label: d.toLocaleDateString('en-US', { month: 'short' }), startCol: col, endCol: col });
      } else {
        last.endCol = col;
      }
      cellIndex++;
    }
    $('#heatmap-months').innerHTML = monthSpans.map((m, i) => {
      const span = Math.max(1, m.endCol - m.startCol + 1);
      // Drop the label when its month is too narrow to show text.
      return `<div class="hm-month" style="grid-column: span ${span}">${span >= 3 || i === 0 ? m.label : ''}</div>`;
    }).join('');

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = toLocalKey(d);
      const bucket = byDay.get(key);
      const score = bucket ? bucket.outages * 3 + bucket.deadAir * 3 + bucket.blips : 0;
      const level = score === 0 ? 0 : score <= 2 ? 1 : score <= 5 ? 2 : score <= 10 ? 3 : 4;
      const cls = score === 0 ? 'empty' : `l${level}`;
      const selected = dayFilter === key ? ' selected' : '';
      const label = bucket
        ? `${key}: ${bucket.outages} outage(s), ${bucket.blips} blip(s), ${bucket.deadAir} dead air, ${bucket.recoveries} recovery`
        : `${key}: no events`;
      cells.push(
        `<div class="hm-cell ${cls}${selected}" data-day="${key}" title="${esc(label)}"></div>`,
      );
    }

    el.innerHTML = cells.join('');
    $('#heatmap-range').textContent =
      `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    el.querySelectorAll('.hm-cell[data-day]').forEach((cell) => {
      cell.onclick = () => {
        const day = cell.dataset.day;
        dayFilter = dayFilter === day ? null : day;
        renderHeatmap();
        applyFilters();
      };
    });
  }

  // ── Root causes ─────────────────────────────────────────────────────────
  function renderCauses() {
    const list = $('#causes-list');
    const causes = stats.causes || [];

    if (!causes.length) {
      list.innerHTML = '<div class="causes-empty">No diagnosed failures in this range.</div>';
      return;
    }

    const max = Math.max(...causes.map((c) => c.count));
    const palette = {
      source_disconnected: '#f59e0b',
      icecast_down: '#ef4444',
      server_restart: '#f87171',
      connection_reset: '#a78bfa',
      network: '#60a5fa',
      dns: '#38bdf8',
      tls: '#fbbf24',
      timeout: '#818cf8',
      server_error: '#fb7185',
      dead_air: '#eab308',
      mount_stalled: '#c084fc',
    };

    list.innerHTML = causes.map((c) => {
      const active = $('#f-cause').value === c.cause ? ' active' : '';
      const color = palette[c.cause] || '#7c6aef';
      return `
        <div class="cause-row${active}" data-cause="${esc(c.cause)}" title="Click to filter by this cause">
          <div class="cause-name"><span class="timing-dot" style="background:${color}"></span>${esc(c.label)}</div>
          <div class="cause-track"><div class="cause-fill" style="width:${(c.count / max) * 100}%; background:${color}"></div></div>
          <div class="cause-count">${c.count}</div>
        </div>`;
    }).join('');

    list.querySelectorAll('.cause-row').forEach((row) => {
      row.onclick = () => {
        const sel = $('#f-cause');
        sel.value = sel.value === row.dataset.cause ? '' : row.dataset.cause;
        renderCauses();
        applyFilters();
      };
    });
  }

  // ── Filtering ───────────────────────────────────────────────────────────
  function applyFilters() {
    const streamId = $('#f-stream').value;
    const severity = $('#f-severity').value;
    const cause = $('#f-cause').value;
    const email = $('#f-email').value;
    const search = $('#f-search').value.trim().toLowerCase();

    filtered = allEvents.filter((e) => {
      if (streamId && e.streamId !== streamId) return false;
      if (severity && e.severity !== severity) return false;
      if (cause && e.diagnosis?.cause !== cause) return false;
      if (email === 'true' && e.email?.sent !== true) return false;
      if (email === 'false' && e.email?.sent === true) return false;
      if (dayFilter && toLocalKey(new Date(e.timestamp)) !== dayFilter) return false;
      if (search) {
        const hay = [
          e.message, e.streamName, e.diagnosis?.causeLabel,
          e.diagnosis?.errorMessage, e.diagnosis?.errorCode,
          ...(e.diagnosis?.evidence || []),
        ].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    renderUptimeStat();
    renderRoundupScope();
    renderSummary();
    renderActiveFilterNote();

    rendered = 0;
    $('#timeline').innerHTML = '';
    renderMore();
  }

  function renderActiveFilterNote() {
    const note = $('#active-filter-note');
    if (!dayFilter) { note.style.display = 'none'; return; }
    note.style.display = 'flex';
    note.innerHTML = `
      <span class="material-symbols-outlined" style="font-size:18px;">event</span>
      Showing only ${new Date(dayFilter + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
      <button id="clear-day">Clear day filter</button>`;
    $('#clear-day').onclick = () => {
      dayFilter = null;
      renderHeatmap();
      applyFilters();
    };
  }

  // ── Listener audience ───────────────────────────────────────────────────
  /**
   * Small multiples, one row per stream, sharing a single time axis.
   *
   * A shared Y axis was the obvious first idea and the wrong one: Main peaks
   * around 200 concurrent listeners while HD2 and HD3 sit under 15, so one
   * scale flattens two of the three streams into a line along the floor. Giving
   * each row its own scale keeps every stream's shape readable, and the shared
   * X axis still lets a server-wide event be read at a glance — its outage
   * bands line up vertically across all three rows.
   */
  function renderAudience() {
    const host = $('#audience-chart');
    const hint = $('#audience-hint');
    const panel = $('#audience-panel');
    // A browser holding a cached copy of the previous HTML will not have these
    // nodes. Bailing quietly beats throwing and taking the whole page with it.
    if (!host || !panel) return;

    const data = lastListeners;
    if (!data || !data.series || !data.streams?.length) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';

    const rows = data.streams.filter((s) => (data.series[s.id] || []).length);
    if (!rows.length) {
      host.innerHTML = '<div class="audience-empty">No audience data in this range yet.</div>';
      return;
    }

    // Geometry — a fixed viewBox scaled by CSS keeps text and strokes in
    // proportion at any container width.
    const W = 1000;
    const PAD_L = 54;
    const PAD_R = 12;
    const ROW_H = 92;
    const ROW_GAP = 14;
    const AXIS_H = 26;
    const H = rows.length * (ROW_H + ROW_GAP) - ROW_GAP + AXIS_H;
    const plotW = W - PAD_L - PAD_R;

    const times = rows.flatMap((s) => data.series[s.id].map((p) => new Date(p.t).getTime()));
    let t0 = Math.min(...times);
    let t1 = Math.max(...times) + (data.bucketMs || 0);
    if (!(t1 > t0)) t1 = t0 + 1;
    const x = (t) => PAD_L + ((t - t0) / (t1 - t0)) * plotW;

    const parts = [];

    rows.forEach((stream, i) => {
      const series = data.series[stream.id];
      const top = i * (ROW_H + ROW_GAP);
      const base = top + ROW_H;

      // Own scale per row. Headroom keeps the peak off the ceiling.
      const maxVal = Math.max(1, ...series.map((p) => Math.max(p.peak ?? 0, p.avg ?? 0)));
      const yMax = niceCeil(maxVal);
      const y = (v) => base - (Math.max(0, v) / yMax) * (ROW_H - 8);

      parts.push(`<rect class="aud-rowbg" x="${PAD_L}" y="${top}" width="${plotW}" height="${ROW_H}"/>`);

      // Gridlines at 0 / mid / max, labelled only at the extremes.
      [0, yMax / 2, yMax].forEach((v) => {
        parts.push(`<line class="aud-grid" x1="${PAD_L}" y1="${y(v).toFixed(1)}" x2="${W - PAD_R}" y2="${y(v).toFixed(1)}"/>`);
      });
      parts.push(`<text class="aud-ytick" x="${PAD_L - 8}" y="${(y(yMax) + 4).toFixed(1)}" text-anchor="end">${yMax}</text>`);
      parts.push(`<text class="aud-ytick" x="${PAD_L - 8}" y="${(base + 4).toFixed(1)}" text-anchor="end">0</text>`);

      // Outage bands sit UNDER the data: they are context, not the subject.
      //
      // Three classes, not two. An outage lasting minutes is far narrower than
      // one pixel across a multi-day span, so without a distinct treatment the
      // confirmed ones are indistinguishable from the far more numerous brief
      // ones. Confirmed outages therefore also get a fixed-width marker tick.
      const confirmedMarks = [];
      (data.outages || []).forEach((o) => {
        if (o.streamId !== stream.id) return;
        const s = new Date(o.start).getTime();
        const e = o.end ? new Date(o.end).getTime() : t1;
        if (e < t0 || s > t1) return;
        const bx = x(Math.max(s, t0));
        const harmless = (o.audience?.listenerImpact ?? o.listenerImpact) === 'none';
        const confirmed = o.severity === 'outage' || o.severity === 'dead_air';
        const cls = harmless ? 'harmless' : confirmed ? 'confirmed' : 'brief';
        const bw = Math.max(confirmed ? 2.5 : 1.5, x(Math.min(e, t1)) - bx);
        const heads = o.audience?.listenersBefore;
        const tip =
          `${o.streamName} — ${o.causeLabel || o.severity}\n` +
          `${confirmed ? 'Confirmed outage' : harmless ? 'Probe anomaly' : 'Brief outage'}\n` +
          `${fmtTime(o.start)} · lasted ${o.durationLabel || '—'}` +
          (harmless
            ? '\nNo listener impact — mount kept serving'
            : heads != null
            ? `\n${heads} listener(s) were tuned in`
            : '');
        parts.push(
          `<rect class="aud-band ${cls}" x="${bx.toFixed(1)}" y="${top}" ` +
          `width="${bw.toFixed(1)}" height="${ROW_H}"><title>${esc(tip)}</title></rect>`,
        );
        if (confirmed) confirmedMarks.push({ cx: bx + bw / 2, tip, start: o.start });
      });

      // A fixed-width tick is still not countable when outages arrive in a
      // burst: three on Main within fourteen minutes land 2px apart at the
      // 30-day zoom, and three on HD2 within six minutes land 0.8px apart, so
      // nine outages drew as five marks. Ticks closer together than their own
      // width are therefore merged into one marker carrying a count, which
      // stays truthful at every zoom instead of quietly under-reporting.
      confirmedMarks.sort((a, b) => a.cx - b.cx);
      const TICK_W = 9;
      const clusters = [];
      confirmedMarks.forEach((m) => {
        const last = clusters[clusters.length - 1];
        if (last && m.cx - last.cx < TICK_W) {
          last.items.push(m);
          last.cx = m.cx;
        } else {
          clusters.push({ cx: m.cx, items: [m] });
        }
      });

      clusters.forEach((c) => {
        const n = c.items.length;
        const tip = n === 1
          ? c.items[0].tip
          : `${n} confirmed outages in this period\n\n${c.items.map((i) => i.tip).join('\n\n')}`;
        parts.push(
          `<path class="aud-tick" d="M${(c.cx - 4).toFixed(1)},${top - 1} L${(c.cx + 4).toFixed(1)},${top - 1} ` +
          `L${c.cx.toFixed(1)},${top + 5} Z"><title>${esc(tip)}</title></path>`,
        );
        if (n > 1) {
          // <title> must be a CHILD of the element it describes, not a sibling.
          parts.push(
            `<text class="aud-tick-count" x="${(c.cx + 6).toFixed(1)}" y="${top + 5}">${n}<title>${esc(tip)}</title></text>`,
          );
        }
      });

      // Area + line. Nulls break the path rather than being drawn as zero — a
      // gap in the data is not an audience of nobody.
      const segs = [];
      let cur = [];
      series.forEach((p) => {
        if (p.avg == null) {
          if (cur.length) segs.push(cur);
          cur = [];
        } else {
          cur.push(p);
        }
      });
      if (cur.length) segs.push(cur);

      segs.forEach((seg) => {
        const pts = seg.map((p) => `${x(new Date(p.t).getTime()).toFixed(1)},${y(p.avg).toFixed(1)}`);
        const first = x(new Date(seg[0].t).getTime()).toFixed(1);
        const last = x(new Date(seg[seg.length - 1].t).getTime()).toFixed(1);
        parts.push(`<path class="aud-area" d="M${first},${base.toFixed(1)} L${pts.join(' L')} L${last},${base.toFixed(1)} Z"/>`);
        parts.push(`<polyline class="aud-line" points="${pts.join(' ')}"/>`);

        if (seg.some((p) => p.peak != null && p.peak > p.avg)) {
          const pk = seg.map((p) => `${x(new Date(p.t).getTime()).toFixed(1)},${y(p.peak ?? p.avg).toFixed(1)}`);
          parts.push(`<polyline class="aud-peak" points="${pk.join(' ')}"/>`);
        }
      });

      const sum = data.summary?.perStream?.[stream.id];
      // State the outage count in words as well as marks. However the ticks
      // cluster, the number itself is never in doubt.
      const nOutages = confirmedMarks.length;
      parts.push(
        `<text class="aud-rowlabel" x="${PAD_L + 8}" y="${top + 15}">${esc(stream.name)}</text>` +
        `<text class="aud-rowmeta" x="${W - PAD_R - 6}" y="${top + 15}" text-anchor="end">` +
        (nOutages ? `${nOutages} outage${nOutages === 1 ? '' : 's'} · ` : '') +
        `avg ${sum?.avgListeners ?? '—'} · peak ${sum?.peakListeners ?? '—'} listeners` +
        `</text>`,
      );
    });

    // Shared time axis.
    const axisY = rows.length * (ROW_H + ROW_GAP) - ROW_GAP;
    parts.push(`<line class="aud-axis" x1="${PAD_L}" y1="${axisY}" x2="${W - PAD_R}" y2="${axisY}"/>`);
    // Six evenly-spaced ticks across four days land two per day, so date-only
    // labels repeat ("Aug 5 | Aug 5") and read as a rendering fault. Where a
    // label would duplicate its predecessor, show the time instead — that is
    // the part which actually differs.
    const tickTimes = timeTicks(t0, t1, 6);
    const span = t1 - t0;
    let prevLabel = null;
    tickTimes.forEach((t) => {
      const tx = x(t);
      if (tx < PAD_L - 1 || tx > W - PAD_R + 1) return;
      let label = fmtAxis(t, span);
      if (label === prevLabel) {
        label = new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      } else {
        prevLabel = label;
      }
      parts.push(`<line class="aud-grid" x1="${tx.toFixed(1)}" y1="${axisY}" x2="${tx.toFixed(1)}" y2="${axisY + 5}"/>`);
      parts.push(`<text class="aud-xtick" x="${tx.toFixed(1)}" y="${axisY + 18}" text-anchor="middle">${esc(label)}</text>`);
    });

    host.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Listeners over time per stream, with outage periods marked">${parts.join('')}</svg>`;

    if (hint) {
      // Concurrent listeners, which is what the chart actually plots.
      const peak = rows.reduce((m, s) => {
        const p = data.summary?.perStream?.[s.id]?.peakListeners;
        return p != null ? Math.max(m, p) : m;
      }, 0);
      hint.textContent = peak ? `peak ${peak} listeners online` : '';
    }
  }

  /** Rounds an axis maximum up to something a person would choose. */
  function niceCeil(v) {
    if (v <= 5) return 5;
    if (v <= 10) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.ceil(v / (mag / 2)) * (mag / 2);
  }

  /**
   * Ticks on natural boundaries — midnight, or the top of the hour — rather
   * than on even divisions of the span.
   *
   * Dividing the range into six equal parts puts ticks at arbitrary instants,
   * so a four-day span produced labels like "Aug 4 | Aug 5 | 8:00 PM | Aug 6",
   * mixing two label formats and repeating a time. Snapping to real boundaries
   * gives one label per day, which is what a reader is looking for anyway.
   */
  function timeTicks(t0, t1, want) {
    const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
    const span = t1 - t0;
    const steps = [
      15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
      DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY, 91 * DAY, 182 * DAY, 365 * DAY,
    ];
    const target = span / want;
    const step = steps.find((s) => s >= target) || steps[steps.length - 1];

    // Align to the step so ticks land on round times, not on t0 + n·step.
    const out = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);

    // A span shorter than one step can leave nothing to label.
    if (out.length < 2) return [t0, t1];
    return out;
  }

  function fmtAxis(t, span) {
    const d = new Date(t);
    const DAY = 86400000;
    if (span <= 2 * DAY) {
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    if (span <= 200 * DAY) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  }

  // ── Summary tiles ───────────────────────────────────────────────────────
  /**
   * Did this failure actually cost the audience audio?
   *
   * Mirrors store.settledImpact. Every event carries two verdicts: what we
   * believed while it was still failing (`diagnosis.listenerImpact`, usually
   * 'unknown' because Icecast was unreachable at the time) and what recovery
   * settled it to once Icecast could be asked (`audience.listenerImpact`). The
   * settled one wins. 'unknown' counts as impact — an outage we could not clear
   * is never quietly written off.
   */
  function costListeners(e) {
    return (e.audience?.listenerImpact ?? e.diagnosis?.listenerImpact ?? 'unknown') !== 'none';
  }

  function renderSummary() {
    const UNCONFIRMED = new Set(['brief_outage', 'probe_error', 'blip']);
    // Headline counts group by what the AUDIENCE experienced, not by whether a
    // failure lasted long enough to pass our confirmation threshold. Those two
    // groupings disagree in both directions — short failures that really did
    // drop the mount, and confirmed outages Icecast proved were harmless — so
    // counting by severity put real outages under a heading the station reads
    // as "ignore me".
    const failures = filtered.filter((e) => e.type !== 'up');
    const felt = failures.filter(costListeners);
    const unfelt = failures.filter((e) => !costListeners(e));
    // Sustained enough that the audience is gone, vs a gap the player rode out.
    // Counting a 60-second reconnect alongside an 18-hour dropout produced a
    // headline of "45 outages" with a median duration of two minutes, which
    // told the station nothing it could act on.
    const sigMs = lastRollup?.significantThresholdMs ?? 5 * 60 * 1000;
    const significant = felt.filter((e) => (e.durationMs || 0) >= sigMs);
    const briefFelt = felt.filter((e) => (e.durationMs || 0) < sigMs);
    const outages = significant.length;
    const blips = unfelt.length;
    const deadAir = filtered.filter((e) => e.severity === 'dead_air').length;

    // Events that could plausibly notify. An event that DID email always
    // counts, whatever its severity — the retired server-blip rule emailed
    // unconfirmed events, and excluding them produced a denominator smaller
    // than its own numerator ("54 of 36 notifiable").
    const notifiable = filtered.filter(
      (e) => !UNCONFIRMED.has(e.severity) || e.email?.sent === true,
    );
    const emailed = filtered.filter((e) => e.email?.sent === true).length;
    // An outage the monitor deliberately declined to email — Icecast proved the
    // mount kept serving — has a known outcome and must not be counted below as
    // one whose delivery is unknown.
    const isSuppressed = (e) => typeof e.email?.reason === 'string'
      && e.email.reason.startsWith('suppressed');
    const suppressed = filtered.filter(isSuppressed).length;
    // Backfilled events predate delivery tracking: an alert may well have gone
    // out, we simply have no record of it. Lumping them in with genuine
    // non-delivery reads as an alerting failure that never happened.
    const untracked = notifiable.filter((e) => e.email?.sent == null && !isSuppressed(e)).length;
    // Delivery we know happened but never logged live — flagged so the tile
    // never passes reconstruction off as a measured send.
    const reconstructedSends = filtered.filter(
      (e) => e.email?.sent === true && e.email?.deliveryReconstructed,
    ).length;

    // Downtime, two ways — because they answer different questions and only one
    // of them is what "how long were we down" means.
    //
    // Failures the stream survived are excluded outright: Icecast was reachable
    // and still serving the mount, so counting them as downtime contradicts a
    // verdict we already reached about them.
    //
    // Computed here from the FILTERED events rather than read from the rollup,
    // so the tile still answers for whatever the timeline is showing. The store
    // runs the same merge for the roundup email.
    const downEvents = felt.filter((e) => e.durationMs);
    const streamDowntimeMs = downEvents.reduce((a, e) => a + e.durationMs, 0);
    const downtimeMs = mergeIntervals(downEvents);

    $('#stat-outages').textContent = outages;
    // Say how many streams it touched, not how many rows are in the table —
    // "177 events in view" invited reading the whole log as damage.
    const streamsHit = new Set(significant.map((e) => e.streamId)).size;
    $('#stat-outages-detail').textContent = outages
      ? `over ${fmtDuration(sigMs)} · ${streamsHit} stream${streamsHit === 1 ? '' : 's'} affected`
      : 'no sustained loss of audience';

    const briefEl = $('#stat-brief');
    if (briefEl) {
      briefEl.textContent = briefFelt.length;
      const longest = briefFelt.reduce((a, e) => Math.max(a, e.durationMs || 0), 0);
      $('#stat-brief-detail').textContent = briefFelt.length
        ? `under ${fmtDuration(sigMs)} · longest ${fmtDuration(longest)}`
        : 'short gaps — players usually rebuffer';
    }

    const blipsDetail = $('#stat-blips-detail');
    if (blipsDetail) {
      // Name the reason these cost nothing. "Probe anomaly" means nothing to a
      // programme director; "Icecast kept serving" does.
      blipsDetail.textContent = blips
        ? `Icecast kept serving throughout · ${fmtDuration(unfelt.reduce((a, e) => a + (e.durationMs || 0), 0))} total`
        : 'stream kept playing throughout';
    }

    // Listener headcounts live in the hero block above, and audience volume in
    // its own section below. Neither belongs in this row of clock-time tiles.
    $('#stat-blips').textContent = blips;
    $('#stat-deadair').textContent = deadAir;
    $('#stat-emailed').textContent = emailed;
    let emailedDetail = `of ${notifiable.length} notifiable`;
    // This tile counts EVENTS that were alerted; the roundup sentence above it
    // counts MESSAGES, and one consolidated email covers several streams. Two
    // different numbers labelled "emailed" a few centimetres apart read as a
    // bug, so when they differ this says which is which. Only while the view is
    // unfiltered — the rollup describes the whole period, not a subset.
    const messages = lastRollup?.alerts?.messages;
    if (messages != null && messages !== emailed && filtered.length === allEvents.length) {
      emailedDetail += ` · ${messages} email${messages === 1 ? '' : 's'} sent`;
    }
    if (suppressed) emailedDetail += ` · ${suppressed} suppressed as harmless`;
    if (untracked) emailedDetail += ` · ${untracked} predate tracking`;
    else if (reconstructedSends === emailed && emailed) emailedDetail += ' · delivery reconstructed';
    $('#stat-emailed-detail').textContent = emailedDetail;
    $('#stat-emailed-detail').className = untracked && !emailed
      ? 'summary-detail partial'
      : 'summary-detail';
    $('#stat-downtime').textContent = downtimeMs ? fmtDuration(downtimeMs) : '0s';
    const dtDetail = $('#stat-downtime-detail');
    if (dtDetail) {
      // Say what is down. Narrowed to one stream, "at least one stream" is a
      // strange way to describe the only stream in view.
      const selId = $('#f-stream').value;
      const subject = selId
        ? `${streams.find((s) => s.id === selId)?.name || 'this stream'} down`
        : 'at least one stream down';
      // Name the difference rather than hiding it. One server fault that took
      // two streams down for 3h35m each is 3h35m off air, not 7h10m.
      dtDetail.textContent = streamDowntimeMs > downtimeMs
        ? `${subject} · ${fmtDuration(streamDowntimeMs)} summed across streams`
        : subject;
    }

    $('#timeline-count').textContent =
      `${filtered.length} event${filtered.length === 1 ? '' : 's'}`;
  }

  // ── Timeline rendering ──────────────────────────────────────────────────
  function renderMore() {
    const container = $('#timeline');

    if (!filtered.length) {
      container.innerHTML = `
        <div class="evt-empty">
          <span class="material-symbols-outlined">check_circle</span>
          <p>No events match these filters.</p>
        </div>`;
      $('#timeline-more').style.display = 'none';
      return;
    }

    const slice = filtered.slice(rendered, rendered + PAGE_SIZE);
    let html = '';
    let lastDay = rendered > 0 ? toLocalKey(new Date(filtered[rendered - 1].timestamp)) : null;
    let openGroup = rendered > 0;

    slice.forEach((e) => {
      const day = toLocalKey(new Date(e.timestamp));
      if (day !== lastDay) {
        if (openGroup) html += '</div>';
        const count = filtered.filter((x) => toLocalKey(new Date(x.timestamp)) === day).length;
        html += `<div class="day-group"><div class="day-heading">${fmtDay(e.timestamp)}<span class="day-count">${count}</span></div>`;
        lastDay = day;
        openGroup = true;
      }
      html += renderEvent(e);
    });
    if (openGroup) html += '</div>';

    container.insertAdjacentHTML('beforeend', html);
    rendered += slice.length;

    $('#timeline-more').style.display = rendered < filtered.length ? 'block' : 'none';
    if (rendered < filtered.length) {
      $('#load-more').textContent = `Load more (${filtered.length - rendered} remaining)`;
    }

    wireEventRows(container);
    openFromHash();
  }

  /** Deep link support: #<event-id> opens and scrolls to that incident. */
  function openFromHash() {
    const id = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!id) return;
    const row = document.querySelector(`.evt[data-id="${CSS.escape(id)}"]`);
    if (!row || row.classList.contains('open')) return;
    const evt = allEvents.find((x) => x.id === id);
    if (!evt) return;
    openIds.add(id);
    row.querySelector('.evt-body').innerHTML = renderBody(evt);
    row.classList.add('open');
    row.scrollIntoView({ block: 'center' });
  }

  function renderEvent(e) {
    const meta = SEVERITY_META[e.severity] || SEVERITY_META.outage;
    const isOpen = openIds.has(e.id);

    const scopeBadge = e.diagnosis?.scope === 'server'
      ? '<span class="badge scope-server">Server-wide</span>'
      : e.diagnosis?.scope === 'station'
      ? '<span class="badge scope-station">Station-wide</span>'
      : '';

    // Backfilled history must never read as a live observation.
    const reconBadge = e.reconstructed
      ? '<span class="badge reconstructed" title="Backfilled from raw telemetry — diagnosis inferred, not observed live">Reconstructed</span>'
      : '';

    // A failure that has ended must not keep reading as a live one. Without
    // this the list showed every historical event with the same red badge it
    // had at the moment it fired, so a fully recovered week looked like a wall
    // of unresolved errors.
    const isFailure = e.type !== 'up';
    const resolvedChip = !isFailure
      ? ''
      : e.resolvedAt
      ? `<span class="state-chip resolved" title="Recovered ${new Date(e.resolvedAt).toLocaleString('en-US')}"><span class="material-symbols-outlined">check_circle</span>Resolved</span>`
      : '<span class="state-chip ongoing"><span class="material-symbols-outlined">pending</span>Ongoing</span>';

    let mailChip;
    if (e.email?.sent === true) {
      mailChip = '<span class="mail-chip sent"><span class="material-symbols-outlined">mark_email_read</span>Alert sent</span>';
    } else if (e.email?.attempted) {
      mailChip = '<span class="mail-chip failed"><span class="material-symbols-outlined">error</span>Send failed</span>';
    } else {
      mailChip = '<span class="mail-chip none"><span class="material-symbols-outlined">notifications_off</span>No alert</span>';
    }

    const subParts = [`<span>${esc(e.streamName || e.streamId)}</span>`];
    if (e.diagnosis?.causeLabel && e.type !== 'up') {
      subParts.push(`<span class="sep">·</span><span>${esc(e.diagnosis.causeLabel)}</span>`);
    }
    if (e.durationLabel) {
      subParts.push(`<span class="sep">·</span><span>lasted ${esc(e.durationLabel)}</span>`);
    }
    if (e.failedChecks) {
      subParts.push(`<span class="sep">·</span><span>${e.failedChecks} failed check${e.failedChecks === 1 ? '' : 's'}</span>`);
    }

    return `
      <div class="evt${isOpen ? ' open' : ''}${isFailure && e.resolvedAt ? ' settled' : ''}" data-id="${esc(e.id)}">
        <div class="evt-head row-tip" data-tip="Click for full diagnosis" data-tip-open="Click to collapse">
          <div class="evt-icon ${e.severity}"><span class="material-symbols-outlined">${meta.icon}</span></div>
          <div class="evt-time">${fmtTime(e.timestamp)}</div>
          <div class="evt-main">
            <div class="evt-title">${esc(e.message)}</div>
            <div class="evt-sub">${subParts.join('')}</div>
          </div>
          <div class="evt-badges">
            ${reconBadge}
            ${scopeBadge}
            <span class="badge ${e.severity}">${meta.label}</span>
            ${resolvedChip}
            ${mailChip}
          </div>
          <div class="evt-chevron"><span class="material-symbols-outlined">expand_more</span></div>
        </div>
        <div class="evt-body">${isOpen ? renderBody(e) : ''}</div>
      </div>`;
  }

  // Detail rendering is shared with the dashboard via event-detail.js, so an
  // incident reads identically wherever it is opened.
  function renderBody(e) {
    return window.EventDetail.render(e);
  }

  function wireEventRows(container) {
    container.querySelectorAll('.evt').forEach((row) => {
      if (row.dataset.wired) return;
      row.dataset.wired = '1';
      row.querySelector('.evt-head').onclick = () => {
        const id = row.dataset.id;
        const body = row.querySelector('.evt-body');
        if (openIds.has(id)) {
          openIds.delete(id);
          row.classList.remove('open');
        } else {
          openIds.add(id);
          const evt = allEvents.find((x) => x.id === id);
          if (evt && !body.innerHTML.trim()) body.innerHTML = renderBody(evt);
          row.classList.add('open');
        }
      };
    });
  }

  // ── Controls ────────────────────────────────────────────────────────────
  function wireControls() {
    $('#f-range').onchange = () => { dayFilter = null; reload(); };

    document.querySelectorAll('#history-range-pills .range-pill').forEach((btn) => {
      btn.onclick = () => {
        $('#f-range').value = btn.dataset.days;
        dayFilter = null;
        syncRangePills();
        reload();
      };
    });
    ['#f-stream', '#f-severity', '#f-cause', '#f-email'].forEach((sel) => {
      $(sel).onchange = () => { renderCauses(); applyFilters(); };
    });

    let searchTimer = null;
    $('#f-search').oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 180);
    };

    $('#f-reset').onclick = () => {
      $('#f-stream').value = '';
      $('#f-severity').value = '';
      $('#f-cause').value = '';
      $('#f-email').value = '';
      $('#f-search').value = '';
      dayFilter = null;
      renderHeatmap();
      renderCauses();
      applyFilters();
    };

    $('#load-more').onclick = renderMore;
    window.addEventListener('hashchange', openFromHash);

    $('#export-btn').onclick = () => {
      const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kpft-incidents-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };
  }

  // ── Utilities ───────────────────────────────────────────────────────────
  /** Local-date key (YYYY-MM-DD) — avoids the UTC off-by-one near midnight. */
  function toLocalKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function fmtDay(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    if (toLocalKey(d) === toLocalKey(today)) return 'Today';
    if (toLocalKey(d) === toLocalKey(yest)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  }

  /**
   * Elapsed time covered by a set of events, with concurrent ones merged.
   *
   * Mirrors store.mergedDowntimeMs — deliberately duplicated rather than fetched,
   * because this tile has to answer for the CURRENT filter selection and the
   * server figure describes the whole period.
   */
  function mergeIntervals(list) {
    const iv = list
      .map((e) => {
        const s = new Date(e.timestamp).getTime();
        return [s, s + e.durationMs];
      })
      .filter(([s]) => isFinite(s))
      .sort((a, b) => a[0] - b[0]);

    let total = 0;
    let start = null;
    let end = null;
    iv.forEach(([s, e]) => {
      if (start === null) { start = s; end = e; }
      else if (s <= end) { end = Math.max(end, e); }
      else { total += end - start; start = s; end = e; }
    });
    if (start !== null) total += end - start;
    return total;
  }

  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    // Drop a zero remainder rather than printing "5m 0s", which reads as a
    // stopwatch reading where a plain "5m" reads as a length.
    if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
  }

  function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
