/* ═══════════════════════════════════════════════════════════════════════════
   Shared Event Detail Renderer
   ───────────────────────────────────────────────────────────────────────────
   Builds the expanded drill-down for a single incident: root-cause diagnosis,
   evidence, remediation, Icecast state at the time of failure, email delivery
   record, and the connection-layer timing breakdown.

   Used by BOTH the live dashboard and the history page so an incident reads
   identically wherever it is opened, and so the two views cannot drift apart.

   Exposes: window.EventDetail.render(event) -> HTML string
   ═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function kvRow(key, value, cls) {
    return `<div class="kv-row"><span class="kv-key">${key}</span><span class="kv-val ${cls || ''}">${value}</span></div>`;
  }

  function render(e) {
    if (!e) return '';
    const d = e.diagnosis;
    const blocks = [];

    if (d && d.cause) {
      blocks.push(`
        <div class="diag-head">
          <span class="diag-cause">🔎 ${esc(d.causeLabel)}</span>
          <span class="conf ${esc(d.confidence)}">${esc(d.confidence)} confidence</span>
        </div>`);
    }

    // Backfilled history must never read as a live observation.
    if (e.reconstructed) {
      blocks.push(`
        <div class="recon-note">
          <span class="material-symbols-outlined">history_toggle_off</span>
          <div>
            <strong>Reconstructed event.</strong>
            ${esc(e.reconstructionNote || 'Backfilled from raw per-check telemetry captured before the storage migration. Timestamps, statuses and error strings are the real recorded values; the root-cause diagnosis was inferred from those errors plus cross-stream correlation, not from a live probe.')}
          </div>
        </div>`);
    }

    const grid = [];

    if (d && d.evidence && d.evidence.length) {
      grid.push(`
        <div class="detail-block">
          <h5>Evidence</h5>
          <ul>${d.evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>`);
    }

    if (d && d.remediation && d.remediation.length) {
      grid.push(`
        <div class="detail-block">
          <h5>What to do</h5>
          <ol>${d.remediation.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
        </div>`);
    }

    // ── Technical facts ─────────────────────────────────────────────────────
    const rows = [];
    const push = (k, v, cls) => { if (v != null && v !== '') rows.push(kvRow(k, v, cls)); };

    push('Occurred', new Date(e.timestamp).toLocaleString('en-US'));
    if (e.resolvedAt) push('Resolved', new Date(e.resolvedAt).toLocaleString('en-US'));
    // The verdict that decides whether this event was worth an email.
    if (d && d.listenerImpact && e.type !== 'up') {
      const IMPACT = {
        confirmed: ['Listeners were cut off', 'bad'],
        none: ['None — mount kept serving', 'good'],
        unknown: ['Unknown — Icecast unreachable', 'warn'],
      };
      const [label, cls] = IMPACT[d.listenerImpact] || [d.listenerImpact, ''];
      push('Listener impact', label, cls);
    }
    if (e.durationLabel) push('Duration', esc(e.durationLabel), 'warn');
    if (e.sourceOutage) {
      push('Source reconnected', new Date(e.sourceOutage.reconnectedAt).toLocaleString('en-US'), 'good');
      push('True source downtime', esc(e.sourceOutage.sourceDownLabel), 'warn');
    }
    if (d && d.httpStatus != null) push('HTTP status', d.httpStatus, d.httpStatus === 200 ? 'good' : 'bad');
    if (d && d.errorCode) push('Error code', `<code class="inline">${esc(d.errorCode)}</code>`);
    if (d && d.errorMessage) push('Error', `<code class="inline">${esc(d.errorMessage)}</code>`, 'bad');
    if (e.failedChecks) push('Failed checks', e.failedChecks);
    if (e.selfCleared) push('Outcome', 'Self-cleared before confirmation', 'good');
    if (rows.length) {
      grid.push(`<div class="detail-block"><h5>Details</h5><div class="kv">${rows.join('')}</div></div>`);
    }

    // ── Icecast state at the time of failure ────────────────────────────────
    const ice = d && d.icecast;
    if (ice) {
      const ir = [];
      const ipush = (k, v, cls) => { if (v != null && v !== '') ir.push(kvRow(k, v, cls)); };
      ipush('Status endpoint', ice.reachable ? 'Reachable' : 'UNREACHABLE', ice.reachable ? 'good' : 'bad');
      if (ice.statusError) ipush('Status error', esc(ice.statusError), 'bad');
      if (ice.serverId) ipush('Server', esc(ice.serverId));
      if (ice.mountPath) ipush('Mount', `<code class="inline">${esc(ice.mountPath)}</code>`);
      // null means we could not query Icecast, which is not the same claim as
      // observing the mount gone — never render the two identically.
      if (ice.mountPresent === null || ice.mountPresent === undefined) {
        ipush('Mount present', 'Not checked — Icecast unreachable', 'warn');
      } else {
        ipush('Mount present', ice.mountPresent ? 'Yes' : 'NO', ice.mountPresent ? 'good' : 'bad');
      }
      if (ice.mountCount) ipush('Mounts on server', ice.mountCount);
      if (ice.sourceConnectedSince) ipush('Source connected since', new Date(ice.sourceConnectedSince).toLocaleString('en-US'));
      if (ice.listeners != null) ipush('Listeners', ice.listeners);
      if (ice.serverRestarted) ipush('Server restarted', 'YES', 'warn');
      if (ir.length) {
        grid.push(`<div class="detail-block"><h5>Icecast server state</h5><div class="kv">${ir.join('')}</div></div>`);
      }
    }

    // ── Email delivery record ───────────────────────────────────────────────
    const em = e.email || {};
    const er = [];
    const epush = (k, v, cls) => { if (v != null && v !== '') er.push(kvRow(k, v, cls)); };
    epush('Alert sent', em.sent === true ? 'Yes' : em.attempted ? 'FAILED' : 'No',
      em.sent === true ? 'good' : em.attempted ? 'bad' : '');
    if (em.reason) epush('Reason', esc(em.reason));
    if (em.error) epush('SMTP error', `<code class="inline">${esc(em.error)}</code>`, 'bad');
    if (em.recipients && em.recipients.length) epush('Recipients', esc(em.recipients.join(', ')));
    if (em.sentAt) epush('Sent at', new Date(em.sentAt).toLocaleString('en-US'));
    if (em.consolidated) epush('Delivery', 'Consolidated multi-stream alert');
    if (em.subject) epush('Subject', esc(em.subject));
    if (er.length) {
      grid.push(`<div class="detail-block"><h5>Email notification</h5><div class="kv">${er.join('')}</div></div>`);
    }

    blocks.push(`<div class="detail-grid">${grid.join('')}</div>`);

    // ── Connection-layer timing breakdown ───────────────────────────────────
    const t = d && d.timings;
    if (t && (t.dns != null || t.tcp != null || t.tls != null || t.ttfb != null)) {
      const segs = [];
      const legend = [];
      const add = (key, label, color, val) => {
        if (val == null || val <= 0) return;
        segs.push({ key, val });
        legend.push(`<span><span class="timing-dot" style="background:${color}"></span>${label} ${val}ms</span>`);
      };
      // ttfb is measured from request start, so show only the tail after TLS.
      const pre = (t.dns || 0) + (t.tcp || 0) + (t.tls || 0);
      const serverTime = t.ttfb != null ? Math.max(t.ttfb - pre, 0) : null;

      add('dns', 'DNS', '#60a5fa', t.dns);
      add('tcp', 'TCP connect', '#34d399', t.tcp);
      add('tls', 'TLS handshake', '#fbbf24', t.tls);
      add('ttfb', 'Server response', '#a78bfa', serverTime);

      if (segs.length) {
        const total = segs.reduce((a, s) => a + s.val, 0) || 1;
        const strip = segs.map((s) =>
          `<div class="timing-seg ${s.key}" style="flex:${(s.val / total) * 100}">${s.val >= total * 0.12 ? s.val + 'ms' : ''}</div>`,
        ).join('');

        blocks.push(`
          <div class="detail-block" style="margin-top:18px;">
            <h5>Connection breakdown${t.resolvedIp ? ` — resolved to ${esc(t.resolvedIp)}` : ''}</h5>
            <div class="timing-strip">${strip}</div>
            <div class="timing-legend">${legend.join('')}</div>
          </div>`);
      }
    }

    return blocks.join('');
  }

  global.EventDetail = { render, esc };
})(window);
