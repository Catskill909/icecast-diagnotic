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
        `The check asks each channel's highest-bitrate mount. Its other bitrates are
         checked less often — every fifth cycle — which is enough to catch one that has
         stopped serving without opening a connection to every mount every minute.
         Each connection both pulls audio from the station's own server and registers
         as a listener on that mount, so they are not spent freely.`,
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
        `A <strong>degraded channel</strong> — still playing, but missing one of its
         bitrates — emails only if the fault lasts <em>and</em> people were listening on
         the mount that failed. The message says DEGRADED, never DOWN: describing a
         playing channel as offline is the most damaging thing an alert can get wrong.`,
      ],
      note: `This assigns the side to investigate. It does not prove which physical
             device failed.`,
    },
    {
      id: 'impact',
      icon: 'group',
      title: 'Who lost audio',
      lead: 'What an interruption cost, in people rather than minutes.',
      body: [
        `A channel is usually served at several bitrates, each its own Icecast mount.
         Listener counts add them together, because they are one audience.`,
        `<strong>Listeners cut off</strong> is the audience present when each
         interruption began; someone affected twice counts twice.
         <strong>Listening lost</strong> combines that reach with duration — fifty
         people missing an hour is fifty listener-hours. It is not a clock duration.`,
        `<strong>Audio uptime</strong> excludes probe failures where Icecast proves
         the mount kept playing — so it reflects what the audience experienced, not
         what our connection did.`,
        `These figures are frozen when a fault ends, not calculated later. Icecast only
         reports listeners while a mount exists, so once an outage is over the audience
         it interrupted can never be recovered from anywhere.`,
      ],
    },
    {
      id: 'audience',
      icon: 'groups',
      title: 'The Audience page',
      lead: 'How many people are listening — the reach figures, not the server ones.',
      body: [
        `<strong>Total listeners</strong> leads the page, and it is the number to quote
         in a pledge drive, a grant application or an underwriting pitch. It counts how
         many times someone tuned in: every rise in the listener count is somebody
         starting to listen. On this station it runs roughly four to nine times higher
         than the number listening at once.`,
        `That gap is the whole point. Reporting "178 listeners" when 178 is the
         <em>simultaneous</em> figure understates the station by an order of magnitude,
         to exactly the people whose funding decisions depend on it.`,
        `Total listeners is a <strong>floor</strong>. Within a single check, one person
         leaving as another arrives cancels out and cannot be seen, so the real number is
         higher — never lower. Where an earlier period was recorded incompletely, the
         comparison is withheld rather than shown as a percentage that would be an
         artefact of the missing data.`,
        `<strong>Total individual listeners</strong> is the companion figure: how many
         different <em>people</em>, rather than how many tune-ins. Someone who listens
         ten times is ten total listeners and one individual listener. Telling one
         listener from another needs admin access to the streaming server, so the card is
         shown as unavailable rather than filled in with a number that would mean
         something else.`,
        `<strong>At once</strong> is the most people connected at a single moment, every
         channel summed — a fact about server load rather than reach.
         <strong>Typically</strong> is the average. Both are kept, ranked below the reach
         figures.`,
        `Below that: every channel on one shared scale, a day-by-day table, the split
         <strong>by mount</strong> showing which bitrate carries the audience, and an
         hour-of-day profile. Every period is compared against the <em>same elapsed
         span</em> of the one before, so nine days of this month are measured against the
         first nine days of last month rather than all thirty-one. <strong>Export
         CSV</strong> downloads exactly what is on screen.`,
      ],
    },
    {
      id: 'royalties',
      icon: 'hourglass_top',
      title: 'Listening hours and royalties',
      lead: 'The figure a US noncommercial station\'s SoundExchange rate is computed from.',
      body: [
        `<strong>ATH</strong> — aggregate tuning hours — is one person listening for one
         hour. The annual noncommercial fee covers each channel's first 159,140 ATH per
         month; above that, more is owed. The Audience page tracks the month to date
         against that allowance and projects where the month will land.`,
        `A projection is rated over the span actually <em>watched</em>, not the elapsed
         month, so a monitor that started mid-month does not project two-thirds too low
         on the one number with a threshold attached.`,
        `<strong>It is an estimate.</strong> It is counted by polling listeners once a
         minute, not by logging every connection. Use it as an early warning — if it says
         you are approaching the allowance, go and get the real figure before filing
         anything.`,
      ],
    },
    {
      id: 'degraded',
      icon: 'signal_cellular_alt_2_bar',
      title: 'Degraded channels',
      lead: 'Still playing, but not on every mount it publishes.',
      body: [
        `A channel is published at several bitrates, each its own Icecast mount, and the
         health check only asks the highest one. So a single bitrate can stop while the
         card still reads ONLINE and the listeners on that bitrate are off the air.`,
        `Each channel's card lists every mount it publishes, with that mount's own
         listener count. A failing one turns amber: <strong>struck through</strong> if
         Icecast has stopped listing it at all, <strong>underlined</strong> if it is
         still listed but serving no audio.`,
        `A degradation is recorded as its own incident and is deliberately
         <em>not</em> counted as downtime — the channel never went off air. You are
         emailed about one only if it lasts (thirty minutes by default) <em>and</em>
         people were listening on the mount that failed.`,
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
        <span class="guide-count">
          ${index + 1} of ${TOPICS.length}
          <span class="guide-keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd></span>
        </span>
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
    // Clicking the backdrop closes; clicking the card must not.
    $('help-modal').addEventListener('click', (e) => { if (e.target === $('help-modal')) close(); });
    renderNav();
  });
})();
