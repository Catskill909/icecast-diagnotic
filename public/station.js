/* Alert recipients, per station.
 *
 * External file, not inline: the Content-Security-Policy is script-src 'self'
 * with no 'unsafe-inline', so an injected <script> does not execute. Putting
 * this back inside the page would require weakening that.
 *
 * This screen is deliberately NOT part of the station admin panel. Editing
 * channels is technical and occasional; editing who gets paged is routine and
 * belongs to the station itself, and the two should not share a Save button
 * with "remove station" beside it.
 */
(() => {
  const $ = (id) => document.getElementById(id);

  /** Escapes for text AND attribute contexts — quotes included. */
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // The working copy. Edits are held here and written on Save, so a half-typed
  // recipient list is never what the monitor is running from.
  let stations = [];
  let current = null;
  let draft = { recipients: [], cc: [], enabled: true, inherited: false };

  async function api(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch {
      return { ok: false, status: 0, body: {} };
    }
    if (res.status === 401) {
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      return null;
    }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }

  function show(text, kind) {
    const el = $('msg');
    el.className = 'msg ' + (kind || 'err');
    el.textContent = text;
  }
  function showList(intro, items) {
    const el = $('msg');
    el.className = 'msg err';
    el.innerHTML = `<strong>${esc(intro)}</strong><ul>` +
      items.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>';
  }
  const clearMsg = () => { const el = $('msg'); el.className = 'msg'; el.textContent = ''; };

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  function renderList(elId, addresses, inherited) {
    const el = $(elId);
    if (!addresses.length) {
      el.innerHTML = `<div class="addr-empty">${
        elId === 'cc' ? 'Nobody copied in.' : 'No addresses yet.'
      }</div>`;
      return;
    }
    el.innerHTML = addresses.map((a, i) => `
      <div class="addr">
        <span class="${inherited ? 'inherited' : ''}">${esc(a)}</span>
        <button class="mini danger" data-list="${esc(elId)}" data-i="${i}" type="button">Remove</button>
      </div>`).join('');
  }

  function render() {
    renderList('recipients', draft.recipients, draft.inherited);
    renderList('cc', draft.cc, draft.inherited);
    $('enabled').checked = draft.enabled !== false;
    $('editor').hidden = false;
  }

  /**
   * Says whether mail will actually go out, in the server's words.
   *
   * Four separate things have to hold — SMTP configured, instance deployed,
   * station not muted, list not empty — and each fails silently on its own. The
   * verdict is computed server-side from the rules the sender itself uses, so
   * this cannot drift into promising delivery that will not happen.
   */
  function renderRouting(routing) {
    const el = $('routing');
    if (!routing) { el.className = 'routing'; el.textContent = ''; return; }

    if (routing.willSend) {
      const n = routing.recipientCount;
      const cc = routing.ccCount ? `, copying ${routing.ccCount}` : '';
      el.className = 'routing on';
      el.innerHTML =
        `<strong>Alerts are on for this station</strong>` +
        `<span class="why">${n} recipient${n === 1 ? '' : 's'}${cc}.` +
        (routing.recipientSource === 'global'
          ? ' Using the monitor-wide list — this station has none of its own yet.'
          : '') + '</span>';
      return;
    }

    el.className = 'routing off';
    el.innerHTML =
      `<strong>Nothing will be emailed for this station</strong>` +
      `<span class="why">${esc(routing.reason || 'Alerts are not configured.')} ` +
      `Outages are still recorded in full — only the email is withheld.</span>`;
  }

  /* ── Loading ───────────────────────────────────────────────────────────── */

  async function loadStations() {
    const res = await api('/api/stations');
    if (!res) return;
    if (!res.ok) return show('Could not load stations.');

    stations = res.body.stations || [];
    if (!stations.length) return show('No stations are configured yet.', 'warn');

    // The station lives in the URL so an alert email can deep-link straight to
    // the screen for the station it is about.
    const wanted = new URLSearchParams(location.search).get('station');
    current = stations.find((s) => s.id === wanted) || stations[0];

    $('station-picker').innerHTML = stations
      .map((s) => `<option value="${esc(s.id)}"${s.id === current.id ? ' selected' : ''}>${esc(s.name)}</option>`)
      .join('');

    selectStation(current.id);
  }

  function selectStation(id) {
    current = stations.find((s) => s.id === id);
    if (!current) return;

    const url = new URL(location.href);
    url.searchParams.set('station', current.id);
    history.replaceState(null, '', url);

    const a = current.alerts || {};
    // An address shown here that came from the monitor-wide fallback is NOT
    // this station's own. Saving it would silently copy the fallback onto the
    // station and freeze it there, so the draft starts empty and the fallback
    // is described in the routing line instead of being pre-filled.
    draft = {
      recipients: Array.isArray(a.recipients) ? [...a.recipients] : [],
      cc: Array.isArray(a.cc) ? [...a.cc] : [],
      enabled: a.enabled !== false,
      inherited: false,
    };
    clearMsg();
    render();
    refreshRouting();
  }

  /** Re-asks the server what it would actually do now. */
  async function refreshRouting() {
    const res = await api('/api/stations/' + encodeURIComponent(current.id) + '/alerts/preview');
    if (!res || !res.ok) { renderRouting(null); return; }
    renderRouting(res.body.effective);
  }

  /* ── Editing ───────────────────────────────────────────────────────────── */

  function addFrom(inputEl, list) {
    const raw = inputEl.value.trim();
    if (!raw) return;
    // Split here as well as on the server, so pasting three addresses shows
    // three rows immediately rather than one row that turns into three on save.
    for (const part of raw.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean)) {
      if (!list.some((a) => a.toLowerCase() === part.toLowerCase())) list.push(part);
    }
    inputEl.value = '';
    clearMsg();
    render();
  }

  async function save() {
    clearMsg();
    $('save').disabled = true;

    const res = await api('/api/stations/' + encodeURIComponent(current.id) + '/alerts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: draft.recipients,
        cc: draft.cc,
        enabled: $('enabled').checked,
      }),
    });
    $('save').disabled = false;
    if (!res) return;

    if (!res.ok) {
      const errors = res.body.errors;
      return Array.isArray(errors) && errors.length
        ? showList('That could not be saved:', errors)
        : show(res.body.error || 'Could not save.');
    }

    // Re-read rather than trusting the draft: normalisation may have deduped or
    // dropped something, and the screen must show what is stored.
    current.alerts = res.body.alerts || {};
    const a = current.alerts;
    draft = {
      recipients: Array.isArray(a.recipients) ? [...a.recipients] : [],
      cc: Array.isArray(a.cc) ? [...a.cc] : [],
      enabled: a.enabled !== false,
      inherited: false,
    };
    render();
    renderRouting(res.body.effective);
    show('Saved. This takes effect immediately — no redeploy needed.', 'ok');
  }

  async function sendTest() {
    const to = draft.recipients[0];
    if (!to) return show('Add an address first — a test needs somewhere to go.', 'warn');

    $('test').disabled = true;
    show(`Sending a test message to ${to}…`, 'warn');
    const res = await api('/api/test-alert?to=' + encodeURIComponent(to));
    $('test').disabled = false;
    if (!res) return;

    if (!res.ok) return show(res.body.error || 'The test message could not be sent.');
    show(`Test message sent to ${to}. If it does not arrive, check the spam folder before anything else.`, 'ok');
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  $('station-picker').addEventListener('change', (e) => selectStation(e.target.value));

  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addFrom($('add-input'), draft.recipients);
  });
  $('add-cc-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addFrom($('add-cc-input'), draft.cc);
  });

  // Delegated, because the rows are re-rendered on every change.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-list]');
    if (!btn) return;
    const list = btn.dataset.list === 'cc' ? draft.cc : draft.recipients;
    list.splice(Number(btn.dataset.i), 1);
    clearMsg();
    render();
  });

  $('save').addEventListener('click', save);
  $('test').addEventListener('click', sendTest);
  $('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  loadStations();
})();
