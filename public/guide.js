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
      id: 'structure',
      icon: 'account_tree',
      title: 'Stations, channels and mounts',
      lead: 'Three levels. Which one a thing belongs to decides where you see it.',
      body: [
        `A <strong>mount</strong> is one address on an Icecast server, usually one
         bitrate. KPFA's direct server carries seven of them for a single programme.
         Listener counts are summed across all of a channel's mounts, because somebody
         on the 24k stream is still somebody listening.`,
        `A <strong>channel</strong> is one stream as a listener thinks of it, and it is
         what each dashboard card watches. Every channel is checked on its own, so it
         keeps its own card, its own uptime bar and its own alert history.`,
        `A <strong>station</strong> groups channels. It decides who receives the emails,
         which timezone its weekly report is written in, and what the Audience page adds
         together when you pick it from the dropdown. It does <em>not</em> merge the
         dashboard cards.`,
        `That distinction matters most when one station is carried on two servers — a
         network relay and the station's own Icecast. That is <strong>one station with
         two channels</strong>: watched separately on the dashboard, counted together on
         the Audience page. When you paste a URL belonging to a station already being
         watched, the panel offers to add it as a channel rather than creating a second
         station with the same name.`,
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
        `Press play on any stream card to confirm by ear what the monitor is reporting,
         or click one of the mount chips to hear that bitrate specifically. Your
         preview is a listener like any other: it appears in that mount's own count
         while it plays.`,
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
      lead: 'Only when listeners were affected — and never twice for the same fault.',
      body: [
        `This is the rule that makes the alerts worth reading. A failed probe proves
         only that <em>our</em> connection broke. Icecast is the witness: if it stayed
         reachable and kept serving the mount, nobody lost audio, and no email is sent.`,
        `After the confirmation threshold, an outage emails when listeners were cut
         off — or when Icecast itself was unreachable and impact could not be ruled
         out. Simultaneous failures across channels are correlated and consolidated
         into one message rather than several — but never across two stations. A
         station only ever hears about its own channels.`,
        `<strong>Each station has its own list of addresses</strong>, set with the
         Alerts button on its card in the admin panel. That one list receives
         everything the station sends — outage alerts, recovery notices and its
         weekly report. A station with nobody on its list emails nobody.`,
        `Switching a station off there stops its email without stopping its
         monitoring: the outages are still recorded in full, still diagnosed, and
         still appear on every page — <strong>and so is every recovery</strong>, so
         a muted station's history still shows what came back and when.`,
        `<strong>A fault that keeps repeating gets one alert, not one per flap.</strong>
         A source encoder that drops and reconnects every few minutes produces a
         genuine outage each time, and left alone would fill the mailbox with
         them — the sixth message says nothing the first did not. So the second
         failure within 45 minutes marks the channel <strong>UNSTABLE</strong>,
         says so, and pauses further alerts for it. Everything carries on being
         recorded and diagnosed; only the mail stops. When the channel has stayed
         on air for 30 minutes, one summary arrives with the totals — how many
         outages, how long off air, and what it cost in listeners — and normal
         alerting resumes. The first outage is never held back.`,
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
        `<strong>Came back</strong> and <strong>First time</strong> split that audience by
         whether each person was also here in the period before. They are separate numbers
         because they answer different questions \u2014 <em>retention</em> and
         <em>growth</em> \u2014 and a station acts on them differently. A single
         percentage would hide the second: a month can keep every regular and reach nobody
         new, and the share goes <em>up</em>.`,
        `<strong>The ranked lists show the busiest first, and say what they left
         out.</strong> Player/app, platform, metro and country each show a top few,
         and the last row counts everything below it \u2014 "3 more". So the numbers
         in a list always add up to the total above it, and a player you expected to
         see is either on the list or inside that last row, never simply absent.
         <strong>Those entries are listed underneath it</strong>, and clicking the row
         folds them away when you want the shape of the list back.`,
        `<strong>The line is drawn at one per cent, not at a fixed number of rows.</strong>
         Anything accounting for at least 1% of listeners is on the page, so a station
         with three players shows three and offers nothing to expand, while a station
         with twenty meaningful ones shows twenty. What is left over is named for the
         reason it was left over &mdash; "15 more, each under 1%" &mdash; which answers
         the question worth asking: is there anything in there I should have seen?`,
        `<strong>Session length</strong> is the engagement half of the story: reach says
         how many people you got, this says whether they stayed. A station can grow its
         audience and lose engagement at the same time, and the two figures side by side
         are what shows it.`,
        `<strong>Each listener is counted once, at their longest session in the
         period.</strong> Somebody who listens every day is one row here, not seven. That
         matters more than it sounds: the streaming server is asked every few minutes who
         is connected, so a six-hour listener appears in seventy-odd of those answers and
         a two-minute one in barely any. Adding up what each check sees would report an
         audience that stays far longer than it really does. Listeners the server gave no
         connection time for are left out rather than counted as short.`,
        `<strong>When each region listens</strong> answers the daypart question: does
         the New York audience arrive at the same hour as the Los Angeles one? Each row
         is one region across the 24 hours of a day, and the hours are the
         <strong>station's own</strong> \u2014 a programme airs on the station's clock,
         so that is what a daypart is read against. Selecting all stations reports UTC,
         because a selection spanning three time zones has no single local hour.`,
        `<strong>Each row is shaded against its own busiest hour, not the biggest
         region's.</strong> On one shared scale the home state fills every row and
         everywhere else renders as an empty strip \u2014 which answers "who is
         biggest", something the map already tells you, and hides the question this
         panel exists for. The count beside each row is the size; the shading is the
         shape.`,
        `<strong>It measures when listening happens, not how many people.</strong>
         Somebody listening from seven until nine is counted in both hours, which is
         what makes it a picture of demand across the day. It is not a headcount and
         the hours must not be added together into one.`,
        `<strong>This one could not be worked out after the fact.</strong> Detailed
         listener records are kept for about two days and then compacted, and once that
         happens the hour is gone \u2014 a listener belongs to a day and nothing
         finer. So the hour-of-day figures are set down while the detail still exists,
         and the record begins the day that started. Two days of history could not have
         answered this honestly in any case: a weekend and a Tuesday are different
         stations, and a profile built from whichever two days happened to be in range
         could be wrong by half.`,
        `<strong>How they listen, over time</strong> is the same device mix shown as a
         series rather than as today's snapshot \u2014 the form a platform decision is
         actually made from. It groups by KIND of device, not by individual player,
         because "smart speakers went from 8% to 22%" is a sentence somebody can act on
         and "Sonos 4%, Alexa 3%, Chromecast 1%" is not. The line above the bars names
         the category that MOVED most, which is rarely the biggest one: the largest
         category is usually the least interesting news.`,
        `Two things that panel deliberately will not do. It <strong>ignores the period
         still running</strong> \u2014 today, or this month \u2014 because a period
         measured so far always looks smaller than the finished ones beside it, and the
         last bar falling off a cliff is the most convincing wrong chart this page could
         draw. And it <strong>will not draw a trend from fewer than three finished
         periods</strong>; it says so instead.`,
        `<strong>The bars get wider on longer ranges, and that is the data speaking.</strong>
         Listener records are kept in full detail for days and then compacted into
         calendar months. Once a range reaches that older material the chart switches to
         monthly bars, because a month's worth of listening carries the month's start as
         its date \u2014 drawn by day, a year of history would appear as twelve enormous
         spikes on the 1st of each month and nothing in between.`,
        `<strong>"Came back" is a floor.</strong> One listener is told from another by
         their connection, so somebody whose address changed between the two periods
         \u2014 most mobile listening, and plenty of home connections \u2014 reads as a
         new person. Real loyalty is therefore higher than the figure shown, never lower.`,
        `<strong>Both are blank unless the earlier period was also recorded</strong>, and
         the card says which reason. This matters more than it sounds: if the monitor was
         not running through the previous period, the people who listened then are not in
         the record, so every one of them would count as a first-time listener \u2014 a
         gap in the recording would render as a surge of new audience. The comparison is
         withheld instead, because "we could not measure it" and "nobody came back" are
         not the same sentence. It is also measured in <em>whole days</em>, so today
         joins the figure once it has finished.`,
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
      id: 'geography',
      icon: 'public',
      title: 'Where the audience is',
      lead: 'Which states people listen from \u2014 and which of the two numbers on that panel you are reading.',
      body: [
        `<strong>There are two maps, and the buttons above the panel choose between
         them.</strong> They answer different questions and their numbers are nothing
         like each other, which is the single most misread thing on the Audience page.`,
        `<strong>The range button</strong> \u2014 whatever the pills at the top of the page
         are set to \u2014 counts <em>distinct people</em> who listened over that period.
         This is the figure for a report, a board meeting or a grant application.
         <strong>Right now</strong> counts the <em>connections open this second</em>. It is
         a snapshot, and it is far smaller on purpose: a station averaging 175 listeners
         across a week, peaking at 1,060, might have 77 people connected at the moment you
         look. Neither number is wrong; they are answers to different questions.`,
        `<strong>Where people are is recorded as it happens, not remembered.</strong>
         Icecast will tell you where its listeners are <em>right now</em> and keeps no
         history of it. So the period map is built from locations this app writes down as
         it sees them, and it <strong>cannot be filled in backwards</strong>. It starts the
         day recording begins and reaches one day further back every day after that. While
         the record is shorter than the period you have selected, the panel says so and
         tells you how many people it covers. That notice disappears by itself once
         everyone in the range is accounted for \u2014 nobody has to remember to remove it.`,
        `<strong>"In [state]" is a STATE, not your signal area.</strong> A licence covers a
         metro; this counts the whole state, so it reads slightly high against the
         transmitter footprint and is labelled as a state share. The point of it is the
         other half: how much of the audience the broadcast signal never reaches, which is
         the part streaming adds.`,
        `<strong>Each station has its own state, set on its card in the admin panel.</strong>
         A station with none set shows no in-market share rather than borrowing another
         station's \u2014 a shared setting once reported WPFW's Washington audience as
         "0% in Texas", which is worse than showing nothing.`,
        `<strong>Relays and datacenters are left out of the map.</strong> A connection from
         a hosting company geolocates to the hosting company, so counting them would report
         a server farm as an audience. They are shown as excluded rather than hidden, so
         the number is visible.`,
        `<strong>The metro list is the number a licence actually covers.</strong> A
         station's licence covers a city and its surroundings, but the map counts a
         whole state \u2014 so "in Texas" includes Dallas, and reads higher than the
         audience the transmitter reaches. The metro list under the map uses the same
         denominator, so the two can be read together: <em>412 of Texas's 700 are in
         Houston</em> is the in-footprint figure, and the rest is the audience
         streaming adds.`,
        `<strong>A metro needs much better evidence than a state, so fewer listeners
         get one.</strong> Location databases report how sure they are, and an answer
         good to within 200 km is genuinely inside one state \u2014 but 200 km from
         Houston reaches Austin, so the same answer is useless for naming a city.
         Listeners whose record is precise enough for a state but not a metro stay in
         the state map and are reported as such, rather than being quietly assigned to
         the nearest city.`,
        `<strong>Some listeners are counted without a state.</strong> Location databases
         report how sure they are, and when an answer is too vague it is a regional
         centre rather than a real place \u2014 which would invent listeners somewhere
         nobody lives. Those are counted in the country total and left off the state map on
         purpose. Outside the United States the country is as far as it goes.`,
        `<strong>What is never collected:</strong> no street address, no city, no point on a
         map, and nothing about any individual. The page holds counts \u2014 "Maryland: 29"
         \u2014 and the listener's address is used for the lookup and immediately discarded.`,
      ],
    },
    {
      id: 'access',
      icon: 'key',
      title: 'What needs the server\u2019s password',
      lead: 'Some figures work on any Icecast. Others need an admin password for the server the stream lives on.',
      body: [
        `<strong>One sentence covers it.</strong> Counting <em>how many</em> people are
         listening needs nothing special. Telling <em>one listener from another</em>
         needs an admin password for the Icecast server that stream is served from.`,
        `<strong>Works on any stream, no password:</strong> listeners now, peak and
         average, the per-mount split, tune-ins, the hour-of-day profile, listening
         hours and the royalty allowance, uptime, outages, root-cause diagnosis and
         every alert. That is most of this application, and it is the whole of the
         dashboard and the history page.`,
        `<strong>Needs the admin password:</strong> individual listeners, who came back
         and who was new, which players and devices people use and how that moves over
         time, how long sessions last, and everything about where listeners are \u2014
         the map, the in-market share and the daypart profile. All of these come from
         one Icecast endpoint that lists the connections currently open, and it is
         password-protected because those connections are the audience.`,
        `<strong>The password belongs to the SERVER, not to the station</strong>, and a
         station's channels do not all have to live on the same server. On this network
         KPFA is carried both on Pacifica's shared server and on its own, so a password
         for one of them covers part of that station and not the rest. Where that
         happens the page says which channels are covered, because figures describing
         half a station would otherwise read as the whole of it.`,
        `<strong>"Sign in" and "needs an admin password" are different problems.</strong>
         Signing in is about you and takes a moment. An admin password is about the
         deployment: somebody runs that streaming server, and it is entered once, per
         server. If the panel asks for one, that is who to ask.`,
        `<strong>Nothing is hidden because it is unavailable.</strong> A figure that
         cannot be measured is shown empty with a key beside it, so it is always clear
         what this tool can do and what would switch it on \u2014 rather than the page
         quietly changing shape depending on which station is selected.`,
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
        `The chips are also the card's play controls. Click one to point the preview
         player at that mount — which is how you hear an underlined mount for
         yourself, where the connection opens and no audio arrives. Clicking the mount
         that is already playing stops it. A struck-through mount cannot be clicked:
         Icecast is not serving it, so there is nothing to play.`,
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
        `<strong>One report per station</strong>, covering only that station's
         channels and going to exactly the people its outage alerts go to. It
         arrives at the chosen hour in the station's own timezone, so a 9am report
         reaches a reader in Los Angeles at 9am, not at 7am.`,
        `A station with nobody on its recipient list, or with alerts switched off,
         gets no roundup — there is nobody to send it to.`,
      ],
    },
  ];

  /* ONE RENDERER, TWO AUDIENCES.

     The dashboard's topics are declared above; the admin page declares its own
     in `admin-guide.js` and loads it first. Forking this file would give the
     project two spellings of the same component — and the copy nobody is
     looking at is the one that rots. */
  const TOPIC_SET = (typeof window !== 'undefined' && Array.isArray(window.GUIDE_TOPICS))
    ? window.GUIDE_TOPICS
    : TOPICS;

  /* The admin page loads Inter and nothing else — no icon font — so a glyph
     name would render as the literal word "key" in its navigation. A page
     without the font declares so rather than being detected. */
  const USE_ICONS = !(typeof window !== 'undefined' && window.GUIDE_ICONS === false);

  const $ = (id) => document.getElementById(id);
  let index = 0;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function renderNav() {
    $('guide-nav').innerHTML = TOPIC_SET.map((t, i) => `
      <button class="guide-tab${i === index ? ' active' : ''}" data-i="${i}">
        ${USE_ICONS ? `<span class="material-symbols-outlined">${esc(t.icon)}</span>` : ''}
        <span class="guide-tab-label">${esc(t.title)}</span>
      </button>`).join('');
    $('guide-nav').querySelectorAll('[data-i]').forEach((b) =>
      b.addEventListener('click', () => go(Number(b.dataset.i))));
  }

  function renderTopic() {
    const t = TOPIC_SET[index];
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
          ${index + 1} of ${TOPIC_SET.length}
          <span class="guide-keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd></span>
        </span>
        <button class="guide-step" id="guide-next" ${index === TOPIC_SET.length - 1 ? 'disabled' : ''}>Next →</button>
      </div>`;
    $('guide-prev').addEventListener('click', () => go(index - 1));
    $('guide-next').addEventListener('click', () => go(index + 1));
    $('guide-content').scrollTop = 0;
  }

  function go(i) {
    if (i < 0 || i >= TOPIC_SET.length) return;
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
