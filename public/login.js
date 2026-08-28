/* Extracted from login.html so the Content-Security-Policy can forbid inline
   script outright. With script-src 'self' and no 'unsafe-inline', an injected
   <script> tag does not execute even if one is somehow rendered. */
const $ = (id) => document.getElementById(id);
  const msg = $('msg');
  let username = '';

  function show(text, kind) {
    msg.textContent = text;
    msg.className = 'msg ' + (kind || 'err');
  }
  function clear() { msg.className = 'msg'; msg.textContent = ''; }

  // Warn early if no credential is configured, so a 503 at submit time is not a
  // mystery.
  fetch('/api/me').then((r) => r.json()).then((s) => {
    if (s.authenticated) return location.replace(next());
    if (!s.configured) show('No admin password is configured on the server. Set ADMIN_PASSWORD_HASH and restart.', 'warn');
  }).catch(() => {});

  function next() {
    const p = new URLSearchParams(location.search).get('next') || '/';
    // Only same-origin paths: an attacker-supplied absolute URL here would turn
    // the login into an open redirect.
    return p.startsWith('/') && !p.startsWith('//') ? p : '/';
  }

  $('step1').addEventListener('submit', (e) => {
    e.preventDefault();
    username = $('username').value.trim();
    if (!username) return;
    clear();
    $('who').textContent = username;
    $('step1').classList.add('hidden');
    $('step2').classList.remove('hidden');
    $('title').textContent = 'Enter password';
    $('sub').textContent = 'Welcome back';
    $('password').focus();
  });

  // Show/hide the password. Typing a passphrase blind is how people end up
  // choosing shorter ones.
  $('pw-toggle').addEventListener('click', () => {
    const input = $('password');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    $('pw-toggle').classList.toggle('on', !shown);
    $('pw-toggle').setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
    $('pw-toggle').title = shown ? 'Show password' : 'Hide password';
    input.focus();
  });

  $('backBtn').addEventListener('click', () => {
    clear();
    $('password').value = '';
    $('step2').classList.add('hidden');
    $('step1').classList.remove('hidden');
    $('title').textContent = 'Sign in';
    $('sub').textContent = 'Stream monitor administration';
    $('username').focus();
  });

  $('step2').addEventListener('submit', async (e) => {
    e.preventDefault();
    clear();
    const btn = $('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: $('password').value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return location.replace(next());
      if (res.status === 429) {
        show(`Too many attempts. Try again in ${Math.ceil((body.retryAfterSeconds || 900) / 60)} minutes.`);
      } else if (res.status === 503) {
        show(body.detail || 'Admin password is not configured on the server.', 'warn');
      } else {
        show('Incorrect username or password.');
      }
    } catch {
      show('Could not reach the server. Check your connection and try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      $('password').select();
    }
  });
