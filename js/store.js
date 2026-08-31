/* Cellular Drift — persistence: versioned, checksummed local save document.
 * Never stores credentials or tokens. Browser global: window.CDStore.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CDStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAVE_VERSION = 1;
  var KEY = 'cellulardrift.save.v1';
  var LB_KEY = 'cellulardrift.leaderboards.v1';

  var DEFAULT_SETTINGS = {
    music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8,
    muted: false, captions: false,
    graphicsTier: 'auto',       // auto | low | medium | high
    theme: 'lagoon',
    reducedMotion: false,
    highContrast: false,
    cvdPalette: false,
    largeText: false,
    leftHanded: false,
    haptics: true,
    boardMirror: false,         // always-visible DOM board summary
    confirmActions: false       // timing assistance: tap Split/Eject twice to confirm
  };

  function defaultProgress() {
    return {
      lessonsDone: {},          // lessonId -> true
      journeyStars: {},         // levelId -> 0..3
      journeyBest: {},          // levelId -> score
      challengeBest: {},        // challengeId -> score
      dailiesDone: {},          // dateStr -> score
      dailyStreak: { last: null, count: 0 },
      achievements: {},         // key -> unlockedAtMs
      stats: { rounds: 0, goals: 0, wins: 0, massAbsorbed: 0, cellsAbsorbed: 0, splits: 0, playMs: 0 }
    };
  }

  function checksum(str) { // FNV-1a, base36
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function migrate(doc) {
    // v1 is current; older shapes are upgraded field-by-field here.
    if (!doc || typeof doc !== 'object') return null;
    if (doc.v > SAVE_VERSION) return null; // future format: don't clobber
    doc.v = SAVE_VERSION;
    doc.settings = Object.assign({}, DEFAULT_SETTINGS, doc.settings || {});
    doc.progress = Object.assign(defaultProgress(), doc.progress || {});
    return doc;
  }

  function fresh() {
    return { v: SAVE_VERSION, settings: Object.assign({}, DEFAULT_SETTINGS), progress: defaultProgress() };
  }

  var memoryFallback = null; // used when localStorage is unavailable

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (raw == null && memoryFallback) raw = memoryFallback;
    if (raw == null) return fresh();
    try {
      var doc = JSON.parse(raw);
      if (!doc || doc.sum !== checksum(doc.payload)) return fresh(); // corrupt → clean slate
      var migrated = migrate(JSON.parse(doc.payload));
      return migrated || fresh();
    } catch (e) { return fresh(); }
  }

  function save(doc) {
    doc.v = SAVE_VERSION;
    var payload = JSON.stringify(doc);
    var wrapped = JSON.stringify({ sum: checksum(payload), payload: payload });
    memoryFallback = wrapped;
    try { localStorage.setItem(KEY, wrapped); } catch (e) { /* memory fallback keeps session */ }
  }

  // ---------- leaderboards (local; host adapter may sync)
  function loadBoards() {
    try {
      var raw = localStorage.getItem(LB_KEY);
      return raw ? JSON.parse(raw) : { entries: [] };
    } catch (e) { return { entries: [] }; }
  }
  function saveBoards(b) {
    try { localStorage.setItem(LB_KEY, JSON.stringify(b)); } catch (e) {}
  }

  // Ties: objective completion, higher score, fewer invalid actions, lower
  // elapsed, then stable session id. Returns sorted copy.
  function sortEntries(entries) {
    return entries.slice().sort(function (a, b) {
      if ((b.objective ? 1 : 0) !== (a.objective ? 1 : 0)) return (b.objective ? 1 : 0) - (a.objective ? 1 : 0);
      if (b.score !== a.score) return b.score - a.score;
      if ((a.invalid || 0) !== (b.invalid || 0)) return (a.invalid || 0) - (b.invalid || 0);
      if ((a.durationMs || 0) !== (b.durationMs || 0)) return (a.durationMs || 0) - (b.durationMs || 0);
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
  }

  return {
    SAVE_VERSION: SAVE_VERSION,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    load: load, save: save, fresh: fresh, migrate: migrate,
    checksum: checksum,
    loadBoards: loadBoards, saveBoards: saveBoards, sortEntries: sortEntries
  };
});
