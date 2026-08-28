/* Station administration.
 *
 * External file, not inline: the Content-Security-Policy is script-src 'self'
 * with no 'unsafe-inline', so an injected <script> does not execute. Putting
 * this back inside the page would require weakening that.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  let discovered = null;

  /** Escapes for text AND attribute contexts — quotes included. */
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function show(el, text, kind) {
    el.className = 'msg ' + (kind || 'err');
    el.textContent = text;
  }
  function showList(el, items, kind) {
    el.className = 'msg ' + (kind || 'err');
    el.innerHTML = '<strong>Could not add this station:</strong><ul>' +
      items.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>';
  }
  const clear = (el) => { el.className = 'msg'; el.textContent = ''; };

  async function api(path, options) {
    const res = await fetch(path, options);
    if (res.status === 401) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return null; }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }

  // ── Current stations ──────────────────────────────────────────────────────
  async function loadStations() {
    const r = await api('/api/stations');
    if (!r) return;
    const host = $('stations');
    if (!r.ok) { host.textContent = 'Could not load configuration.'; return; }

    const stations = r.body.stations || [];
    const channels = stations.reduce((n, s) => n + (s.channels || []).length, 0);
    $('summary').textContent =
      `${stations.length} station${stations.length === 1 ? '' : 's'}, ` +
      `${channels} channel${channels === 1 ? '' : 's'}, ` +
      `${(r.body.hosts || []).length} Icecast host${(r.body.hosts || []).length === 1 ? '' : 's'}`;

    host.innerHTML = stations.map((s) => `
      <div class="station">
        <div class="station-name">${esc(s.name)}</div>
        <div class="station-meta">${esc(s.id)} · ${esc(s.timezone || 'UTC')}</div>
        <div class="chan">
          ${(s.channels || []).map((c) =>
            `<span class="chip">${esc(c.name)} · ${esc((c.mounts || []).length || 1)} mount${(c.mounts || []).length === 1 ? '' : 's'}</span>`
          ).join('')}
        </div>
      </div>`).join('') || '<div class="hint">No stations configured.</div>';
  }

  // ── Discovery ─────────────────────────────────────────────────────────────
  $('discover-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clear($('discover-msg'));
    $('results').classList.add('hidden');
    const btn = $('discover-btn');
    btn.disabled = true; btn.textContent = 'Looking…';

    const r = await api('/api/stations/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: $('url').value.trim() }),
    });

    btn.disabled = false; btn.textContent = 'Discover';
    if (!r) return;
    if (!r.ok) {
      show($('discover-msg'), r.body.error || 'Could not read that address.',
           r.status === 502 ? 'warn' : 'err');
      return;
    }

    discovered = r.body;
    renderResults(r.body);
  });

  function renderResults(d) {
    $('found').innerHTML =
      `Found <strong>${esc(d.mountCount)}</strong> mount${d.mountCount === 1 ? '' : 's'} on ` +
      `<strong>${esc(d.host || 'that server')}</strong>` +
      (d.serverId ? ` (${esc(d.serverId)})` : '') +
      `, grouped into <strong>${esc(d.channelCount)}</strong> channel${d.channelCount === 1 ? '' : 's'}.` +
      (d.repairedJson ? ' <em>That server emits slightly malformed JSON; it was repaired.</em>' : '');

    // On a shared host most of what was found belongs to other stations, so
    // nothing is pre-selected and the point is stated rather than implied.
    $('shared-note').textContent = d.sharedHost
      ? 'This server carries several stations. Tick only the channels that belong to yours.'
      : 'Tick the channels to monitor.';

    $('channels').innerHTML = (d.channels || []).map((c, i) => `
      <label class="ch${c.matched ? ' matched' : ''}">
        <input type="checkbox" data-i="${i}" ${c.matched || !d.sharedHost ? 'checked' : ''}>
        <span class="ch-body">
          <span class="ch-name">${esc(c.name)}${c.matched ? '<span class="tag">the URL you pasted</span>' : ''}</span>
          <span class="ch-meta">
            <span class="ch-listeners">${esc(c.listeners)} listening</span>
            <span>${esc(c.variants)} bitrate${c.variants === 1 ? '' : 's'}</span>
            <span>${esc((c.mounts || []).join('  '))}</span>
          </span>
        </span>
      </label>`).join('');

    // Fields carry REAL values, not placeholders that look like values. The
    // first version of this form used realistic placeholder text and was
    // submitted empty, because there was no way to tell the two apart.
    const s = d.suggestedStation || {};
    $('st-name').value = s.name || '';
    $('st-id').value = s.id || '';
    idTouched = false;
    $('st-tz').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    $('results').classList.remove('hidden');
    $('st-name').focus();
    $('st-name').select();
  }

  // Suggest an identifier from the name, but never overwrite a typed one.
  let idTouched = false;
  $('st-id').addEventListener('input', () => { idTouched = true; });
  $('st-name').addEventListener('input', () => {
    if (idTouched) return;
    $('st-id').value = $('st-name').value.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  });

  $('cancel-btn').addEventListener('click', () => {
    $('results').classList.add('hidden');
    clear($('save-msg')); clear($('discover-msg'));
    discovered = null; idTouched = false;
  });

  // ── Save ──────────────────────────────────────────────────────────────────
  $('save-btn').addEventListener('click', async (e) => {
    e.preventDefault();
    clear($('save-msg'));
    if (!discovered) return;

    const picked = [...document.querySelectorAll('#channels input:checked')]
      .map((cb) => discovered.channels[Number(cb.dataset.i)]);
    if (!picked.length) { show($('save-msg'), 'Select at least one channel.'); return; }

    const stationId = $('st-id').value.trim();
    if (!stationId || !$('st-name').value.trim()) {
      show($('save-msg'), 'Give the station a name and an identifier.');
      return;
    }
    const payload = {
      station: { id: stationId, name: $('st-name').value.trim(), timezone: $('st-tz').value.trim() },
      // Channel ids are prefixed with the station so they stay unique across
      // stations — they key this channel's history permanently.
      channels: picked.map((c) => ({
        // Prefixed with the station so ids stay unique across stations — they
        // key this channel's history permanently. Not doubled up when the
        // channel already carries the station's name: "wpfw-wpfw" helps nobody.
        id: (c.id === stationId || c.id.startsWith(stationId + '-')
              ? c.id
              : `${stationId}-${c.id}`).slice(0, 64),
        name: c.name,
        url: c.url,
        mounts: c.mounts,
      })),
    };

    const btn = $('save-btn');
    btn.disabled = true; btn.textContent = 'Adding…';
    const r = await api('/api/stations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    btn.disabled = false; btn.textContent = 'Add station';
    if (!r) return;

    if (!r.ok) {
      if (Array.isArray(r.body.errors)) showList($('save-msg'), r.body.errors);
      else show($('save-msg'), r.body.error || 'Could not add this station.');
      return;
    }

    show($('save-msg'),
      `${r.body.station.name} added and being monitored now — ` +
      `${r.body.monitoring.added.length} channel(s), no restart needed.`, 'ok');
    $('results').classList.add('hidden');
    $('url').value = ''; discovered = null; idTouched = false;
    loadStations();
  });

  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  loadStations();
})();
