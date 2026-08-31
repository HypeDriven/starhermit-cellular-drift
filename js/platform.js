/*
 * Cellular Drift — platform adapter: server-time sync and score submission
 * against same-origin /api routes when hosted (StarHermit). Fully optional:
 * offline play falls back to the local clock and local leaderboards.
 */
export function createPlatform() {
  let timeOffsetMs = 0; // server - local
  let synced = false;

  async function syncTime() {
    try {
      const t0 = Date.now();
      const res = await fetch('/api/v1/time', { cache: 'no-store' });
      if (!res.ok) return false;
      const body = await res.json();
      const t1 = Date.now();
      if (typeof body.now !== 'number') return false;
      timeOffsetMs = body.now - Math.round((t0 + t1) / 2);
      synced = true;
      return true;
    } catch {
      return false; // offline / static hosting: local clock is fine
    }
  }

  function now() {
    return new Date(Date.now() + timeOffsetMs);
  }

  async function submitScore(entry) {
    try {
      const res = await fetch('/api/v1/scores', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function fetchBoard(contentId) {
    try {
      const res = await fetch('/api/v1/scores?content=' + encodeURIComponent(contentId), { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  return { syncTime, now, submitScore, fetchBoard, get synced() { return synced; } };
}
