/*
 * Image Flow — auth.js  (PRIMARY auth path, runs in the background)
 * =======================================================================
 * Session-cookie authentication using the user's EXISTING reddit.com login.
 *
 * Why this exists: a freshly-installed extension cannot rely on separate Reddit
 * app setup. Instead, we make the exact same `.json` requests that reddit.com's
 * own website makes for a logged-in user, sending the user's first-party session
 * cookie via `credentials: 'include'`. No app registration or API key is needed.
 *
 * This is NOT scraping or a third-party data client: it is a navigation/UX layer
 * over the user's own authenticated session, reading only what the user could
 * already see by browsing reddit.com manually. See the compliance block in
 * background.js.
 *
 * NOTE: www.reddit.com/.json does NOT return X-Ratelimit-* headers, so the
 * background self-throttles conservatively (~30 req/min) — see background.js.
 */

const api = globalThis.browser || globalThis.chrome;
const WWW = 'https://www.reddit.com';
const VALID_SORTS = ['hot', 'new', 'top', 'rising', 'best'];

/**
 * Verify the user has a valid reddit.com session. Prefers a direct cookie check
 * (needs the "cookies" permission), then falls back to /api/me.json.
 */
export async function checkSession() {
  // 1) Cheap cookie presence check.
  try {
    if (api.cookies?.get) {
      const c = await api.cookies.get({ url: WWW, name: 'reddit_session' });
      if (c && c.value) {
        const me = await fetchMe().catch(() => null);
        return { loggedIn: true, name: me?.name || null, via: 'cookie' };
      }
    }
  } catch {
    /* fall through to /api/me.json */
  }
  // 2) Authoritative check: /api/me.json returns the account when logged in.
  const me = await fetchMe().catch(() => null);
  if (me?.name) return { loggedIn: true, name: me.name, via: 'me' };
  return { loggedIn: false, name: null };
}

/** GET /api/me.json with the user's cookie. Logged-out ⇒ `{}` (no name). */
export async function fetchMe() {
  const res = await fetch(`${WWW}/api/me.json`, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`me ${res.status}`), { status: res.status });
  const data = await res.json();
  return { name: data?.data?.name || data?.name || null };
}

/* ---------------- Session-mode `.json` URL builders ---------------- */
// A feed is either a subreddit (/r/<name>/<sort>.json) or a user's submissions
// (/user/<name>/submitted.json?sort=...). `name` is the sub or username.
export function listingUrl({ kind = 'subreddit', name, sub, sort = 'hot', after = null, t = null, limit = 100 }) {
  const n = name || sub;
  const params = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (after) params.set('after', after);
  if (t) params.set('t', t);
  if (kind === 'user') {
    // /user/<name>/submitted takes sort as a query param (hot/new/top/…).
    params.set('sort', VALID_SORTS.includes(sort) ? sort : 'new');
    return `${WWW}/user/${encodeURIComponent(n)}/submitted.json?${params.toString()}`;
  }
  const sp = VALID_SORTS.includes(sort) ? sort : 'hot';
  return `${WWW}/r/${encodeURIComponent(n)}/${sp}.json?${params.toString()}`;
}

// Canonical comment-thread JSON: /comments/<id>.json — the most reliable form.
// (Appending `.json` to a stripped permalink slug can 30x-redirect to HTML,
//  which the session fetch then treats as a login page. Using the id avoids it.)
export function commentsUrl({ id, permalink, sort = 'top' }) {
  const params = new URLSearchParams({ raw_json: '1', sort, limit: '100' });
  if (id) return `${WWW}/comments/${encodeURIComponent(id)}.json?${params.toString()}`;
  return `${WWW}${permalink.replace(/\/+$/, '')}/.json?${params.toString()}`;
}

export function moreUrl({ linkId, children, sort = 'top' }) {
  const params = new URLSearchParams({
    api_type: 'json', raw_json: '1', link_id: linkId, sort,
    children: (children || []).slice(0, 100).join(','),
  });
  return `${WWW}/api/morechildren.json?${params.toString()}`;
}
