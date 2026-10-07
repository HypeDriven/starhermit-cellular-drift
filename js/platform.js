/*
 * Cellular Drift — platform adapter over window.StarHermit (starhermit-sdk.js,
 * loaded and init()ed from index.html before the game modules). The SDK owns
 * the launch token (#game_token / #access_token), renewal, the profile
 * nickname, the cloud-save slot game:<slug>, the settings KV, control
 * bindings, the invite link and sign-in. This adapter keeps the game's API
 * and adds server-time sync (the own-server /api/v1/time route) and posting
 * finished rounds to the platform leaderboard — both only when signed in.
 * Standalone (no token) makes no network requests at all.
 */
const SAVE_DEBOUNCE_MS = 2000;
const sdk = () => (typeof globalThis !== 'undefined' && globalThis.StarHermit) || null;

// Keyboard actions — declared as control.<action> in starhermit.txt.
export const DEFAULT_BINDINGS = {
  up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
  split: ['Space'], eject: ['KeyE'], hint: ['KeyH'], pause: ['Escape', 'KeyP'],
};
// Synthetic events (no `code`) map by key.
const KEY_FALLBACK = {
  ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right',
  ' ': 'split', e: 'eject', h: 'hint', Escape: 'pause', p: 'pause',
};
const cloneBindings = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.slice()]));

export function createPlatform() {
  let reachable = false;    // own-server /api answered /time
  let timeOffsetMs = 0;     // server - local
  let synced = false;
  let profile = null;       // { name } for the signed-in player
  let sync = 'offline';     // offline | saving | synced (cloud mirror)
  let bindings = cloneBindings(DEFAULT_BINDINGS);
  let codeMap = null;
  let hooked = false;
  const syncListeners = [];
  const authListeners = [];

  const signedIn = () => { const s = sdk(); return !!(s && s.signedIn); };

  function apiHeaders(extra) {
    const h = extra || {};
    const s = sdk();
    if (s && s.token) h['Authorization'] = 'Bearer ' + s.token;
    return h;
  }

  function setSync(state) {
    if (sync === state) return;
    sync = state;
    for (const fn of syncListeners) {
      try { fn(state); } catch { /* listener errors never break the adapter */ }
    }
  }

  // Display names: the profile nickname (never /api/v1/me, never usernames).
  function profileFor(pid) {
    if (!pid || typeof pid !== 'string') return Promise.resolve('player');
    const s = sdk();
    if (!s || !s.signedIn) return Promise.resolve('Player ' + pid.slice(0, 6));
    return s.profile(pid).then((p) => (p && p.displayName) || 'Player ' + pid.slice(0, 6))
      .catch(() => 'Player ' + pid.slice(0, 6));
  }
  function fetchProfile() {
    const s = sdk();
    if (!s || !s.userId) return Promise.resolve(null);
    return profileFor(s.userId).then((n) => {
      profile = { name: n.slice(0, 40) };
      return profile;
    });
  }

  async function syncTime() {
    if (!signedIn()) return false; // standalone: local clock, no requests
    try {
      const t0 = Date.now();
      // bounded: a host that never answers must not hold the title screen hostage
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined;
      const res = await fetch('/api/v1/time', { cache: 'no-store', signal, headers: apiHeaders() });
      if (!res.ok) return false;
      const body = await res.json();
      const t1 = Date.now();
      if (typeof body.now !== 'number') return false;
      timeOffsetMs = body.now - Math.round((t0 + t1) / 2);
      synced = true;
      reachable = true;
      return true;
    } catch {
      return false;
    }
  }

  function now() {
    return new Date(Date.now() + timeOffsetMs);
  }

  // Platform leaderboard (score-script.js): post a finished round's total to
  // the high-score board; resolves { posted, rank } (rank may be null).
  async function submitScore(total) {
    const s = sdk();
    if (!s || !s.signedIn) return { posted: false, rank: null };
    try {
      const keys = await s.submitScores({ 'high-score': total });
      if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      try {
        const r = await s.leaderboard('high-score', { pageSize: 100 });
        const me = (r.items || []).filter((i) => i.userId === s.userId)[0];
        return { posted: true, rank: me ? me.rank : null };
      } catch { return { posted: true, rank: null }; }
    } catch { return { posted: false, rank: null }; }
  }

  // Cloud save: the SDK slot game:<slug> holds the wrapped {sum, payload}
  // doc string (the checksummed local doc stays the offline cache). Remote
  // wins on boot; saves debounce ~2 s and flush on pagehide/hidden.
  function loadCloud() {
    if (!signedIn()) return Promise.resolve(null);
    return sdk().loadSave().catch(() => null);
  }

  // Called by CDStore.save with the wrapped doc string.
  function onLocalSave(wrapped) {
    if (!signedIn()) return;
    setSync('saving');
    sdk().saveJSON(JSON.parse(wrapped), SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (!signedIn()) return Promise.resolve(false);
    return sdk().flushSave(true);
  }

  // ---- settings KV ----
  function getSettings() {
    if (!signedIn()) return Promise.resolve({});
    return sdk().getSettings().then((s) => s || {}, () => ({}));
  }
  function patchSettings(obj) {
    if (!signedIn()) return Promise.resolve(null);
    return sdk().patchSettings(obj).catch(() => null);
  }

  // ---- controls ----
  function loadBindings() {
    const s = sdk();
    const p = s && s.signedIn ? s.loadBindings(DEFAULT_BINDINGS).catch(() => cloneBindings(DEFAULT_BINDINGS)) : Promise.resolve(cloneBindings(DEFAULT_BINDINGS));
    return p.then((b) => { bindings = b; codeMap = null; return b; });
  }
  function actionFor(e) {
    if (!codeMap) {
      codeMap = {};
      for (const [a, codes] of Object.entries(bindings)) for (const c of codes) codeMap[c] = a;
    }
    if (e.code) return codeMap[e.code] || null;
    const k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return KEY_FALLBACK[k] || null;
  }
  function keyLabel(action) {
    return (bindings[action] || []).map((c) => ({
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Space: 'Space',
    }[c] || c.replace(/^Key|^Digit/, ''))).join(' / ');
  }

  // ---- invite / sign-in ----
  function inviteLink() { const s = sdk(); return s && s.signedIn ? s.inviteLink() : null; }
  async function copyInvite() {
    const link = inviteLink();
    if (!link) return false;
    try { await navigator.clipboard.writeText(link); return true; } catch { return false; }
  }

  function init() {
    const s = sdk();
    if (s && !hooked) {
      hooked = true;
      s.on('saved', (ok) => setSync(ok ? 'synced' : 'offline'));
      s.on('auth', (a) => {
        if (!a.signedIn) { profile = null; reachable = false; setSync('offline'); }
        for (const fn of authListeners) { try { fn(a); } catch { /* ignore */ } }
      });
    }
    if (signedIn()) {
      try {
        window.addEventListener('pagehide', flushSave);
        document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
      } catch { /* no window events available */ }
      fetchProfile(); // nickname lands via the account-line listener
    }
    return syncTime().then((ok) => ({ hosted: signedIn(), reachable: ok }));
  }

  return {
    init,
    syncTime,
    now,
    submitScore,
    profileFor,
    fetchProfile,
    loadCloud,
    onLocalSave,
    flushSave,
    getSettings,
    patchSettings,
    loadBindings,
    actionFor,
    keyLabel,
    inviteLink,
    copyInvite,
    canSignIn() { const s = sdk(); return !!(s && s.canSignIn()); },
    signIn() { const s = sdk(); return !!(s && s.signIn()); },
    onSync(fn) { if (typeof fn === 'function') syncListeners.push(fn); },
    onAuth(fn) { if (typeof fn === 'function') authListeners.push(fn); },
    get bindings() { return bindings; },
    get hosted() { return signedIn(); },
    get tokenHosted() { return signedIn(); },
    get reachable() { return reachable; },
    get synced() { return synced; },
    get profile() { return profile; },
    get sync() { return sync; },
    get userId() { const s = sdk(); return s ? s.userId : null; },
    get gameSlug() { const s = sdk(); return s ? s.slug : null; }
  };
}
