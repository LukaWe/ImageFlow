/*
 * Image Flow — background event page (MV3 / Firefox, non-persistent)
 * =========================================================================
 *
 * COMPLIANCE / DESIGN NOTE — honest description of how auth works
 * --------------------------------------------------------------
 * This extension uses the USER'S OWN existing reddit.com login session. It
 * makes the same `www.reddit.com/.../.json` requests that reddit.com's website
 * already makes for that logged-in user, sending the user's first-party session
 * cookie via `credentials:'include'`. This is standard browser-side automation
 * of a service the user is already an authorized member of. It is NOT bulk
 * scraping, NOT third-party data resale, and exposes NO data the user couldn't
 * already see by browsing reddit.com manually — it is purely a navigation/UX
 * layer over their own session. Because these endpoints return no
 * X-Ratelimit-* headers, we self-throttle CONSERVATIVELY (~30 req/min) and
 * cache aggressively.
 *
 * The user is told this up front (first-run-notice.html) and warned that a
 * policy change on Reddit's side may require an extension update.
 *
 * WHAT COSTS API BUDGET vs. WHAT DOESN'T
 * --------------------------------------
 *   • Reddit `.json` session requests — listings/comments:
 *       COUNTS toward the self-imposed 30/min;
 *       short-circuited by the IndexedDB metadata cache.
 *   • CDN image binaries (i.redd.it / preview.redd.it): DOES NOT COUNT — served
 *       and prefetched through the Cache Storage image cache (cache-manager.js,
 *       prefetch.js). Prefetch aggressively; it's free.
 */

import * as auth from './auth.js';
import * as cache from './cache-manager.js';
import { runPrefetch, cancelAll as cancelAllPrefetch, prefetchStats } from './prefetch.js';

const api = globalThis.browser || globalThis.chrome;
const META_TTL_MS = 5 * 60 * 1000; // 5 min metadata TTL

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Session stats (for the debug overlay)                              */
/* ------------------------------------------------------------------ */
const stats = { apiCalls: 0, imageHits: 0, imageMisses: 0, since: Date.now() };

/* ------------------------------------------------------------------ */
/* Session request serialization + conservative backoff                */
/* ------------------------------------------------------------------ */
let gateUntil = 0; // pause new Reddit metadata calls until this timestamp

async function backoffGate(tabId) {
  const now = Date.now();
  if (gateUntil > now) {
    const secs = Math.ceil((gateUntil - now) / 1000);
    notifyTab(tabId, { type: 'RATE_LIMIT', seconds: secs, reason: 'backoff' });
    await sleep(gateUntil - now);
  }
}

// Serialize API calls so the gate/bucket can't be bypassed by parallel bursts.
let apiChain = Promise.resolve();
function enqueueApi(fn) {
  const run = apiChain.then(fn, fn);
  // keep the chain alive regardless of individual outcomes
  apiChain = run.then(() => {}, () => {});
  return run;
}

/* ------------------------------------------------------------------ */
/* SESSION MODE (primary) — the user's own reddit.com login cookie     */
/* ------------------------------------------------------------------ */
/* www.reddit.com/.json returns NO X-Ratelimit-* headers, so we can't see real
 * headroom — self-throttle conservatively at ~30 req/min and back off hard. */
const SESSION_RPM = 30;
const bucket = { tokens: SESSION_RPM, last: Date.now() };
function refillBucket() {
  const now = Date.now();
  bucket.tokens = Math.min(SESSION_RPM, bucket.tokens + ((now - bucket.last) / 60_000) * SESSION_RPM);
  bucket.last = now;
}
async function takeToken(tabId) {
  refillBucket();
  while (bucket.tokens < 1) {
    const waitMs = Math.max(500, Math.ceil(((1 - bucket.tokens) / SESSION_RPM) * 60_000));
    notifyTab(tabId, { type: 'RATE_LIMIT', seconds: Math.ceil(waitMs / 1000), reason: 'throttle' });
    await sleep(waitMs);
    refillBucket();
  }
  bucket.tokens -= 1;
}

// Graceful-failure detection: repeated auth failures flip a "needs update" flag
// so the UI can tell the user the access method broke (rather than retry-spam).
let consecutiveAuthFail = 0;
let needsUpdate = false;

/** Session-mode GET using the user's cookie; conservative throttle + backoff. */
async function sessionGet(url, tabId) {
  return enqueueApi(async () => {
    let backoff = 5000; // session backoff: 5s → doubling → 120s cap
    for (let attempt = 0; attempt < 6; attempt++) {
      await backoffGate(tabId);
      await takeToken(tabId);
      let res;
      try {
        res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      stats.apiCalls++;

      if (res.status === 429 || res.status === 403) {
        if (res.status === 403) consecutiveAuthFail++;
        notifyTab(tabId, { type: 'RATE_LIMIT', seconds: Math.round(backoff / 1000), reason: String(res.status) });
        gateUntil = Date.now() + backoff;
        if (consecutiveAuthFail >= 4) { needsUpdate = true; return { ok: false, needsUpdate: true, status: res.status }; }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 120_000);
        continue;
      }
      if (res.status === 401) {
        consecutiveAuthFail++;
        if (consecutiveAuthFail >= 4) { needsUpdate = true; return { ok: false, needsUpdate: true, status: 401 }; }
        return { ok: false, needLogin: true, status: 401 };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };

      // A logged-out or bot-challenge response is HTML, not JSON — treat as auth.
      let data;
      try { data = await res.json(); }
      catch {
        consecutiveAuthFail++;
        if (consecutiveAuthFail >= 4) { needsUpdate = true; return { ok: false, needsUpdate: true }; }
        return { ok: false, needLogin: true, error: 'non-JSON (login or challenge page)' };
      }
      consecutiveAuthFail = 0;
      return { ok: true, data };
    }
    return { ok: false, error: 'gave up after backoff' };
  });
}

/* ---- Listings ---- */
async function getListing(msg) {
  const nm = msg.name || msg.sub;
  const key = `listing|${msg.kind || 'subreddit'}|${nm}|${msg.sort}|${msg.after || ''}|${msg.t || ''}`;
  const cached = await cache.metaGet(key, META_TTL_MS); // HIT ⇒ no request at all
  if (cached) return { ok: true, data: cached, fromCache: true };

  const res = await sessionGet(auth.listingUrl(msg), msg.__tabId);
  if (res.ok) await cache.metaSet(key, res.data);
  return { ...res, fromCache: false, mode: 'session' };
}

/* ---- Comments (lazy: only fetched when the panel opens) ---- */
async function getComments(msg) {
  const key = `comments|${msg.id || msg.permalink}|${msg.sort || 'top'}`;
  const cached = await cache.metaGet(key, META_TTL_MS);
  if (cached) return { ok: true, data: cached, fromCache: true };

  const res = await sessionGet(auth.commentsUrl(msg), msg.__tabId);
  if (res.ok) await cache.metaSet(key, res.data);
  return { ...res, fromCache: false, mode: 'session' };
}

async function getMore(msg) {
  const res = await sessionGet(auth.moreUrl(msg), msg.__tabId);
  if (!res.ok) return res;
  return { ok: true, things: res.data?.json?.data?.things || [] };
}

/* ---- Unified auth status for the UI ---- */
async function authStatus() {
  const s = await auth.checkSession();
  return { mode: 'session', needsUpdate, loggedIn: s.loggedIn, name: s.name };
}

/* ------------------------------------------------------------------ */
/* Image broker (CDN — DOES NOT count against QPM)                    */
/* ------------------------------------------------------------------ */
async function getImage({ url }) {
  const cached = await cache.imageGet(url);
  if (cached) { stats.imageHits++; return { ok: true, blob: cached, fromCache: true }; }
  stats.imageMisses++;
  try {
    const res = await fetch(url, { cache: 'force-cache', headers: { Accept: 'image/*' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    await cache.imagePut(url, res.clone());
    return { ok: true, blob: await res.blob(), fromCache: false };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function imageCacheCapBytes() {
  const { settings = {} } = await api.storage.local.get('settings');
  const mb = Number(settings.imageCacheMB) || 250;
  return mb * 1024 * 1024;
}

/* ------------------------------------------------------------------ */
/* Downloads (single / sequential / ZIP)                              */
/* ------------------------------------------------------------------ */
async function downloadOne({ url, filename }) {
  const id = await api.downloads.download({ url, filename: sanitize(filename), saveAs: false, conflictAction: 'uniquify' });
  return { ok: true, id };
}
async function downloadMany({ items = [] }) {
  const ids = [];
  for (const it of items) {
    try { ids.push((await downloadOne(it)).id); } catch (e) { ids.push({ error: String(e) }); }
    await sleep(150);
  }
  return { ok: true, ids };
}
async function zipDownload({ items = [], zipName = 'image-flow.zip' }) {
  const files = [];
  const failures = [];
  for (const it of items) {
    try {
      // Reuse the image cache when we can — still a CDN op, never an API call.
      let blob = await cache.imageGet(it.url);
      if (!blob) {
        const res = await fetch(it.url, { headers: { Accept: 'image/*' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await cache.imagePut(it.url, res.clone());
        blob = await res.blob();
      }
      files.push({ name: dedupe(it.filename, files), data: new Uint8Array(await blob.arrayBuffer()) });
    } catch (err) { failures.push({ url: it.url, error: String(err) }); }
  }
  if (!files.length) return { ok: false, error: 'No images downloaded', failures };
  const url = URL.createObjectURL(new Blob([buildZip(files)], { type: 'application/zip' }));
  try {
    const id = await api.downloads.download({ url, filename: sanitize(zipName), saveAs: false, conflictAction: 'uniquify' });
    setTimeout(() => URL.revokeObjectURL(url), 90_000);
    return { ok: true, id, count: files.length, failures };
  } catch (err) { URL.revokeObjectURL(url); return { ok: false, error: String(err), failures }; }
}
const sanitize = (n) => String(n).replace(/[<>:"|?*]/g, '_').replace(/\.\.+/g, '.').trim();
function dedupe(name, files) {
  const taken = new Set(files.map((f) => f.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  let i = 1; let c;
  do { c = dot > 0 ? `${name.slice(0, dot)}(${i})${name.slice(dot)}` : `${name}(${i})`; i++; } while (taken.has(c));
  return c;
}

/* ---- Minimal ZIP writer (STORE + CRC-32); replaces JSZip, CSP-safe ---- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function buildZip(files) {
  const enc = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const D = 0x21, F = 0x0800;
  for (const f of files) {
    const nm = enc.encode(f.name); const d = f.data; const crc = crc32(d);
    const h = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(F), ...u16(0), ...u16(0), ...u16(D), ...u32(crc), ...u32(d.length), ...u32(d.length), ...u16(nm.length), ...u16(0)]);
    chunks.push(h, nm, d);
    central.push({ head: new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(F), ...u16(0), ...u16(0), ...u16(D), ...u32(crc), ...u32(d.length), ...u32(d.length), ...u16(nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name: nm });
    offset += h.length + nm.length + d.length;
  }
  const start = offset; let cSize = 0;
  for (const c of central) { chunks.push(c.head, c.name); cSize += c.head.length + c.name.length; }
  chunks.push(new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cSize), ...u32(start), ...u16(0)]));
  let total = 0; for (const c of chunks) total += c.length;
  const out = new Uint8Array(total); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/* ------------------------------------------------------------------ */
/* Idle LRU pruning of the image cache                                */
/* ------------------------------------------------------------------ */
async function pruneNow() {
  try { await cache.pruneImages(await imageCacheCapBytes()); } catch (e) { /* ignore */ }
}
setInterval(pruneNow, 3 * 60 * 1000); // every 3 min, off the UI thread entirely

/* ------------------------------------------------------------------ */
/* Toolbar badge + tab notifications                                  */
/* ------------------------------------------------------------------ */
async function setBadge({ text = '', tabId }) {
  try { await api.action.setBadgeBackgroundColor({ color: '#ff2d55' }); await api.action.setBadgeText({ text: String(text || ''), tabId }); } catch { /* */ }
}
function notifyTab(tabId, msg) { if (tabId != null) api.tabs.sendMessage(tabId, msg).catch(() => {}); }

/* ------------------------------------------------------------------ */
/* Message router                                                     */
/* ------------------------------------------------------------------ */
api.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender?.tab?.id;
  switch (msg?.type) {
    /* ---- Auth status ---- */
    case 'AUTH_STATUS': return authStatus();
    case 'AUTH_RESET': // user clicked "retry" after a login/needs-update banner
      needsUpdate = false; consecutiveAuthFail = 0;
      return authStatus();

    /* ---- Reddit API (rate-limited) ---- */
    case 'API_LISTING': return getListing({ ...msg, __tabId: tabId });
    case 'API_COMMENTS': return getComments({ ...msg, __tabId: tabId });
    case 'API_MORE': return getMore({ ...msg, __tabId: tabId });

    /* ---- CDN images (unlimited) ---- */
    case 'IMG_GET': return getImage(msg);
    case 'IMG_PREFETCH': return runPrefetch(msg.urls, msg.conn).then(() => ({ ok: true }));
    case 'IMG_CANCEL': return Promise.resolve(cancelAllPrefetch()).then(() => ({ ok: true }));

    /* ---- Downloads ---- */
    case 'DOWNLOAD': return downloadOne(msg).catch((e) => ({ ok: false, error: String(e) }));
    case 'DOWNLOAD_MANY': return downloadMany(msg).catch((e) => ({ ok: false, error: String(e) }));
    case 'ZIP_DOWNLOAD': return zipDownload(msg).catch((e) => ({ ok: false, error: String(e) }));

    /* ---- Stats / cache / misc ---- */
    case 'CACHE_STATS':
      return cache.cacheStats().then((c) => ({
        ok: true,
        ...c,
        mode: 'session',
        api: { calls: stats.apiCalls, remaining: Math.floor((refillBucket(), bucket.tokens)), reset: 0, limit: SESSION_RPM },
        images: { hits: stats.imageHits, misses: stats.imageMisses },
        prefetch: prefetchStats(),
      }));
    case 'CACHE_CLEAR': return cache.clearAll().then(() => ({ ok: true }));
    // Reddit's page CSP blocks a content-script <link> to our moz-extension
    // stylesheet, so the content script asks us for the CSS text (background is
    // not subject to page CSP) and applies it via a constructable stylesheet.
    case 'GET_CSS':
      return fetch(api.runtime.getURL('src/gallery.css'))
        .then((r) => r.text())
        .then((css) => ({ ok: true, css }))
        .catch((e) => ({ ok: false, error: String(e), css: '' }));
    case 'SET_BADGE': return setBadge({ ...msg, tabId });
    // openOptionsPage() is not exposed to content scripts, so the gallery asks
    // the background (an extension context) to open Settings on its behalf.
    case 'OPEN_OPTIONS':
      return (api.runtime.openOptionsPage ? api.runtime.openOptionsPage() : Promise.reject(new Error('no options')))
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: String(e) }));

    default: return false;
  }
});

api.tabs?.onRemoved?.addListener((tabId) => setBadge({ text: '', tabId }));

// Honest, user-facing heads-up about the session-based auth approach.
const SESSION_WARNING =
  '[Image Flow] This extension relies on your Reddit login session. If Reddit\'s ' +
  'policies change or this stops working, an update may be required.';
console.warn(SESSION_WARNING);

api.runtime.onInstalled?.addListener((details) => {
  if (details?.reason === 'install') {
    api.storage.local.get('firstRunShown').then(({ firstRunShown }) => {
      if (firstRunShown) return;
      api.storage.local.set({ firstRunShown: true });
      api.tabs.create({ url: api.runtime.getURL('src/first-run-notice.html') }).catch(() => {});
    });
  }
});
