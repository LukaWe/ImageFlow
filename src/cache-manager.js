/*
 * Image Flow — cache-manager.js  (runs in the background event page)
 * -------------------------------------------------------------------------
 * TWO-TIER CACHE, with a hard rule about what touches the rate-limited API:
 *
 *   ┌─ metadata cache (IndexedDB) ──────────────────────────────────────────┐
 *   │ Structured JSON: post listings + comment trees, keyed by              │
 *   │ subreddit+sort+after (listings) or permalink+sort (comments).         │
 *   │ A HIT here AVOIDS a Reddit API call (saves QPM). TTL ~5–10 min.        │
 *   └───────────────────────────────────────────────────────────────────────┘
 *   ┌─ image binary cache (Cache Storage API) ──────────────────────────────┐
 *   │ Real HTTP responses for i.redd.it / preview.redd.it images. These are │
 *   │ static CDN files — fetching/caching them does NOT count against the   │
 *   │ Reddit API rate limit. Cap + LRU eviction keeps disk/memory bounded.  │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * Cache Storage (caches.*) is purpose-built for binary HTTP responses and is
 * faster + more memory-efficient than base64-in-IndexedDB, so images live there
 * while only their small LRU bookkeeping (url→{size,ts}) lives in IndexedDB.
 */

const DB_NAME = 'image-flow';
const DB_VERSION = 1;
const STORE_META = 'meta'; // { key, data, ts }
const STORE_IMGIDX = 'imgidx'; // { url, size, ts }
const IMAGE_CACHE = 'image-flow-images-v1';

/* ---------------------- tiny promisified IndexedDB ---------------------- */
let dbPromise = null;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_META)) d.createObjectStore(STORE_META, { keyPath: 'key' });
      if (!d.objectStoreNames.contains(STORE_IMGIDX)) d.createObjectStore(STORE_IMGIDX, { keyPath: 'url' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        Promise.resolve(fn(s)).then((v) => (out = v));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}
const idbGet = (store, key) =>
  tx(store, 'readonly', (s) => new Promise((res) => { const r = s.get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }));
const idbPut = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
const idbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
const idbAll = (store) =>
  tx(store, 'readonly', (s) => new Promise((res) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); }));

/* ----------------------------- metadata cache ---------------------------- */
/**
 * Read cached metadata if present and younger than ttlMs. A hit means we do NOT
 * call the Reddit API. Returns null on miss/expiry.
 */
export async function metaGet(key, ttlMs) {
  const row = await idbGet(STORE_META, key);
  if (!row) return null;
  if (typeof ttlMs === 'number' && Date.now() - row.ts > ttlMs) return null;
  return row.data;
}
export async function metaSet(key, data) {
  await idbPut(STORE_META, { key, data, ts: Date.now() });
}

/* --------------------------- image binary cache -------------------------- */
export async function imageHas(url) {
  const cache = await caches.open(IMAGE_CACHE);
  return Boolean(await cache.match(url));
}

/** Return a cached image Blob (and refresh its LRU timestamp), or null. */
export async function imageGet(url) {
  const cache = await caches.open(IMAGE_CACHE);
  const res = await cache.match(url);
  if (!res) return null;
  const idx = await idbGet(STORE_IMGIDX, url);
  await idbPut(STORE_IMGIDX, { url, size: idx?.size ?? 0, ts: Date.now() }); // touch (LRU)
  return res.blob();
}

/** Store a fetched CDN Response (clone) + record size/time for LRU. */
export async function imagePut(url, response) {
  const cache = await caches.open(IMAGE_CACHE);
  const clone = response.clone();
  await cache.put(url, response);
  let size = Number(clone.headers.get('content-length')) || 0;
  if (!size) size = (await clone.blob()).size;
  await idbPut(STORE_IMGIDX, { url, size, ts: Date.now() });
}

export async function cacheStats() {
  const idx = await idbAll(STORE_IMGIDX);
  const meta = await idbAll(STORE_META);
  const bytes = idx.reduce((a, r) => a + (r.size || 0), 0);
  return { imageCount: idx.length, imageBytes: bytes, metaCount: meta.length };
}

/**
 * LRU eviction: if total cached image bytes exceed capBytes, delete the
 * oldest-accessed entries (from both Cache Storage and the index) until under
 * cap. Cheap enough to run on an idle interval; never blocks the UI thread.
 */
export async function pruneImages(capBytes) {
  const idx = await idbAll(STORE_IMGIDX);
  let total = idx.reduce((a, r) => a + (r.size || 0), 0);
  if (total <= capBytes) return { evicted: 0, bytes: total };
  const cache = await caches.open(IMAGE_CACHE);
  idx.sort((a, b) => a.ts - b.ts); // oldest first
  let evicted = 0;
  for (const row of idx) {
    if (total <= capBytes) break;
    await cache.delete(row.url).catch(() => {});
    await idbDel(STORE_IMGIDX, row.url).catch(() => {});
    total -= row.size || 0;
    evicted++;
  }
  return { evicted, bytes: total };
}

export async function clearAll() {
  await caches.delete(IMAGE_CACHE).catch(() => {});
  await tx(STORE_META, 'readwrite', (s) => s.clear());
  await tx(STORE_IMGIDX, 'readwrite', (s) => s.clear());
}
