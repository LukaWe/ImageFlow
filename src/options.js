/*
 * Image Flow — options page.
 * Persists a single `settings` object in browser.storage.local (applied live by
 * the content script) and shows Reddit session status.
 */
const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  commentsSide: 'right',
  slideshowSeconds: 5,
  slideshowFirstDelaySeconds: 5,
  slideshowTransitionMs: 220,
  slideshowPauseOnHover: true,
  nsfwBlur: true,
  defaultSort: 'hot',
  panelWidth: 400,
  dataSaver: false,
  imageCacheMB: 250,
  showTitle: true,
};

const FIELDS = {
  commentsSide: { el: 'commentsSide', kind: 'value' },
  defaultSort: { el: 'defaultSort', kind: 'value' },
  nsfwBlur: { el: 'nsfwBlur', kind: 'checked' },
  showTitle: { el: 'showTitle', kind: 'checked' },
  slideshowSeconds: { el: 'slideshowSeconds', kind: 'number', out: 'slideshowSecondsVal', suffix: 's' },
  slideshowFirstDelaySeconds: { el: 'slideshowFirstDelaySeconds', kind: 'number', out: 'slideshowFirstDelaySecondsVal', suffix: 's' },
  slideshowTransitionMs: { el: 'slideshowTransitionMs', kind: 'number', out: 'slideshowTransitionMsVal', suffix: ' ms' },
  slideshowPauseOnHover: { el: 'slideshowPauseOnHover', kind: 'checked' },
  panelWidth: { el: 'panelWidth', kind: 'number', out: 'panelWidthVal', suffix: 'px' },
  dataSaver: { el: 'dataSaver', kind: 'checked' },
  imageCacheMB: { el: 'imageCacheMB', kind: 'number', out: 'imageCacheMBVal', suffix: ' MB' },
};

async function load() {
  const { settings = {} } = await api.storage.local.get('settings');
  const merged = { ...DEFAULTS, ...settings };
  for (const [key, cfg] of Object.entries(FIELDS)) {
    const node = $(cfg.el);
    if (!node) continue; // preloadCount input may be absent depending on layout
    if (cfg.kind === 'checked') node.checked = Boolean(merged[key]);
    else node.value = merged[key];
    if (cfg.out && $(cfg.out)) $(cfg.out).textContent = `${merged[key]}${cfg.suffix || ''}`;
    node.addEventListener('input', save);
    node.addEventListener('change', save);
  }
  refreshAccount();
}

async function save() {
  const { settings: existing = {} } = await api.storage.local.get('settings');
  const settings = { ...DEFAULTS, ...existing };
  for (const [key, cfg] of Object.entries(FIELDS)) {
    const node = $(cfg.el);
    if (!node) continue;
    if (cfg.kind === 'checked') settings[key] = node.checked;
    else if (cfg.kind === 'number') settings[key] = Number(node.value);
    else settings[key] = node.value.trim();
    if (cfg.out && $(cfg.out)) $(cfg.out).textContent = `${node.value}${cfg.suffix || ''}`;
  }
  await api.storage.local.set({ settings });
  flashSaved();
  refreshAccount();
}

let savedTimer;
function flashSaved() {
  const s = $('saved');
  s.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => s.classList.remove('show'), 1200);
}

/* ---- Account status ---- */
async function refreshAccount() {
  const status = $('acctStatus');
  const btn = $('connectBtn');
  try {
    const st = await api.runtime.sendMessage({ type: 'AUTH_STATUS' });
    if (st?.needsUpdate) {
      status.textContent = 'Access method needs updating — check for an extension update.';
      btn.style.display = 'none';
    } else if (st?.loggedIn) {
      status.textContent = st.name ? `Using your Reddit session (u/${st.name}). No setup needed.` : 'Using your Reddit session. No setup needed.';
      btn.style.display = 'none';
    } else {
      status.textContent = 'Not logged in to Reddit. Log in to reddit.com in a tab.';
      btn.textContent = 'Open Reddit login'; btn.dataset.action = 'login'; btn.style.display = '';
    }
  } catch {
    status.textContent = 'Could not check your Reddit session.';
  }
}

$('connectBtn').addEventListener('click', async () => {
  const btn = $('connectBtn');
  if (btn.dataset.action === 'login') return api.tabs.create({ url: 'https://www.reddit.com/login' });
});

$('reset').addEventListener('click', async () => {
  await api.storage.local.set({ settings: { ...DEFAULTS } });
  await load();
  flashSaved();
});

load();
