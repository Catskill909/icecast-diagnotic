/* ═══════════════════════════════════════════════════════════════════════════
   KPFT Stream Monitor — Frontend Application
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const POLL_INTERVAL = 10000; // 10 seconds
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let history = {};
  let lastStatus = null;
  let pollTimer = null;
  let isFirstLoad = true;
  let uptimeRangeDays = 1; // active tab on the top "Uptime" tile

  // ── Boot ────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      // Fetch initial status in parallel
      const [statusRes, historyRes] = await Promise.all([
        fetch('/api/status').then((r) => r.json()),
        fetch('/api/history').then((r) => r.json()),
      ]);

      history = historyRes.history || {};

      // Show dashboard
      $('#loading').style.display = 'none';
      $('#dashboard').style.display = 'block';

      // Render initial data
      renderStatus(statusRes);
      renderIncidents(historyRes.incidents || []);

      // Mark connected
      setConnected(true);
      isFirstLoad = false;

      // Setup Help Modal
      setupHelpModal();
      setupUptimeRangePills();

      // Start polling
      pollTimer = setInterval(poll, POLL_INTERVAL);
    } catch (err) {
      console.error('Boot failed:', err);
      $('#loading .loading-text').textContent = 'Failed to connect. Retrying…';
      setTimeout(boot, 5000);
    }
  }

  // ── Help Modal ───────────────────────────────────────────────────────────
  function setupHelpModal() {
    const modal = $('#help-modal');
    const openBtn = $('#help-btn');
    const closeBtn = $('#modal-close-btn');
    const okBtn = $('#modal-ok-btn');

    if (!modal || !openBtn) return;

    const open = () => { modal.style.display = 'flex'; };
    const close = () => { modal.style.display = 'none'; };

    openBtn.onclick = open;
    if (closeBtn) closeBtn.onclick = close;
    if (okBtn) okBtn.onclick = close;

    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
  }

  async function poll() {
    try {
      const [statusRes, historyRes] = await Promise.all([
        fetch('/api/status').then((r) => r.json()),
        fetch('/api/history').then((r) => r.json()),
      ]);

      history = historyRes.history || {};
      renderStatus(statusRes);
      renderIncidents(historyRes.incidents || []);
      setConnected(true);
    } catch (err) {
      console.error('Poll failed:', err);
      setConnected(false);
    }
  }

  // ── Connection Badge ────────────────────────────────────────────────────
  function setConnected(connected) {
    const badge = $('#connection-badge');
    const text = $('#connection-text');
    if (connected) {
      badge.classList.add('connected');
      text.textContent = 'Live';
    } else {
      badge.classList.remove('connected');
      text.textContent = 'Disconnected';
    }
  }

  // ── Status Render ───────────────────────────────────────────────────────
  function renderStatus(data) {
    const streams = data.streams || [];
    lastStatus = streams;

    // Summary metrics
    const upCount = streams.filter((s) => s.status === 'up').length;
    const downCount = streams.filter((s) => s.status === 'down').length;
    const totalListeners = streams.reduce((acc, s) => acc + (s.listeners || 0), 0);
    const responseTimes = streams.filter((s) => s.responseTime != null).map((s) => s.responseTime);
    const avgResponse = responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : 0;

    $('#summary-up').textContent = upCount;
    $('#summary-up-detail').textContent = `of ${streams.length} streams`;
    $('#summary-down').textContent = downCount;
    $('#summary-down-detail').textContent = downCount > 0 ? 'action required' : 'all clear';

    // Total Listeners
    const listenersEl = $('#summary-listeners');
    if (listenersEl) {
      listenersEl.textContent = totalListeners;
      $('#summary-listeners-detail').textContent = `${totalListeners} active stream listeners`;
    }

    // Color the down summary
    const downEl = $('#summary-down');
    if (downCount > 0) {
      downEl.className = 'summary-value down';
    } else {
      downEl.className = 'summary-value neutral';
      downEl.style.color = 'var(--status-up)';
    }

    $('#summary-response').textContent = `${avgResponse}`;

    // Uptime tile — respects whichever range tab is active
    refreshUptimeTile();

    // Stream cards
    renderStreamCards(streams);
  }

  function calculate24hUptime() {
    let totalChecks = 0;
    let upChecks = 0;
    for (const id of Object.keys(history)) {
      const entries = history[id] || [];
      totalChecks += entries.length;
      upChecks += entries.filter((e) => e.status === 'up').length;
    }
    if (totalChecks === 0) return 100;
    return Math.round((upChecks / totalChecks) * 10000) / 100;
  }

  // ── Uptime range tile ───────────────────────────────────────────────────
  const UPTIME_RANGE_LABELS = { 1: 'last 24 hours', 7: 'last 7 days', 30: 'last 30 days', 90: 'last 90 days', 365: 'last year' };

  function coverageLabel(coverageDays) {
    if (!coverageDays) return '0h';
    if (coverageDays < 1) return `${Math.max(1, Math.round(coverageDays * 24))}h`;
    return `${coverageDays < 10 ? coverageDays.toFixed(1) : Math.round(coverageDays)}d`;
  }

  function applyUptimeValue(percent, { partial = false, detail = 'across all streams', collecting = false } = {}) {
    const uptimeEl = $('#summary-uptime');
    const detailEl = $('#summary-uptime-detail');
    if (!uptimeEl || !detailEl) return;

    if (collecting || percent == null) {
      uptimeEl.textContent = '—';
      uptimeEl.style.color = '';
      uptimeEl.className = 'summary-value neutral';
      detailEl.textContent = 'Collecting data — check back soon';
      detailEl.className = 'summary-detail partial';
      return;
    }

    uptimeEl.textContent = `${percent}%`;
    uptimeEl.style.color = '';
    if (percent >= 99) {
      uptimeEl.className = 'summary-value up';
    } else if (percent >= 95) {
      uptimeEl.className = 'summary-value neutral';
      uptimeEl.style.color = '#f59e0b';
    } else {
      uptimeEl.className = 'summary-value down';
    }
    detailEl.textContent = detail;
    detailEl.className = partial ? 'summary-detail partial' : 'summary-detail';
  }

  let uptimeFetchToken = 0;
  async function refreshUptimeTile() {
    const rangeLabel = UPTIME_RANGE_LABELS[uptimeRangeDays] || `last ${uptimeRangeDays} days`;

    if (uptimeRangeDays === 1) {
      applyUptimeValue(calculate24hUptime(), { detail: `across all streams · ${rangeLabel}` });
      return;
    }

    const token = ++uptimeFetchToken;
    try {
      const res = await fetch(`/api/uptime?days=${uptimeRangeDays}`).then((r) => r.json());
      if (token !== uptimeFetchToken) return; // a newer tab click superseded this request
      if (res.uptime == null) {
        applyUptimeValue(null, { collecting: true });
        return;
      }
      if (res.coverageDays < uptimeRangeDays * 0.95) {
        applyUptimeValue(res.uptime, {
          partial: true,
          detail: `Partial — only ${coverageLabel(res.coverageDays)} of history collected so far`,
        });
      } else {
        applyUptimeValue(res.uptime, { detail: `across all streams · ${rangeLabel}` });
      }
    } catch (err) {
      console.error('Uptime range fetch failed:', err);
    }
  }

  function setupUptimeRangePills() {
    const container = $('#uptime-range-pills');
    if (!container) return;
    container.querySelectorAll('.range-pill').forEach((btn) => {
      btn.onclick = () => {
        uptimeRangeDays = parseInt(btn.dataset.days, 10);
        container.querySelectorAll('.range-pill').forEach((b) => b.classList.toggle('active', b === btn));
        refreshUptimeTile();
      };
    });
  }

  // Player state tracking: { [streamId]: 'stopped' | 'buffering' | 'playing' }
  const playerStates = {};
  const activePlayers = {};

  // ── Stream Cards ────────────────────────────────────────────────────────
  function renderStreamCards(streams) {
    const grid = $('#streams-grid');

    streams.forEach((stream, i) => {
      let card = $(`#card-${stream.id}`);

      const cardStatus = stream.silenceState === 'dead_air' ? 'dead-air' : stream.silenceState === 'evaluating' ? 'evaluating' : stream.status;

      if (!card) {
        card = document.createElement('div');
        card.id = `card-${stream.id}`;
        card.className = `stream-card slide-in ${cardStatus}`;
        card.style.animationDelay = `${i * 80}ms`;
        grid.appendChild(card);
      } else {
        card.className = `stream-card ${cardStatus}`;
      }

      const responseClass = getResponseClass(stream.responseTime);
      const uptimePercent = getStreamUptime(stream.id);
      const uptimeClass = uptimePercent >= 99 ? 'good' : uptimePercent >= 95 ? 'warn' : 'bad';
      const uptimeBar = renderUptimeBar(stream.id);
      const state = playerStates[stream.id] || 'stopped';

      let statusLabel = stream.status === 'up' ? 'Online' : stream.status === 'down' ? 'Offline' : 'Unknown';
      let dotClass = stream.status;

      if (stream.silenceState === 'evaluating') {
        statusLabel = `Evaluating Silence (${stream.silenceStreak || 1}/3)`;
        dotClass = 'evaluating';
      } else if (stream.silenceState === 'dead_air') {
        statusLabel = 'Dead Air Alert';
        dotClass = 'dead-air';
      }

      let playBtnContent = '<span class="material-symbols-outlined">play_arrow</span>';
      if (state === 'buffering') {
        playBtnContent = '<div class="btn-spinner"></div>';
      } else if (state === 'playing') {
        playBtnContent = '<span class="material-symbols-outlined">pause</span>';
      }

      let silenceBadgeHtml = '';
      if (stream.silenceState === 'evaluating') {
        silenceBadgeHtml = `<div class="silence-badge evaluating">🟡 Evaluating Silence Pause (Aggressive 5s Probe)</div>`;
      } else if (stream.silenceState === 'dead_air') {
        silenceBadgeHtml = `<div class="silence-badge dead-air">🔴 Sustained Dead Air Alert (Silence Confirmed)</div>`;
      } else if (stream.isSilent) {
        silenceBadgeHtml = `<div class="silence-badge">⚠️ Silence Detected</div>`;
      }

      card.innerHTML = `
        <div class="stream-header">
          <div class="stream-info">
            <div class="stream-name">${escapeHtml(stream.name)}</div>
            <div class="stream-url">${escapeHtml(truncateUrl(stream.url))}</div>
          </div>
          <div class="status-indicator ${dotClass}">
            <span class="status-dot ${dotClass}"></span>
            ${statusLabel}
          </div>
        </div>

        <!-- Live Audio Preview Player -->
        <div class="audio-player-box">
          <button class="play-btn" data-stream-id="${stream.id}" data-stream-url="${escapeHtml(stream.url)}" title="Toggle Preview Audio">
            ${playBtnContent}
          </button>
          <div class="player-info">
            <div class="player-title" title="${escapeHtml(stream.title || stream.name + ' Stream')}">${escapeHtml(stream.title || stream.name + ' Stream')}</div>
            <div class="player-subtitle">
              <span>${stream.bitrate || 128} kbps</span>
              <span class="bullet-dot">●</span>
              <span>Audio Preview</span>
              <div class="visualizer-waves ${state === 'playing' ? 'playing' : ''}">
                <div class="visualizer-bar"></div>
                <div class="visualizer-bar"></div>
                <div class="visualizer-bar"></div>
                <div class="visualizer-bar"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="stream-metrics">
          <div class="metric">
            <div class="metric-value" style="color: var(--primary-light);">${stream.listeners != null ? stream.listeners : '—'}</div>
            <div class="metric-label">Listeners</div>
          </div>
          <div class="metric">
            <div class="metric-value ${responseClass}">${stream.responseTime != null ? stream.responseTime + 'ms' : '—'}</div>
            <div class="metric-label">Response</div>
          </div>
          <div class="metric">
            <div class="metric-value ${uptimeClass}">${uptimePercent}%</div>
            <div class="metric-label">24h Uptime</div>
          </div>
          <div class="metric">
            <div class="metric-value">${stream.consecutiveFailures || 0}</div>
            <div class="metric-label">Failures</div>
          </div>
        </div>

        ${silenceBadgeHtml}

        <div class="uptime-bar-container">
          <div class="uptime-bar-label">
            <span>24 hours ago</span>
            <span>Now</span>
          </div>
          <div class="uptime-bar">${uptimeBar}</div>
        </div>

        ${stream.error ? `<div class="stream-error">${escapeHtml(stream.error)}</div>` : ''}

        <div class="stream-last-check">
          ${stream.lastChecked ? 'Checked ' + relativeTime(stream.lastChecked) : 'Not yet checked'}
        </div>
      `;
    });

    // Attach audio player click listeners
    $$('.play-btn').forEach((btn) => {
      btn.onclick = () => toggleAudioPlayer(btn.dataset.streamId, btn.dataset.streamUrl);
    });
  }

  function toggleAudioPlayer(streamId, streamUrl) {
    // Stop all other playing audio
    Object.keys(activePlayers).forEach((id) => {
      if (id !== streamId && activePlayers[id]) {
        activePlayers[id].pause();
        activePlayers[id] = null;
        playerStates[id] = 'stopped';
      }
    });

    let audio = activePlayers[streamId];

    if (audio && (playerStates[streamId] === 'playing' || playerStates[streamId] === 'buffering')) {
      audio.pause();
      activePlayers[streamId] = null;
      playerStates[streamId] = 'stopped';
      if (lastStatus) renderStreamCards(lastStatus);
    } else {
      playerStates[streamId] = 'buffering';
      if (lastStatus) renderStreamCards(lastStatus);

      audio = new Audio(streamUrl);
      activePlayers[streamId] = audio;

      audio.addEventListener('playing', () => {
        playerStates[streamId] = 'playing';
        if (lastStatus) renderStreamCards(lastStatus);
      });

      audio.addEventListener('waiting', () => {
        playerStates[streamId] = 'buffering';
        if (lastStatus) renderStreamCards(lastStatus);
      });

      audio.addEventListener('pause', () => {
        playerStates[streamId] = 'stopped';
        activePlayers[streamId] = null;
        if (lastStatus) renderStreamCards(lastStatus);
      });

      audio.addEventListener('ended', () => {
        playerStates[streamId] = 'stopped';
        activePlayers[streamId] = null;
        if (lastStatus) renderStreamCards(lastStatus);
      });

      audio.addEventListener('error', () => {
        playerStates[streamId] = 'stopped';
        activePlayers[streamId] = null;
        if (lastStatus) renderStreamCards(lastStatus);
      });

      audio.play().catch((err) => {
        console.error('Audio playback error:', err);
        playerStates[streamId] = 'stopped';
        activePlayers[streamId] = null;
        if (lastStatus) renderStreamCards(lastStatus);
      });
    }
  }

  function renderUptimeBar(streamId) {
    const entries = history[streamId] || [];
    if (entries.length === 0) {
      return '<div class="uptime-segment unknown" style="flex:1"></div>';
    }

    // Bucket into ~60 segments across 24h
    const BUCKETS = 60;
    const now = Date.now();
    const window = 24 * 60 * 60 * 1000;
    const bucketSize = window / BUCKETS;
    const buckets = new Array(BUCKETS).fill(null); // null = no data

    entries.forEach((entry) => {
      const age = now - new Date(entry.timestamp).getTime();
      const bucketIdx = BUCKETS - 1 - Math.floor(age / bucketSize);
      if (bucketIdx >= 0 && bucketIdx < BUCKETS) {
        // If any check in this bucket is down, mark bucket as down
        if (buckets[bucketIdx] === null) {
          buckets[bucketIdx] = entry.status;
        } else if (entry.status === 'down') {
          buckets[bucketIdx] = 'down';
        }
      }
    });

    return buckets
      .map((status) => {
        const cls = status || 'unknown';
        return `<div class="uptime-segment ${cls}" style="flex:1"></div>`;
      })
      .join('');
  }

  function getStreamUptime(streamId) {
    const entries = history[streamId] || [];
    if (entries.length === 0) return 100;
    const up = entries.filter((e) => e.status === 'up').length;
    return Math.round((up / entries.length) * 10000) / 100;
  }

  function getResponseClass(ms) {
    if (ms == null) return '';
    if (ms < 500) return 'good';
    if (ms < 2000) return 'warn';
    return 'bad';
  }

  // ── Incidents ───────────────────────────────────────────────────────────
  // Expanded rows are tracked by id so they survive the 10s poll re-render —
  // otherwise reading an incident's detail would collapse under you.
  const openIncidents = new Set();
  let lastIncidents = [];

  function renderIncidents(incidents) {
    const container = $('#incidents-container');
    lastIncidents = incidents || [];

    if (!incidents || incidents.length === 0) {
      container.innerHTML = `
        <div class="incidents-empty">
          <span class="material-symbols-outlined">check_circle</span>
          <p>No incidents recorded in the last 24 hours</p>
        </div>
      `;
      return;
    }

    // Sort by timestamp, newest first
    const sorted = [...incidents].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const shown = sorted.slice(0, 8);
    const hidden = sorted.length - shown.length;

    // Severity is richer than the old down/up split. A failure that never met
    // the alert threshold is split by whether Icecast proves listeners were
    // affected: a vanished mount ('brief_outage') cut the audience off, while a
    // failed probe against a still-serving mount ('probe_error') cost nobody
    // anything. 'blip' is the retired name for both, kept for stored history.
    const META = {
      outage: { icon: 'error', label: 'Outage', cls: 'down' },
      brief_outage: { icon: 'bolt', label: 'Brief Outage', cls: 'blip' },
      probe_error: { icon: 'sensors_off', label: 'Probe Anomaly', cls: 'probe-error' },
      blip: { icon: 'bolt', label: 'Blip', cls: 'blip' },
      dead_air: { icon: 'volume_off', label: 'Dead Air', cls: 'dead-air' },
      recovery: { icon: 'check_circle', label: 'Recovered', cls: 'up' },
    };

    container.innerHTML = `
      <div class="incidents-list">
        ${shown
          .map((inc) => {
            const sev = inc.severity || (inc.type === 'down' ? 'outage' : 'recovery');
            const meta = META[sev] || META.outage;
            const cause = inc.diagnosis?.causeLabel && inc.type !== 'up'
              ? ` <span class="incident-cause">· ${escapeHtml(inc.diagnosis.causeLabel)}</span>`
              : '';
            const duration = inc.durationLabel
              ? ` <span class="incident-cause">· lasted ${escapeHtml(inc.durationLabel)}</span>`
              : '';
            const mail = inc.email?.sent === true
              ? '<span class="incident-mail sent" title="Alert email delivered">✉ sent</span>'
              : inc.email?.attempted
              ? '<span class="incident-mail failed" title="Alert email failed to send">✉ failed</span>'
              : '<span class="incident-mail none" title="No alert email sent for this event">✉ none</span>';
            const isOpen = openIncidents.has(inc.id);
            const recon = inc.reconstructed
              ? '<span class="incident-badge reconstructed" title="Backfilled from raw telemetry — diagnosis inferred, not observed live">Reconstructed</span>'
              : '';
            return `
          <div class="incident${isOpen ? ' open' : ''}" data-id="${escapeHtml(inc.id)}">
            <div class="incident-head row-tip" data-tip="Click for full diagnosis" data-tip-open="Click to collapse">
              <div class="incident-icon ${meta.cls}">
                <span class="material-symbols-outlined">${meta.icon}</span>
              </div>
              <div class="incident-content">
                <div class="incident-message">${escapeHtml(inc.message)}</div>
                <div class="incident-time">${formatTimestamp(inc.timestamp)}${cause}${duration}</div>
              </div>
              ${recon}
              ${mail}
              <div class="incident-badge ${meta.cls}">${meta.label}</div>
              <div class="incident-chevron"><span class="material-symbols-outlined">expand_more</span></div>
            </div>
            <div class="incident-body">${isOpen ? renderIncidentDetail(inc) : ''}</div>
          </div>`;
          })
          .join('')}
      </div>
      ${hidden > 0
        ? `<div class="incidents-more"><a href="history.html">View all ${sorted.length} events from the last 24h, plus the full permanent history →</a></div>`
        : '<div class="incidents-more"><a href="history.html">Open the full permanent incident history →</a></div>'}
    `;

    wireIncidentRows(container);
  }

  /** Shared with the history page via event-detail.js. */
  function renderIncidentDetail(inc) {
    if (!window.EventDetail) return '<p class="incident-detail-fallback">Detail view unavailable.</p>';
    return window.EventDetail.render(inc);
  }

  function wireIncidentRows(container) {
    container.querySelectorAll('.incident[data-id]').forEach((row) => {
      const head = row.querySelector('.incident-head');
      if (!head) return;
      head.onclick = () => {
        const id = row.dataset.id;
        const body = row.querySelector('.incident-body');
        if (openIncidents.has(id)) {
          openIncidents.delete(id);
          row.classList.remove('open');
        } else {
          openIncidents.add(id);
          const inc = lastIncidents.find((x) => x.id === id);
          if (inc && !body.innerHTML.trim()) body.innerHTML = renderIncidentDetail(inc);
          row.classList.add('open');
        }
      };
    });
  }

  // ── Utilities ───────────────────────────────────────────────────────────
  function relativeTime(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  function formatTimestamp(isoString) {
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  function truncateUrl(url) {
    try {
      const u = new URL(url);
      return `${u.hostname}:${u.port}${u.pathname}`;
    } catch {
      return url;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Start ───────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', boot);
})();
