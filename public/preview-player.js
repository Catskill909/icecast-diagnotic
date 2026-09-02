/* ═══════════════════════════════════════════════════════════════════════════
   Stream card preview players

   Which mount each card's preview is pointed at, whether it is playing, and the
   rule that only one preview plays at a time. Kept out of the page, and given
   its audio elements rather than making them, so it can be tested in Node —
   the same reason audience-stats.js lives beside it.

   The race worth testing: `pause` arrives asynchronously, so when a card
   switches mounts the old element's pause event lands AFTER the new one has
   started. Handlers keyed by stream alone would then stop the card that is now
   playing. Every handler here is scoped to the element that registered it.

   Loaded as a plain script in the browser (window.PreviewPlayer) and required
   directly in tests. No build step, matching the rest of the app.
   ═══════════════════════════════════════════════════════════════════════════ */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PreviewPlayer = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /**
   * @param createAudio  (url) => an HTMLAudioElement-shaped object
   * @param onChange     called whenever the visible state changes, so the cards
   *                     can be re-rendered
   */
  function createPreviewPlayers({ createAudio, onChange = () => {} }) {
    const states = {}; // streamId -> 'stopped' | 'buffering' | 'playing'
    const players = {}; // streamId -> the element this stream currently owns
    const selected = {}; // streamId -> mount path

    const state = (id) => states[id] || 'stopped';
    const isActive = (id) => states[id] === 'playing' || states[id] === 'buffering';

    function stop(id, { notify = true } = {}) {
      const audio = players[id];
      // Cleared BEFORE pausing. The handlers test this to decide whether they
      // are still the current player, and pause fires after we return.
      players[id] = null;
      states[id] = 'stopped';
      if (audio) audio.pause();
      if (notify) onChange();
    }

    function start(id, url) {
      // One preview at a time, this stream's own included: switching mounts
      // tears the previous element down before the new one is built.
      Object.keys(players).forEach((other) => {
        if (players[other]) stop(other, { notify: false });
      });

      states[id] = 'buffering';
      const audio = createAudio(url);
      players[id] = audio;

      const on = (event, fn) =>
        audio.addEventListener(event, () => {
          if (players[id] !== audio) return; // superseded — not ours to report
          fn();
          onChange();
        });

      on('playing', () => {
        states[id] = 'playing';
      });
      on('waiting', () => {
        states[id] = 'buffering';
      });
      // A preview that pauses, ends or fails is over either way, and the card
      // says so the same way for all three.
      ['pause', 'ended', 'error'].forEach((event) =>
        on(event, () => {
          states[id] = 'stopped';
          players[id] = null;
        }),
      );

      const played = audio.play();
      if (played && typeof played.catch === 'function') {
        played.catch((err) => {
          // Autoplay refusal and unreachable mounts both land here, and both
          // mean the same thing to the card: it is not playing.
          console.error('Audio playback error:', err);
          if (players[id] !== audio) return;
          stop(id);
        });
      }

      onChange();
    }

    function toggle(id, url) {
      if (isActive(id)) stop(id);
      else start(id, url);
    }

    /**
     * Point a card at one of its mounts and play it. Choosing the mount that is
     * already playing stops it, so a mount chip behaves like the play button
     * beside it rather than being a one-way switch.
     */
    function selectMount(id, path, url) {
      if (isActive(id) && selected[id] === path) {
        stop(id);
        return;
      }
      selected[id] = path;
      start(id, url);
    }

    /**
     * The mount to highlight and play, given what is currently playable.
     *
     * Falls back to the first playable mount — normally the probed one — so a
     * card whose chosen mount has vanished from Icecast never highlights
     * something nobody can play.
     */
    function selectionFor(id, playable) {
      if (!playable.includes(selected[id])) selected[id] = playable[0] || '';
      return selected[id];
    }

    return { state, isActive, stop, toggle, selectMount, selectionFor };
  }

  return { createPreviewPlayers };
});
