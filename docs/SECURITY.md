# Security review — 2026-08-27

A point-by-point review of the running system. Reviewed at commit `5f77aa0`;
all findings closed as of `df11e35`. Findings are
ranked by what an attacker can reach **without any credential**, because that is
the only tier that is exploitable from the open internet.

Every finding below was fixed the same day unless marked otherwise.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Staff email addresses served on a public endpoint | **High** | ✅ Fixed |
| 2 | Unauthenticated endpoint that sends mail | **High** | ✅ Fixed |
| 3 | XSS via Icecast metadata in HTML attributes | **Medium** | ✅ Fixed |
| 4 | No Content-Security-Policy or hardening headers | Medium | ✅ Fixed |
| 5 | Upstream administrator address in stored advice text | Low | ✅ Fixed |
| 6 | `nodemailer` advisories | Low (not exposed) | ✅ Upgraded to 9.0.5, audit clean |
| 7 | SSRF once station URLs become user-supplied | **Not yet real** | ✅ Guard built ahead of the feature |
| 8 | Reads are unauthenticated by design | Accepted | — |

Checked and found sound: path traversal, credential logging, response size
limits, open redirect on login, session forgery, login brute force.

---

## 1. Staff addresses on a public endpoint — High

`/api/events` returned stored events verbatim to anonymous callers. Each event's
delivery record names every recipient, so real staff addresses were readable by
anyone who found the URL.

Neither half was a mistake alone: recording recipients answers "who was told, and
did it arrive", and open reads are a deliberate choice. Together they published
the addresses.

**Fixed** by projecting public responses through `redact.js`. Administrators
still see the full audit trail; stored records are unchanged.

**The part worth keeping:** station configuration is projected by **allowlist**,
not blocklist. Per-station alert recipients are landing in that structure
shortly, and a blocklist would have leaked them the moment they arrived —
silently, with nothing failing.

## 2. Unauthenticated mail sender — High

`/api/test-alert` sent mail through the station's SMTP with no credential. Anyone
who found the URL could fire station-branded email at arbitrary addresses,
burning SMTP quota and the sending domain's reputation. `/api/weekly-roundup`
could do the same to an address of the caller's choosing.

**Fixed.** Both require a session. Protected routes **fail closed**: with no
password configured they return 503 rather than allowing the request, so a
deployment that forgets to set one gets a broken button, not a silent hole.

## 3. XSS via Icecast metadata — Medium

All three frontend escape helpers used the DOM trick — set `textContent`, read
`innerHTML` — which escapes `&`, `<`, `>` and leaves quotes untouched. Correct
for text; wrong inside an attribute, where a double quote closes the attribute
early and the rest is parsed as markup.

Ten call sites interpolate into `title="..."` or `data-*="..."`. One renders
`stream.title` — **Icecast metadata, set by whoever streams to the mount, not by
us.** On the shared Pacifica host that is another operator; for affiliates it is
an arbitrary third party. Another interpolated a stream id with no escaping at
all.

Exploiting it requires control of a source encoder, so it is Medium today. **It
becomes materially worse with affiliates**, where dozens of unrelated parties
control metadata the dashboard renders.

**Fixed in the helpers**, not at the call sites, so all ten are covered and the
next one is too.

## 4. Missing hardening headers — Medium

The app set only `X-Robots-Tag`. Added CSP, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS on https.

**Closed the same day.** `login.html` was the only page carrying an inline
`<script>`; it now loads `login.js` and `login.css` from files, so the policy is
`script-src 'self'` with **no `'unsafe-inline'`**. An injected `<script>` does not
execute even if escaping somewhere fails — which is the difference between an
escaping bug being a defect and being an account takeover.

Inline *style attributes* remain permitted via `style-src-attr`: nine of them sit
in the dashboard markup. Style injection is defacement; script injection is what
strictness is worth spending on, and the split policy keeps scripts strict
without a layout rewrite.

## 5. Administrator address in advice text — Low

`diagnose.js` hardcoded an upstream administrator's address inside remediation
advice, stored on every matching event and served publicly. Low severity — that
address is published by Pacifica's own Icecast server at a public URL — but the
hardcoding is wrong regardless: it puts one station's contact into generic advice
other stations will read.

**Fixed** at the source, with free text scrubbed in the public projection to
cover events already stored.

## 6. `nodemailer` advisories — Low, not exposed

`npm audit` reported one high-severity advisory against `nodemailer@6.10.1`.
Checked feature by feature: the app uses **none** of the affected paths —
no `jsonTransport`, no OAuth2, no `raw:`, no direct `addressparser`. Real
exposure is effectively nil.

**Done 2026-08-27.** Upgraded to `nodemailer@9.0.5`; `npm audit` reports zero
vulnerabilities. Five tests render real messages through an in-memory transport
using the exact option objects the app builds, because a major version bump can
change option shapes and the failure mode is silent until an alert does not
arrive at 3am.

## 7. SSRF — not yet real, but design it in now

The server fetches URLs it is given: `ICECAST_STATUS_URL` and each stream's
`url`. **Today both are set by the operator, so there is no vulnerability.**

**The add-station flow changes that.** Its whole appeal is "paste a URL and we
discover the rest" — which is a server-side fetch of an attacker-chosen address.
Without controls it can be pointed at `http://169.254.169.254/` (cloud metadata),
`http://localhost:*`, or private ranges, and the response is rendered back to
the person who asked.

**Done 2026-08-27, ahead of the feature.** `safe-url.js` implements the checks
below, with 16 tests written as the specification for the add-station flow. The
tests that matter are the bypasses: a hostname resolving to loopback, an IPv4
address wearing an IPv6 costume (`::ffff:127.0.0.1`), and adjacent public ranges
that must NOT be blocked. One known limit is recorded in the module: resolving
and then connecting leaves a DNS-rebinding window, narrow for an
operator-initiated one-shot request.

Requirements implemented:

- Reject non-`http(s)` schemes.
- Resolve the hostname and refuse loopback, link-local, and RFC1918 addresses —
  **after** resolution, so a DNS name pointing at `127.0.0.1` is caught.
- Re-check on redirect; a permitted host can redirect to a forbidden one.
- Cap response size and time.
- Never return the raw upstream body on error, only a parsed summary.

## 8. Reads are unauthenticated — accepted

Dashboard, history and most API endpoints are open. This is deliberate and
predates the review; `redact.js` keeps identities out of the responses.

**Now a setting rather than an open question.** `REQUIRE_LOGIN_FOR_READ=true`
puts the dashboard and every read endpoint behind the session; the login page and
the health check stay reachable. It is off by default, because the dashboard is
meant to be openable and public responses carry no personal data.

Written as a switch deliberately: "we should decide about this someday" is how a
deployment ends up more open than its operator believes.

---

## Verified sound

| Area | Finding |
|---|---|
| Path traversal | `streamId` is an object key, never a filesystem path. `../../etc/passwd` returns `[]` |
| Credential logging | Nothing writes a password, hash or secret to a log — the two auth warnings name variables, not values |
| Session forgery | HMAC-signed, expiry enforced, `timingSafeEqual` comparison; tampered and re-signed payloads rejected under test |
| Login brute force | Rate limited with lockout, verified end to end (429 on the sixth attempt) |
| Timing attacks | Password and username both compared in constant time, and both are always compared so failure timing reveals nothing |
| CSRF | `SameSite=Strict` on the session cookie; write routes accept JSON only |
| Open redirect | The login's `?next=` accepts same-origin paths only |
| Response limits | JSON bodies capped at 256 KB; event queries capped at 2000 |
| Indexing | `robots.txt`, `X-Robots-Tag` on every response, and a robots meta tag on every page |

---

## Recommendation: SMTP

The question was whether to move email out of the application. **Keep the sending
logic in the app; change the class of credential.**

**Why keep it in the app.** The decision to send is inseparable from the
diagnosis — the listener-impact gate is what makes these alerts worth reading,
and it lives here. Pushing that to an external service means either exporting the
whole decision or exporting every event and re-deciding elsewhere. It also adds a
failure mode this system exists to avoid: alerts stopping silently.

**Why change the credential.** The real risk is not where the code runs, it is
what the secret can do. A mailbox account's SMTP password (a Gmail app password,
say) usually grants **read** access as well as send. A leaked one does not just
let an attacker send as the station — it may let them read the station's mail.

Move to a **send-only API credential** from a transactional provider — Postmark,
SES, Resend. Same `nodemailer` code and the same SMTP interface, but:

- It can only send. There is no mailbox behind it.
- It is scoped to one verified sending domain.
- It rotates in seconds without touching a human's account.
- It brings delivery, bounce and complaint logs, which answer "did the GM
  actually receive it" — a question this system currently cannot answer.

That last point is an operational win as much as a security one.

**Ranking, honestly:** SMTP was not the biggest danger here. The two High
findings were reachable from the internet with no credential at all; the SMTP
secret requires compromising the host first. Fix the exposed surface first, then
improve the credential.
