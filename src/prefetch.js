/*
 * Image Flow — prefetch.js  (runs in the background event page)
 * -------------------------------------------------------------------
 * Connection-aware IMAGE prefetching into the Cache Storage image cache.
 *
 * ▶ RATE-LIMIT NOTE: everything in this file fetches image binaries from the
 *   CDN (i.redd.it / preview.redd.it). Those are static files and do **NOT**
 *   count against Reddit's 100 QPM API limit. That is exactly why prefetching
 *   here can be aggressive — it buys perceived speed without spending QPM.
 *   (Contrast: post metadata + comments in background.js DO cost QPM.)
 *
 * The content script can't fetch these cross-origin (post-FF85 content scripts
 * are CORS-bound and i.redd.it sends no ACAO header), so prefetching runs in the
 * background where host_permissions make cross-origin fetches CORS-free. The
 * content script supplies the ordered upcoming URLs plus a connection profile
 * (navigator.connection) and we decide depth here.
 */

import { imageHas, imagePut } from './cache-manager.js';

const inflight = new Map(); // url -> AbortController
let recentSlow = 0; // consecutive slow/failed prefetches (adaptive backoff)
const SLOW_MS = 3000;

/** Choose how many images to prefetch ahead based on the connection profile. */
function depthFor(conn) {
  if (!conn) return 3;
  if (conn.saveData) return 1;
  const t = conn.effectiveType || '4g';
  const down = conn.downlink || 10;
  if (t === 'slow-2g' || t === '2g') return 1;
  if (t === '3g') return 2;
  // 4g / unknown-fast
  return down >= 10 ? 6 : down >= 5 ? 5 : 4;
}

/**
 * Prefetch the first `depth` of `urls` that aren't already cached / in flight.
 * Also cancels any in-flight prefetch whose URL is no longer in the requested
 * window (handles a fast-swiping user who blew past queued images).
 */
export async function runPrefetch(urls = [], conn = null) {
  if (recentSlow >= 2) {
    // Adaptive backoff: after 2 slow/failed in a row, only keep 1 ahead until
    // conditions recover.
    urls = urls.slice(0, 1);
  }
  const depth = Math.min(depthFor(conn), urls.length);
  const wanted = new Set(urls.slice(0, depth));

  // Cancel prefetches the user has navigated past.
  for (const [url, ctrl] of inflight) {
    if (!wanted.has(url)) {
      ctrl.abort();
      inflight.delete(url);
    }
  }

  for (const url of wanted) {
    if (inflight.has(url)) continue;
    if (await imageHas(url)) continue;
    startOne(url);
  }
}

function startOne(url) {
  const ctrl = new AbortController();
  inflight.set(url, ctrl);
  const t0 = performance.now();
  // {cache:'force-cache'} lets the HTTP cache satisfy the request when possible.
  fetch(url, { signal: ctrl.signal, cache: 'force-cache', headers: { Accept: 'image/*' } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await imagePut(url, res);
      const dt = performance.now() - t0;
      recentSlow = dt > SLOW_MS ? recentSlow + 1 : 0;
    })
    .catch((err) => {
      if (err.name !== 'AbortError') recentSlow += 1;
    })
    .finally(() => inflight.delete(url));
}

/** Abort everything (e.g. on gallery close). */
export function cancelAll() {
  for (const [, ctrl] of inflight) ctrl.abort();
  inflight.clear();
}

export function prefetchStats() {
  return { inflight: inflight.size, recentSlow };
}
