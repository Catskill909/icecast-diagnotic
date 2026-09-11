/* ═══════════════════════════════════════════════════════════════════════════
   Admin guide — the topics, as data

   Rendered by guide.js, which takes its topic set from `window.GUIDE_TOPICS`
   when a page declares one. Same modal, same navigation, different audience:
   this page is read by whoever CONFIGURES the monitor, not by whoever reads
   its figures.

   WHAT BELONGS HERE AND WHAT DOES NOT. A field whose consequence fits in a
   sentence gets an inline popover, at the field, where the decision is being
   made. This file is for the things that need a worked example — three levels
   of structure, or why two stations on the same page show different amounts of
   detail. A guide nobody opens is worse than no guide, so it stays short.
   ═══════════════════════════════════════════════════════════════════════════ */

window.GUIDE_ICONS = false;   // this page loads no icon font
window.GUIDE_TOPICS = [
  {
    id: 'structure',
    title: 'Stations, channels and mounts',
    lead: 'Three levels. Which one something belongs to decides how it is watched and where it appears.',
    body: [
      `<strong>A mount</strong> is one address on one server, usually one bitrate.
       <strong>A channel</strong> is a stream as a listener thinks of it &mdash; "KPFT Main"
       &mdash; which may be published at several bitrates at once.
       <strong>A station</strong> is a group of channels that share recipients, a
       timezone and a weekly report.`,
      `<strong>The channel is the unit that gets watched.</strong> Each one is probed on
       its own, gets its own card on the dashboard, its own uptime figure and its own
       alert history. Mounts underneath it are summed into one listener count, because
       a listener choosing the 64k stream is still listening to KPFT Main.`,
      `<strong>That summing is why the per-mount split exists.</strong> On this server
       /live_64 carries about a third of KPFT Main's audience, so the total can hold
       perfectly steady while one bitrate's listeners collapse inside it. No other
       Icecast panel shows that, and it is what made degraded-channel detection
       possible at all.`,
      `<strong>Adding a stream to a station already being watched:</strong> the panel
       offers it as a new CHANNEL of that station, and that is almost always right. The
       alternative &mdash; adding it as another mount on an existing channel &mdash;
       collapses two servers into a single probe, ends independent monitoring of one of
       them, and cannot be undone later because a channel's identifier is permanent.`,
    ],
  },
  {
    id: 'access',
    title: 'Why some stations show less',
    lead: 'The audience figures split in two, and the line is a password on a server.',
    body: [
      `<strong>Counting how many people are listening needs nothing.</strong> Listener
       counts, peaks, uptime, outages, root cause and every alert work on any Icecast
       stream, anywhere, with no credential at all. That is most of this application.`,
      `<strong>Telling one listener from another needs an admin password</strong> for
       the server that stream is served from. Individual listeners, who came back and
       who was new, players and devices, session length, and everything about where
       listeners are &mdash; all of it comes from one password-protected endpoint that
       lists the connections currently open.`,
      `<strong>The password belongs to the SERVER, not to the station</strong>, and a
       station's channels need not all live on the same server. On this network KPFT,
       WPFW and KPFK are on Pacifica's shared server, WBAI is on its own, and KPFA is
       on BOTH. So WBAI shows no per-listener figures, and KPFA shows them for one of
       its two channels.`,
      `Where that happens the Audience page says so &mdash; "these figures cover 1 of 2
       channels" &mdash; because figures describing half a station would otherwise read
       as the whole of it. <strong>Nothing is hidden for being unavailable</strong>: a
       figure that cannot be measured is shown empty with a key beside it, so it is
       always clear what the tool can do and what would switch it on.`,
      `Getting a password for a station's server switches on everything already built,
       for that station, with no change to the software.`,
    ],
  },
  {
    id: 'alerts',
    title: 'Who gets emailed, and when',
    lead: 'Each station owns one list. Four separate things can stop mail leaving.',
    body: [
      `<strong>One list per station, and no CC.</strong> Everything that station sends
       &mdash; outage alerts, recovery notices, its weekly report &mdash; goes to the
       same addresses. To and CC distinguish people in a conversation and distinguish
       nothing in an automated alert, where everyone gets the identical message.`,
      `<strong>Muted and empty are deliberately different.</strong> An empty list is an
       unfinished setup; a station switched off is a decision, usually one being
       trialled or whose staff are not onboarded yet. Collapsing them would make
       "we turned this off on purpose" indistinguishable from "somebody deleted the
       last address by accident". A muted station still records everything.`,
      `<strong>Four things can independently stop mail</strong>, and the panel names
       which: no SMTP configured, this not being a deployed instance, the station being
       switched off, or no recipients. A developer running the app from a laptop is the
       second one &mdash; that guard exists so a shared configuration file cannot mail
       a real General Manager from somebody's desk.`,
      `<strong>A test message proves one thing only:</strong> that this server can hand
       mail for that address to the mail system and have it accepted. It deliberately
       reports FAILURE when a mail server refuses the address, because a button whose
       entire purpose is proving an address works is worthless if it says yes anyway.
       It does not prove the message escaped a spam filter.`,
      `<strong>Not every outage emails.</strong> The monitor watches from outside, so a
       failed check proves only that OUR connection broke. If Icecast is reachable and
       still serving the mount, nobody lost audio and no mail goes out &mdash; it is
       still recorded. And a stream that keeps flapping is one fault, not fourteen, so
       repeats are suppressed after the second while still being logged.`,
    ],
  },
  {
    id: 'removing',
    title: 'What happens when you remove something',
    lead: 'Configuration says what is watched from now on. It is not a statement about the past.',
    body: [
      `<strong>Removing a station stops it being monitored. The record of what happened
       while it WAS monitored stays exactly where it is.</strong> Deleting that would
       destroy the thing this application exists to keep, and would do it on a click.`,
      `<strong>Dropping a channel works the same way</strong>, and its history stays
       filed under its identifier. If the channel is added back later with the same
       identifier, the old record is still there and continues.`,
      `<strong>A channel's identifier cannot be changed</strong>, only its display name,
       its address and its mount list. Renaming what you call it is safe at any time.
       Changing the key underneath would orphan every sample filed against it.`,
      `Every destructive confirmation on this page names what SURVIVES rather than
       asking whether you are sure &mdash; because "are you sure?" asks a question
       nobody can answer, and the thing worth knowing is what you get to keep.`,
    ],
  },
  {
    id: 'backup',
    title: 'Backup and moving servers',
    lead: 'One file holds the whole deployment. One field inside it decides whether listener history survives.',
    body: [
      `<strong>Download a backup</strong> changes nothing on the server. The file holds
       the stations, the incident record, the listener history and the settings. There
       is no other copy: if the server is lost without one, the record starts again
       from zero.`,
      `<strong>The file contains the alert email addresses</strong>, because they are
       part of a station's settings. Passwords are not in it &mdash; those live outside
       the data folder and must be set again by hand on a new server. Treat the file as
       you would a contact list.`,
      `<strong>The one field that matters.</strong> Listeners are recognised by a
       scrambled code, and the scrambling uses a secret number belonging to this
       installation. Same person plus same secret equals the same code, which is the
       only reason the app can say somebody listened last week too. The codes and the
       secret live in different places, so a hand copy of the files can easily leave
       the secret behind &mdash; and then every returning listener looks brand new, for
       ever, with nothing on screen to say so. The backup carries both, and a restore
       refuses a file missing it.`,
      `<strong>Restoring replaces everything.</strong> You are shown what is in the file
       first &mdash; how many stations, incidents and listeners, and when it was made
       &mdash; and the current data is renamed and kept rather than deleted, so a
       mistake can be undone by hand. The app must be restarted afterwards, because it
       holds the old settings in memory until it is.`,
    ],
  },
];
