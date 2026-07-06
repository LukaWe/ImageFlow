/*
 * Image Flow — toolbar popup.
 * Picks a subreddit + sort, launches the gallery, and shows Reddit session
 * status.
 */
const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const REDDIT_RE = /:\/\/([^/]*\.)?reddit\.com\//i;
const DEFAULT_QUICK = ['pics', 'EarthPorn', 'aww', 'itookapicture', 'wallpapers'];

async function init() {
  const { settings = {} } = await api.storage.local.get('settings');
  $('sort').value = settings.defaultSort || 'hot';

  const tab = await activeTab();
  // Pre-fill from the current Reddit tab: a subreddit or a /user/<name> page.
  let fromUrl = null;
  if (tab?.url && REDDIT_RE.test(tab.url)) {
    const u = /\/(?:user|u)\/([^/?#]+)/i.exec(tab.url);
    const r = /\/r\/([^/?#]+)/i.exec(tab.url);
    if (u) fromUrl = `u/${u[1]}`;
    else if (r) fromUrl = r[1];
  }
  $('sub').value = fromUrl || 'pics';
  $('sub').select();

  const quick = $('quick');
  for (const s of DEFAULT_QUICK) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = `r/${s}`;
    chip.addEventListener('click', () => { $('sub').value = s; launch(); });
    quick.append(chip);
  }

  refreshAuth();
  $('open').addEventListener('click', launch);
  $('sub').addEventListener('keydown', (e) => { if (e.key === 'Enter') launch(); });
  $('settings').addEventListener('click', () => api.runtime.openOptionsPage());
  $('help').addEventListener('click', () => api.runtime.openOptionsPage());
}

/* ---- Auth status ---- */
async function refreshAuth() {
  const dot = $('loginDot');
  const text = $('loginText');
  const hint = $('loginHint');
  const authBtn = $('authBtn');
  try {
    const st = await api.runtime.sendMessage({ type: 'AUTH_STATUS' });
    if (st?.needsUpdate) {
      dot.className = 'dot out';
      text.textContent = 'Access method needs updating';
      hint.textContent = 'Reddit changed something. Check for an extension update.';
      authBtn.textContent = 'Open Settings'; authBtn.dataset.action = 'settings'; authBtn.style.display = '';
    } else if (st?.loggedIn) {
      dot.className = 'dot in';
      text.textContent = st.name ? `Using session: u/${st.name}` : 'Using your Reddit session';
      hint.textContent = 'Signed in via your reddit.com session — no setup needed.';
      authBtn.style.display = 'none';
    } else {
      dot.className = 'dot out';
      text.textContent = 'Not logged in to Reddit';
      hint.textContent = 'Log in to reddit.com in a tab, then reopen this popup.';
      authBtn.textContent = 'Open Reddit login'; authBtn.dataset.action = 'login'; authBtn.style.display = '';
    }
  } catch {
    dot.className = 'dot';
    text.textContent = 'Could not check connection';
  }
  authBtn.onclick = onAuthClick;
}

async function onAuthClick() {
  const btn = $('authBtn');
  const action = btn.dataset.action;
  if (action === 'settings') return api.runtime.openOptionsPage();
  if (action === 'login') return api.tabs.create({ url: 'https://www.reddit.com/login' });
}

/* ------------------------------ Launch --------------------------------- */
// Parse the input into a feed source: "u/name" / "user/name" → user; else subreddit.
function parseSource(v) {
  const s = (v || '').trim();
  let m = /^\/?(?:u|user)\/([^/?#\s]+)/i.exec(s);
  if (m) return { kind: 'user', name: m[1] };
  m = /^\/?r\/([^/?#\s]+)/i.exec(s);
  if (m) return { kind: 'subreddit', name: m[1] };
  const name = s.split(/[/?#\s]/)[0] || 'pics';
  return { kind: 'subreddit', name };
}
async function activeTab() { const [tab] = await api.tabs.query({ active: true, currentWindow: true }); return tab; }

async function launch() {
  const src = parseSource($('sub').value);
  const sort = $('sort').value;
  const tab = await activeTab();
  if (tab?.url && REDDIT_RE.test(tab.url)) {
    try { await api.tabs.sendMessage(tab.id, { type: 'START_GALLERY', sub: src.name, kind: src.kind, sort }); window.close(); return; } catch { /* fall through */ }
  }
  await api.storage.local.set({ pendingGallery: { sub: src.name, kind: src.kind, sort, ts: Date.now() } });
  const url = src.kind === 'user'
    ? `https://www.reddit.com/user/${encodeURIComponent(src.name)}/submitted/`
    : `https://www.reddit.com/r/${encodeURIComponent(src.name)}/`;
  await api.tabs.create({ url });
  window.close();
}

init();
