/* Cellular Drift — seeded random streams.
 * UMD: usable from the browser (window.CDRNG) and Node (require).
 * Three independent streams are derived from one master seed so that
 * rules, decoration, and audiovisual randomness never interfere.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CDRNG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STREAM_RULES = 0x9e3779b9;
  var STREAM_DECOR = 0x85ebca6b;
  var STREAM_AV = 0xc2b2ae35;

  // mulberry32: tiny, fast, deterministic 32-bit PRNG.
  function create(state) {
    state = state >>> 0;
    return {
      get state() { return state >>> 0; },
      set state(s) { state = s >>> 0; },
      next: function () { // float in [0, 1)
        state = (state + 0x6D2B79F5) >>> 0;
        var t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      int: function (n) { // integer in [0, n)
        return Math.floor(this.next() * n);
      },
      range: function (lo, hi) { // float in [lo, hi)
        return lo + this.next() * (hi - lo);
      },
      pick: function (arr) {
        return arr[this.int(arr.length)];
      },
      shuffle: function (arr) { // in-place Fisher–Yates
        for (var i = arr.length - 1; i > 0; i--) {
          var j = this.int(i + 1);
          var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
      }
    };
  }

  // FNV-1a string hash → 32-bit seed (used for daily dates, session ids).
  function hashString(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function derive(masterSeed, streamTag) {
    return create(((masterSeed >>> 0) ^ streamTag) >>> 0);
  }

  function streams(masterSeed) {
    return {
      rules: derive(masterSeed, STREAM_RULES),
      decor: derive(masterSeed, STREAM_DECOR),
      av: derive(masterSeed, STREAM_AV)
    };
  }

  return {
    create: create,
    hashString: hashString,
    derive: derive,
    streams: streams,
    STREAM_RULES: STREAM_RULES,
    STREAM_DECOR: STREAM_DECOR,
    STREAM_AV: STREAM_AV
  };
});
