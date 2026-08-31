# SMS Alerting

**Status:** scoped, not built. Queued as build-order item 9 — see
[`HANDOFF.md`](../HANDOFF.md) §6.

**Scope authored:** 2026-08-28. Pricing is a snapshot and must be re-checked in
the vendor portal before anyone signs up; carrier surcharges in particular change
without notice.

---

## 1. Objective

Deliver automated, low-latency mobile text alerts to administrators when an
Icecast stream or audio encoder goes offline.

Email already works and is the system of record. SMS is for the case email does
not cover: **nobody reads email at 4am.** The station's existing outage pattern —
source encoder disconnects clustering at 12:00, 13:00 and 17:00 Central, plus
overnight failures nobody notices until morning — is the argument for it.

## 2. Vendor comparison (US market)

| Provider | Outbound SMS | Number rental | Minimums | Best for |
|---|---|---|---|---|
| **Telnyx** | $0.0040 / text + carrier fee | $1.00 / mo | Pure pay-as-you-go, no minimum balance | Lowest total cost per message |
| **Plivo** | $0.0050 – $0.0077 / text + carrier fee | $0.50 / mo | $25 initial top-up | Lowest monthly number rental |
| **Twilio** | $0.0083 / text + carrier fee | $1.15 / mo | $20 initial top-up | Documentation and SDK support |

Major US carriers (AT&T, Verizon, T-Mobile) add mandatory pass-through
surcharges of **$0.0035 – $0.0045 per message part** on all outbound SMS. These
are unavoidable and apply to every vendor above.

## 3. Operating budget (low-volume alerting)

| Line item | Cost |
|---|---|
| Message volume (~10–15 alerts/month) | < $0.20 / mo |
| Phone number rental | $0.50 – $1.15 / mo |
| 10DLC low-volume campaign fee | $1.50 – $2.00 / mo |
| **Total ongoing** | **~$3.00 – $4.50 / mo** |

One-time: **$15 – $20** for A2P 10DLC brand and campaign vetting.

The recurring cost is dominated by the number rental and the regulatory fee, not
the messages. Volume would have to rise by two orders of magnitude before
per-message price mattered — so **pick the vendor on integration quality, not on
the per-text rate.**

## 4. US regulatory requirements

**A2P 10DLC registration is mandatory.** Application-to-Person traffic from an
unregistered number is filtered as spam by the carriers — the alert does not
bounce, it silently disappears. Registration is handled in the vendor portal and
is a prerequisite for the first message, not a follow-up task.

## 5. Technical implementation

- Trigger from the monitoring service via the vendor's REST API
  (`POST /v2/messages`).
- API keys in server environment variables only, never in the store or the
  config UI. They are send-money credentials.
- **Debounce.** This is the requirement that decides whether the feature is worth
  having.

### 5.1 What debouncing has to mean here

The system already solved this problem for email, and SMS must reuse that answer
rather than inventing a second one:

- **Alert on listener impact, not on probe failure.** The monitor sits outside
  Pacifica's network, so a failed probe alone proves only that *our* connection
  broke. 12 of 21 early email alerts were 60-second probe resets where no mount
  ever dropped a listener. Route SMS through the same `warrantsAlert()` gate.
- **Respect the confirmation threshold.** Nothing texts on a single failed check.
- **Never text a degraded channel.** A missing bitrate variant on a channel that
  is still playing is not a 4am problem. `degraded` events are excluded.
- **Consolidate per cycle.** One server-wide failure is one message naming three
  streams, not three messages — the same rule `dispatchNotifications()` already
  applies to email.
- **Rate-limit per stream.** A flapping encoder must not be able to send fifty
  texts overnight. A hard cap per stream per hour, with the suppressed count
  reported in the next message.

### 5.2 Where it plugs in

`sendAlert()` in `monitor.js` is the seam. It already receives a composed
`{ kind, entries, scope }` and returns a delivery record that is written onto the
event. SMS becomes a second transport behind the same call, with the same record
shape, so the history page can show "texted" alongside "emailed" without a new
data model.

**SMS is a truncation of the email, not a different message.** Subject line plus
listener count plus the dashboard link — the email already computes all three.

## 6. Dependency

**UNBLOCKED 2026-08-31.** This was to be built after per-station alert
recipients (build-order item 7), because phone numbers are per-person and
per-station in exactly the way email addresses are, and building SMS against a
single global recipient list would build that routing twice and throw the first
away — the same reasoning that put the admin panel before adding stations.

That routing now exists. Numbers belong in the same per-station `alerts` block,
and `sendGroupedAlert()` in monitor.js is the seam that already guarantees one
station's incident reaches only that station's people — so SMS inherits the
grouping rather than re-deriving it. The admin panel's Alerts section is where
the field goes.
