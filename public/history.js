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
    const [statsRes, eventsRes] = await Promise.all([
      fetch(`/api/stats?days=${days}`).then((r) => r.json()),
      fetch(`/api/events?days=${days}&limit=2000`).then((r) => r.json()),
    ]);

    stats = statsRes;
    allEvents = eventsRes.events || [];
    streams = statsRes.streams || [];

    populateStreamFilter();
    populateCauseFilter();
    renderStorage();
    renderHeatmap();
    renderCauses();
    applyFilters();
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

    const downtimeMs = filtered
      .filter((e) => e.type !== 'up' && e.durationMs)
      .reduce((a, e) => a + e.durationMs, 0);

    $('#stat-outages').textContent = outages;
    $('#stat-outages-detail').textContent = `${filtered.length} events in view`;
    $('#stat-blips').textContent = blips;
    $('#stat-deadair').textContent = deadAir;
    $('#stat-emailed').textContent = emailed;
    $('#stat-emailed-detail').textContent = `of ${notifiable.length} notifiable`;
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
        <div class="evt-head">
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

  function renderBody(e) {
    const d = e.diagnosis;
    const blocks = [];

    if (d && d.cause) {
      blocks.push(`
        <div class="diag-head">
          <span class="diag-cause">🔎 ${esc(d.causeLabel)}</span>
          <span class="conf ${esc(d.confidence)}">${esc(d.confidence)} confidence</span>
        </div>`);
    }

    if (e.reconstructed) {
      blocks.push(`
        <div class="recon-note">
          <span class="material-symbols-outlined">history_toggle_off</span>
          <div>
            <strong>Reconstructed event.</strong>
            ${esc(e.reconstructionNote || 'Backfilled from raw per-check telemetry captured before the storage migration. Timestamps, statuses and error strings are the real recorded values; the root-cause diagnosis was inferred from those errors plus cross-stream correlation, not from a live probe.')}
          </div>
        </div>`);
    }

    const grid = [];

    if (d?.evidence?.length) {
      grid.push(`
        <div class="detail-block">
          <h5>Evidence</h5>
          <ul>${d.evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>`);
    }

    if (d?.remediation?.length) {
      grid.push(`
        <div class="detail-block">
          <h5>What to do</h5>
          <ol>${d.remediation.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
        </div>`);
    }

    // Technical facts
    const rows = [];
    const push = (k, v, cls) => { if (v != null && v !== '') rows.push(`<div class="kv-row"><span class="kv-key">${k}</span><span class="kv-val ${cls || ''}">${v}</span></div>`); };

    push('Occurred', new Date(e.timestamp).toLocaleString('en-US'));
    if (e.resolvedAt) push('Resolved', new Date(e.resolvedAt).toLocaleString('en-US'));
    if (e.durationLabel) push('Duration', esc(e.durationLabel), 'warn');
    if (e.sourceOutage) {
      push('Source reconnected', new Date(e.sourceOutage.reconnectedAt).toLocaleString('en-US'), 'good');
      push('True source downtime', esc(e.sourceOutage.sourceDownLabel), 'warn');
    }
    if (d?.httpStatus != null) push('HTTP status', d.httpStatus, d.httpStatus === 200 ? 'good' : 'bad');
    if (d?.errorCode) push('Error code', `<code class="inline">${esc(d.errorCode)}</code>`);
    if (d?.errorMessage) push('Error', `<code class="inline">${esc(d.errorMessage)}</code>`, 'bad');
    if (e.failedChecks) push('Failed checks', e.failedChecks);
    if (e.selfCleared) push('Outcome', 'Self-cleared before confirmation', 'good');
    if (rows.length) {
      grid.push(`<div class="detail-block"><h5>Details</h5><div class="kv">${rows.join('')}</div></div>`);
    }

    // Icecast state
    const ice = d?.icecast;
    if (ice) {
      const ir = [];
      const ipush = (k, v, cls) => { if (v != null && v !== '') ir.push(`<div class="kv-row"><span class="kv-key">${k}</span><span class="kv-val ${cls || ''}">${v}</span></div>`); };
      ipush('Status endpoint', ice.reachable ? 'Reachable' : 'UNREACHABLE', ice.reachable ? 'good' : 'bad');
      if (ice.statusError) ipush('Status error', esc(ice.statusError), 'bad');
      if (ice.serverId) ipush('Server', esc(ice.serverId));
      if (ice.mountPath) ipush('Mount', `<code class="inline">${esc(ice.mountPath)}</code>`);
      ipush('Mount present', ice.mountPresent ? 'Yes' : 'NO', ice.mountPresent ? 'good' : 'bad');
      if (ice.mountCount) ipush('Mounts on server', ice.mountCount);
      if (ice.sourceConnectedSince) ipush('Source connected since', new Date(ice.sourceConnectedSince).toLocaleString('en-US'));
      if (ice.listeners != null) ipush('Listeners', ice.listeners);
      if (ice.serverRestarted) ipush('Server restarted', 'YES', 'warn');
      if (ir.length) {
        grid.push(`<div class="detail-block"><h5>Icecast server state</h5><div class="kv">${ir.join('')}</div></div>`);
      }
    }

    // Email delivery record
    const em = e.email || {};
    const er = [];
    const epush = (k, v, cls) => { if (v != null && v !== '') er.push(`<div class="kv-row"><span class="kv-key">${k}</span><span class="kv-val ${cls || ''}">${v}</span></div>`); };
    epush('Alert sent', em.sent === true ? 'Yes' : em.attempted ? 'FAILED' : 'No', em.sent === true ? 'good' : em.attempted ? 'bad' : '');
    if (em.reason) epush('Reason', esc(em.reason));
    if (em.error) epush('SMTP error', `<code class="inline">${esc(em.error)}</code>`, 'bad');
    if (em.recipients?.length) epush('Recipients', esc(em.recipients.join(', ')));
    if (em.sentAt) epush('Sent at', new Date(em.sentAt).toLocaleString('en-US'));
    if (em.consolidated) epush('Delivery', 'Consolidated multi-stream alert');
    if (em.subject) epush('Subject', esc(em.subject));
    if (er.length) {
      grid.push(`<div class="detail-block"><h5>Email notification</h5><div class="kv">${er.join('')}</div></div>`);
    }

    blocks.push(`<div class="detail-grid">${grid.join('')}</div>`);

    // Connection-layer timing strip
    const t = d?.timings;
    if (t && (t.dns != null || t.tcp != null || t.tls != null || t.ttfb != null)) {
      const segs = [];
      const legend = [];
      const add = (key, label, color, val) => {
        if (val == null || val <= 0) return;
        segs.push({ key, val });
        legend.push(`<span><span class="timing-dot" style="background:${color}"></span>${label} ${val}ms</span>`);
      };
      // ttfb is measured from request start, so show only the tail after TLS.
      const pre = (t.dns || 0) + (t.tcp || 0) + (t.tls || 0);
      const serverTime = t.ttfb != null ? Math.max(t.ttfb - pre, 0) : null;

      add('dns', 'DNS', '#60a5fa', t.dns);
      add('tcp', 'TCP connect', '#34d399', t.tcp);
      add('tls', 'TLS handshake', '#fbbf24', t.tls);
      add('ttfb', 'Server response', '#a78bfa', serverTime);

      const total = segs.reduce((a, s) => a + s.val, 0) || 1;
      const strip = segs.map((s) =>
        `<div class="timing-seg ${s.key}" style="flex:${(s.val / total) * 100}">${s.val >= total * 0.12 ? s.val + 'ms' : ''}</div>`,
      ).join('');

      blocks.push(`
        <div class="detail-block" style="margin-top:18px;">
          <h5>Connection breakdown${t.resolvedIp ? ` — resolved to ${esc(t.resolvedIp)}` : ''}</h5>
          <div class="timing-strip">${strip}</div>
          <div class="timing-legend">${legend.join('')}</div>
        </div>`);
    }

    return blocks.join('');
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
