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

  const SEVERITY_META = {
    outage:   { icon: 'error',        label: 'Outage' },
    blip:     { icon: 'bolt',         label: 'Blip' },
    dead_air: { icon: 'volume_off',   label: 'Dead Air' },
    recovery: { icon: 'check_circle', label: 'Recovered' },
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

    populateStreamFilter();
    populateCauseFilter();
    renderStorage();
    renderUptimeStat(uptimeRes, isAllTime);
    renderHeatmap();
    renderCauses();
    applyFilters();
  }

  // ── Uptime tile ─────────────────────────────────────────────────────────
  function coverageLabel(coverageDays) {
    if (!coverageDays) return '0h';
    if (coverageDays < 1) return `${Math.max(1, Math.round(coverageDays * 24))}h`;
    return `${coverageDays < 10 ? coverageDays.toFixed(1) : Math.round(coverageDays)}d`;
  }

  function renderUptimeStat(uptimeRes, isAllTime) {
    const valueEl = $('#stat-uptime');
    const detailEl = $('#stat-uptime-detail');

    if (!uptimeRes || uptimeRes.uptime == null) {
      valueEl.textContent = '—';
      valueEl.className = 'summary-value neutral';
      detailEl.textContent = uptimeRes
        ? 'Collecting data — check back soon'
        : 'Uptime unavailable';
      detailEl.className = 'summary-detail partial';
      return;
    }

    valueEl.textContent = `${uptimeRes.uptime}%`;
    valueEl.className = uptimeRes.uptime >= 99 ? 'summary-value up' : uptimeRes.uptime >= 95 ? 'summary-value neutral' : 'summary-value down';

    const partial = !isAllTime && uptimeRes.coverageDays < uptimeRes.days * 0.95;
    if (partial) {
      detailEl.textContent = `Partial — only ${coverageLabel(uptimeRes.coverageDays)} of history collected so far`;
      detailEl.className = 'summary-detail partial';
    } else {
      detailEl.textContent = 'across all streams';
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

  // ── Summary tiles ───────────────────────────────────────────────────────
  function renderSummary() {
    const outages = filtered.filter((e) => e.severity === 'outage').length;
    const blips = filtered.filter((e) => e.severity === 'blip').length;
    const deadAir = filtered.filter((e) => e.severity === 'dead_air').length;

    // Only events that could plausibly notify count toward the ratio.
    const notifiable = filtered.filter((e) => e.severity !== 'blip');
    const emailed = filtered.filter((e) => e.email?.sent === true).length;
    // Backfilled events predate delivery tracking: an alert may well have gone
    // out, we simply have no record of it. Lumping them in with genuine
    // non-delivery reads as an alerting failure that never happened.
    const untracked = notifiable.filter((e) => e.email?.sent == null).length;
    // Delivery we know happened but never logged live — flagged so the tile
    // never passes reconstruction off as a measured send.
    const reconstructedSends = filtered.filter(
      (e) => e.email?.sent === true && e.email?.deliveryReconstructed,
    ).length;

    const downtimeMs = filtered
      .filter((e) => e.type !== 'up' && e.durationMs)
      .reduce((a, e) => a + e.durationMs, 0);

    $('#stat-outages').textContent = outages;
    $('#stat-outages-detail').textContent = `${filtered.length} events in view`;
    $('#stat-blips').textContent = blips;
    $('#stat-deadair').textContent = deadAir;
    $('#stat-emailed').textContent = emailed;
    let emailedDetail = `of ${notifiable.length} notifiable`;
    if (untracked) emailedDetail += ` · ${untracked} predate tracking`;
    else if (reconstructedSends === emailed && emailed) emailedDetail += ' · delivery reconstructed';
    $('#stat-emailed-detail').textContent = emailedDetail;
    $('#stat-emailed-detail').className = untracked && !emailed
      ? 'summary-detail partial'
      : 'summary-detail';
    $('#stat-downtime').textContent = downtimeMs ? fmtDuration(downtimeMs) : '0s';

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
      <div class="evt${isOpen ? ' open' : ''}" data-id="${esc(e.id)}">
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

  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
