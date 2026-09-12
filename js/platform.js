/*
 * Cellular Drift — platform adapter: launch-token lifecycle (fragment read,
 * Bearer, 45-min refresh), profile nickname, cloud-save mirror for the
 * progress doc, plus server-time sync and score submission/board against
 * the game's own same-origin backend routes when reachable. Fully optional:
 * offline play falls back to the local clock and local leaderboards, and
 * no /api call is made at all unless a launch token or the own server was
 * detected.
 *
 * The platform opens the game as index.html#game_token=<jwt> (optional
 * &session_id=), stripped after the read. The JWT carries sub = user id
 * and game_scope = this game's slug — never hard-coded. The token is kept
 * in memory only — never written to localStorage.
 */
const REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
const RETRY_MS = 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function createPlatform() {
  let launchToken = null;   // memory only — never persisted
  let userId = null;        // JWT sub
  let gameSlug = null;      // JWT game_scope
  let hosted = false;       // a launch token was read
  let reachable = false;    // own-server /api answered /time
  let timeOffsetMs = 0;     // server - local
  let synced = false;
  let profile = null;       // { name } for the signed-in player
  let sync = 'offline';     // offline | saving | synced (cloud mirror)
  const syncListeners = [];
  const profileNames = {};  // userId -> Promise<string>
  let refreshTimer = null, retryTimer = null;
  let saveTimer = null, pendingSave = null, saveWaiters = [];

  function apiHeaders(extra) {
    const h = extra || {};
    if (launchToken) h['Authorization'] = 'Bearer ' + launchToken;
    return h;
  }

  function decodeJwt(t) {
    try {
      const seg = String(t).split('.')[1];
      if (!seg) return null;
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  // Fragment first (platform contract); query forms are local-dev only.
  function readLaunchToken() {
    try {
      const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        const rest = h.toString();
        history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
        return t;
      }
      const q = new URLSearchParams(location.search);
      return q.get('game_token') || q.get('token') || q.get('launch_token') || null;
    } catch {
      return null;
    }
  }

  function setSync(state) {
    if (sync === state) return;
    sync = state;
    for (const fn of syncListeners) {
      try { fn(state); } catch { /* listener errors never break the adapter */ }
    }
  }

  // The token lives 60 min; scoped tokens may re-mint via the game's
  // launch-token route. Retry a failed re-mint after ~60 s.
  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshToken, REFRESH_MS);
  }
  function refreshToken() {
    if (!launchToken || !gameSlug) return Promise.resolve(false);
    return fetch('/api/v1/games/' + encodeURIComponent(gameSlug) + '/launch-token', {
      method: 'POST', headers: apiHeaders({ 'content-type': 'application/json' }), body: '{}'
    }).then((r) => r.json().catch(() => null)).then((j) => {
      if (j && typeof j.token === 'string' && j.token) {
        launchToken = j.token;
        const claims = decodeJwt(launchToken);
        if (claims && claims.sub) userId = claims.sub;
        if (claims && claims.game_scope) gameSlug = claims.game_scope;
        return true;
      }
      retryRefresh();
      return false;
    }).catch(() => { retryRefresh(); return false; });
  }
  function retryRefresh() {
    if (retryTimer || !launchToken) return;
    retryTimer = setTimeout(() => { retryTimer = null; refreshToken(); }, RETRY_MS);
  }

  // Display names: the profile nickname is the only profile read a
  // game-scoped token may make (never /api/v1/me, never usernames).
  // Cached per id; off-platform falls back to a neutral shortened id.
  function profileFor(pid) {
    if (!pid || typeof pid !== 'string') return Promise.resolve('player');
    if (profileNames[pid]) return profileNames[pid];
    const p = fetch('/api/v1/users/' + encodeURIComponent(pid) + '/profile', { headers: apiHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j.nickname === 'string' && j.nickname ? j.nickname : null))
      .then((n) => n || ('Player ' + pid.slice(0, 8)))
      .catch(() => 'Player ' + pid.slice(0, 8));
    profileNames[pid] = p;
    return p;
  }
  function fetchProfile() {
    if (!userId) return Promise.resolve(null);
    return profileFor(userId).then((n) => {
      profile = { name: n.slice(0, 40) };
      return profile;
    });
  }

  async function syncTime() {
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
      return false; // offline / static hosting: local clock is fine
    }
  }

  function now() {
    return new Date(Date.now() + timeOffsetMs);
  }

  // Own-server backend routes (declared server=server.js): ranked scores.
  // On the platform these run behind the declared backend; when they 404
  // the failure is swallowed silently (no console errors).
  async function submitScore(entry) {
    if (!reachable) return false;
    try {
      const res = await fetch('/api/v1/scores', {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(entry)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function fetchBoard(contentId) {
    if (!reachable) return null;
    try {
      const res = await fetch('/api/v1/scores?content=' + encodeURIComponent(contentId), { cache: 'no-store', headers: apiHeaders() });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // cloud save: ONE zip+base64 slot at /api/v1/me/cloud-saves/{slug}. The
  // checksummed local save doc stays the offline cache; this mirrors the
  // wrapped doc string. Remote wins on boot (the caller validates the
  // checksum through CDStore.loadRaw). Saves debounce ~2 s and flush on
  // pagehide/hidden with keepalive.
  // ---------------------------------------------------------------------

  function loadCloud() {
    if (!hosted || !gameSlug) return Promise.resolve(null);
    return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(gameSlug), { headers: apiHeaders() })
      .then((res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('http-' + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (!buf || !buf.byteLength) return null;
        return new TextDecoder().decode(unzipFirstEntry(new Uint8Array(buf)));
      })
      .catch(() => null);
  }

  // Called by CDStore.save with the wrapped {sum, payload} doc string.
  function onLocalSave(wrapped) {
    if (!hosted || !gameSlug) return;
    pendingSave = wrapped;
    setSync('saving');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const waiters = saveWaiters;
    saveWaiters = [];
    if (!hosted || !gameSlug || pendingSave == null) return Promise.resolve(false);
    const wrapped = pendingSave;
    pendingSave = null;
    let body;
    try {
      body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(wrapped))) };
    } catch {
      return Promise.resolve(false);
    }
    return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(gameSlug), {
      method: 'PUT',
      headers: apiHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      keepalive: true
    }).then((res) => {
      if (res.ok) { setSync('synced'); return true; }
      pendingSave = pendingSave == null ? wrapped : pendingSave;
      setSync('offline');
      return false;
    }).catch(() => {
      pendingSave = pendingSave == null ? wrapped : pendingSave;
      setSync('offline');
      return false;
    });
  }

  function init() {
    launchToken = readLaunchToken();
    if (launchToken) {
      const claims = decodeJwt(launchToken);
      if (!claims) launchToken = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) gameSlug = claims.game_scope;
        if (!userId || !gameSlug) launchToken = null; // not a usable launch token
      }
    }
    hosted = !!launchToken;
    if (hosted) {
      scheduleRefresh();
      try {
        window.addEventListener('pagehide', flushSave);
        document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
      } catch { /* no window events available */ }
      fetchProfile(); // nickname lands via the account-line listener
    }
    return syncTime().then((ok) => ({ hosted, reachable: ok }));
  }

  return {
    init,
    syncTime,
    now,
    submitScore,
    fetchBoard,
    profileFor,
    fetchProfile,
    loadCloud,
    onLocalSave,
    flushSave,
    onSync(fn) { if (typeof fn === 'function') syncListeners.push(fn); },
    get hosted() { return hosted; },
    get tokenHosted() { return hosted; },
    get reachable() { return reachable; },
    get synced() { return synced; },
    get profile() { return profile; },
    get sync() { return sync; },
    get userId() { return userId; },
    get gameSlug() { return gameSlug; }
  };
}
