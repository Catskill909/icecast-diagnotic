/* ═══════════════════════════════════════════════════════════════════════════
   Pacifica Stream Monitor — Incident History
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const PAGE_SIZE = 60;

  /* ── Station scope ─────────────────────────────────────────────────────────
     Every figure on this page is an aggregate, and with more than one station
     an unscoped aggregate is not merely broader — it is wrong. A GM reading
     "uptime" would be reading their own outages plus somebody else's.
     Absent means all stations, which is what a fleet view wants.            */
  // The URL wins over the remembered choice, so a link to one station always
  // opens that station — which is what makes it sendable to a GM.
  let stationId = null;
  try {
    stationId = new URLSearchParams(location.search).get('station')
      || localStorage.getItem('historyStationId')
      || null;
  } catch (e) { /* private mode */ }
  const scope = () => (stationId ? '&stationId=' + encodeURIComponent(stationId) : '');

  /**
   * Puts the station where it cannot be missed: in the page's own title, in the
   * browser tab, and in the address bar.
   *
   * The selection persists between visits, which is right — a GM cares about one
   * station and re-picking it every time would be worse. But persistence is only
   * safe if the current scope is unmistakable. A remembered choice that is only
   * visible inside a dropdown means opening the page and reading another
   * station's numbers without noticing.
   */
  function reflectStation(stations) {
    const s = stations && stations.find((x) => x.id === stationId);
    const label = s ? s.name : 'All stations';
    const titleEl = document.querySelector('.header-title');
    if (titleEl) titleEl.textContent = label;
    const subEl = document.getElementById('retention-note');
    if (subEl && !subEl.dataset.base) subEl.dataset.base = subEl.textContent;
    if (subEl) subEl.textContent = 'Incident history · ' + (subEl.dataset.base || '');
    document.title = label + ' · Incident History';

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

    // A picker with one option is furniture, not a control — but the title
    // still names the station, because that is a label rather than a control.
    if (stations.length < 2) { reflectStation(stations); return; }

    // A remembered station that has since been removed would scope every figure
    // on the page to nothing, silently. Fall back to all stations.
    if (stationId && !stations.some((s) => s.id === stationId)) stationId = null;

    const sel = document.getElementById('station-select');
    const opts = ['<option value="">All stations</option>'];
    for (const s of stations) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;          // textContent, so a station name cannot inject markup
      opts.push(o.outerHTML);
    }
    sel.innerHTML = opts.join('');
    sel.value = stationId || '';
    document.getElementById('station-picker').classList.remove('hidden');
    reflectStation(stations);

    sel.addEventListener('change', () => {
      stationId = sel.value || null;
      try {
        if (stationId) localStorage.setItem('historyStationId', stationId);
        else localStorage.removeItem('historyStationId');
      } catch (e) { /* private mode */ }
      reflectStation(stations);
      reload();
    });
  }


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
  let incidentsExpanded = false;  // "show all" state for the What happened list

  // 'blip' is the retired severity — stored history still carries it, so it has
  // to keep rendering. New events split it in two, because a vanished mount and
  // a failed probe against a healthy mount are not the same thing.
  const SEVERITY_META = {
    outage:       { icon: 'error',        label: 'Outage' },
    brief_outage: { icon: 'bolt',         label: 'Brief Outage' },
    probe_error:  { icon: 'sensors_off',  label: 'Probe Anomaly' },
    blip:         { icon: 'bolt',         label: 'Blip (legacy)' },
    dead_air:     { icon: 'volume_off',   label: 'Dead Air' },
    degraded:     { icon: 'signal_cellular_alt_2_bar', label: 'Degraded Channel' },
    recovery:     { icon: 'check_circle', label: 'Recovered' },
  };

  // ── Boot ────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      // Before reload(): the scope has to be known before the first fetch, or the
      // page renders every station once and then corrects itself.
      await initStationPicker();
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
      fetch(`/api/stats?days=${days}${scope()}`).then((r) => r.json()),
      fetch(`/api/events?days=${days}&limit=2000${scope()}`).then((r) => r.json()),
      // Supplementary — the incident record must never depend on it. A monitor
      // mid-deploy serves the new page from a process that lacks this route,
      // and a rejection here would take every summary tile, the heatmap and
      // the timeline down with it.
      fetch(`/api/uptime?days=${days}${scope()}`)
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
      fetch(`/api/listeners?days=${days}${scope()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/rollup?days=${days}${scope()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    populateStreamFilter();
    populateCauseFilter();
    renderStorage();
    syncRangePills();
    renderOverviewRange();
    renderImpactHero();
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

    // When the monitor has not been running as long as the selected range, show
    // the window that actually has data. "Last 30 days · Jul 13 – Aug 11" over
    // seven days of history invites spreading the figures across a month that
    // was never watched.
    const covStart = stats?.storage?.oldestEvent && lastRollup?.coverageStart;
    const realStart = covStart ? new Date(lastRollup.coverageStart) : null;
    if (value !== 'all' && realStart && startText) {
      const nominal = new Date(end);
      nominal.setDate(nominal.getDate() - (parseInt(value, 10) - 1));
      if (realStart > nominal) {
        const days = (end - realStart) / 86400000;
        el.textContent = `${label} · only ${days < 10 ? days.toFixed(1) : Math.round(days)} days of data — ${fmt(realStart)} – ${fmt(end)}`;
        return;
      }
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

    // Lead with proportion, not an unqualified large count. Listener-hours
    // naturally grows with both audience and duration, so the share delivered
    // is the only top-line number whose scale is immediately legible.
    const cutOff = a.listenersCutOff || 0;
    const deliveredPct = a.lostSharePercent == null
      ? null
      : Math.round((100 - a.lostSharePercent) * 10) / 10;
    $('#ih-value').textContent = deliveredPct == null ? '—' : `${deliveredPct}%`;
    $('#ih-peak').textContent = peak ? peak.toLocaleString() : '—';
    $('#ih-incidents-count').textContent = r.counts?.listenerAffecting ?? 0;
    $('#ih-streams').textContent = r.counts?.streamsAffected ?? 0;

    // Say what window this really covers. A "Last 30 days" pill over a monitor
    // that has only been running a week invites the reader to spread these
    // figures across a month that was never watched.
    const covDays = r.coverageMs ? r.coverageMs / 86400000 : null;
    const partial = covDays != null && r.windowMs && r.coverageMs < r.windowMs * 0.95;
    const window = partial
      ? `in the ${covDays < 10 ? covDays.toFixed(1) : Math.round(covDays)} days monitored so far`
      : 'in this period';
    $('#ih-sub').textContent = clean
      ? `No estimated listening was lost ${window}.`
      : `${window}; ${a.lostSharePercent}% of possible listening was lost.`;

    // SUBHEADLINE — the same loss as listening time. Directly under the
    // headline because it is the second thing a manager asks; the definition
    // now sits in the compact info popover beside the headline.
    const sec = $('#ih-secondary');
    if (sec) {
      sec.innerHTML = clean
        ? '<span class="ihs-text">No listener interruptions were recorded.</span>'
        : `<span class="ihs-value">${cutOff.toLocaleString()} listener interruptions</span>` +
          `<span class="ihs-text"> recorded — this is not a unique-person count; the same listener is counted again if a later outage interrupts them.</span>`;
    }

    renderMetricReconciliation();
    renderFaultSplit();

    // Name the incidents. This is the part an engineer acts on and the part a
    // manager remembers; a total on its own gives neither of them anything.
    const host = $('#ih-incidents');
    if (!host) return;

    // Which side of the handoff the evidence points to. Reachability identifies
    // a path, not a particular physical device, so the labels stay deliberately
    // narrower than "equipment failed" or "server failed".
    const FAULT = {
      kpft: { label: 'Station source/feed path', cls: 'kpft' },
      pacifica: { label: 'Pacifica/Icecast path', cls: 'pacifica' },
      unknown: { label: 'cause unclear', cls: 'unknown' },
    };

    // Lead with sustained, grouped incidents. The explicit expansion below
    // exposes every listener-impacting stream record, including brief ones.
    const CAP = 8;
    const impactful = allEvents
      .filter((e) => isFailureEvent(e) && costListeners(e))
      .map((e) => ({
        timestamp: e.timestamp,
        streams: [e.streamName || e.streamId],
        durationMs: e.durationMs || 0,
        cause: e.diagnosis?.causeLabel || e.message,
        fault: e.diagnosis?.icecast?.reachable === true
          ? 'kpft'
          : e.diagnosis?.icecast?.reachable === false ? 'pacifica' : 'unknown',
        listenersTunedIn: e.audience?.listenersBefore || 0,
        eventIds: [e.id],
      }))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const visible = incidentsExpanded ? impactful : top.slice(0, CAP);

    const rows = visible.map((i) => {
      const when = new Date(i.timestamp).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const f = FAULT[i.fault] || FAULT.unknown;
      const heads = i.listenersTunedIn
        ? `${i.listenersTunedIn} listener${i.listenersTunedIn === 1 ? '' : 's'}`
        : 'no one listening';
      return `
        <div class="ih-row" data-event="${esc(i.eventIds?.[0] || '')}" title="Open the full diagnosis for this incident">
          <span class="ih-when">${esc(when)}</span>
          <span class="ih-streams">${esc(i.streams.join(' + '))} off air</span>
          <span class="ih-dur">${esc(fmtDuration(i.durationMs))}</span>
          <span class="ih-cause">${esc(i.cause || 'cause not diagnosed')}
            <span class="ih-fault ${f.cls}">${esc(f.label)}</span>
          </span>
          <span class="ih-cost">${esc(heads)}</span>
        </div>`;
    }).join('');

    const rest = !impactful.length
      ? '<div class="ih-rest">No listener-impacting interruptions were recorded in this period.</div>'
      : !incidentsExpanded && r.otherIncidents?.count
        ? `<div class="ih-rest">Plus ${r.otherIncidents.count} brief interruption${
        r.otherIncidents.count === 1 ? '' : 's'} under ${fmtDuration(r.significantThresholdMs || 300000)}${
        r.otherIncidents.longestMs ? `, the longest ${fmtDuration(r.otherIncidents.longestMs)}` : ''}.</div>`
        : `<div class="ih-rest">Each row covers one interruption from failure through recovery. ` +
          `The technical timeline also retains separate recovery/all-clear entries and monitoring-only anomalies.</div>`;

    const collapsedCount = Math.min(CAP, top.length);
    const moreBtn = impactful.length > collapsedCount
      ? `<button class="ih-more" id="ih-more">${incidentsExpanded
        ? 'Show sustained incidents only'
        : `Show all ${impactful.length} listener-impacting stream records`}</button>`
      : '';
    const timelineBtn = `<button class="ih-more ih-timeline-link" id="ih-timeline-link">` +
      `Open technical timeline — ${allEvents.length} down, recovery, and monitoring entries</button>`;

    host.innerHTML = rows + rest + `<div class="ih-actions">${moreBtn}${timelineBtn}</div>`;

    const btn = $('#ih-more');
    if (btn) {
      btn.onclick = () => { incidentsExpanded = !incidentsExpanded; renderImpactHero(); };
    }
    const timelineLink = $('#ih-timeline-link');
    if (timelineLink) timelineLink.onclick = openTechnicalTimeline;

    // Each row opens the full diagnosis — evidence, remediation, Icecast state
    // — in the timeline below, reusing the drill-down that already exists
    // rather than growing a second copy of it here.
    host.querySelectorAll('.ih-row[data-event]').forEach((row) => {
      const id = row.dataset.event;
      if (!id) return;
      row.classList.add('clickable');
      row.onclick = () => openEventInTimeline(id);
    });

    const countNote = $('#incidents-count-note');
    if (countNote) {
      // Reconcile the two counts out loud. One fault can take two streams down
      // at the same second, so "9 outages" and "8 incidents" are both true and
      // the difference has to be visible rather than look like an error.
      const sigCount = r.counts?.significant ?? top.length;
      countNote.textContent = incidentsExpanded
        ? `all ${impactful.length} listener-impacting stream records, newest first`
        : sigCount === top.length
          ? `${top.length} sustained incident${top.length === 1 ? '' : 's'}, longest first`
          : `${sigCount} sustained stream records grouped into ${top.length} incidents; some hit two streams at once`;
    }
  }

  /** Reset timeline-only filters and move directly to the complete technical log. */
  function openTechnicalTimeline() {
    $('#f-stream').value = '';
    $('#f-severity').value = '';
    $('#f-cause').value = '';
    $('#f-email').value = '';
    $('#f-search').value = '';
    dayFilter = null;
    renderHeatmap();
    renderCauses();
    applyFilters();
    $('#event-timeline-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Put the unit and counting rule directly beside each large duration. */
  function renderMetricReconciliation() {
    const el = $('#metric-reconciliation');
    if (!el || !lastRollup) return;
    const r = lastRollup;
    const a = r.audience || {};
    const title = $('#mr-title');
    if (title) title.textContent = `How totals across ${streams.length} monitored stream${streams.length === 1 ? '' : 's'} relate`;
    $('#stat-downtime').textContent = fmtDuration(r.downtime?.wallClockMs || 0);
    $('#stat-streamtime').textContent = fmtDuration(r.downtime?.streamMs || 0);
    $('#mr-listener-hours').textContent = `${(a.listenerHoursLost || 0).toLocaleString()} listener-hours`;

    const sig = r.counts?.significant || 0;
    const brief = r.counts?.brief || 0;
    const total = r.counts?.listenerAffecting || 0;
    $('#mr-equation').innerHTML =
      `<strong id="stat-outages">${total}</strong> ` +
      `<span id="stat-outages-detail">stream interruption record${total === 1 ? '' : 's'}` +
      ` = ${sig} sustained (${fmtDuration(r.significantThresholdMs || 300000)} or longer)` +
      ` + ${brief} brief (under ${fmtDuration(r.significantThresholdMs || 300000)}). ` +
      `These are per-stream records, so one incident affecting two streams creates two records.</span>`;
  }

  /**
   * Opens one incident's full diagnosis in the timeline below and scrolls to it.
   *
   * Clears any filter that would hide the row first — clicking a summary line
   * and landing on nothing because a stream filter was set is worse than not
   * making it clickable at all.
   */
  function openEventInTimeline(id) {
    const evt = allEvents.find((e) => e.id === id);
    if (!evt) return;

    if (!filtered.some((e) => e.id === id)) {
      $('#f-stream').value = '';
      $('#f-severity').value = '';
      $('#f-cause').value = '';
      $('#f-email').value = '';
      $('#f-search').value = '';
      dayFilter = null;
      renderHeatmap();
      renderCauses();
      applyFilters();
    }

    openIds.add(id);
    // Page it in if it sits beyond the rows rendered so far.
    let guard = 0;
    while (!document.querySelector(`.evt[data-id="${CSS.escape(id)}"]`)
      && rendered < filtered.length && guard++ < 50) {
      renderMore();
    }

    const row = document.querySelector(`.evt[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    if (!row.classList.contains('open')) {
      row.querySelector('.evt-body').innerHTML = renderBody(evt);
      row.classList.add('open');
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /**
   * Who has to act.
   *
   * The block a station manager forwards and an engineer acts on. Icecast's own
   * reachability at the moment of failure separates the station source/feed
   * path from the Pacifica/Icecast path. It does not prove which physical box
   * failed, so the evidence and the owner are stated separately.
   */
  function renderFaultSplit() {
    const host = $('#fault-split');
    if (!host || !lastRollup) return;

    const META = {
      kpft: {
        label: 'Station source/feed path', owner: 'Station / local feed owner', cls: 'kpft',
        sub: 'Evidence: Icecast answered, but the monitored source or mount was absent. This identifies the station-to-Icecast feed path, not a specific device.',
      },
      pacifica: {
        label: 'Pacifica/Icecast path', owner: 'Pacifica / platform engineer', cls: 'pacifica',
        sub: 'Evidence: the monitor could not reach Icecast. Check the server and its network, DNS, and TLS path; reachability alone does not isolate the component.',
      },
      unknown: {
        label: 'Path unclear', owner: 'Joint investigation', cls: 'unknown',
        sub: 'The recorded evidence is not sufficient to assign the handoff.',
      },
    };

    const split = lastRollup.faultSplit || [];
    if (!split.length) {
      host.innerHTML = '<div class="fs-clean">No outage reached a listener in this period.</div>';
      return;
    }

    host.innerHTML = split.map((s) => {
      const m = META[s.side] || META.unknown;
      const recordCount = s.streamRecords ?? s.outages;
      return `
        <div class="fs-card ${m.cls}">
          <div class="fs-head">
            <span class="fs-dot"></span>
            <span class="fs-label">${esc(m.label)}</span>
            <span class="fs-owner">${esc(m.owner)}</span>
          </div>
          <div class="fs-time">${recordCount} of ${lastRollup.counts?.listenerAffecting || recordCount}</div>
          <div class="fs-time-label">listener-impacting stream records</div>
          <div class="fs-facts">
            <span><strong>${s.listenersCutOff.toLocaleString()}</strong> listener interruptions</span>
            <span>longest single interruption <strong>${esc(fmtDuration(s.longestMs))}</strong></span>
          </div>
          <div class="fs-sub">${esc(m.sub)}</div>
        </div>`;
    }).join('');

    const recordEquation = split.map((s) => s.streamRecords ?? s.outages).join(' + ');
    host.insertAdjacentHTML('beforeend',
      `<div class="fs-reading-note"><strong>How to read this:</strong> the cards divide all ` +
      `${lastRollup.counts?.listenerAffecting || 0} stream interruption records by the path that needs investigation ` +
      `(${recordEquation} = ${lastRollup.counts?.listenerAffecting || 0}). ` +
      `Only the longest single interruption is shown here; every duration is available under What happened.</div>`);
  }

  // ── Uptime tile ─────────────────────────────────────────────────────────
  function coverageLabel(coverageDays) {
    if (!coverageDays) return '0h';
    if (coverageDays < 1) return `${Math.max(1, Math.round(coverageDays * 24))}h`;
    return `${coverageDays < 10 ? coverageDays.toFixed(1) : Math.round(coverageDays)}d`;
  }

  /**
   * Reads from the last fetch rather than taking arguments, so it can be
   * re-run after data refresh. Timeline filters never rewrite Overview totals;
   * only the range control above the section governs this figure.
   */
  function renderUptimeStat() {
    const valueEl = $('#stat-uptime');
    const detailEl = $('#stat-uptime-detail');
    if (!valueEl || !detailEl) return;

    // Audio uptime — probe-only failures are not charged to the station.
    const streamId = null;
    const percent = lastRollup?.uptime ?? lastUptime?.uptime;
    const streamNames = streams.map((s) => s.name).join(', ');
    const scope = `${streams.length} monitored audio stream${streams.length === 1 ? '' : 's'} ` +
      `(${streamNames}) combined — not ${streams.length} server${streams.length === 1 ? '' : 's'}`;

    if (percent == null) {
      valueEl.textContent = '—';
      valueEl.className = 'mr-value neutral';
      detailEl.textContent = !streamId && !lastUptime
        ? 'Uptime unavailable'
        : 'Collecting data — check back soon';
      detailEl.className = 'mr-note partial';
      return;
    }

    valueEl.textContent = `${percent}%`;
    valueEl.className = percent >= 99 ? 'mr-value up' : percent >= 95 ? 'mr-value neutral' : 'mr-value down';

    // Coverage is a property of the monitor's lifetime, not of the selected
    // stream, so the shortfall warning applies either way.
    const partial = !lastRangeIsAllTime && lastUptime
      && lastUptime.coverageDays < lastUptime.days * 0.95;
    // Say that this excludes probe-only failures, otherwise it reads as the
    // same number the dashboard used to show and quietly means something else.
    const basis = `${scope} · excludes probe-only failures`;
    if (partial) {
      detailEl.textContent = `${basis} · partial, only ${coverageLabel(lastUptime.coverageDays)} collected`;
      detailEl.className = 'mr-note partial';
    } else {
      detailEl.textContent = basis;
      detailEl.className = 'mr-note';
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
    const atLimit = s.maxEvents && s.eventCount >= s.maxEvents;
    $('#retention-note').textContent = s.oldestEvent
      ? `${atLimit ? `Newest ${s.maxEvents.toLocaleString()} events` : 'Long-term record'} since ${new Date(s.oldestEvent).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
      : 'Complete long-term record';
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
      const impactMs = bucket?.impactMs || 0;
      const level = impactMs === 0 ? 0
        : impactMs < 5 * 60000 ? 1
        : impactMs < 60 * 60000 ? 2
        : impactMs < 6 * 60 * 60000 ? 3 : 4;
      const cls = impactMs === 0 ? 'empty' : `l${level}`;
      const selected = dayFilter === key ? ' selected' : '';
      const streamExtra = bucket?.streamMs > impactMs
        ? `; ${fmtDuration(bucket.streamMs)} summed across streams`
        : '';
      const label = impactMs
        ? `${key}: ${fmtDuration(impactMs)} elapsed off-air time${streamExtra}; ${bucket.impactStarts || 0} interruption(s) began`
        : `${key}: no listener-impacting off-air time`;
      cells.push(
        `<div class="hm-cell ${cls}${selected}"${impactMs ? ` data-day="${key}"` : ''} title="${esc(label)}"></div>`,
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
      if (dayFilter && !eventOverlapsDay(e, dayFilter)) return false;
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

  /**
   * Is this event a failure of the channel itself? Mirrors store.isFailureEvent
   * — a 'degraded' event is a channel that kept playing while one bitrate
   * variant went missing, so it is a real fault but not downtime, and counting
   * it in the failure totals would disagree with the server's own rollup.
   *
   * TOTALS only. The per-event rendering below deliberately keeps testing
   * `type !== 'up'`, because a degraded event does have a duration, a cause and
   * an ongoing/resolved state, and should show all three.
   */
  function isFailureEvent(e) {
    return e.type !== 'up' && e.type !== 'degraded';
  }

  function renderSummary() {
    const UNCONFIRMED = new Set(['brief_outage', 'probe_error', 'blip']);
    // Overview figures are governed only by the range control above them. The
    // filters belong to the Event Timeline below; silently letting a cause or
    // search filter rewrite these totals makes them disagree with the visible
    // reconciliation block.
    const summaryEvents = allEvents;
    // Headline counts group by what the AUDIENCE experienced, not by whether a
    // failure lasted long enough to pass our confirmation threshold. Those two
    // groupings disagree in both directions — short failures that really did
    // drop the mount, and confirmed outages Icecast proved were harmless — so
    // counting by severity put real outages under a heading the station reads
    // as "ignore me".
    const failures = summaryEvents.filter(isFailureEvent);
    const felt = failures.filter(costListeners);
    const unfelt = failures.filter((e) => !costListeners(e));
    // Sustained enough that the audience is gone, vs a gap the player rode out.
    // Counting a 60-second reconnect alongside an 18-hour dropout produced a
    // headline of "45 outages" with a median duration of two minutes, which
    // told the station nothing it could act on.
    const sigMs = lastRollup?.significantThresholdMs ?? 5 * 60 * 1000;
    const significant = felt.filter((e) => (e.durationMs || 0) >= sigMs);
    const briefFelt = felt.filter((e) => (e.durationMs || 0) < sigMs);
    const blips = unfelt.length;
    const deadAir = summaryEvents.filter((e) => e.severity === 'dead_air').length;

    // Events that could plausibly notify. An event that DID email always
    // counts, whatever its severity — the retired server-blip rule emailed
    // unconfirmed events, and excluding them produced a denominator smaller
    // than its own numerator ("54 of 36 notifiable").
    const notifiable = summaryEvents.filter(
      (e) => !UNCONFIRMED.has(e.severity) || e.email?.sent === true,
    );
    const emailed = summaryEvents.filter((e) => e.email?.sent === true).length;
    // An outage the monitor deliberately declined to email — Icecast proved the
    // mount kept serving — has a known outcome and must not be counted below as
    // one whose delivery is unknown.
    const isSuppressed = (e) => typeof e.email?.reason === 'string'
      && e.email.reason.startsWith('suppressed');
    const suppressed = summaryEvents.filter(isSuppressed).length;
    // Backfilled events predate delivery tracking: an alert may well have gone
    // out, we simply have no record of it. Lumping them in with genuine
    // non-delivery reads as an alerting failure that never happened.
    const untracked = notifiable.filter((e) => e.email?.sent == null && !isSuppressed(e)).length;
    // Delivery we know happened but never logged live — flagged so the tile
    // never passes reconstruction off as a measured send.
    const reconstructedSends = summaryEvents.filter(
      (e) => e.email?.sent === true && e.email?.deliveryReconstructed,
    ).length;

    // Downtime, two ways — because they answer different questions and only one
    // of them is what "how long were we down" means.
    //
    // Failures the stream survived are excluded outright: Icecast was reachable
    // and still serving the mount, so counting them as downtime contradicts a
    // verdict we already reached about them.
    //
    // Computed from every event in the selected period. Timeline filters below
    // do not change these Overview totals. The store runs the same merge for
    // the roundup email.
    const downEvents = felt.filter((e) => e.durationMs);
    const streamDowntimeMs = downEvents.reduce((a, e) => a + e.durationMs, 0);
    const downtimeMs = mergeIntervals(downEvents);

    $('#stat-outages').textContent = felt.length;
    $('#stat-outages-detail').textContent = felt.length
      ? `stream interruption records = ${significant.length} sustained (${fmtDuration(sigMs)}+) + ${briefFelt.length} brief. One incident affecting two streams creates two records.`
      : 'stream interruption records; no listener-impacting failures in this period.';

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
    // This tile counts a DIFFERENT population from every other one on the page:
    // outage alerts AND their "back online" counterparts. Unstated, 92 sitting
    // beside "9 outages" reads as impossible. So it says which is which.
    const downAlerts = summaryEvents.filter((e) => e.email?.sent === true && e.type !== 'up').length;
    const upAlerts = summaryEvents.filter((e) => e.email?.sent === true && e.type === 'up').length;
    $('#stat-emailed').textContent = emailed;
    let emailedDetail = upAlerts
      ? `${downAlerts} outage + ${upAlerts} all-clear`
      : `of ${notifiable.length} notifiable`;
    // This tile counts EVENTS that were alerted; the roundup sentence above it
    // counts MESSAGES, and one consolidated email covers several streams. Two
    // different numbers labelled "emailed" a few centimetres apart read as a
    // bug, so when they differ this says which is which. Only while the view is
    // unfiltered — the rollup describes the whole period, not a subset.
    const messages = lastRollup?.alerts?.messages;
    if (messages != null && messages !== emailed) {
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
    const streamTimeEl = $('#stat-streamtime');
    const streamTimeDetail = $('#stat-streamtime-detail');
    if (streamTimeEl) streamTimeEl.textContent = streamDowntimeMs ? fmtDuration(streamDowntimeMs) : '0s';
    if (streamTimeDetail) {
      streamTimeDetail.textContent = streamDowntimeMs > downtimeMs
        ? `each of the ${streams.length} streams counted separately · ${fmtDuration(streamDowntimeMs - downtimeMs)} more than elapsed because stream outages overlapped`
        : `each of the ${streams.length} streams counted separately`;
    }
    const dtDetail = $('#stat-downtime-detail');
    if (dtDetail) {
      // Say what is down. Narrowed to one stream, "at least one stream" is a
      // strange way to describe the only stream in view.
      const names = streams.map((s) => s.name.replace(/^KPFT\s+/i, '')).join(', ');
      const subject = `at least one of ${streams.length} monitored streams (${names}) down`;
      // Name the difference rather than hiding it. One server fault that took
      // two streams down for 3h35m each is 3h35m off air, not 7h10m.
      dtDetail.textContent = streamDowntimeMs > downtimeMs
        ? `${subject} · simultaneous outages merged and counted once`
        : `${subject} · elapsed clock time`;
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
    const infoPopovers = [...document.querySelectorAll('.info-popover')];
    infoPopovers.forEach((popover) => {
      popover.addEventListener('toggle', () => {
        if (!popover.open) return;
        infoPopovers.forEach((other) => { if (other !== popover) other.open = false; });
      });
    });
    document.addEventListener('click', (event) => {
      if (event.target.closest('.info-popover')) return;
      infoPopovers.forEach((popover) => { popover.open = false; });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      infoPopovers.forEach((popover) => { popover.open = false; });
    });

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

  /** A selected duration cell shows every event whose interval touched it. */
  function eventOverlapsDay(e, day) {
    const bucket = (stats?.daily || []).find((b) => b.day === day);
    const dayStart = bucket?.start
      ? new Date(bucket.start).getTime()
      : new Date(`${day}T00:00:00`).getTime();
    const dayEnd = bucket?.end
      ? new Date(bucket.end).getTime()
      : new Date(`${day}T24:00:00`).getTime();
    const eventStart = new Date(e.timestamp).getTime();
    if (!isFinite(eventStart)) return false;
    const eventEnd = e.type !== 'up' && e.durationMs
      ? eventStart + e.durationMs
      : eventStart + 1;
    return eventStart < dayEnd && eventEnd > dayStart;
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
    // Escapes for BOTH text and attribute contexts.
    //
    // This previously used the DOM trick — set textContent, read innerHTML —
    // which escapes & < > but leaves quotes untouched. That is safe for text and
    // unsafe inside an attribute: a value containing a double quote closes the
    // attribute early and anything after it becomes markup. Several call sites
    // interpolate into title="..." and data-*="...", and one of them renders
    // Icecast metadata, which is set by whoever streams to the mount.
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
