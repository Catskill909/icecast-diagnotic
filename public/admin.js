/* Station administration.
 *
 * External file, not inline: the Content-Security-Policy is script-src 'self'
 * with no 'unsafe-inline', so an injected <script> does not execute. Putting
 * this back inside the page would require weakening that.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  let discovered = null;
  // The station list as last loaded. Discovery needs the FULL station — its
  // channels, not just its name — to hand a channel over to its editor.
  let knownStations = [];

  /** Mirrors discover.deriveChannelId() on the server. Keep the two identical. */
  function deriveChannelId(stationId, channelId) {
    const c = String(channelId || 'channel');
    const st = String(stationId || '');
    return (c === st || c.startsWith(st + '-') ? c : `${st}-${c}`).slice(0, 64);
  }

  // Comfortably above the server's own budget for the same request, so a server
  // that IS answering is never cut off by the client sitting in front of it.
  const DISCOVER_TIMEOUT_MS = 45000;

  /** Escapes for text AND attribute contexts — quotes included. */
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * What actually went wrong, in words an operator can report.
   *
   * "Could not save." was the whole message for every failure mode — a rejected
   * address, a server exception, a dropped connection, a proxy timeout. It named
   * no cause and could not be diagnosed from either end. Anything a person might
   * have to relay down a phone line has to say more than that.
   */
  function failureText(res, verb = 'save') {
    if (!res) return `Could not ${verb} — the session ended. Sign in and try again.`;
    if (res.status === 0) {
      return `Could not ${verb} — the server could not be reached. Check the connection and try again.`;
    }
    if (res.body && res.body.error) return res.body.error;
    if (res.body && res.body._text) {
      const text = String(res.body._text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return `Could not ${verb} (HTTP ${res.status}): ${text.slice(0, 200) || 'the server returned no explanation'}`;
    }
    return `Could not ${verb} — the server replied HTTP ${res.status}.`;
  }

  function show(el, text, kind) {
    el.className = 'msg ' + (kind || 'err');
    el.textContent = text;
  }
  // The intro is a parameter because this now reports failures from three
  // different actions. Hardcoded, it told someone fixing a mistyped recipient
  // that their station could not be added.
  function showList(el, items, intro = 'Could not add this station:', kind) {
    el.className = 'msg ' + (kind || 'err');
    el.innerHTML = `<strong>${esc(intro)}</strong><ul>` +
      items.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>';
  }
  const clear = (el) => { el.className = 'msg'; el.textContent = ''; };

  /**
   * Fetch with a ceiling.
   *
   * A request with no client-side limit is indistinguishable from a frozen page:
   * discovery reaches a server the operator chose, and an unreachable one used
   * to leave "Looking…" on screen with nothing behind it. The server now bounds
   * its own work, so this is the backstop for the network in between.
   */
  async function api(path, options, timeoutMs) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl && timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(path, ctl ? { ...options, signal: ctl.signal } : options);
    } catch (err) {
      // An abort is the timeout above; anything else is the network itself.
      if (err && err.name === 'AbortError') return { ok: false, status: 0, timedOut: true, body: {} };
      return { ok: false, status: 0, body: {} };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 401) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return null; }
    // A non-JSON response is kept as text rather than discarded. Swallowing it
    // is what turned a real server error into the word "Could not save.", which
    // names no cause and cannot be diagnosed from either end.
    const raw = await res.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _text: raw }; }
    return { ok: res.ok, status: res.status, body };
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
    knownStations = stations;
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
            <button class="mini" data-alerts="${esc(s.id)}">Alerts</button>
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
        <div class="station-editor hidden" data-alertbox="${esc(s.id)}"></div>
      </div>`).join('') || '<div class="hint">No stations configured.</div>';

    host.querySelectorAll('[data-alerts]').forEach((b) =>
      b.addEventListener('click', () => openAlerts(stations.find((s) => s.id === b.dataset.alerts))));
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
    btn.disabled = true;

    // A counting label, not a static one. "Looking…" that never changes is how a
    // slow-but-working request and a dead one look identical, and the only
    // difference that matters to the person waiting is whether to keep waiting.
    const startedAt = Date.now();
    btn.textContent = 'Looking…';
    const tick = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      btn.textContent = `Looking… ${secs}s`;
      if (secs === 5) {
        show($('discover-msg'), 'Still waiting on that server — it has not answered yet.', 'warn');
      }
    }, 1000);

    let r;
    try {
      r = await api('/api/stations/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: $('url').value.trim() }),
      }, DISCOVER_TIMEOUT_MS);
    } finally {
      clearInterval(tick);
      btn.disabled = false; btn.textContent = 'Discover';
    }

    if (!r) return;
    if (r.timedOut) {
      show($('discover-msg'),
           `That address did not answer within ${Math.round(DISCOVER_TIMEOUT_MS / 1000)} seconds. ` +
           'Check the host and port, and whether that port really speaks HTTPS.', 'err');
      return;
    }
    if (!r.ok) {
      const detail = r.body.triedBothSchemes
        ? ' Both http and https were tried on that port.'
        : '';
      show($('discover-msg'), (r.body.error || 'Could not read that address.') + detail,
           r.status === 502 ? 'warn' : 'err');
      return;
    }

    // A corrected scheme is reported, never applied quietly: https -> http is a
    // real downgrade, and it is the scheme every future probe of this station
    // will use.
    if (r.body.schemeCorrected) {
      const { from, to } = r.body.schemeCorrected;
      show($('discover-msg'),
           `That server does not answer over ${from} on this port — ${to} worked, ` +
           `so this station will be monitored over ${to}.`, 'warn');
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
    // The server decides this, beside the classification that produces `mine`
    // and `others` — see discover.js. Re-deriving it here from `sharedHost` is
    // what pre-ticked another station's stream into WBAI.
    const preTicked = (c) => (c.proposed !== undefined ? c.proposed : (c.matched || !d.sharedHost));
    const row = (c, i) => `
      <label class="ch${c.matched ? ' matched' : ''}">
        <input type="checkbox" data-i="${i}" ${preTicked(c) ? 'checked' : ''}>
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
    // `discovered.identityNote` is deliberately NOT rendered.
    //
    // When a station is already monitored on another server the identifier is
    // de-conflicted automatically — that is the feature working, not a problem
    // to report. Announcing it in a warning-coloured box said "something went
    // wrong" about a success, and the note itself admitted the detail does not
    // matter ("the identifier is only used internally"). If it does not matter,
    // do not put it on screen. The value is visible in the Identifier field for
    // anyone who cares, and editable.
    //
    // The server still returns the note: it is honest metadata for an API
    // consumer, and it explains the value in a log or a support conversation.
    // A suggested id is a decision, not a placeholder. Only fall back to
    // slugging the name when discovery could not work one out.
    idFixed = !!s.id;
    // The same grouped select the station EDITOR uses — US zones first, named by
    // city. This form kept a bare text input for an IANA identifier, which is
    // not something most people can produce from memory and was only validated
    // on save. Two forms asking for the same value must ask for it the same way.
    let guess = 'America/New_York';
    try { guess = Intl.DateTimeFormat().resolvedOptions().timeZone || guess; } catch { /* keep the default */ }
    $('st-tz-slot').innerHTML = timezoneSelectHtml(guess);
    renderExistingStationOffer(d);
    $('results').classList.remove('hidden');
    $('st-name').focus();
    $('st-name').select();
  }

  /**
   * A channel name that will not collide with the ones the station already has.
   *
   * Two channels of one station are told apart by WHERE they come from — being
   * on different servers is the whole reason there are two. Without this, KPFA's
   * second stream arrives named "KPFA Berkeley" onto a station named "KPFA
   * Berkeley", and the station card shows two chips nobody can tell apart.
   */
  function distinctChannelName(name, url, station) {
    const taken = new Set([
      String(station.name || '').toLowerCase(),
      ...(station.channels || []).map((c) => String(c.name || '').toLowerCase()),
    ]);
    const base = String(name || '').trim();
    if (base && !taken.has(base.toLowerCase())) return base;
    let host = '';
    try { host = new URL(url).host; } catch { /* no host to add; the name stands */ }
    return host ? `${base || station.name} (${host})` : base;
  }

  /**
   * The offer to put this stream on the station it belongs to.
   *
   * Shown INSTEAD of nothing, not instead of the form: adding a separate station
   * is still right when two stations genuinely share a call sign, so the add
   * form stays exactly where it was and this sits above it.
   *
   * This is the case that produced two "KPFA Berkeley" entries. The station id
   * collided, the server quietly renamed it to `kpfa-2`, the save succeeded, and
   * one station's audience ended up split across two pages.
   */
  function renderExistingStationOffer(d) {
    const box = $('existing-station');
    const save = $('save-btn');
    const ex = d.existingStation;

    if (!ex) {
      box.className = 'msg hidden';
      box.innerHTML = '';
      save.className = 'primary';
      save.textContent = 'Add station';
      return;
    }

    // THE SAFE ACTION BECOMES THE DEFAULT ONE.
    //
    // The first version of this left "Add station" as the big primary button
    // and put the offer in a note above it. The note was read, understood, and
    // then the primary button was pressed anyway — because that is what a
    // primary button is for. A warning that competes with a call to action
    // loses, so the duplicate got created a second time.
    //
    // Adding a separate station stays possible; it is no longer what the page
    // is inviting.
    save.className = 'ghost';
    save.textContent = 'Add as a separate station instead';

    box.className = 'msg warn';
    box.innerHTML = `
      <strong>${esc(ex.name)} is already being monitored.</strong>
      <p>This is almost certainly the same station on a second server. Adding it as its
      own station would split one station's listeners across two pages — its stream cards
      stay separate either way.</p>
      <button class="primary" type="button" data-join="${esc(ex.id)}">
        Add the ticked channel(s) to ${esc(ex.name)}
      </button>`;

    box.querySelector('[data-join]').addEventListener('click', () => {
      const station = knownStations.find((x) => x.id === ex.id);
      if (!station) { show($('save-msg'), 'That station is no longer in the list — reload the page.'); return; }

      const picked = [...document.querySelectorAll('#channels input:checked')]
        .map((cb) => discovered.channels[Number(cb.dataset.i)]);
      if (!picked.length) { show($('save-msg'), 'Tick at least one channel to add.'); return; }

      // Nothing is saved here. The channels are handed to the station's editor
      // as unsaved rows, so the operator reviews and presses Save — the same
      // path as "+ Add a channel", which is what this case always should have
      // been.
      $('results').classList.add('hidden');
      $('url').value = ''; discovered = null; idFixed = false;
      openEditor(station, picked.map((c) => ({
        name: distinctChannelName(c.name, c.url, station),
        url: c.url,
        mounts: c.mounts || [],
      })));
      document.querySelector(`[data-station="${CSS.escape(station.id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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
      station: {
        id: stationId,
        name: $('st-name').value.trim(),
        timezone: (document.querySelector('#st-tz-slot [data-f=tz]') || {}).value || 'UTC',
      },
      // Channel ids are prefixed with the station so they stay unique across
      // stations — they key this channel's history permanently.
      channels: picked.map((c) => ({
        // The SAME rule the server used when it de-conflicted the station id.
        // It lived only here once, so the server could not predict what this
        // would produce and could not tell whether it was free.
        id: deriveChannelId(stationId, c.id),
        name: c.name,
        url: c.url,
        mounts: c.mounts,
      })),
    };

    const btn = $('save-btn');
    // Restored rather than hardcoded: when this stream belongs to a station
    // already monitored the button is relabelled, and putting "Add station"
    // back would re-promote the action that creates the duplicate.
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Adding…';
    const r = await api('/api/stations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    btn.disabled = false; btn.textContent = label;
    if (!r) return;

    if (!r.ok) {
      const errs = Array.isArray(r.body.errors) ? [...r.body.errors] : [];
      // "already exists" is not a dead end — it means this belongs on the
      // station that already has that id, as another channel. Say so, because
      // the next step is a different button in a different panel.
      if (errs.some((x) => /already exists|already used by another station/i.test(x))) {
        errs.push('This looks like a station already being monitored. To add another '
          + 'stream to it, use Edit on that station below, then "+ Add a channel".');
      }
      if (errs.length) showList($('save-msg'), errs);
      else show($('save-msg'), r.body.error || 'Could not add this station.');
      return;
    }

    clear($('list-msg'));
    show($('save-msg'),
      `${r.body.station.name} added and being monitored now — ` +
      `${r.body.monitoring.added.length} channel(s), no restart needed.`, 'ok');
    $('results').classList.add('hidden');
    $('url').value = ''; discovered = null; idFixed = false;
    // Nothing from the attempt survives the success. A note left over from
    // discovery reads as a warning about the station that was just added.
    clear($('discover-msg'));
    loadStations();
  });

  // ── Alert recipients ──────────────────────────────────────────────────────
  /* Lives ON the station card rather than on a page of its own.
   *
   * It shipped first as a separate screen, on the reasoning that configuring
   * channels is technical and occasional while choosing who gets paged is
   * routine and belongs to the station. That reasoning assumed two kinds of
   * login. There is one — so it was the same person, behind the same password,
   * looking at two menus that each showed half of one station's settings.
   * A station's channels and a station's recipients are one idea: its settings.
   *
   * When per-user roles exist (build order item 12), a GM-facing screen can be
   * split back out. Splitting it BEFORE the roles that justify it only bought a
   * second navigation bar.
   */

  // Edits held per station until Save, so a half-typed address is never what
  // the monitor is running from.
  const alertDrafts = {};

  function alertsBox(id) { return document.querySelector(`[data-alertbox="${CSS.escape(id)}"]`); }

  /* A station card has two panels and they are mutually exclusive.
   *
   * Each used to toggle only itself, so Edit followed by Alerts left one card
   * showing two stacked forms with two Save buttons and nothing on screen
   * saying which saved what. */
  /* A message must describe the thing in front of you.
   *
   * The add-station form's error sits at the top of the page and was cleared
   * only by that form's own actions. Opening a station editor left it visible,
   * so a failed "add" read as though the EDIT had just failed — reported by the
   * operator, who was looking at a correct editor and a stale error together. */
  function clearAddFormMessages() {
    clear($('save-msg'));
    clear($('discover-msg'));
  }

  function closePanels(id, except) {
    for (const attr of ['data-editor', 'data-alertbox']) {
      if (attr === except) continue;
      const el = document.querySelector(`[${attr}="${CSS.escape(id)}"]`);
      if (el) el.classList.add('hidden');
    }
  }


  /** Whether mail will actually go out, in the server's words. */
  function routingHtml(routing) {
    if (!routing) return '';
    if (routing.willSend) {
      const n = routing.recipientCount;
      const cc = routing.ccCount ? `, copying ${routing.ccCount}` : '';
      return `<div class="routing on">
        <strong>Alerts are on</strong>
        <span class="why">Emailed to ${n} recipient${n === 1 ? '' : 's'}${cc}.</span></div>`;
    }
    return `<div class="routing off">
      <strong>Nothing is emailed for this station</strong>
      <span class="why">${esc(routing.reason || 'Alerts are not configured.')}
      Outages are still recorded in full — only the email is withheld.</span></div>`;
  }

  /* One list, not two.
   *
   * This panel briefly offered a separate CC list, mirroring the ALERT_CC env
   * var. To and CC is a meaningful distinction between PEOPLE — "act on this"
   * versus "for your awareness" — and it means nothing in an automated alert:
   * everyone receives the identical message, everyone can act on it, and the
   * only difference is which header the address lands on. It was a second field,
   * a second concept and a second decision buying nothing. */
  function addrRowsHtml(list, editing) {
    if (!list.length) {
      return '<div class="addr-empty">Nobody yet. Add an address below and this station\'s alerts will go to it.</div>';
    }
    return list.map((a, i) => (i === editing ? `
      <div class="addr editing">
        <input class="addr-edit" data-edit-input value="${esc(a)}" type="email"
               autocapitalize="off" autocorrect="off" spellcheck="false">
        <div class="addr-actions">
          <button class="mini" data-save-addr data-i="${i}" type="button">Save</button>
          <button class="mini" data-cancel-addr type="button">Cancel</button>
        </div>
      </div>` : `
      <div class="addr">
        <span>${esc(a)}</span>
        <div class="addr-actions">
          <button class="mini" data-edit-addr data-i="${i}" type="button">Edit</button>
          <button class="mini" data-test-addr data-i="${i}" type="button">Test</button>
          <button class="mini danger" data-drop-addr data-i="${i}" type="button">Remove</button>
        </div>
      </div>`)).join('');
  }

  function paintAlerts(id) {
    const box = alertsBox(id);
    const d = alertDrafts[id];
    if (!box || !d) return;
    box.querySelector('[data-recipients]').innerHTML = addrRowsHtml(d.recipients, d.editing);
    // Focus follows the edit, so the keyboard lands where the eye already is.
    const edit = box.querySelector('[data-edit-input]');
    if (edit) { edit.focus(); edit.select(); }
  }

  async function openAlerts(s) {
    if (!s) return;
    const box = alertsBox(s.id);
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    closePanels(s.id, 'data-alertbox');
    clearAddFormMessages();

    const a = s.alerts || {};
    // Addresses shown from the monitor-wide fallback are NOT this station's own.
    // Pre-filling them would silently copy the fallback onto the station and
    // freeze it there, so the draft starts from what the station actually has.
    alertDrafts[s.id] = {
      recipients: Array.isArray(a.recipients) ? [...a.recipients] : [],
      enabled: a.enabled !== false,
      editing: null,
    };

    box.innerHTML = `
      <div data-routing>${routingHtml(null)}</div>

      <div class="field-group">
        <label class="field-label" for="to-${esc(s.id)}">Alert recipients</label>
        <p class="field-help">Emailed when <strong>${esc(s.name)}</strong> goes off air and
           again when it recovers, and copied on its weekly report. Nobody else is
           emailed about this station, and this station's alerts go nowhere else.</p>
        <div class="addr-list" data-recipients></div>
        <div class="add-row">
          <input id="to-${esc(s.id)}" data-add="to" type="email" placeholder="name@station.org"
                 autocapitalize="off" autocorrect="off" spellcheck="false">
          <button class="ghost" data-addbtn="to" type="button">Add</button>
        </div>
        <span class="note">One address, or several separated by commas.</span>
      </div>

      <label class="toggle">
        <input type="checkbox" data-enabled ${alertDrafts[s.id].enabled ? 'checked' : ''}>
        <span>Send alerts for this station
          <span class="note">Turn off while a station is being set up. Outages are
            still recorded in full — only the email is withheld.</span></span>
      </label>

      <div class="actions">
        <button class="primary" data-save-alerts="${esc(s.id)}">Save recipients</button>
        <button class="linkbtn" data-cancel-alerts="1" type="button">Close</button>
      </div>
      <div class="msg" data-msg="1"></div>`;

    box.classList.remove('hidden');
    paintAlerts(s.id);
    refreshRouting(s.id);

    const input = box.querySelector('[data-add="to"]');
    const commit = () => {
      const raw = input.value.trim();
      if (!raw) return;
      const list = alertDrafts[s.id].recipients;
      // Split here as well as on the server, so pasting three addresses shows
      // three rows now rather than one row that becomes three on save.
      for (const part of raw.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)) {
        if (!list.some((x) => x.toLowerCase() === part.toLowerCase())) list.push(part);
      }
      input.value = '';
      clear(box.querySelector('[data-msg]'));
      paintAlerts(s.id);
    };
    box.querySelector('[data-addbtn="to"]').addEventListener('click', commit);
    // Enter inside the field adds the address rather than doing nothing.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });

    /* Row actions.
     *
     * EDIT is here because "remove it and type it again" is not editing. A
     * transposed character in an address is the most likely mistake anyone makes
     * on this screen and the one with the quietest consequence — mail goes
     * nowhere and nothing reports it — so correcting it must be the cheapest
     * possible action, not a destroy-and-retype.
     *
     * TEST is the only verification this screen offers, deliberately (see
     * admin-dev.md §6.3). It proves the address works BEFORE an outage proves it
     * does not. It sends to that one address and nobody else. */
    box.addEventListener('click', async (e) => {
      const d = alertDrafts[s.id];
      const msg = box.querySelector('[data-msg]');

      const edit = e.target.closest('[data-edit-addr]');
      if (edit) {
        d.editing = Number(edit.dataset.i);
        clear(msg);
        paintAlerts(s.id);
        return;
      }

      const cancel = e.target.closest('[data-cancel-addr]');
      if (cancel) {
        d.editing = null;
        paintAlerts(s.id);
        return;
      }

      const save = e.target.closest('[data-save-addr]');
      if (save) {
        const input = box.querySelector('[data-edit-input]');
        const value = input.value.trim();
        const i = Number(save.dataset.i);
        if (!value) return show(msg, 'An address cannot be empty. Use Remove to delete it.');
        // Checked here as well as on the server so the row does not close on a
        // value the save would then reject.
        if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/.test(value)) {
          return show(msg, `"${value}" is not an email address.`);
        }
        if (d.recipients.some((a, j) => j !== i && a.toLowerCase() === value.toLowerCase())) {
          return show(msg, `${value} is already on the list.`);
        }
        d.recipients[i] = value;
        d.editing = null;
        clear(msg);
        paintAlerts(s.id);
        return;
      }

      const test = e.target.closest('[data-test-addr]');
      if (test) {
        sendTestTo(s, d.recipients[Number(test.dataset.i)]);
        return;
      }

      const drop = e.target.closest('[data-drop-addr]');
      if (drop) {
        const i = Number(drop.dataset.i);
        const addr = d.recipients[i];
        const left = d.recipients.filter((_, j) => j !== i);

        const ok = await confirmAction({
          title: `Stop alerting ${addr}?`,
          body: [
            `<strong>${esc(addr)}</strong> stops receiving <strong>${esc(s.name)}</strong>'s
             outage alerts, recovery notices and weekly report.`,
            left.length
              ? `${left.length} address${left.length === 1 ? '' : 'es'} will still be alerted.`
              : `This is the <strong>last address</strong> on this station. Nobody will be
                 told when it goes off air — outages are still recorded, but no email is sent.`,
          ],
          keep: 'Nothing changes until you press <strong>Save recipients</strong> — reopening the panel puts it back.',
          confirmLabel: 'Remove address',
        });
        if (!ok) return;

        d.recipients.splice(i, 1);
        d.editing = null;
        clear(msg);
        paintAlerts(s.id);
      }
    });

    // Enter saves the row being edited, Escape abandons it.
    box.addEventListener('keydown', (e) => {
      if (!e.target.matches('[data-edit-input]')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        box.querySelector('[data-save-addr]').click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        alertDrafts[s.id].editing = null;
        paintAlerts(s.id);
      }
    });

    box.querySelector('[data-cancel-alerts]').addEventListener('click', () => box.classList.add('hidden'));
    box.querySelector('[data-save-alerts]').addEventListener('click', () => saveAlerts(s));
  }

  /** Re-asks the server what it would actually do now. */
  async function refreshRouting(id) {
    const res = await api(`/api/stations/${encodeURIComponent(id)}/alerts/preview`);
    const box = alertsBox(id);
    if (!res || !res.ok || !box) return;
    const slot = box.querySelector('[data-routing]');
    if (slot) slot.innerHTML = routingHtml(res.body.effective);
  }

  async function saveAlerts(s) {
    const box = alertsBox(s.id);
    const msg = box.querySelector('[data-msg]');
    clear(msg);
    const d = alertDrafts[s.id];

    const res = await api(`/api/stations/${encodeURIComponent(s.id)}/alerts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // `cc` is deliberately NOT sent. The panel does not edit it, and an
      // omitted field is left unchanged by the server — sending an empty array
      // would silently clear a CC list configured elsewhere.
      body: JSON.stringify({
        recipients: d.recipients,
        enabled: box.querySelector('[data-enabled]').checked,
      }),
    });
    if (!res) return;
    if (!res.ok) {
      const errors = res.body.errors;
      return Array.isArray(errors) && errors.length
        ? showList(msg, errors, 'That could not be saved:')
        : show(msg, failureText(res));
    }

    // Re-read rather than trusting the draft: normalisation may have deduped or
    // dropped something, and the screen must show what is actually stored.
    const saved = res.body.alerts || {};
    alertDrafts[s.id] = {
      recipients: Array.isArray(saved.recipients) ? [...saved.recipients] : [],
      enabled: saved.enabled !== false,
      editing: null,
    };
    s.alerts = saved;
    paintAlerts(s.id);
    box.querySelector('[data-routing]').innerHTML = routingHtml(res.body.effective);
    show(msg, 'Saved. This takes effect immediately — no redeploy needed.', 'ok');
  }

  /**
   * Sends one test message to one address.
   *
   * Targeted rather than "test the list", because the question being asked is
   * always about a specific address someone just typed. Testing the whole list
   * mails everyone else on it too, which turns checking a typo into spamming the
   * general manager.
   */
  async function sendTestTo(s, to) {
    const box = alertsBox(s.id);
    const msg = box.querySelector('[data-msg]');
    if (!to) return show(msg, 'Add an address first — a test needs somewhere to go.', 'warn');

    show(msg, `Sending a test message to ${to}…`, 'warn');
    // The station goes with it. Without it the server cannot tell which station
    // the test is for and falls back to showing every stream the monitor
    // watches — which is what shipped: a test for a KPFT address arrived listing
    // all four stations' listener counts.
    const res = await api(
      `/api/test-alert?to=${encodeURIComponent(to)}&stationId=${encodeURIComponent(s.id)}`,
    );
    if (!res) return;
    if (!res.ok) return show(msg, failureText(res, 'send the test message'));
    show(msg, `Test message sent to ${to} and nobody else. If it does not arrive, check the spam folder first.`, 'ok');
  }

  // ── Editing ───────────────────────────────────────────────────────────────
  /* A channel row.
   *
   * MOUNTS ARE A LIST, not a space-separated string in a text box. They were the
   * latter, which offered no way to see that it was a list, no way to remove one
   * without editing text, and no check beyond "starts with a slash". Each mount
   * is now a chip you can remove, with its own add field.
   *
   * The ID is rendered as text and never as an input. It keys every sample,
   * rollup and event for this channel: renaming it does not move that history,
   * it orphans it, and the channel silently restarts from zero while uptime is
   * computed from the empty one. A NEW channel gets an id generated from its
   * name, shown before saving so it is never a surprise. */
  /* ── Live mount inventory ───────────────────────────────────────────────── */

  /* What the station's Icecast host is serving right now, so a mount can be
   * checked BEFORE it is saved rather than discovered wrong weeks later.
   *
   * The check is free — the monitor already holds the inventory — and it opens
   * no connection. That matters: Icecast counts every connection as a listener,
   * ours included, so a real probe is something a person presses, never
   * something a form does while you type. Presence in the inventory catches the
   * typo, which is the mistake that actually happens.
   */
  const mountCache = {};

  async function loadMounts(stationId) {
    if (mountCache[stationId]) return mountCache[stationId];
    const res = await api(`/api/stations/${encodeURIComponent(stationId)}/mounts`);
    if (!res || !res.ok) return null;
    mountCache[stationId] = res.body;
    return res.body;
  }

  /** The datalist backing every mount field in one editor. */
  function mountDatalistHtml(id, inv) {
    if (!inv || !inv.available) return '';
    return `<datalist id="${esc(id)}">${
      inv.mounts.map((m) => {
        const bits = [];
        if (m.name) bits.push(m.name);
        if (m.listeners != null) bits.push(`${m.listeners} listening`);
        if (m.assignedTo) bits.push(`already on ${m.assignedTo.channelId}`);
        return `<option value="${esc(m.path)}"${bits.length ? ` label="${esc(bits.join(' · '))}"` : ''}>`;
      }).join('')
    }</datalist>`;
  }

  /* ── Timezones ──────────────────────────────────────────────────────────── */

  /* US zones first, named by the city an operator actually knows.
   *
   * This was a free-text field holding an IANA identifier. "America/Chicago" is
   * not something most people can produce from memory, a typo is only caught on
   * save, and the identifier says nothing about which offset it means —
   * Houston is Central, and nothing in the string says Houston.
   *
   * Every US station is in one of the first eight. Arizona is listed separately
   * because it does not observe daylight saving, which is exactly the kind of
   * thing that silently shifts a weekly report by an hour for half the year.
   */
  const US_ZONES = [
    ['America/New_York', 'Eastern — New York, Washington DC, Atlanta'],
    ['America/Chicago', 'Central — Chicago, Houston, New Orleans'],
    ['America/Denver', 'Mountain — Denver, Salt Lake City'],
    ['America/Phoenix', 'Mountain, no daylight saving — Phoenix, Arizona'],
    ['America/Los_Angeles', 'Pacific — Los Angeles, Seattle, San Francisco'],
    ['America/Anchorage', 'Alaska — Anchorage'],
    ['Pacific/Honolulu', 'Hawaii — Honolulu'],
    ['America/Puerto_Rico', 'Atlantic — San Juan, Puerto Rico'],
  ];

  const NEARBY_ZONES = [
    ['America/Toronto', 'Eastern — Toronto'],
    ['America/Vancouver', 'Pacific — Vancouver'],
    ['America/Mexico_City', 'Central — Mexico City'],
    ['Europe/London', 'London'],
    ['Europe/Berlin', 'Berlin, Paris, Madrid'],
    ['UTC', 'UTC — no local time'],
  ];

  /** The current offset, so a reader can sanity-check the choice at a glance. */
  function zoneOffsetLabel(tz) {
    try {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
      return name ? ` (${name})` : '';
    } catch { return ''; }
  }

  function zoneOption(value, label, current) {
    const sel = value === current ? ' selected' : '';
    return `<option value="${esc(value)}"${sel}>${esc(label)}${esc(zoneOffsetLabel(value))}</option>`;
  }

  function timezoneSelectHtml(current) {
    const listed = new Set([...US_ZONES, ...NEARBY_ZONES].map(([v]) => v));

    // Every other IANA zone, so nothing is unreachable — but below the ones a US
    // station will actually pick.
    let rest = [];
    try {
      rest = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [])
        .filter((z) => !listed.has(z));
    } catch { rest = []; }

    // A stored value that is in no list must still appear, and stay selected —
    // otherwise opening the editor silently changes the station's timezone to
    // whatever happens to be first.
    const orphan = current && !listed.has(current) && !rest.includes(current)
      ? `<option value="${esc(current)}" selected>${esc(current)}${esc(zoneOffsetLabel(current))}</option>`
      : '';

    return `
      <select data-f="tz" class="tz-select">
        ${orphan}
        <optgroup label="United States">
          ${US_ZONES.map(([v, l]) => zoneOption(v, l, current)).join('')}
        </optgroup>
        <optgroup label="Nearby and common">
          ${NEARBY_ZONES.map(([v, l]) => zoneOption(v, l, current)).join('')}
        </optgroup>
        ${rest.length ? `<optgroup label="All other timezones">
          ${rest.map((z) => zoneOption(z, z, current)).join('')}
        </optgroup>` : ''}
      </select>`;
  }

  function channelRowHtml(c, isNew) {
    return `
      <div class="edit-ch" data-cid="${esc(c.id)}"${isNew ? ' data-new="1"' : ''}>
        <div class="edit-ch-head">
          <div class="edit-ch-id" title="Permanent — it keys this channel's recorded history">
            ${esc(c.id)}${isNew ? ' <span class="tag alt">new</span>' : ''}
          </div>
          <button class="mini danger" data-drop="${esc(c.id)}" type="button">
            ${isNew ? 'Discard' : 'Drop channel'}
          </button>
        </div>
        <div class="edit-ch-fields">
          <label class="field-label sm">Name
            <input data-f="cname" value="${esc(c.name || '')}" placeholder="KPFT Main">
          </label>
          <label class="field-label sm">Stream URL
            <input data-f="curl" value="${esc(c.url || '')}" placeholder="https://streams.example.org:9000/live_128">
          </label>
        </div>
        <div class="mounts-block">
          <span class="field-label sm">Mounts</span>
          <p class="note">Every bitrate variant of this channel. Listener counts are summed across all of them.</p>
          <div class="chips" data-mounts>${mountChipsHtml(c.mounts || [])}</div>
          <div class="add-row">
            <input data-add-mount placeholder="/live_64" list="mountlist" autocapitalize="off" autocorrect="off" spellcheck="false">
            <button class="ghost" data-add-mount-btn type="button">Add mount</button>
          </div>
        </div>
      </div>`;
  }

  function mountChipsHtml(mounts) {
    if (!mounts.length) {
      return '<span class="note">No mounts listed — only the stream URL above is counted.</span>';
    }
    return mounts.map((m) => `
      <span class="chip removable">${esc(m)}<button class="chip-x" data-drop-mount="${esc(m)}"
        type="button" aria-label="Remove ${esc(m)}">×</button></span>`).join('');
  }

  /** Reads the mounts currently shown on a row. The DOM is the draft here. */
  function rowMounts(row) {
    return [...row.querySelectorAll('[data-drop-mount]')].map((b) => b.dataset.dropMount);
  }

  /* Generated from the name, never typed. An operator given a free text field
   * for an id will eventually reuse one, which attaches a new channel to another
   * channel's recorded history. */
  function channelIdFrom(stationId, name, taken) {
    const base = `${stationId}-${name}`.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `${stationId}-channel`;
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  /**
   * `prefill` carries channels handed over from discovery — this station's
   * stream found on a second server. They arrive as UNSAVED rows, identical to
   * pressing "+ Add a channel" and typing them, so the operator reviews the
   * names and URLs and presses Save. Nothing is written by the handover itself.
   */
  function openEditor(s, prefill) {
    if (!s) return;
    const box = document.querySelector(`[data-editor="${CSS.escape(s.id)}"]`);
    // Edit toggles; a HANDOVER always opens. Toggling here would close an
    // already-open editor and silently discard the channels being handed to it.
    if (!box.classList.contains('hidden') && !(prefill || []).length) {
      box.classList.add('hidden');
      return;
    }
    closePanels(s.id, 'data-editor');
    clearAddFormMessages();

    box.innerHTML = `
      <div class="fields">
        <label>Name<input data-f="name" value="${esc(s.name)}"></label>
        <label>Timezone
          ${timezoneSelectHtml(s.timezone || 'UTC')}
          <span class="note">Sets when this station's weekly report arrives, and the day boundaries in its figures.</span>
        </label>
      </div>
      <h3>Channels</h3>
      <p class="hint">A channel's identifier is fixed — it keys this channel's recorded history. Everything else can change.</p>
      <div class="edit-channels">
        ${(s.channels || []).map((c) => channelRowHtml(c)).join('')}
      </div>
      <div class="actions-inline">
        <button class="ghost" data-add-channel type="button">+ Add a channel</button>
      </div>
      <div class="actions">
        <button class="primary" data-save="${esc(s.id)}">Save changes</button>
        <button class="ghost" data-cancel="1" type="button">Cancel</button>
      </div>
      <div class="msg" data-msg="1"></div>
      <span data-mountlist></span>`;
    box.classList.remove('hidden');

    for (const p of prefill || []) {
      const taken = new Set([...box.querySelectorAll('.edit-ch')].map((r) => r.dataset.cid));
      box.querySelector('.edit-channels').insertAdjacentHTML('beforeend',
        channelRowHtml({
          id: channelIdFrom(s.id, p.name || 'channel', taken),
          name: p.name || '', url: p.url || '', mounts: p.mounts || [],
        }, true));
    }

    const msgEl = box.querySelector('[data-msg]');

    // Fetched once per station and cached. Feeds the autocomplete on every
    // mount field, and the check when one is added.
    loadMounts(s.id).then((inv) => {
      const slot = box.querySelector('[data-mountlist]');
      if (slot) slot.innerHTML = mountDatalistHtml('mountlist', inv);
    });

    box.addEventListener('click', async (e) => {
      // ── Remove one mount ──────────────────────────────────────────────────
      const dropMount = e.target.closest('[data-drop-mount]');
      if (dropMount) {
        const row = dropMount.closest('.edit-ch');
        const path = dropMount.dataset.dropMount;
        const chName = row.querySelector('[data-f=cname]').value.trim() || row.dataset.cid;
        const left = rowMounts(row).filter((m) => m !== path);

        // Asked for, because the consequence is invisible: the channel keeps
        // working and its listener count quietly drops by whatever that mount
        // was carrying. On this server /live_64 regularly carries a third of
        // KPFT Main's audience.
        const ok = await confirmAction({
          title: `Remove ${path} from ${chName}?`,
          body: [
            `Its listeners stop being counted toward <strong>${esc(chName)}</strong>, and
             this mount stops being checked — so it can go off air without anyone
             being told.`,
            left.length
              ? `The channel keeps ${left.length} mount${left.length === 1 ? '' : 's'}:
                 <strong>${esc(left.join(', '))}</strong>.`
              : `This is the channel's <strong>last mount</strong>. Only the stream URL
                 above will be counted.`,
          ],
          keep: 'Nothing changes until you press <strong>Save changes</strong> — Cancel puts it back.',
          confirmLabel: 'Remove mount',
        });
        if (!ok) return;

        row.querySelector('[data-mounts]').innerHTML = mountChipsHtml(left);
        clear(msgEl);
        return;
      }

      // ── Add one mount ─────────────────────────────────────────────────────
      const addMount = e.target.closest('[data-add-mount-btn]');
      if (addMount) {
        const row = addMount.closest('.edit-ch');
        const input = row.querySelector('[data-add-mount]');
        let value = input.value.trim();
        if (!value) return;
        // Accept a full URL and reduce it, because pasting the stream URL is
        // what an operator will actually do.
        try { if (/^https?:\/\//i.test(value)) value = new URL(value).pathname; } catch { /* keep as typed */ }
        if (!value.startsWith('/')) {
          return show(msgEl, `A mount is an Icecast path beginning with "/" — "${value}" is not.`);
        }
        const current = rowMounts(row);
        if (current.includes(value)) return show(msgEl, `${value} is already on this channel.`);

        // Checked against what the server is serving right now. Free, and it
        // catches the mistake that actually happens: a mistyped path saves
        // cleanly and then under-reports the channel's audience for ever, or
        // raises a degraded alert for a mount that never existed.
        const inv = await loadMounts(s.id);

        // The inventory only covers hosts this station ALREADY has saved. A
        // channel being pointed at a new server — KPFA's own Icecast beside the
        // shared Pacifica one — is not in it yet, and checking a mount against
        // the wrong server's inventory would report every one of them missing
        // while naming a host the operator did not type.
        let rowHost = null;
        try { rowHost = new URL(row.querySelector('[data-f=curl]').value.trim()).host; } catch { /* incomplete URL */ }
        const hostKnown = !!inv && inv.available && !!rowHost
          && (inv.hosts || []).includes(rowHost);

        const found = hostKnown ? inv.mounts.find((m) => m.path === value) : null;

        if (inv && inv.available && rowHost && !hostKnown) {
          // Honest about which it is: unverifiable, not absent.
          show(msgEl,
            `${value} added. It is on ${rowHost}, which is not monitored yet — `
            + 'save the channel and reopen this editor to check it against that server.',
            'warn');
          row.querySelector('[data-mounts]').innerHTML = mountChipsHtml([...current, value]);
          input.value = '';
          return;
        }

        if (hostKnown && !found) {
          const ok = await confirmAction({
            title: `${value} is not being served right now`,
            body: [
              `The Icecast server at <strong>${esc(rowHost || 'this host')}</strong>
               is not currently publishing this mount.`,
              `That usually means a typo. It can also mean a mount whose source is
               temporarily disconnected — which is real, and worth monitoring.`,
            ],
            keep: inv.mounts.length
              ? `Currently served: <strong>${esc(inv.mounts.slice(0, 12).map((m) => m.path).join(', '))}</strong>`
              : 'The server is publishing no mounts at all right now.',
            confirmLabel: 'Add it anyway',
            icon: '?',
          });
          if (!ok) { input.focus(); input.select(); return; }
        }

        if (found && found.assignedTo && found.assignedTo.channelId !== row.dataset.cid) {
          const ok = await confirmAction({
            title: `${value} is already on another channel`,
            body: [
              `It belongs to <strong>${esc(found.assignedTo.channelId)}</strong>. A mount on two
               channels has its listeners counted twice, in both channels' figures.`,
            ],
            keep: 'Remove it from the other channel if it should only be counted once.',
            confirmLabel: 'Add it anyway',
            icon: '?',
          });
          if (!ok) { input.focus(); input.select(); return; }
        }

        row.querySelector('[data-mounts]').innerHTML = mountChipsHtml([...current, value]);
        input.value = '';
        if (found) {
          show(msgEl, `${value} added — the server is serving it${
            found.listeners != null ? ` to ${found.listeners} listener${found.listeners === 1 ? '' : 's'}` : ''
          } right now.`, 'ok');
        } else {
          clear(msgEl);
        }
        return;
      }

      // ── Add a channel ─────────────────────────────────────────────────────
      const addChannel = e.target.closest('[data-add-channel]');
      if (addChannel) {
        const taken = new Set([...box.querySelectorAll('.edit-ch')].map((r) => r.dataset.cid));
        // Named provisionally; the id follows the name the operator types, and
        // is regenerated on save while it is still new.
        const id = channelIdFrom(s.id, 'channel', taken);
        box.querySelector('.edit-channels').insertAdjacentHTML('beforeend',
          channelRowHtml({ id, name: '', url: '', mounts: [] }, true));
        box.querySelector('.edit-ch[data-new] [data-f=cname]')?.focus();
        clear(msgEl);
        return;
      }

      // ── Drop a channel ────────────────────────────────────────────────────
      const b = e.target.closest('[data-drop]');
      if (!b) return;
      const row = b.closest('.edit-ch');

      // A channel added in this session has no history to warn about, so
      // discarding one is not a decision worth a dialog.
      if (row.dataset.new) { row.remove(); clear(msgEl); return; }

      if (box.querySelectorAll('.edit-ch').length < 2) {
        show(msgEl, 'A station must keep at least one channel.');
        return;
      }
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
    });

    // Enter in a mount field adds it rather than submitting nothing.
    box.addEventListener('keydown', (e) => {
      if (!e.target.matches('[data-add-mount]')) return;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.target.closest('.edit-ch').querySelector('[data-add-mount-btn]').click();
    });
    box.querySelector('[data-cancel]').addEventListener('click', () => box.classList.add('hidden'));
    box.querySelector('[data-save]').addEventListener('click', () => saveEdit(s.id, box));
  }

  async function saveEdit(id, box) {
    const msg = box.querySelector('[data-msg]');
    clear(msg);
    const taken = new Set([...box.querySelectorAll('.edit-ch')]
      .filter((r) => !r.dataset.new).map((r) => r.dataset.cid));

    const channels = [...box.querySelectorAll('.edit-ch')].map((row) => {
      const name = row.querySelector('[data-f=cname]').value.trim();
      // An EXISTING channel's id is read from the row and never from an input —
      // it keys this channel's whole recorded history. A NEW one gets its id
      // from the name at the moment of saving, so the id matches the name the
      // operator finally settled on rather than the placeholder it started with.
      const cid = row.dataset.new ? channelIdFrom(id, name || 'channel', taken) : row.dataset.cid;
      if (row.dataset.new) taken.add(cid);
      return {
        id: cid,
        name,
        url: row.querySelector('[data-f=curl]').value.trim(),
        mounts: rowMounts(row),
      };
    });
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
