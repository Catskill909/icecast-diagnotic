/* In-app guide.
 *
 * The content is unchanged in substance — it was good — but it used to arrive as
 * eight dense sections stacked in one scrolling box, which made none of it
 * readable. It is now one topic at a time with room around it.
 *
 * A separate file because the Content-Security-Policy forbids inline script.
 */
(() => {
  const TOPICS = [
    {
      id: 'diagnosis',
      icon: 'troubleshoot',
      title: 'It tells you which end broke',
      lead: 'This is the point of the tool. A dropout is not just reported — it is diagnosed.',
      body: [
        `Every check compares the stream against Icecast's live mount inventory and
         against the other streams being watched, so an alert names a cause instead
         of leaving you to guess who to call.`,
      ],
      cases: [
        {
          kind: 'studio',
          icon: '🎙️',
          title: 'Studio side — the source encoder',
          text: `The mount returns 404 and has vanished from Icecast's inventory, while the
                 server keeps serving every other station normally. The encoder has dropped
                 its connection. Everyone listening is cut off, and the audience takes a
                 long time to rebuild.`,
        },
        {
          kind: 'server',
          icon: '🖥️',
          title: 'Server side — Icecast',
          text: `The connection is reset or refused, often on several streams in the same
                 second. People already listening are usually unaffected, but new listeners
                 cannot start playback during the window.`,
        },
      ],
    },
    {
      id: 'checks',
      icon: 'cell_tower',
      title: 'What gets checked, and how often',
      lead: 'Every monitored channel, every 60 seconds.',
      body: [
        `Each check records HTTP status, content type, and a full
         DNS → TCP → TLS → first byte timing breakdown — which is what reveals
         <em>where</em> in the chain a failure happened rather than merely that one did.`,
        `Press play on any stream card to confirm by ear what the monitor is reporting.`,
      ],
    },
    {
      id: 'outage',
      icon: 'bolt',
      title: 'What counts as an outage',
      lead: 'Two consecutive failed checks confirm one.',
      body: [
        `A failure that clears sooner is recorded as one of two things, and the
         distinction matters:`,
      ],
      cases: [
        {
          kind: 'studio', icon: '🔴', title: 'Brief outage',
          text: `The mount vanished and listeners were genuinely cut off — it simply
                 recovered before the second check.`,
        },
        {
          kind: 'server', icon: '⚪', title: 'Probe anomaly',
          text: `Icecast kept serving the mount throughout. Only this monitor's own
                 connection failed, and no listener noticed.`,
        },
      ],
      after: `Both stay in the long-term record. Neither is deleted for being minor.`,
    },
    {
      id: 'silence',
      icon: 'volume_off',
      title: 'Silence and dead air',
      lead: 'The stream is connected, and playing nothing.',
      body: [
        `This is the failure a status check cannot see: everything reports healthy
         while the audience hears nothing.`,
        `To avoid false alarms during ordinary speech pauses, suspected silence
         triggers re-probes every 5 seconds, and any detected audio instantly resets
         the count. Dead air is declared only after 3 consecutive silent probes.`,
      ],
    },
    {
      id: 'alerts',
      icon: 'mail',
      title: 'When you get an email',
      lead: 'Only when listeners were actually affected.',
      body: [
        `This is the rule that makes the alerts worth reading. A failed probe proves
         only that <em>our</em> connection broke. Icecast is the witness: if it stayed
         reachable and kept serving the mount, nobody lost audio, and no email is sent.`,
        `After the confirmation threshold, an outage emails when listeners were cut
         off — or when Icecast itself was unreachable and impact could not be ruled
         out. Simultaneous failures across channels are correlated and consolidated
         into one message rather than several.`,
        `Alerts lead with the root cause, the listener reach, and specific things to
         check. Every event records whether its alert actually sent.`,
      ],
      note: `This assigns the side to investigate. It does not prove which physical
             device failed.`,
    },
    {
      id: 'impact',
      icon: 'group',
      title: 'Listener impact',
      lead: 'Counts come straight from Icecast, summed across a channel.',
      body: [
        `A channel is usually served at several bitrates, each its own Icecast mount.
         Listener counts add them together, because they are one audience.`,
        `<strong>Listeners cut off</strong> is the audience present when each
         interruption began; someone affected twice counts twice.
         <strong>Listening lost</strong> combines that reach with duration.`,
        `<strong>Audio uptime</strong> excludes probe failures where Icecast proves
         the mount kept playing — so it reflects what the audience experienced, not
         what our connection did.`,
      ],
    },
    {
      id: 'history',
      icon: 'history',
      title: 'The long-term record',
      lead: 'Nothing is pruned by age.',
      body: [
        `Incidents are kept permanently — not for 24 hours, not for 30 days. The
         newest 100,000 events are retained as a memory-safety limit, which is
         roughly eight years at the current rate.`,
        `Open <strong>History</strong> for filters, an outage heatmap, root-cause
         breakdowns, listener-impact reporting, and the evidence behind every single
         event.`,
      ],
    },
    {
      id: 'roundup',
      icon: 'summarize',
      title: 'The weekly roundup',
      lead: 'It arrives even when nothing broke.',
      body: [
        `A scheduled weekly report covering audio uptime, listener impact, downtime,
         which side the faults sat on, and whether alerts were delivered.`,
        `Sending it after a quiet week is deliberate: it is the only message that
         proves monitoring is still running. Silence from a monitor is ambiguous —
         a quiet week and a dead monitor look identical from the inbox.`,
      ],
    },
  ];

  const $ = (id) => document.getElementById(id);
  let index = 0;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function renderNav() {
    $('guide-nav').innerHTML = TOPICS.map((t, i) => `
      <button class="guide-tab${i === index ? ' active' : ''}" data-i="${i}">
        <span class="material-symbols-outlined">${esc(t.icon)}</span>
        <span class="guide-tab-label">${esc(t.title)}</span>
      </button>`).join('');
    $('guide-nav').querySelectorAll('[data-i]').forEach((b) =>
      b.addEventListener('click', () => go(Number(b.dataset.i))));
  }

  function renderTopic() {
    const t = TOPICS[index];
    // Body strings carry intentional inline markup (<em>, <strong>) written here
    // in this file — they are not user input, and nothing external reaches them.
    $('guide-content').innerHTML = `
      <div class="guide-topic">
        <span class="material-symbols-outlined guide-topic-icon">${esc(t.icon)}</span>
        <h3>${esc(t.title)}</h3>
        <p class="guide-lead">${esc(t.lead)}</p>
        ${(t.body || []).map((p) => `<p>${p}</p>`).join('')}
        ${(t.cases || []).length ? `<div class="guide-cases">${t.cases.map((c) => `
          <div class="guide-case ${esc(c.kind)}">
            <div class="guide-case-title">${esc(c.icon)} ${esc(c.title)}</div>
            <p>${c.text}</p>
          </div>`).join('')}</div>` : ''}
        ${t.after ? `<p>${t.after}</p>` : ''}
        ${t.note ? `<p class="guide-note">${t.note}</p>` : ''}
      </div>
      <div class="guide-stepper">
        <button class="guide-step" id="guide-prev" ${index === 0 ? 'disabled' : ''}>← Previous</button>
        <span class="guide-count">${index + 1} of ${TOPICS.length}</span>
        <button class="guide-step" id="guide-next" ${index === TOPICS.length - 1 ? 'disabled' : ''}>Next →</button>
      </div>`;
    $('guide-prev').addEventListener('click', () => go(index - 1));
    $('guide-next').addEventListener('click', () => go(index + 1));
    $('guide-content').scrollTop = 0;
  }

  function go(i) {
    if (i < 0 || i >= TOPICS.length) return;
    index = i;
    renderNav();
    renderTopic();
    $('guide-content').focus({ preventScroll: true });
  }

  function open() {
    $('help-modal').style.display = 'flex';
    go(index);
    document.addEventListener('keydown', onKey);
  }
  function close() {
    $('help-modal').style.display = 'none';
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('help-btn');
    if (btn) btn.addEventListener('click', open);
    $('guide-close').addEventListener('click', close);
    $('guide-done').addEventListener('click', close);
    // Clicking the backdrop closes; clicking the card must not.
    $('help-modal').addEventListener('click', (e) => { if (e.target === $('help-modal')) close(); });
    renderNav();
  });
})();
