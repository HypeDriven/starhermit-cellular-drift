/* Cellular Drift — the save document of the engine client and what the
 * browser build (starhermit-sdk.js) left in the player's account, as the
 * engine client takes it over (pure: no storage).
 *  - The engine save (starhermit:storage `saves`) is { v: 1, progress }: the
 *    browser build's progress record (CDStore defaultProgress), merged across
 *    devices by CDStore.mergeProgress (more stars, better bests, every done
 *    mark, the larger lifetime counters, every achievement with its earliest
 *    unlock, the later daily streak).
 *  - The browser build's cloud save (slot game:<slug>) holds the SDK's
 *    save.json: the checksummed { sum, payload } wrapper of the whole
 *    document { v, settings, progress }. The engine shows it as a foreign
 *    save; docFromBrowserSave reads it (CDStore.loadRaw), its progress is
 *    merged in and its game settings are kept where this account has none.
 *  - The per-player settings keys (the SDK's PATCH of the settings object):
 *    the game's own options (captions, colour-vision palette, theme) carry
 *    over as game settings; volumes, mute, graphics, reduced motion, high
 *    contrast, larger text and the language are the runtime's Options now
 *    and are dropped, as are the never-wired leftHanded, haptics,
 *    boardMirror and confirmActions.
 * UMD: globalThis.CDMigrate (loadClassic, after js/store.js) / Node.
 */
(function (root, factory) {
  var S = (typeof module === 'object' && module.exports) ? require('./store.js') : root.CDStore;
  var api = factory(S);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CDMigrate = api;
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  function bool(v) { return typeof v === 'boolean'; }
  /** Settings the game still owns (game.<key> in the runtime's settings), with their checks. */
  var GAME_SETTINGS = {
    captions: bool,
    cvdPalette: bool,
    theme: function (v) { return typeof v === 'string' && /^(lagoon|amethyst|verdant|cinder|aurora)$/.test(v); }
  };
  var GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
  /** Every key the browser build kept in the account's per-player settings. */
  var BROWSER_SETTING_KEYS = Object.keys(S.DEFAULT_SETTINGS).concat(['ui.language', 'audio.options']);

  function isProgress(p) {
    return !!(p && typeof p === 'object' && !Array.isArray(p) && p.stats && typeof p.stats === 'object');
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** A progress record with every field the game reads (missing ones fresh). */
  function normalize(p) {
    return S.migrate({ v: 1, progress: clone(p) }).progress;
  }

  /** The progress in an engine save document ({ v: 1, progress }), or null. */
  function progressFromSave(doc) {
    if (!doc || typeof doc !== 'object' || doc.v !== 1 || !isProgress(doc.progress)) return null;
    return normalize(doc.progress);
  }

  /** The whole browser-build document ({ v, settings, progress }) in its cloud save text, or null. */
  function docFromBrowserSave(text) {
    if (typeof text !== 'string') return null;
    return S.loadRaw(text);
  }

  /** The engine save document for a progress record. */
  function saveDoc(progress) { return { v: 1, progress: progress }; }

  /** Two progress records merged (either may be null); a fresh one when both are. */
  function mergeProgress(remote, local) {
    if (!local && !remote) return S.fresh().progress;
    if (!local) return normalize(remote);
    if (!remote) return normalize(local);
    var a = { v: 1, settings: {}, progress: normalize(local) };
    return S.mergeProgress(a, { progress: normalize(remote) }).progress;
  }

  /** A browser-build setting's value as the engine client keeps it, or undefined (dropped). */
  function migrateSetting(key, value) {
    var check = GAME_SETTINGS[key];
    if (!check) return undefined;
    return check(value) ? value : undefined;
  }

  return {
    GAME_SETTING_KEYS: GAME_SETTING_KEYS, BROWSER_SETTING_KEYS: BROWSER_SETTING_KEYS,
    progressFromSave: progressFromSave, docFromBrowserSave: docFromBrowserSave,
    saveDoc: saveDoc, mergeProgress: mergeProgress, migrateSetting: migrateSetting
  };
});
