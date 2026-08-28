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

  /**
   * Asks before doing something destructive.
   *
   * Resolves true only on an explicit confirm; Escape, the backdrop and Cancel
   * all resolve false, and Cancel holds focus so the dangerous option is never
   * the one a stray Enter reaches.
   *
   * `keep` is the part that matters more than the warning: naming what SURVIVES
   * is what lets somebody decide, where "Are you sure?" asks a question they
   * have no way to answer.
   */
  function confirmAction({ title, body, keep, confirmLabel = 'Remove', icon = '⚠' }) {
    return new Promise((resolve) => {
      const overlay = $('confirm-overlay');
      $('confirm-icon').textContent = icon;
      $('confirm-title').textContent = title;
      $('confirm-body').innerHTML =
        body.map((p) => `<p>${p}</p>`).join('') +
        (keep ? `<div class="confirm-keep">${keep}</div>` : '');
      $('confirm-go').textContent = confirmLabel;
      overlay.hidden = false;
      $('confirm-cancel').focus();

      const done = (answer) => {
        overlay.hidden = true;
        $('confirm-go').onclick = null;
        $('confirm-cancel').onclick = null;
        overlay.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(answer);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };

      $('confirm-go').onclick = () => done(true);
      $('confirm-cancel').onclick = () => done(false);
      overlay.onclick = (e) => { if (e.target === overlay) done(false); };
      document.addEventListener('keydown', onKey);
    });
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

    const only = stations.length < 2;
    host.innerHTML = stations.map((s) => `
      <div class="station" data-station="${esc(s.id)}">
        <div class="station-head">
          <div>
            <div class="station-name">${esc(s.name)}</div>
            <div class="station-meta">${esc(s.id)} · ${esc(s.timezone || 'UTC')}</div>
          </div>
          <div class="station-actions">
            <button class="mini" data-edit="${esc(s.id)}">Edit</button>
            <button class="mini danger" data-remove="${esc(s.id)}" ${only ? 'disabled title="The only station cannot be removed"' : ''}>Remove</button>
          </div>
        </div>
        <div class="chan">
          ${(s.channels || []).map((c) =>
            `<span class="chip">${esc(c.name)} · ${esc((c.mounts || []).length || 1)} mount${(c.mounts || []).length === 1 ? '' : 's'}</span>`
          ).join('')}
        </div>
        <div class="station-editor hidden" data-editor="${esc(s.id)}"></div>
      </div>`).join('') || '<div class="hint">No stations configured.</div>';

    host.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => openEditor(stations.find((s) => s.id === b.dataset.edit))));
    host.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => confirmRemove(stations.find((s) => s.id === b.dataset.remove))));
  }

  // ── Discovery ─────────────────────────────────────────────────────────────
  $('discover-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Clear every message, not just this one. A confirmation left over from an
    // edit reads as though it describes the station being added now.
    clear($('discover-msg'));
    clear($('save-msg'));
    clear($('list-msg'));
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

    // MOST STATIONS HAVE ONE STREAM. Twenty-two of the twenty-eight affiliates
    // on the shared Pacifica host are single-channel; KPFT's three is the
    // exception. So the default shows the one channel that was asked for, and
    // everything else on the server — which belongs to other stations — is
    // folded away behind a disclosure. The first version showed all eight and
    // made the normal case look like a puzzle.
    const all = d.channels || [];
    // The pasted channel, plus anything sharing its call sign — KPFT Main and
    // KPFT HD2 belong together and should not be separated by four other
    // stations' streams.
    const mine = all.filter((c) => c.matched || c.sameStation);
    const others = all.filter((c) => !c.matched && !c.sameStation);
    const row = (c, i) => `
      <label class="ch${c.matched ? ' matched' : ''}">
        <input type="checkbox" data-i="${i}" ${c.matched || !d.sharedHost ? 'checked' : ''}>
        <span class="ch-body">
          <span class="ch-name">${esc(c.name)}${
            c.matched ? '<span class="tag">the URL you pasted</span>'
            : c.sameStation ? '<span class="tag alt">same call sign — also yours?</span>' : ''
          }</span>
          <span class="ch-meta">
            <span class="ch-listeners">${esc(c.listeners)} listening</span>
            <span>${esc(c.variants)} bitrate${c.variants === 1 ? '' : 's'}</span>
            <span>${esc((c.mounts || []).join('  '))}</span>
          </span>
        </span>
      </label>`;
    const indexOf = (c) => all.indexOf(c);

    if (mine.length) {
      $('shared-note').textContent = mine.length > 1
        ? 'The stream you pasted, plus others on this server sharing its call sign. Tick any that are also yours.'
        : 'This is the stream you pasted. Most stations have exactly one.';
      $('channels').innerHTML =
        mine.map((c) => row(c, indexOf(c))).join('') +
        (others.length ? `
          <details class="more">
            <summary>${others.length} other channel${others.length === 1 ? '' : 's'} on this server — other stations, most likely</summary>
            <div class="more-body">${others.map((c) => row(c, indexOf(c))).join('')}</div>
          </details>` : '');
    } else {
      // A status URL was pasted rather than a stream, so there is nothing to
      // single out and the whole list is the answer.
      $('shared-note').textContent = d.sharedHost
        ? 'This server carries several stations. Tick only the channels that belong to yours.'
        : 'Tick the channels to monitor.';
      $('channels').innerHTML = all.map((c, i) => row(c, i)).join('');
    }

    // Fields carry REAL values, not placeholders that look like values. The
    // first version of this form used realistic placeholder text and was
    // submitted empty, because there was no way to tell the two apart.
    const s = d.suggestedStation || {};
    $('st-name').value = s.name || '';
    $('st-id').value = s.id || '';
    // A suggested id is a decision, not a placeholder. Only fall back to
    // slugging the name when discovery could not work one out.
    idFixed = !!s.id;
    $('st-tz').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    $('results').classList.remove('hidden');
    $('st-name').focus();
    $('st-name').select();
  }

  // The identifier is derived from the name only while nothing better is known.
  //
  // Discovery works out a good one from the call sign — "KPFK HiRes Stream"
  // gives kpfk — and once it has, typing a friendlier station name must not
  // overwrite it. That is how "KPFK Los Angeles" turned kpfk into
  // kpfk-los-angeles: a permanent identifier, which keys this station's entire
  // history, silently rewritten from a display name.
  //
  // A name and an identifier are different things. The name is for people and
  // can be changed later; the identifier cannot.
  let idFixed = false;                 // suggested by discovery, or typed by hand
  $('st-id').addEventListener('input', () => { idFixed = true; });
  $('st-name').addEventListener('input', () => {
    if (idFixed) return;
    $('st-id').value = $('st-name').value.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  });

  $('cancel-btn').addEventListener('click', () => {
    $('results').classList.add('hidden');
    clear($('save-msg')); clear($('discover-msg')); clear($('list-msg'));
    discovered = null; idFixed = false;
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

    clear($('list-msg'));
    show($('save-msg'),
      `${r.body.station.name} added and being monitored now — ` +
      `${r.body.monitoring.added.length} channel(s), no restart needed.`, 'ok');
    $('results').classList.add('hidden');
    $('url').value = ''; discovered = null; idFixed = false;
    loadStations();
  });

  // ── Editing ───────────────────────────────────────────────────────────────
  function openEditor(s) {
    if (!s) return;
    const box = document.querySelector(`[data-editor="${CSS.escape(s.id)}"]`);
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }

    box.innerHTML = `
      <div class="fields">
        <label>Name<input data-f="name" value="${esc(s.name)}"></label>
        <label>Timezone<input data-f="tz" value="${esc(s.timezone || 'UTC')}"></label>
      </div>
      <h3>Channels</h3>
      <p class="hint">A channel's identifier is fixed — it keys this channel's recorded history. Everything else can change.</p>
      <div class="edit-channels">
        ${(s.channels || []).map((c) => `
          <div class="edit-ch" data-cid="${esc(c.id)}">
            <div class="edit-ch-id">${esc(c.id)}</div>
            <input data-f="cname" value="${esc(c.name)}" placeholder="Display name">
            <input data-f="curl" value="${esc(c.url)}" placeholder="Stream URL">
            <input data-f="cmounts" value="${esc((c.mounts || []).join(' '))}" placeholder="/mount /mount_64">
            <button class="mini danger" data-drop="${esc(c.id)}">Drop</button>
          </div>`).join('')}
      </div>
      <div class="actions">
        <button class="primary" data-save="${esc(s.id)}">Save changes</button>
        <button class="ghost" data-cancel="1" type="button">Cancel</button>
      </div>
      <div class="msg" data-msg="1"></div>`;
    box.classList.remove('hidden');

    box.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', async () => {
      if (box.querySelectorAll('.edit-ch').length < 2) {
        show(box.querySelector('[data-msg]'), 'A station must keep at least one channel.');
        return;
      }
      const row = b.closest('.edit-ch');
      const name = row.querySelector('[data-f=cname]').value.trim() || b.dataset.drop;
      const ok = await confirmAction({
        title: `Drop ${name} from ${s.name}?`,
        body: [
          `This channel stops being checked once you save. Nothing changes until then —
           Cancel still puts it back.`,
        ],
        keep: `Its recorded history is kept under <strong>${esc(b.dataset.drop)}</strong>.`,
        confirmLabel: 'Drop channel',
      });
      if (ok) row.remove();
    }));
    box.querySelector('[data-cancel]').addEventListener('click', () => box.classList.add('hidden'));
    box.querySelector('[data-save]').addEventListener('click', () => saveEdit(s.id, box));
  }

  async function saveEdit(id, box) {
    const msg = box.querySelector('[data-msg]');
    clear(msg);
    const channels = [...box.querySelectorAll('.edit-ch')].map((row) => ({
      // The id is read from the row, never from an input: it is not editable.
      id: row.dataset.cid,
      name: row.querySelector('[data-f=cname]').value.trim(),
      url: row.querySelector('[data-f=curl]').value.trim(),
      mounts: row.querySelector('[data-f=cmounts]').value.trim().split(/\s+/).filter(Boolean),
    }));
    const body = {
      name: box.querySelector('[data-f=name]').value.trim(),
      timezone: box.querySelector('[data-f=tz]').value.trim(),
      channels,
    };

    const btn = box.querySelector('[data-save]');
    btn.disabled = true; btn.textContent = 'Saving…';
    const r = await api(`/api/stations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    btn.disabled = false; btn.textContent = 'Save changes';
    if (!r) return;
    if (!r.ok) {
      if (Array.isArray(r.body.errors)) showList(msg, r.body.errors);
      else show(msg, r.body.error || 'Could not save.');
      return;
    }
    const dropped = (r.body.removedChannels || []);
    show($('list-msg'),
      `${r.body.station.name} updated.` +
      (dropped.length ? ` Stopped monitoring ${dropped.join(', ')} — its recorded history is kept.` : ''),
      'ok');
    loadStations();
  }

  // ── Removing ──────────────────────────────────────────────────────────────
  async function confirmRemove(s) {
    if (!s) return;
    const channels = (s.channels || []).length;
    const ok = await confirmAction({
      title: `Stop monitoring ${s.name}?`,
      body: [
        `Its <strong>${channels}</strong> channel${channels === 1 ? '' : 's'} will no longer be
         checked, and it will disappear from the dashboard and the station picker.`,
        `Any alerts currently configured for it stop.`,
      ],
      keep: `Its recorded history is kept. Re-adding ${esc(s.name)} later with the same
             channel identifiers reconnects to it.`,
      confirmLabel: 'Stop monitoring',
    });
    if (ok) removeStation(s);
  }

  async function removeStation(s) {
    const r = await api(`/api/stations/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    if (!r) return;
    if (!r.ok) { show($('list-msg'), r.body.error || 'Could not remove.'); return; }
    show($('list-msg'),
      `${r.body.removed.name} is no longer monitored. Its recorded history is kept — ` +
      `re-adding it with the same channel identifiers reconnects to it.`, 'ok');
    loadStations();
  }

  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  loadStations();
})();
