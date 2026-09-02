/* ═══════════════════════════════════════════════════════════════════════════
   Pacifica Stream Monitor — Frontend Application
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
      const [statusRes, historyRes, configRes] = await Promise.all([
        fetch('/api/status').then((r) => r.json()),
        fetch('/api/history').then((r) => r.json()),
        fetch('/api/config').then((r) => (r.ok ? r.json() : null)).catch(() => null),
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

      setupUptimeRangePills();
      initListTools();

      // Start polling
      pollTimer = setInterval(poll, POLL_INTERVAL);
    } catch (err) {
      console.error('Boot failed:', err);
      $('#loading .loading-text').textContent = 'Failed to connect. Retrying…';
      setTimeout(boot, 5000);
    }
  }

  // The guide lives in guide.js — it owns #help-btn and #help-modal.


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

    // Every range, including 24h, now comes from /api/uptime. The old local
    // shortcut counted raw check samples, so a run of probe resets that never
    // interrupted a listener dragged the headline figure down — and it
    // disagreed with the same number on the history page.
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
        applyUptimeValue(res.uptime, { detail: `audio delivered · ${rangeLabel}` });
      }
    } catch (err) {
      console.error('Uptime range fetch failed:', err);
      // Fall back to the local sample-based figure rather than showing nothing:
      // a slightly pessimistic number beats an empty tile on the live dashboard.
      if (uptimeRangeDays === 1) {
        applyUptimeValue(calculate24hUptime(), { detail: `across all streams · ${rangeLabel}` });
      }
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

  // The card previews: which mount each is pointed at, what it is doing, and the
  // one-at-a-time rule. The state lives out here rather than in the cards, so
  // the choice survives the re-render that every poll performs.
  const players = PreviewPlayer.createPreviewPlayers({
    createAudio: (url) => new Audio(url),
    onChange: () => {
      if (lastStatus) renderStreamCards(lastStatus);
    },
  });

  // ── Stream Cards ────────────────────────────────────────────────────────
  // ── Filter and sort ───────────────────────────────────────────────────────
  // Applied over the already-loaded status payload. The list is small and the
  // data is in hand, so a round trip would be latency bought for nothing.

  let filterQuery = '';
  // Alphabetical, because it is the only order a reader can PREDICT.
  //
  // This used to open in "Default order", which was the order channels happened
  // to be added to the config. It was offered as "the arrangement the operator
  // chose", but nothing in the app lets an operator arrange anything — there is
  // no reordering, and the config carries no order field. So it named itself by
  // its position in the menu rather than by what it did, and what it did was
  // unpredictable and changed whenever a station was added.
  let sortMode = 'name';

  /**
   * Problems first.
   *
   * Sorting by "status" alphabetically would put Dead Air after Online, which
   * inverts the only reason someone reaches for this sort in the first place.
   */
  function statusRank(stream) {
    if (stream.silenceState === 'dead_air') return 0;
    if (stream.status === 'down') return 1;
    if (stream.silenceState === 'evaluating') return 2;
    if (stream.isSilent) return 3;
    if (stream.status !== 'up') return 4;
    return 5;
  }

  /**
   * Everything on the card that a person might type: its name, the host it
   * lives on, its mount paths and the current programme title.
   *
   * Mounts are in there because "which station is on /wbai_verizon" is a real
   * question, and the mount is the part an operator has in front of them when
   * they are looking at an encoder.
   */
  function streamHaystack(stream) {
    return [
      stream.name,
      hostOf(stream.url),
      stream.title,
      ...channelMounts(stream),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function sortStreams(list) {
    const out = [...list];
    const byName = (a, b) => String(a.name || '')
      .localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });

    switch (sortMode) {
      case 'listeners':
        // Null is "not measured", which is not the same as zero and must not
        // outrank a real count of none.
        return out.sort((a, b) => (b.listeners ?? -1) - (a.listeners ?? -1));
      case 'response':
        return out.sort((a, b) => (a.responseTime ?? Infinity) - (b.responseTime ?? Infinity));
      case 'status':
        return out.sort((a, b) => statusRank(a) - statusRank(b) || byName(a, b));
      case 'name':
      default:
        // Alphabetical is also the fallback, so an unrecognised value can never
        // leave the list in whatever order the payload happened to arrive in.
        return out.sort(byName);
    }
  }

  /**
   * Hides what does not match and reorders what remains.
   *
   * Order is set through the CSS `order` property rather than by moving nodes.
   * Cards are reused across a poll every ten seconds, and re-appending them
   * would replay the slide-in animation on each refresh — the list would twitch
   * continuously while nothing about it had changed.
   */
  function applyFilterSort() {
    if (!lastStatus) return;
    const q = filterQuery.trim().toLowerCase();
    const ordered = sortStreams(lastStatus);
    let visible = 0;

    ordered.forEach((stream, i) => {
      const card = $(`#card-${stream.id}`);
      if (!card) return;
      const show = !q || streamHaystack(stream).includes(q);
      card.hidden = !show;
      card.style.order = String(i);
      if (show) visible += 1;
    });

    const empty = $('#streams-empty');
    if (empty) {
      empty.hidden = visible > 0;
      const text = $('#streams-empty-text');
      // Name the search when there is one. With no query an empty grid means
      // nothing is configured, which is a different message and a different
      // thing for the reader to do about it.
      if (text) {
        text.textContent = q
          ? `No streams match "${filterQuery.trim()}".`
          : 'No streams are configured yet.';
      }
    }

    const clear = $('#stream-search-clear');
    if (clear) clear.hidden = !filterQuery;
  }

  function initListTools() {
    const search = $('#stream-search');
    const sort = $('#stream-sort');
    const clear = $('#stream-search-clear');

    if (search) {
      search.addEventListener('input', () => {
        filterQuery = search.value;
        applyFilterSort();
      });
      // Escape clears, which is what a search field is expected to do and
      // saves reaching for the button.
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && search.value) {
          e.preventDefault();
          search.value = '';
          filterQuery = '';
          applyFilterSort();
        }
      });
    }

    if (clear) {
      clear.addEventListener('click', () => {
        if (!search) return;
        search.value = '';
        filterQuery = '';
        search.focus();
        applyFilterSort();
      });
    }

    if (sort) {
      sort.addEventListener('change', () => {
        sortMode = sort.value;
        applyFilterSort();
      });
    }
  }

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
      const state = players.state(stream.id);

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

      // A channel is published as one mount per bitrate, and the probe only ever
      // asks the highest one — so a variant can stop being served while the card
      // still reads ONLINE and its listeners are off the air.
      //
      // Every mount is LISTED rather than counted. "2 of 3" tells an operator
      // something is wrong; the paths tell them which encoder to restart. The
      // host moves up to its own line so the paths are not competing with it for
      // width — the old single line wrapped mid-path on every card.
      //
      // Single-mount channels list their one mount too. Showing the row on some
      // cards and not others reads as missing data rather than as a channel that
      // simply has one mount.
      const mounts = channelMounts(stream);
      // Only trust a failing-mount verdict while Icecast is answering. When it is
      // unreachable we cannot see any mount, and flagging them all would report
      // an outage we have no evidence for.
      //
      // The two failures are shown differently because they need different
      // actions: a MISSING mount is struck through — it is gone, and its source
      // has to be reconnected. A STALLED one is still listed and still holding
      // its listeners, who are connected to silence, so it stays legible.
      const impaired = new Map(
        (stream.icecastReachable ? stream.impairedMounts || [] : []).map((m) => [m.path, m.reason]),
      );
      // Each chip is also the play control for its own mount. The probed mount
      // is the default, so a card with nothing playing looks exactly as it did
      // when the chips were inert — the highlight simply now means "this is what
      // the player below is pointed at" rather than "this is the probed one".
      //
      // A MISSING mount is not selectable: Icecast is not serving it, so there is
      // nothing to point a player at. If the selected mount goes missing while
      // playing, selection falls back rather than leaving the card highlighting
      // something unplayable.
      const playableMounts = mounts.filter((p) => impaired.get(p) !== 'missing');
      const selectedMount = players.selectionFor(stream.id, playableMounts);
      const selectedUrl = selectedMount ? mountUrl(stream, selectedMount) : stream.url;

      const mountsHtml = mounts.length
        ? `<div class="stream-mounts">${mounts.map((path, i) => {
            const fault = impaired.get(path);
            const title = fault === 'missing'
              ? 'Icecast is not listing this mount — nobody can play it'
              : fault === 'stalled'
              ? 'Icecast lists this mount but it is not serving audio — click to hear it anyway'
              : path === selectedMount
              ? (i === 0 ? 'Probed for health — click to play or stop' : 'Click to play or stop')
              : i === 0
              ? 'Probed for health — click to listen'
              : 'Served by Icecast, checked every few minutes — click to listen';
            // The listener count for this mount specifically. This is the whole
            // point of listing mounts rather than counting them: on this host
            // /live_64 regularly carries a third of the channel's audience, and
            // a summed figure never showed that.
            const n = (stream.mountListeners || {})[path];
            const count = fault == null && typeof n === 'number'
              ? `<span class="mount-n">${n}</span>`
              : '';
            const classes = `mount${i === 0 ? ' primary' : ''}${path === selectedMount ? ' selected' : ''}${fault ? ' ' + fault : ''}`;
            return `<button type="button" class="${classes}"${fault === 'missing' ? ' disabled' : ''} data-stream-id="${escapeHtml(stream.id)}" data-mount-path="${escapeHtml(path)}" data-mount-url="${escapeHtml(mountUrl(stream, path))}" title="${escapeHtml(title)}">${escapeHtml(path)}${count}</button>`;
          }).join('')}</div>`
        : '';

      card.innerHTML = `
        <div class="stream-header">
          <div class="stream-info">
            <div class="stream-name">${escapeHtml(stream.name)}</div>
            <div class="stream-host">${escapeHtml(hostOf(stream.url))}</div>
          </div>
          <div class="status-indicator ${dotClass}">
            <span class="status-dot ${dotClass}"></span>
            ${statusLabel}
          </div>
        </div>

        <!-- Outside .stream-header on purpose. Inside it, this row was a flex
             child sharing the line with the status badge, so it only ever got
             about three quarters of the card and wrapped a three-mount channel
             onto three lines. Out here it spans the full card and wraps only
             when the mounts genuinely do not fit. -->
        ${mountsHtml}

        <!-- Live Audio Preview Player -->
        <div class="audio-player-box">
          <button class="play-btn" data-stream-id="${escapeHtml(stream.id)}" data-stream-url="${escapeHtml(selectedUrl)}" title="Toggle Preview Audio">
            ${playBtnContent}
          </button>
          <div class="player-info">
            <div class="player-title" title="${escapeHtml(stream.title || stream.name + ' Stream')}">${escapeHtml(stream.title || stream.name + ' Stream')}</div>
            <div class="player-subtitle">
              <!-- The configured bitrate describes the PROBED mount only. Beside
                   /kpfa_64 it would be a plain lie, so a variant names itself
                   instead and lets the chip above say the rest. -->
              ${selectedMount && selectedMount !== mounts[0]
                ? `<span class="player-mount">${escapeHtml(selectedMount)}</span>`
                : `<span>${stream.bitrate || 128} kbps</span>`}
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
      btn.onclick = () => players.toggle(btn.dataset.streamId, btn.dataset.streamUrl);
    });

    // A mount chip is the play control for its own mount.
    $$('.mount[data-mount-url]').forEach((chip) => {
      chip.onclick = () =>
        players.selectMount(chip.dataset.streamId, chip.dataset.mountPath, chip.dataset.mountUrl);
    });

    // A card added by this render has to be filtered and ordered like the rest,
    // so this runs on every pass rather than only on user input.
    applyFilterSort();
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
      // A channel that kept playing while one of its bitrate mounts went
      // missing. Without an entry here it fell through to META.outage and
      // rendered as a red 'Outage' — the opposite of what happened.
      degraded: { icon: 'signal_cellular_alt_2_bar', label: 'Degraded Channel', cls: 'degraded' },
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
        ? `<div class="incidents-more"><a href="history.html">View all ${sorted.length} events from the last 24h, plus the full long-term history →</a></div>`
        : '<div class="incidents-more"><a href="history.html">Open the full long-term incident history →</a></div>'}
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

  /** The Icecast host alone. The path belongs to the mount chips below it. */
  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  /**
   * Every mount of the channel, the probed one first.
   *
   * Mirrors diagnose.channelMountPaths(). The configured mount list normally
   * already contains the probed path, but nothing requires it to, and a channel
   * whose own probed mount was missing from its own list would be the one card
   * that quietly told the truth about nothing.
   */
  function channelMounts(stream) {
    let primary = '';
    try {
      primary = new URL(stream.url).pathname;
    } catch {
      // An unparseable URL still has whatever the config listed.
    }
    return [...new Set([primary, ...(stream.mounts || [])].filter(Boolean))];
  }

  /**
   * The channel's URL with its path swapped for one of its other mounts.
   *
   * Everything else about the stream — host, port, scheme — is shared across the
   * channel's mounts, so only the path differs.
   */
  function mountUrl(stream, path) {
    try {
      const u = new URL(stream.url);
      u.pathname = path;
      return u.href;
    } catch {
      // An unparseable URL is not made better by guessing at a path.
      return stream.url;
    }
  }

  function escapeHtml(str) {
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

  // ── Start ───────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', boot);
})();
