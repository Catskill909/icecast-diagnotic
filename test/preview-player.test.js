/* ═══════════════════════════════════════════════════════════════════════════
   Stream card preview players

   The mount chips on each card are play controls: clicking one points that
   card's preview at that mount. That makes a card tear one audio element down
   and build another in the same gesture, and `pause` is delivered
   asynchronously — so the OLD element's pause event arrives after the new one
   has started. Handlers keyed by stream alone would report that pause as the
   card's state and stop the mount the operator just asked for.

   The fake element below delivers pause exactly that way — on flush, not on
   call — so the ordering is the real one rather than a convenient one.
   ═══════════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const { createPreviewPlayers } = require('../public/preview-player');

/** An HTMLAudioElement stand-in whose events fire when the test says so. */
function makeAudio(url) {
  const listeners = {};
  const pending = [];
  return {
    url,
    playCalls: 0,
    paused: true,
    addEventListener(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
    },
    play() {
      this.playCalls++;
      this.paused = false;
      return Promise.resolve();
    },
    // The browser pauses the element immediately and dispatches the event on a
    // later turn. Queued, not fired.
    pause() {
      this.paused = true;
      pending.push('pause');
    },
    emit(event) {
      (listeners[event] || []).forEach((fn) => fn());
    },
    flush() {
      while (pending.length) this.emit(pending.shift());
    },
  };
}

function harness() {
  const made = [];
  const players = createPreviewPlayers({
    createAudio: (url) => {
      const a = makeAudio(url);
      made.push(a);
      return a;
    },
  });
  return { players, made, last: () => made[made.length - 1] };
}

test('switching mounts plays the new one and survives the old element pausing late', () => {
  const { players, made, last } = harness();

  players.selectMount('kpfa', '/kpfa', 'http://h:8443/kpfa');
  last().emit('playing');
  assert.equal(players.state('kpfa'), 'playing');

  players.selectMount('kpfa', '/kpfa_64', 'http://h:8443/kpfa_64');
  assert.equal(made.length, 2);
  assert.equal(last().url, 'http://h:8443/kpfa_64');
  assert.equal(last().playCalls, 1);

  // The pause queued by the switch now lands. It belongs to the element that is
  // gone, and must not touch the card that is playing.
  made[0].flush();
  assert.equal(players.state('kpfa'), 'buffering');

  last().emit('playing');
  assert.equal(players.state('kpfa'), 'playing');
});

test('a late event of any kind from a superseded element is ignored', () => {
  for (const event of ['ended', 'error', 'waiting']) {
    const { players, made, last } = harness();
    players.selectMount('kpfa', '/kpfa', 'http://h:8443/kpfa');
    last().emit('playing');
    players.selectMount('kpfa', '/kpfa_64', 'http://h:8443/kpfa_64');
    last().emit('playing');

    made[0].emit(event);
    assert.equal(players.state('kpfa'), 'playing', `${event} from the old element stopped the card`);
  }
});

test('clicking the mount that is already playing stops the preview', () => {
  const { players, made, last } = harness();

  players.selectMount('kpfa', '/kpfa_64', 'http://h:8443/kpfa_64');
  last().emit('playing');

  players.selectMount('kpfa', '/kpfa_64', 'http://h:8443/kpfa_64');
  assert.equal(players.state('kpfa'), 'stopped');
  assert.equal(made.length, 1, 'stopping must not open a second connection');
  assert.equal(made[0].paused, true);
});

test('only one preview plays at a time, and the stopped one stays stopped', () => {
  const { players, made, last } = harness();

  players.selectMount('kpfa', '/kpfa', 'http://h:8443/kpfa');
  last().emit('playing');

  players.selectMount('kpfk', '/kpfk_128', 'http://h:9000/kpfk_128');
  assert.equal(made[0].paused, true);
  assert.equal(players.state('kpfa'), 'stopped');

  made[0].flush();
  assert.equal(players.state('kpfa'), 'stopped');
  assert.equal(players.state('kpfk'), 'buffering');
});

test('the play button toggles whichever mount is selected', () => {
  const { players, last } = harness();

  players.selectMount('kpfa', '/kpfa_192', 'http://h:8443/kpfa_192');
  last().emit('playing');
  players.toggle('kpfa', 'http://h:8443/kpfa_192');
  assert.equal(players.state('kpfa'), 'stopped');

  players.toggle('kpfa', 'http://h:8443/kpfa_192');
  assert.equal(players.state('kpfa'), 'buffering');
  assert.equal(last().url, 'http://h:8443/kpfa_192');
});

test('a refused play stops the card rather than leaving it buffering forever', async () => {
  const made = [];
  const players = createPreviewPlayers({
    createAudio: (url) => {
      const a = makeAudio(url);
      a.play = () => Promise.reject(new Error('NotAllowedError'));
      made.push(a);
      return a;
    },
  });

  players.toggle('kpfa', 'http://h:8443/kpfa');
  await new Promise((r) => setImmediate(r));
  assert.equal(players.state('kpfa'), 'stopped');
});

test('selection sticks, and falls back when its mount stops being playable', () => {
  const { players } = harness();
  const all = ['/kpfa', '/kpfa_192', '/kpfa_64'];

  // Untouched, a card plays the probed mount — the first one listed.
  assert.equal(players.selectionFor('kpfa', all), '/kpfa');

  players.selectMount('kpfa', '/kpfa_64', 'http://h:8443/kpfa_64');
  assert.equal(players.selectionFor('kpfa', all), '/kpfa_64');

  // /kpfa_64 has gone missing from Icecast: there is nothing to point at, so the
  // highlight must move rather than sit on a mount nobody can play.
  assert.equal(players.selectionFor('kpfa', ['/kpfa', '/kpfa_192']), '/kpfa');
});
