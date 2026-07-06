/*
 * Image Flow — content script (the gallery / "gallery.js")
 * ==============================================================
 * Injects the floating button + full-screen lightbox on reddit.com/r/*.
 *
 * PERFORMANCE MODEL (why this feels instant without spending QPM):
 *   • Post metadata + comments come from the background via the user's logged-in
 *     reddit.com session (rate-limited, cached in IndexedDB).
 *   • Image binaries come from the background image broker backed by the Cache
 *     Storage API (CDN, NOT rate-limited) and are prefetched aggressively.
 *   • Rendering reuses a 2-buffer <img> pool and animates with GPU `transform`
 *     translateX only — no node churn, no layout/paint on navigation.
 *
 * The whole UI lives in a Shadow DOM so Reddit's CSS and ours never collide.
 */
(() => {
  'use strict';
  if (window.__imageFlowLoaded) return;
  window.__imageFlowLoaded = true;

  // NOTE: in a Firefox content script, `browser`/`chrome` are sandbox globals,
  // NOT properties of the page `window`. Use globalThis (the sandbox global).
  const api = globalThis.browser || globalThis.chrome;
  const bg = (msg) => api.runtime.sendMessage(msg);
  const log = (...a) => console.log('%c[IF]', 'color:#ff4500;font-weight:bold', ...a);
  const logErr = (...a) => console.error('%c[IF]', 'color:#ff2d55;font-weight:bold', ...a);

  /*
   * CRITICAL_CSS — the minimum styling needed for the overlay + floating button
   * to be VISIBLE and cover the page. Injected as an inline <style> (allowed by
   * Reddit's `style-src 'unsafe-inline'`) SYNCHRONOUSLY, so the UI can never
   * render invisibly even if the background never answers GET_CSS or the full
   * gallery.css fails to load. The full stylesheet layers on top for polish.
   */
  const CRITICAL_CSS = `
    .rif-fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
      display: inline-flex; align-items: center; gap: 8px; padding: 11px 16px; border: none;
      border-radius: 999px; background: linear-gradient(135deg,#ff5700,#ff2d55); color: #fff;
      font: 600 14px system-ui, sans-serif; cursor: pointer; box-shadow: 0 6px 20px rgba(255,45,85,.45); }
    .rif-overlay { position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column;
      background: rgba(8,9,12,.94); color: #f2f3f5; font: 14px system-ui, sans-serif; }
    .rif-overlay[hidden], .rif-fab[hidden] { display: none !important; }
    .rif-banner { padding: 12px 16px; background: #16181d; border-bottom: 1px solid #2c313b; display: flex;
      gap: 12px; align-items: center; }
    .rif-banner[hidden] { display: none; }
    .rif-banner button { cursor: pointer; }
    .rif-stage { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; min-height: 0; }
    .rif-header { display: flex; gap: 10px; padding: 10px 14px; align-items: center; background: rgba(0,0,0,.35); }
    .rif-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 2147483010; }
    /* Grid layout is guaranteed here so images are always separate boxes,
       never stacked, even if the full stylesheet fails to load. */
    .rif-grid { position: absolute; inset: 0; z-index: 7; display: flex; flex-direction: column; background: rgba(6,7,10,.98); }
    .rif-grid[hidden] { display: none; }
    .rif-grid-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid #2c313b; flex: 0 0 auto; }
    .rif-grid-cells { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; display: grid;
      --rif-grid-cell-size: clamp(112px, 16vw, 170px);
      grid-template-columns: repeat(auto-fill, minmax(var(--rif-grid-cell-size), var(--rif-grid-cell-size)));
      grid-auto-rows: var(--rif-grid-cell-size); gap: 10px;
      align-content: start; align-items: stretch; justify-content: start; }
    .rif-grid-cell { position: relative; display: block; width: 100%; height: 100%; appearance: none; min-width: 0; overflow: hidden;
      border: 2px solid var(--rif-cell-border, transparent); border-radius: 8px; padding: 0; background: #000; cursor: pointer; line-height: 0; }
    .rif-grid-cell img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
    .rif-grid-cell:hover { --rif-cell-border: #a9b0bb; }
    .rif-grid-cell.checked { --rif-cell-border: #ff4500; }
    .rif-grid-group { box-shadow: inset 0 0 0 3px var(--rif-group-soft, var(--rif-group, transparent)), 0 0 0 1px var(--rif-group, transparent); }
    .rif-grid-group::after { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 5px; background: var(--rif-group, transparent); pointer-events: none; }
    .rif-grid-badge { position: absolute; left: 6px; bottom: 6px; padding: 2px 7px; border-radius: 999px;
      font-size: 11px; font-weight: 700; color: #fff; background: var(--rif-group, rgba(0,0,0,.65)); pointer-events: none; }
    .rif-grid-footer { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; padding: 16px; min-height: 44px; }
    .rif-settings { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(6,7,10,.82); }
    .rif-settings[hidden] { display: none; }
    .rif-settings-card { width: min(760px, 100%); max-height: min(760px, calc(100vh - 40px)); overflow: hidden; display: flex; flex-direction: column; background: #16181d; border: 1px solid #2c313b; border-radius: 8px; }
    .rif-settings-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #2c313b; }
    .rif-settings-head h2 { margin: 0; font-size: 17px; }
    .rif-settings-body { overflow-y: auto; padding: 2px 16px; }
    .rif-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 0; border-bottom: 1px solid #2c313b; }
    .rif-settings-row:last-child { border-bottom: none; }
    .rif-settings-meta { min-width: 0; }
    .rif-settings-name { font-weight: 700; }
    .rif-settings-desc { color: #a9b0bb; font-size: 12.5px; margin-top: 2px; }
    .rif-settings-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 190px; }
    .rif-settings-control input[type="range"] { width: 170px; }
    .rif-settings-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #2c313b; }
  `;

  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */
  const DEFAULT_SETTINGS = {
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
    showTitle: true, // show the title/meta caption bar (togglable, key "T")
  };
  let settings = { ...DEFAULT_SETTINGS };
  async function loadSettings() {
    try { const r = await api.storage.local.get('settings'); settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) }; }
    catch { settings = { ...DEFAULT_SETTINGS }; }
  }
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    if (gallery) { gallery.applySettings(); gallery.syncSettingsPanel?.(); }
  });

  /* ------------------------------------------------------------------ */
  /* DOM helper + icons                                                 */
  /* ------------------------------------------------------------------ */
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) { if (kid == null || kid === false) continue; n.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return n;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgFrom(inner) {
    const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}" viewBox="0 0 24 24" width="20" height="20">${inner}</svg>`, 'image/svg+xml');
    return document.importNode(doc.documentElement, true);
  }
  const ICONS = {
    close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    prev: '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    next: '<path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    download: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    comment: '<path d="M4 5h16v11H9l-4 3v-3H4z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
    link: '<path d="M10 14a4 4 0 006 0l3-3a4 4 0 10-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 106 6l1-1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    copy: '<path d="M9 9h10v10H9zM5 15V5h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
    play: '<path d="M7 5l12 7-12 7z" fill="currentColor"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>',
    grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" stroke="currentColor" stroke-width="2" fill="none"/>',
    help: '<path d="M9 9a3 3 0 116 0c0 2-3 2.5-3 4M12 17h.01" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    gear: '<path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M19.4 13a1 1 0 00.2 1.1l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1 1 0 00-1.7.7V21a2 2 0 11-4 0v-.2a1 1 0 00-1.7-.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1 1 0 00-.7-1.7H3a2 2 0 110-4h.2a1 1 0 00.7-1.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1 1 0 001.7-.7V3a2 2 0 114 0v.2a1 1 0 001.7.7l.1-.1a2 2 0 112.8 2.8l-.1.1a1 1 0 00.7 1.7H21a2 2 0 110 4h-.2a1 1 0 00-.9.6z" stroke="currentColor" stroke-width="1.2" fill="none"/>',
    hd: '<path d="M3 7h2a3 3 0 010 6H3zM3 7v10M13 7v10M13 7h3a5 5 0 010 10h-3" stroke="currentColor" stroke-width="1.6" fill="none"/>',
    title: '<path d="M5 7h14M5 12h14M5 17h9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  };
  const icon = (name) => { const s = el('span', { class: 'rif-ico' }); s.append(svgFrom(ICONS[name] || '')); return s; };

  /* ------------------------------------------------------------------ */
  /* Reddit data model                                                  */
  /* ------------------------------------------------------------------ */
  const IMG_EXT_RE = /\.(jpg|jpeg|png|gif|webp)(?:\?|$)/i;
  const decode = (u) => (u || '').replace(/&amp;/g, '&');
  const extFromUrl = (u) => { const m = IMG_EXT_RE.exec(u || ''); return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'; };
  const extFromMime = (m) => ({ 'image/jpg': 'jpg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[m] || 'jpg');

  function normalizePost(d) {
    const base = {
      id: d.id, fullname: d.name, title: d.title || '(untitled)', author: d.author, subreddit: d.subreddit,
      permalink: d.permalink, url: d.url, score: typeof d.score === 'number' ? d.score : d.ups || 0,
      numComments: d.num_comments || 0, nsfw: Boolean(d.over_18), created: d.created_utc, type: 'image', images: [],
    };
    // Reddit gallery
    if (d.is_gallery && d.media_metadata && d.gallery_data) {
      for (const item of d.gallery_data.items || []) {
        const meta = d.media_metadata[item.media_id];
        if (!meta || meta.status !== 'valid') continue;
        let url = null; let ext = 'jpg';
        if (meta.s?.u) { url = decode(meta.s.u); ext = extFromMime(meta.m); }
        else if (meta.s?.gif) { url = decode(meta.s.gif); ext = 'gif'; }
        else if (meta.s?.mp4) { url = decode(meta.s.mp4); ext = 'mp4'; }
        if (!url) continue;
        const variants = (meta.p || []).map((p) => ({ url: decode(p.u), width: p.x, height: p.y })).sort((a, b) => a.width - b.width);
        base.images.push({ url, width: meta.s?.x, height: meta.s?.y, ext, isVideo: ext === 'mp4', caption: item.caption, variants });
      }
      return base.images.length ? base : null;
    }
    // Reddit-hosted video (muted mp4 fallback)
    if (d.is_video && d.media?.reddit_video?.fallback_url) {
      base.type = 'video';
      base.images.push({ url: d.media.reddit_video.fallback_url, ext: 'mp4', isVideo: true, width: d.media.reddit_video.width, height: d.media.reddit_video.height, variants: [] });
      return base;
    }
    if (d.preview?.reddit_video_preview?.fallback_url) {
      base.type = 'video';
      base.images.push({ url: decode(d.preview.reddit_video_preview.fallback_url), ext: 'mp4', isVideo: true, variants: [] });
      return base;
    }
    // Single image
    const directImg = IMG_EXT_RE.test(d.url || '');
    const knownHost = /(i\.redd\.it|i\.imgur\.com)/i.test(d.url || '');
    if (d.post_hint === 'image' || directImg || knownHost) {
      const src = d.preview?.images?.[0]?.source;
      const url = decode(d.url);
      const variants = (d.preview?.images?.[0]?.resolutions || []).map((r) => ({ url: decode(r.url), width: r.width, height: r.height })).sort((a, b) => a.width - b.width);
      base.images.push({ url, width: src?.width, height: src?.height, ext: extFromUrl(url), variants });
      return base;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                              */
  /* ------------------------------------------------------------------ */
  function toast(root, message, ms = 2600) {
    const host = root.querySelector('.rif-toast'); if (!host) return;
    const t = el('div', { class: 'rif-toast-item', text: message });
    host.append(t); requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
  }

  const connProfile = () => { const c = navigator.connection; return c ? { effectiveType: c.effectiveType, downlink: c.downlink, saveData: c.saveData } : null; };
  const formatNum = (n) => (n == null ? '0' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const clampNum = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  // Stable hue per post id → gallery images from the same post share a colour.
  const postHue = (id) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h % 360; };
  const currentSubreddit = () => { const m = /\/r\/([^/?#]+)/i.exec(location.pathname); return m ? m[1] : null; };
  // A "feed source" is a subreddit or a user's submitted page.
  const currentSource = () => {
    const u = /\/(?:user|u)\/([^/?#]+)/i.exec(location.pathname);
    if (u) return { kind: 'user', name: u[1] };
    const r = /\/r\/([^/?#]+)/i.exec(location.pathname);
    if (r) return { kind: 'subreddit', name: r[1] };
    return null;
  };
  // Parse a switcher input into a source: "u/name" or "user/name" → user feed;
  // "r/name" or a bare word → subreddit.
  const parseSource = (v) => {
    const s = (v || '').trim();
    let m = /^\/?(?:u|user)\/([^/?#\s]+)/i.exec(s);
    if (m) return { kind: 'user', name: m[1] };
    m = /^\/?r\/([^/?#\s]+)/i.exec(s);
    if (m) return { kind: 'subreddit', name: m[1] };
    const name = s.split(/[/?#\s]/)[0];
    return name ? { kind: 'subreddit', name } : null;
  };

  /* ================================================================== */
  /* Gallery                                                            */
  /* ================================================================== */
  class Gallery {
    constructor(shadowRoot) {
      this.root = shadowRoot;
      this.posts = []; this.order = []; this.oi = 0; this.ii = 0;
      this.after = null; this.loading = false; this.exhausted = false; this.filter = '';
      this.commentsOpen = false; this.slideshow = null; this.zoom = { scale: 1, x: 0, y: 0 };
      this.revealed = new Set(); this.fullRes = new Set(); this.gridMode = null; this.selected = new Map(); this._gridCount = 0;
      this.sub = null; this.sort = settings.defaultSort; this.sourceKind = 'subreddit';
      this.buffers = []; this.active = 0; this.bufUrls = [null, null];
      this.loadTimes = []; this.hits = 0; this.misses = 0;
      this._renderT = null; this._navDir = 0;
      this.build();
    }

    /* ---------- DOM ---------- */
    build() {
      const r = this.root;
      this.sortSelect = el('select', { class: 'rif-sort', title: 'Sort', onchange: (e) => this.changeSort(e.target.value) },
        ...['hot', 'new', 'top', 'rising', 'best'].map((s) => el('option', { value: s }, s[0].toUpperCase() + s.slice(1))));
      this.subInput = el('input', { class: 'rif-sub', type: 'text', placeholder: 'subreddit or u/user', spellcheck: false, onkeydown: (e) => { if (e.key === 'Enter') this.switchSub(this.subInput.value); } });
      this.srcPrefix = el('span', { class: 'rif-r' }, 'r/');
      this.searchInput = el('input', { class: 'rif-search', type: 'search', placeholder: 'Filter loaded titles…', spellcheck: false, oninput: (e) => this.applyFilter(e.target.value) });

      const btn = (cls, title, ic, onClick) => el('button', { class: `rif-btn ${cls}`, title, onclick: onClick }, icon(ic));
      this.header = el('header', { class: 'rif-header' },
        el('div', { class: 'rif-brand' }, 'Image Flow'),
        el('div', { class: 'rif-switch' }, this.srcPrefix, this.subInput, el('button', { class: 'rif-go', title: 'Go', onclick: () => this.switchSub(this.subInput.value) }, 'Go')),
        this.sortSelect, this.searchInput,
        el('div', { class: 'rif-header-actions' },
          btn('rif-title-btn', 'Toggle title (T)', 'title', () => this.toggleTitle()),
          btn('rif-grid-btn', 'Grid view (G)', 'grid', () => this.toggleGrid()),
          btn('rif-comments-btn', 'Comments (C)', 'comment', () => this.toggleComments()),
          btn('rif-slideshow-btn', 'Slideshow (S)', 'play', () => this.toggleSlideshow()),
          btn('rif-help-btn', 'Shortcuts (?)', 'help', () => this.toggleHelp()),
          btn('rif-settings-btn', 'Settings', 'gear', () => this.toggleSettings()),
          btn('rif-close-btn', 'Close (Esc)', 'close', () => this.close())));

      // Two-buffer image pool inside a viewport (transform-based transitions).
      const makeBuffer = () => { const img = el('img', { class: 'rif-img', alt: '', draggable: 'false' }); const box = el('div', { class: 'rif-slide' }, img); return { el: box, img }; };
      this.buffers = [makeBuffer(), makeBuffer()];
      this.buffers[1].el.style.opacity = '0';
      this.videoWrap = el('div', { class: 'rif-video-wrap', hidden: true });
      this.figure = el('figure', { class: 'rif-figure' }, this.buffers[0].el, this.buffers[1].el, this.videoWrap);
      this.viewport = el('div', { class: 'rif-viewport' }, this.figure);
      this.spinner = el('div', { class: 'rif-spinner', hidden: true });

      this.prevZone = el('div', { class: 'rif-zone rif-zone-prev', title: 'Previous', onclick: () => this.prev() }, icon('prev'));
      this.nextZone = el('div', { class: 'rif-zone rif-zone-next', title: 'Next', onclick: () => this.next() }, icon('next'));
      this.caption = el('div', { class: 'rif-caption' });
      this.progress = el('div', { class: 'rif-progress' });
      this.dots = el('div', { class: 'rif-dots' });
      this.hdBtn = el('button', { class: 'rif-btn rif-hd', title: 'Load full resolution', onclick: () => this.loadFullRes() }, icon('hd'), el('span', { class: 'rif-btn-label' }, 'HD'));
      this.hdBtn.style.display = 'none';
      this.imgActions = el('div', { class: 'rif-img-actions' },
        el('button', { class: 'rif-btn', title: 'Download image (D)', onclick: () => this.downloadCurrent() }, icon('download')),
        el('button', { class: 'rif-btn rif-dl-all', title: 'Download all in post (A)', onclick: () => this.downloadPost() }, icon('download'), el('span', { class: 'rif-btn-label' }, 'All')),
        this.hdBtn,
        el('button', { class: 'rif-btn', title: 'Copy image URL (U)', onclick: () => this.copyUrl() }, icon('copy')),
        el('button', { class: 'rif-btn', title: 'Open post (O)', onclick: () => this.openPost() }, icon('link')));
      this.thumbs = el('div', { class: 'rif-thumbs' });

      // The caption is its OWN bar between the header and the image — never
      // painted over the image. It can be hidden entirely (settings.showTitle).
      this.captionBar = el('div', { class: 'rif-captionbar' }, this.caption);
      // NSFW reveal overlays the image and is independent of the title toggle.
      this.revealBtn = el('button', { class: 'rif-reveal', hidden: true, onclick: () => { const p = this.currentPost(); if (p) { this.revealed.add(p.id); this.renderCurrent(0); } } }, 'NSFW — click to reveal');
      this.stage = el('div', { class: 'rif-stage' }, this.prevZone, this.viewport, this.nextZone, this.spinner, this.progress, this.revealBtn, this.imgActions, this.dots, this.thumbs);
      this.commentsPanel = el('aside', { class: 'rif-comments', dataset: { side: settings.commentsSide }, hidden: true });
      this.gridPanel = el('div', { class: 'rif-grid', hidden: true, dataset: { mode: 'browse' } });
      this.helpPanel = this.buildHelp();
      this.settingsPanel = this.buildSettingsPanel();
      this.debugPanel = el('div', { class: 'rif-debug', hidden: true });
      this.banner = el('div', { class: 'rif-banner', hidden: true });

      this.overlay = el('div', { class: 'rif-overlay', hidden: true, dataset: { comments: 'closed' } },
        this.header, this.banner, this.captionBar, this.stage, this.commentsPanel, this.gridPanel, this.helpPanel, this.settingsPanel, this.debugPanel);
      this.toastHost = el('div', { class: 'rif-toast' });
      r.append(this.overlay, this.toastHost);

      // Lazy thumbnails via IntersectionObserver.
      this.thumbObserver = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { const img = e.target; if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; } this.thumbObserver.unobserve(img); }
      }, { root: this.thumbs, rootMargin: '200px' });

      this.bindStageInteractions();
      this.applySettings();
      this.syncSettingsPanel();
    }

    buildHelp() {
      const rows = [
        ['→ / L / Space / wheel-down', 'Next image'], ['← / H / wheel-up', 'Previous image'],
        ['Click / swipe edges', 'Next / Previous'], ['Home / End', 'First / last loaded'],
        ['C', 'Comments panel'], ['Z / double-click', 'Zoom (drag to pan)'], ['S', 'Slideshow'],
        ['G', 'Grid overview (click to jump)'], ['B', 'Grid in select-to-download mode'],
        ['D / A', 'Download image / whole post'], ['U / O', 'Copy URL / open post'],
        ['T', 'Show / hide title'], ['Ctrl+Shift+D', 'Debug overlay'], ['?', 'This cheat-sheet'], ['Esc', 'Close panel / gallery'],
      ];
      return el('div', { class: 'rif-help', hidden: true }, el('div', { class: 'rif-help-card' },
        el('h2', {}, 'Keyboard & mouse shortcuts'),
        el('div', { class: 'rif-help-grid' }, ...rows.flatMap(([k, v]) => [el('kbd', {}, k), el('span', {}, v)])),
        el('button', { class: 'rif-help-close', onclick: () => this.toggleHelp(false) }, 'Close')));
    }

    buildSettingsPanel() {
      this.settingsControls = new Map();
      this.settingsStatus = el('div', { class: 'rif-settings-desc', text: 'Checking your Reddit session...' });
      this.settingsLoginBtn = el('button', { class: 'rif-btn-secondary', text: 'Open Reddit login', onclick: () => window.open('https://www.reddit.com/login', '_blank', 'noopener') });

      const body = el('div', { class: 'rif-settings-body' },
        this.settingsRow('Reddit sign-in', this.settingsStatus, el('div', { class: 'rif-settings-control' }, this.settingsLoginBtn)),
        this.settingsRow('Comments panel side', 'Which side the comments drawer slides in from.', this.settingsSelect('commentsSide', [['right', 'Right'], ['left', 'Left']])),
        this.settingsRow('Default sort', 'Sort used when a gallery first opens.', this.settingsSelect('defaultSort', [['hot', 'Hot'], ['new', 'New'], ['top', 'Top'], ['rising', 'Rising'], ['best', 'Best']])),
        this.settingsRow('Show image title', 'Show the title and metadata caption bar above the image.', this.settingsToggle('showTitle')),
        this.settingsRow('Blur NSFW images', 'Blur over-18 posts until you click to reveal.', this.settingsToggle('nsfwBlur')),
        this.settingsRow('Slideshow image duration', 'Seconds each image stays visible before the next image is shown.', this.settingsRange('slideshowSeconds', 1, 120, 1, 's')),
        this.settingsRow('Slideshow first switch delay', 'Seconds to wait before the first automatic advance after slideshow starts.', this.settingsRange('slideshowFirstDelaySeconds', 0, 120, 1, 's')),
        this.settingsRow('Slideshow transition duration', 'Animation time for moving from one image to the next.', this.settingsRange('slideshowTransitionMs', 0, 3000, 50, ' ms')),
        this.settingsRow('Pause slideshow on hover', 'Stop the auto-advance timer while the pointer is over the image.', this.settingsToggle('slideshowPauseOnHover')),
        this.settingsRow('Side panel width', 'Reserved empty space on each side.', this.settingsRange('panelWidth', 280, 560, 20, 'px')),
        this.settingsRow('Data saver mode', 'Disables lookahead prefetch and prefers smaller preview variants.', this.settingsToggle('dataSaver')),
        this.settingsRow('Image cache cap', 'Max disk used by the CDN image cache.', this.settingsRange('imageCacheMB', 50, 1000, 50, ' MB')));

      const card = el('section', { class: 'rif-settings-card', role: 'dialog', 'aria-label': 'Settings', 'aria-modal': 'true' },
          el('div', { class: 'rif-settings-head' },
            el('h2', {}, 'Settings'),
            el('button', { class: 'rif-btn-ghost', title: 'Close settings', onclick: () => this.toggleSettings(false) }, 'Close')),
          body,
          el('div', { class: 'rif-settings-foot' },
            el('button', { class: 'rif-btn-ghost', onclick: () => this.resetSettings() }, 'Reset to defaults'),
            el('button', { class: 'rif-btn-secondary', onclick: () => this.openSettingsPage() }, 'Open full settings page')));
      const panel = el('div', { class: 'rif-settings', hidden: true }, card);
      panel.addEventListener('click', (e) => { if (e.target === panel) this.toggleSettings(false); });
      return panel;
    }

    settingsRow(name, desc, control) {
      return el('div', { class: 'rif-settings-row' },
        el('div', { class: 'rif-settings-meta' },
          el('div', { class: 'rif-settings-name', text: name }),
          desc?.nodeType ? desc : el('div', { class: 'rif-settings-desc', text: desc || '' })),
        control);
    }

    settingsSelect(key, choices) {
      const node = el('select', { class: 'rif-settings-input' }, choices.map(([value, label]) => el('option', { value }, label)));
      node.addEventListener('change', () => this.setSetting(key, node.value));
      this.settingsControls.set(key, { node, kind: 'value' });
      return el('div', { class: 'rif-settings-control' }, node);
    }

    settingsRange(key, min, max, step, suffix) {
      const out = el('span', { class: 'rif-settings-value' });
      const node = el('input', { class: 'rif-settings-input', type: 'range', min, max, step });
      node.addEventListener('input', () => {
        out.textContent = `${node.value}${suffix}`;
        this.setSetting(key, Number(node.value));
      });
      this.settingsControls.set(key, { node, out, suffix, kind: 'number' });
      return el('div', { class: 'rif-settings-control' }, node, out);
    }

    settingsToggle(key) {
      const node = el('input', { type: 'checkbox' });
      node.addEventListener('change', () => this.setSetting(key, node.checked));
      this.settingsControls.set(key, { node, kind: 'checked' });
      return el('label', { class: 'rif-settings-switch' }, node, el('span', { class: 'rif-settings-slider' }));
    }

    /* ---------- Open / close / auth ---------- */
    async open({ sub, sort, kind } = {}) {
      const src = (sub ? { kind: kind || 'subreddit', name: sub } : null) || currentSource() || { kind: 'subreddit', name: 'pics' };
      this.sourceKind = src.kind; this.sub = src.name;
      this.sort = sort || settings.defaultSort;
      this.subInput.value = this.sub; this.sortSelect.value = this.sort;
      this.syncSourcePrefix();
      this.overlay.hidden = false; document.documentElement.style.overflow = 'hidden';
      hideFab(); bg({ type: 'SET_BADGE', text: '⋯' });
      this.reset();

      const ok = await this.ensureAuth();
      if (!ok) return; // banner is shown; loading resumes after Retry
      await this.loadMore();
      if (this.order.length) this.renderCurrent(0);
      else this.showBanner('No image posts found in the first page. Try another subreddit or sort.', 'info');
    }

    close() {
      this.stopSlideshow();
      bg({ type: 'IMG_CANCEL' });
      this.overlay.hidden = true; document.documentElement.style.overflow = '';
      showFab(); bg({ type: 'SET_BADGE', text: '' });
      clearInterval(this._debugTimer);
    }

    reset() {
      this.posts = []; this.order = []; this.oi = 0; this.ii = 0; this.after = null; this.exhausted = false;
      this.loading = false; this.selected.clear(); this._gridCount = 0; this.updateGridBar();
    }

    /**
     * Auth is the user's existing reddit.com session. Returns true when we're
     * clear to load; otherwise shows the appropriate banner.
     */
    async ensureAuth() {
      let st;
      try { st = await bg({ type: 'AUTH_STATUS' }); }
      catch (e) {
        logErr('AUTH_STATUS failed — background not responding', e);
        this.showBanner('Could not reach the extension background. Reload the extension in about:debugging, then reload this page.', 'error');
        return false;
      }
      log('auth status', st);
      if (st?.needsUpdate) { this.showUpdateBanner(); return false; }

      if (st?.loggedIn) { this.sessionName = st.name; this.banner.hidden = true; return true; }
      this.showLoginBanner();
      return false;
    }

    showLoginBanner() {
      this.banner.hidden = false; this.banner.dataset.kind = 'warn'; this.banner.textContent = '';
      this.banner.append(
        el('span', { class: 'rif-banner-text' },
          'Please log in to Reddit in this tab first for full functionality, then click Retry. ',
          el('a', { class: 'rif-banner-link', href: 'https://www.reddit.com/login', target: '_blank', rel: 'noopener' }, 'Open Reddit login ↗')),
        el('button', { class: 'rif-banner-retry', text: 'Retry', onclick: () => this.retryAuth() }));
    }

    showUpdateBanner() {
      this.banner.hidden = false; this.banner.dataset.kind = 'error'; this.banner.textContent = '';
      this.banner.append(
        el('span', { class: 'rif-banner-text', text: 'Reddit access method needs updating — check for an extension update.' }),
        el('button', { class: 'rif-banner-retry', text: 'Retry', onclick: () => this.retryAuth() }),
        el('button', { class: 'rif-banner-x', title: 'Open settings', onclick: () => this.toggleSettings(true) }, '⚙'));
    }

    async retryAuth() {
      this.banner.hidden = true;
      const st = await bg({ type: 'AUTH_RESET' }); // clears the needs-update flag
      const ok = st?.needsUpdate ? false : st?.loggedIn;
      if (ok) { await this.loadMore(); if (this.order.length) this.renderCurrent(0); }
      else await this.ensureAuth();
    }

    showBanner(text, kind = 'info') {
      this.banner.hidden = false; this.banner.dataset.kind = kind; this.banner.textContent = '';
      this.banner.append(el('span', { class: 'rif-banner-text', text }), el('button', { class: 'rif-banner-x', title: 'Dismiss', onclick: () => (this.banner.hidden = true) }, '✕'));
    }

    /* ---------- Data (RATE-LIMITED Reddit API via background) ---------- */
    async loadMore() {
      if (this.loading || this.exhausted) return;
      this.loading = true; this.setLoading(true);
      try {
        const res = await bg({ type: 'API_LISTING', kind: this.sourceKind, name: this.sub, sub: this.sub, sort: this.sort, after: this.after, limit: 100 });
        if (res?.needsUpdate) { this.loading = false; this.setLoading(false); this.showUpdateBanner(); return; }
        if (res?.needLogin || res?.needAuth) { this.loading = false; this.setLoading(false); await this.ensureAuth(); return; }
        if (!res?.ok) throw Object.assign(new Error(res?.error || 'fetch failed'), { status: res?.status });
        const children = res.data?.data?.children || [];
        this.after = res.data?.data?.after || null;
        if (!this.after) this.exhausted = true;
        let added = 0;
        for (const c of children) {
          if (c.kind !== 't3') continue;
          const post = normalizePost(c.data); if (!post) continue;
          if (post.nsfw && settings.nsfwBlur && !this.revealed.has(post.id)) post._blur = true;
          this.posts.push(post); added++;
        }
        this.rebuildOrder();
        if (res.fromCache) { /* served from IndexedDB — no QPM spent */ }
        if (added === 0 && !this.exhausted) await this.loadMore();
      } catch (err) { this.showRetryBanner(err); }
      finally { this.loading = false; this.setLoading(false); this.updateProgress(); }
    }

    showRetryBanner(err) {
      const msg = err?.status === 429 ? 'Reddit rate limit reached — pausing before retry.' : `Could not load posts (${err?.message || 'network error'}).`;
      this.banner.hidden = false; this.banner.dataset.kind = 'error'; this.banner.textContent = '';
      this.banner.append(el('span', { class: 'rif-banner-text', text: msg }),
        el('button', { class: 'rif-banner-retry', text: 'Retry', onclick: async () => { this.banner.hidden = true; await this.loadMore(); if (this.order.length && !this.currentPost()) this.renderCurrent(0); } }));
    }

    rebuildOrder() {
      const f = this.filter.trim().toLowerCase();
      const prevId = this.currentPost()?.id;
      this.order = this.posts.map((_, i) => i).filter((i) => !f || this.posts[i].title.toLowerCase().includes(f));
      if (prevId) { const at = this.order.findIndex((i) => this.posts[i].id === prevId); if (at >= 0) this.oi = at; else { this.oi = Math.min(this.oi, Math.max(0, this.order.length - 1)); this.ii = 0; } }
    }

    /* ---------- Navigation (debounced render) ---------- */
    currentPost() { const idx = this.order[this.oi]; return idx == null ? null : this.posts[idx]; }

    /** Pure lookahead: (post,image) `offset` steps from current, or null. */
    itemAtOffset(offset) {
      let oi = this.oi; let ii = this.ii; const step = offset >= 0 ? 1 : -1;
      for (let n = 0; n < Math.abs(offset); n++) {
        const post = this.posts[this.order[oi]]; if (!post) return null;
        if (step > 0) { if (ii < post.images.length - 1) ii++; else { oi++; ii = 0; } }
        else { if (ii > 0) ii--; else { oi--; if (oi < 0) return null; ii = this.posts[this.order[oi]].images.length - 1; } }
        if (oi < 0 || oi >= this.order.length) return null;
      }
      const post = this.posts[this.order[oi]]; if (!post) return null;
      return { post, image: post.images[ii], oi, ii };
    }

    async next() {
      const post = this.currentPost(); if (!post) return;
      if (this.ii < post.images.length - 1) this.ii++;
      else if (this.oi < this.order.length - 1) { this.oi++; this.ii = 0; }
      else { await this.loadMore(); if (this.oi < this.order.length - 1) { this.oi++; this.ii = 0; } else return; }
      this.scheduleRender(1);
    }
    prev() {
      if (this.ii > 0) this.ii--;
      else if (this.oi > 0) { this.oi--; this.ii = this.currentPost().images.length - 1; }
      else return;
      this.scheduleRender(-1);
    }
    goPost(delta) { const t = Math.min(Math.max(this.oi + delta, 0), this.order.length - 1); if (t === this.oi) return; this.oi = t; this.ii = 0; this.scheduleRender(delta > 0 ? 1 : -1); }
    first() { this.oi = 0; this.ii = 0; this.scheduleRender(-1); }
    last() { this.oi = Math.max(0, this.order.length - 1); this.ii = 0; this.scheduleRender(1); }

    // Debounce heavy render so holding the arrow key doesn't load every frame.
    scheduleRender(dir) {
      this._navDir = dir; this.updateProgress();
      clearTimeout(this._renderT);
      this._renderT = setTimeout(() => this.renderCurrent(this._navDir), 100);
      if (this.oi >= this.order.length - 4) this.loadMore();
    }

    /* ---------- Render current slide ---------- */
    async renderCurrent(dir = 0) {
      const post = this.currentPost(); if (!post) return;
      const image = post.images[this.ii];
      this.resetZoom();
      const blurred = Boolean(post._blur && !this.revealed.has(post.id));
      this.figure.classList.toggle('rif-blurred', blurred);
      this.revealBtn.hidden = !blurred; // reveal is independent of the title toggle

      if (image.isVideo) {
        this.buffers.forEach((b) => (b.el.style.display = 'none'));
        this.videoWrap.hidden = false; this.videoWrap.replaceChildren(el('video', { class: 'rif-video', src: image.url, controls: true, autoplay: true, loop: true, muted: true, playsinline: true }));
        if (image.width && image.height) this.figure.style.setProperty('--rif-ar', (image.width / image.height).toFixed(4));
      } else {
        this.videoWrap.hidden = true; this.videoWrap.replaceChildren();
        this.buffers.forEach((b) => (b.el.style.display = ''));
        await this.displayImage(this.pickUrl(image), dir, image);
      }

      this.updateHdButton(image);
      this.updateCaption(post, image);
      this.updateProgress();
      this.updateDots(post);
      this.updateThumbs(post);
      this.imgActions.querySelector('.rif-dl-all').style.display = post.images.length > 1 ? '' : 'none';
      if (this.commentsOpen) this.loadComments(post);
      this.triggerPrefetch();
      this.restartSlideshowTimer();
      if (!this.debugPanel.hidden) this.refreshDebug();
    }

    /** Choose the URL to show: full-res unless data-saver picks a smaller variant. */
    pickUrl(image) {
      const key = `${this.currentPost()?.id}:${this.ii}`;
      if (!settings.dataSaver || this.fullRes.has(key) || !image.variants?.length) return image.url;
      const need = Math.round((this.stage.clientWidth - 2 * settings.panelWidth) * (window.devicePixelRatio || 1)) || 1000;
      const fit = image.variants.find((v) => v.width >= need);
      return (fit || image.variants[image.variants.length - 1]).url;
    }
    updateHdButton(image) {
      const key = `${this.currentPost()?.id}:${this.ii}`;
      const showingReduced = settings.dataSaver && !this.fullRes.has(key) && image.variants?.length && this.pickUrl(image) !== image.url;
      this.hdBtn.style.display = showingReduced ? '' : 'none';
    }
    loadFullRes() { const key = `${this.currentPost()?.id}:${this.ii}`; this.fullRes.add(key); this.renderCurrent(0); }

    /**
     * Two-buffer transform slide. Reuses the pooled <img> elements (no DOM
     * churn) and animates translateX on the GPU (no layout/paint). Image bytes
     * come from the background CDN cache (broker), so a prefetched image is an
     * instant cache hit.
     */
    async displayImage(url, dir, image) {
      if (image.width && image.height) this.figure.style.setProperty('--rif-ar', (image.width / image.height).toFixed(4));
      else this.figure.style.removeProperty('--rif-ar');

      const oldActive = this.active; const incIdx = 1 - oldActive;
      const incoming = this.buffers[incIdx]; const outgoing = this.buffers[oldActive];

      // Fetch bytes via broker (cache hit ⇒ instant, no network, no QPM).
      const t0 = performance.now();
      let objUrl = null; let fromCache = false;
      try { const res = await bg({ type: 'IMG_GET', url }); if (res?.ok && res.blob) { objUrl = URL.createObjectURL(res.blob); fromCache = res.fromCache; } } catch { /* fall back below */ }

      this.setLoading(true);
      incoming.img.onload = () => this.setLoading(false);
      incoming.img.onerror = () => { this.setLoading(false); toast(this.root, 'Image failed to load'); };
      incoming.img.src = objUrl || url; // fallback to direct CDN URL on broker failure
      try { await incoming.img.decode(); } catch { /* onload/onerror still fire */ }
      this.setLoading(false);
      this.recordLoad(performance.now() - t0, fromCache);

      // Position incoming offscreen without transition, then animate both.
      incoming.el.style.transition = 'none';
      incoming.el.style.transform = `translateX(${dir * 100}%)`;
      incoming.el.style.opacity = dir === 0 ? '0' : '1';
      incoming.el.style.zIndex = '2'; outgoing.el.style.zIndex = '1';
      void incoming.el.offsetWidth; // reflow so the next change animates
      incoming.el.style.transition = '';
      incoming.el.style.transform = 'translateX(0)';
      incoming.el.style.opacity = '1';
      outgoing.el.style.transform = `translateX(${-dir * 100}%)`;
      if (dir === 0) outgoing.el.style.opacity = '0';

      this.active = incIdx;
      const prevUrl = this.bufUrls[oldActive];
      this.bufUrls[incIdx] = objUrl;
      setTimeout(() => {
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        this.bufUrls[oldActive] = null;
        outgoing.el.style.transition = 'none';
        outgoing.el.style.transform = 'translateX(100%)';
        outgoing.el.style.opacity = '0';
      }, this.slideshowTransitionMs() + 20);
    }

    recordLoad(ms, fromCache) { this.loadTimes.push(ms); if (this.loadTimes.length > 40) this.loadTimes.shift(); if (fromCache) this.hits++; else this.misses++; }

    /* ---------- Prefetch (CDN — NOT rate-limited) ---------- */
    triggerPrefetch() {
      // In data-saver mode: current image only, no look-ahead. runPrefetch()
      // itself aborts any in-flight prefetch that's no longer in the window,
      // so a fast-swiping user never piles up wasted downloads.
      if (settings.dataSaver) { bg({ type: 'IMG_CANCEL' }); return; }
      const urls = [];
      for (let o = 1; o <= 8; o++) { const it = this.itemAtOffset(o); if (!it) break; if (it.image.isVideo) continue; urls.push(this.pickUrl(it.image)); }
      if (urls.length) bg({ type: 'IMG_PREFETCH', urls, conn: connProfile() });
    }

    /* ---------- Captions / indicators ---------- */
    updateCaption(post, image) {
      this.caption.textContent = '';
      this.caption.append(
        el('div', { class: 'rif-cap-title', text: post.title }),
        el('div', { class: 'rif-cap-meta' },
          el('span', { class: 'rif-cap-sub', text: `r/${post.subreddit}` }), el('span', {}, `u/${post.author}`),
          el('span', { class: 'rif-cap-score', text: `▲ ${formatNum(post.score)}` }), el('span', { text: `💬 ${formatNum(post.numComments)}` }),
          image.caption ? el('span', { class: 'rif-cap-cc', text: image.caption }) : null));
    }
    updateProgress() {
      const total = this.order.length; const post = this.currentPost();
      const parts = [`Post ${total ? this.oi + 1 : 0}/${total}${this.exhausted ? '' : '+'}`];
      if (post && post.images.length > 1) parts.push(`Image ${this.ii + 1}/${post.images.length}`);
      this.progress.textContent = parts.join(' · ');
    }
    updateDots(post) {
      this.dots.textContent = '';
      if (post.images.length <= 1) { this.dots.hidden = true; return; }
      this.dots.hidden = false;
      post.images.forEach((_, i) => this.dots.append(el('button', { class: `rif-dot${i === this.ii ? ' active' : ''}`, title: `Image ${i + 1}`, onclick: () => { this.ii = i; this.renderCurrent(0); } })));
    }
    updateThumbs(post) {
      this.thumbs.textContent = '';
      // In data-saver mode, skip building the strip until the user asks (perf).
      if (post.images.length <= 1 || (settings.dataSaver && !this._forceThumbs)) { this.thumbs.hidden = post.images.length <= 1; if (settings.dataSaver && post.images.length > 1) { this.thumbs.hidden = false; this.thumbs.append(el('button', { class: 'rif-thumb-hint', text: `Show ${post.images.length} thumbnails`, onclick: () => { this._forceThumbs = true; this.updateThumbs(post); } })); } return; }
      this.thumbs.hidden = false;
      post.images.forEach((im, i) => {
        const t = el('button', { class: `rif-thumb${i === this.ii ? ' active' : ''}`, title: `Image ${i + 1}`, onclick: () => { this.ii = i; this.renderCurrent(0); } });
        if (!im.isVideo) { const thumbUrl = (im.variants && im.variants[0]?.url) || im.url; const img = el('img', { draggable: 'false', dataset: { src: thumbUrl } }); t.append(img); this.thumbObserver.observe(img); }
        else t.append(el('span', { class: 'rif-thumb-vid' }, '▶'));
        this.thumbs.append(t);
      });
      requestAnimationFrame(() => this.thumbs.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' }));
    }

    setLoading(on) { this.spinner.hidden = !on; }

    /* ---------- Search / sub / sort ---------- */
    applyFilter(v) { this.filter = v || ''; this.rebuildOrder(); this.updateProgress(); if (this.order.length) this.renderCurrent(0); else { this.caption.textContent = ''; this.progress.textContent = 'No posts match filter'; } }
    syncSourcePrefix() { if (this.srcPrefix) this.srcPrefix.textContent = this.sourceKind === 'user' ? 'u/' : 'r/'; }
    async switchSub(v) {
      const src = parseSource(v); if (!src) return;
      this.sourceKind = src.kind; this.sub = src.name; this.subInput.value = src.name; this.syncSourcePrefix();
      this.filter = ''; this.searchInput.value = ''; this.reset(); this.banner.hidden = true;
      await this.loadMore();
      if (this.order.length) this.renderCurrent(0);
      else this.showBanner(`No image posts found in ${this.sourceKind === 'user' ? 'u/' : 'r/'}${src.name}.`, 'info');
    }
    async changeSort(sort) { this.sort = sort; this.reset(); await this.loadMore(); if (this.order.length) this.renderCurrent(0); }

    /* ---------- Downloads ---------- */
    fileName(post, i) { const ext = post.images[i].ext || 'jpg'; const suf = post.images.length > 1 ? `_${i + 1}` : ''; return `ImageFlow/${post.subreddit}_${post.id}${suf}.${ext}`; }
    async downloadCurrent() { const p = this.currentPost(); if (!p) return; const r = await bg({ type: 'DOWNLOAD', url: p.images[this.ii].url, filename: this.fileName(p, this.ii) }); toast(this.root, r?.ok ? 'Download started' : `Failed: ${r?.error || ''}`); }
    async downloadPost() { const p = this.currentPost(); if (!p) return; const items = p.images.map((im, i) => ({ url: im.url, filename: this.fileName(p, i) })); const r = await bg({ type: 'DOWNLOAD_MANY', items }); toast(this.root, r?.ok ? `Downloading ${items.length} images` : 'Batch failed'); }
    async copyUrl() { const p = this.currentPost(); if (!p) return; const url = p.images[this.ii].url; try { await navigator.clipboard.writeText(url); toast(this.root, 'Image URL copied'); } catch { toast(this.root, url); } }
    openPost() { const p = this.currentPost(); if (p) window.open(`https://www.reddit.com${p.permalink}`, '_blank', 'noopener'); }

    /* ---------- Settings overlay ---------- */
    toggleSettings(force) {
      const open = force ?? this.settingsPanel.hidden;
      this.settingsPanel.hidden = !open;
      this.header.querySelector('.rif-settings-btn')?.classList.toggle('active', open);
      if (open) {
        this.syncSettingsPanel();
        this.refreshSettingsAuthStatus();
      } else {
        this.settingsPanel.querySelector(':focus')?.blur();
      }
    }

    syncSettingsPanel() {
      if (!this.settingsControls) return;
      for (const [key, cfg] of this.settingsControls) {
        const value = settings[key];
        if (cfg.kind === 'checked') cfg.node.checked = Boolean(value);
        else cfg.node.value = value;
        if (cfg.out) cfg.out.textContent = `${cfg.node.value}${cfg.suffix || ''}`;
      }
    }

    setSetting(key, value) {
      settings = { ...settings, [key]: value };
      this.applySettings();
      this.scheduleSettingsSave();
    }

    scheduleSettingsSave() {
      clearTimeout(this._settingsSaveTimer);
      this._settingsSaveTimer = setTimeout(() => this.persistSettings(), 160);
    }

    async persistSettings() {
      clearTimeout(this._settingsSaveTimer);
      try {
        const { settings: existing = {} } = await api.storage.local.get('settings');
        await api.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...existing, ...settings } });
      } catch {
        toast(this.root, 'Could not save settings');
      }
    }

    async resetSettings() {
      settings = { ...DEFAULT_SETTINGS };
      this.applySettings();
      this.syncSettingsPanel();
      clearTimeout(this._settingsSaveTimer);
      try {
        await api.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
        toast(this.root, 'Settings reset');
      } catch {
        toast(this.root, 'Could not reset settings');
      }
    }

    async refreshSettingsAuthStatus() {
      if (!this.settingsStatus || !this.settingsLoginBtn) return;
      try {
        const st = await bg({ type: 'AUTH_STATUS' });
        if (st?.needsUpdate) {
          this.settingsStatus.textContent = 'Access method needs updating - check for an extension update.';
          this.settingsLoginBtn.hidden = true;
        } else if (st?.loggedIn) {
          this.settingsStatus.textContent = st.name ? `Using your Reddit session (u/${st.name}).` : 'Using your Reddit session.';
          this.settingsLoginBtn.hidden = true;
        } else {
          this.settingsStatus.textContent = 'Not logged in to Reddit. Log in to reddit.com in a tab, then retry.';
          this.settingsLoginBtn.hidden = false;
        }
      } catch {
        this.settingsStatus.textContent = 'Could not check your Reddit session.';
        this.settingsLoginBtn.hidden = true;
      }
    }

    openSettings() { this.toggleSettings(true); }

    // openOptionsPage() isn't available to content scripts, so ask the background.
    openSettingsPage() { bg({ type: 'OPEN_OPTIONS' }).then((r) => { if (!r?.ok) toast(this.root, 'Could not open settings page'); }).catch(() => toast(this.root, 'Could not open settings page')); }

    /* ---------- Grid overview (browse + batch-select), a "contact sheet" ---------- */
    toggleGrid(force, mode = 'browse') { const open = force ?? (this.gridMode === null); if (open) this.openGrid(mode); else this.closeGrid(); }
    // 'B' key / batch entry: open the grid straight into selection mode.
    toggleBatch(force) { const open = force ?? (this.gridMode !== 'select'); if (open) this.openGrid('select'); else this.closeGrid(); }
    openGrid(mode) { this.gridMode = mode; this.gridPanel.hidden = false; this.gridPanel.dataset.mode = mode; hideFab(); this.renderGrid(); }
    closeGrid() { this.gridMode = null; this.gridPanel.hidden = true; this._gridIO?.disconnect(); }
    setGridMode(mode) { this.gridMode = mode; this.gridPanel.dataset.mode = mode; this.updateGridBar(); }
    keyFor(post, i) { return `${post.id}:${i}`; }

    /** Flat list of every displayable (non-video) image across the filtered order. */
    gridItems() {
      const items = [];
      this.order.forEach((postIdx, oi) => {
        const post = this.posts[postIdx];
        const postItems = [];
        post.images.forEach((image, ii) => {
          if (!image.isVideo) postItems.push({ oi, ii, post, image });
        });
        const groupTotal = postItems.length;
        postItems.forEach((item, groupIndex) => {
          items.push({ ...item, groupIndex, groupTotal });
        });
      });
      return items;
    }

    renderGrid() {
      this.gridPanel.textContent = '';
      const search = el('input', { class: 'rif-grid-search', type: 'search', placeholder: 'Filter loaded titles…', value: this.filter, spellcheck: false,
        oninput: (e) => { this.filter = e.target.value || ''; this.rebuildOrder(); this.updateProgress(); this.renderGrid(); } });
      const bar = el('div', { class: 'rif-grid-bar' },
        el('strong', { class: 'rif-grid-title' }, ''),
        search,
        el('button', { class: 'rif-grid-modebtn rif-btn-secondary', onclick: () => this.setGridMode(this.gridMode === 'select' ? 'browse' : 'select') }, ''),
        el('button', { class: 'rif-grid-selall rif-btn-secondary', onclick: () => this.selectAll() }, 'Select all'),
        el('button', { class: 'rif-grid-clear rif-btn-ghost', onclick: () => this.clearSelection() }, 'Deselect all'),
        el('button', { class: 'rif-grid-zip rif-btn-primary', onclick: () => this.downloadSelectedZip() }, 'Download ZIP'),
        el('button', { class: 'rif-grid-seq rif-btn-secondary', onclick: () => this.downloadSelectedSeq() }, 'Download files'),
        el('button', { class: 'rif-btn-ghost', onclick: () => this.toggleSettings(true) }, 'Settings'),
        el('button', { class: 'rif-btn-ghost', onclick: () => this.closeGrid() }, 'Close'));
      this.gridCells = el('div', { class: 'rif-grid-cells' });
      this.applyGridLayoutStyles(this.gridCells);
      this.gridPanel.append(bar, this.gridCells);
      this.gridBar = bar;
      this._gridCount = 0;
      this.appendGridCells();
      this.setupGridSentinel();
      this.updateGridBar();
    }

    applyGridLayoutStyles(node) {
      Object.assign(node.style, {
        flex: '1 1 auto',
        minHeight: '0',
        overflowY: 'auto',
        padding: '14px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(var(--rif-grid-cell-size, 150px), var(--rif-grid-cell-size, 150px)))',
        gridAutoRows: 'var(--rif-grid-cell-size, 150px)',
        gap: '10px',
        alignContent: 'start',
        alignItems: 'stretch',
        justifyContent: 'start',
      });
      node.style.setProperty('--rif-grid-cell-size', 'clamp(112px, 16vw, 170px)');
    }

    appendGridCells() {
      const items = this.gridItems();
      const frag = document.createDocumentFragment();
      for (let n = this._gridCount; n < items.length; n++) frag.append(this.gridCell(items[n]));
      // Always insert BEFORE the footer sentinel so the "load more" marker stays
      // at the bottom and existing cells never move.
      if (this.gridFooter && this.gridFooter.parentNode === this.gridCells) this.gridCells.insertBefore(frag, this.gridFooter);
      else this.gridCells.append(frag);
      this._gridCount = items.length;
    }

    /* One-shot lazy loading: a footer sentinel loads exactly ONE more batch when
       the user scrolls it into view, then waits. It never auto-pulls page after
       page (the old 500px-threshold scroll handler did, which piled images up).
       Also clickable as an explicit "Load more". */
    setupGridSentinel() {
      this._gridIO?.disconnect();
      this.gridFooter = el('div', { class: 'rif-grid-footer' });
      this.gridCells.append(this.gridFooter);
      this.updateGridFooter();
      this._gridIO = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) this.gridLoadMore();
      }, { root: this.gridCells, rootMargin: '150px' });
      this._gridIO.observe(this.gridFooter);
    }

    async gridLoadMore() {
      if (this._gridLoading || this.exhausted) return;
      this._gridLoading = true;
      this.updateGridFooter();
      await this.loadMore();
      this._gridLoading = false;
      this.appendGridCells();
      this.updateGridBar();
      this.updateGridFooter();
    }

    updateGridFooter() {
      const f = this.gridFooter;
      if (!f) return;
      f.textContent = '';
      if (this.exhausted) { f.append(el('span', { class: 'rif-grid-end' }, '— no more images —')); return; }
      if (this._gridLoading) { f.append(el('span', { class: 'rif-grid-loading' }, 'Loading more…')); return; }
      f.append(el('button', { class: 'rif-btn-secondary', onclick: () => this.gridLoadMore() }, 'Load more'));
    }

    gridCell({ oi, ii, post, image, groupIndex = 0, groupTotal = 1 }) {
      const key = this.keyFor(post, ii);
      const isGallery = groupTotal > 1; // multiple displayable images from one post
      const label = isGallery ? `${groupIndex + 1}/${groupTotal}` : '';
      const cell = el('button', {
        type: 'button',
        class: `rif-grid-cell${this.selected.has(key) ? ' checked' : ''}${isGallery ? ' rif-grid-group' : ''}`,
        title: `${post.title}${isGallery ? ` - image ${label}` : ''}`,
        'aria-label': `${post.title}${isGallery ? `, image ${label}` : ''}`,
        dataset: { key },
        onclick: () => { if (this.gridMode === 'select') this.toggleSelect(post, ii, cell); else this.jumpTo(oi, ii); },
      });
      Object.assign(cell.style, {
        position: 'relative',
        display: 'block',
        width: '100%',
        height: '100%',
        minWidth: '0',
        overflow: 'hidden',
        padding: '0',
        background: '#000',
        lineHeight: '0',
      });
      cell.style.border = '2px solid var(--rif-cell-border, transparent)';
      cell.style.borderRadius = '8px';
      // Same-post images share a colour ring + carry an i/N badge so
      // the user can see at a glance which cells belong to one post.
      if (isGallery) {
        const hue = postHue(post.id);
        cell.style.setProperty('--rif-group', `hsl(${hue} 65% 55%)`);
        cell.style.setProperty('--rif-group-soft', `hsla(${hue}, 65%, 55%, 0.34)`);
      }
      // Set src directly with native lazy-loading (works in any scroll container).
      const thumbUrl = (image.variants && image.variants[0]?.url) || image.url;
      const img = el('img', { src: thumbUrl, loading: 'lazy', draggable: 'false' });
      Object.assign(img.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        display: 'block',
      });
      cell.append(img, el('span', { class: 'rif-check' }, '✓'));
      if (isGallery) cell.append(el('span', { class: 'rif-grid-badge', text: label }));
      return cell;
    }


    jumpTo(oi, ii) { this.oi = oi; this.ii = ii; this.closeGrid(); showFab(); this.renderCurrent(0); this.maybePrefetchMore?.(); }

    selItem(post, i) { return { url: post.images[i].url, filename: `${post.subreddit}_${post.id}${post.images.length > 1 ? `_${i + 1}` : ''}.${post.images[i].ext}` }; }
    toggleSelect(post, i, cell) {
      const key = this.keyFor(post, i);
      if (this.selected.has(key)) { this.selected.delete(key); cell?.classList.remove('checked'); }
      else { this.selected.set(key, this.selItem(post, i)); cell?.classList.add('checked'); }
      this.updateGridBar();
    }
    // Select every loaded image (galleries fully expanded → a post's images all
    // get selected, so downloading grabs the whole post). Flips into select mode.
    selectAll() {
      for (const { post, ii } of this.gridItems()) { const key = this.keyFor(post, ii); if (!this.selected.has(key)) this.selected.set(key, this.selItem(post, ii)); }
      if (this.gridMode !== 'select') this.setGridMode('select');
      this.reflectSelection(); this.updateGridBar();
    }
    clearSelection() { this.selected.clear(); this.reflectSelection(); this.updateGridBar(); }
    reflectSelection() { this.gridCells?.querySelectorAll('.rif-grid-cell').forEach((c) => c.classList.toggle('checked', this.selected.has(c.dataset.key))); }
    updateGridBar() {
      if (!this.gridBar) return;
      const n = this.selected.size;
      const title = this.gridBar.querySelector('.rif-grid-title');
      if (title) title.textContent = this.gridMode === 'select' ? `${n} selected` : `${this._gridCount} image${this._gridCount === 1 ? '' : 's'}`;
      const mb = this.gridBar.querySelector('.rif-grid-modebtn');
      if (mb) mb.textContent = this.gridMode === 'select' ? '← Browse' : 'Select for download';
    }
    async downloadSelectedZip() { if (!this.selected.size) return toast(this.root, 'Nothing selected — switch to “Select for download” and pick images'); toast(this.root, `Packing ${this.selected.size} images…`, 4000); const items = [...this.selected.values()]; const r = await bg({ type: 'ZIP_DOWNLOAD', items, zipName: `${this.sub}_${this.sort}_${items.length}img.zip` }); toast(this.root, r?.ok ? `ZIP with ${r.count} images ready` : `ZIP failed: ${r?.error || ''}`); }
    async downloadSelectedSeq() { if (!this.selected.size) return toast(this.root, 'Nothing selected'); const items = [...this.selected.values()].map((it) => ({ ...it, filename: `ImageFlow/${it.filename}` })); const r = await bg({ type: 'DOWNLOAD_MANY', items }); toast(this.root, r?.ok ? `Downloading ${items.length} files` : 'Download failed'); }

    /* ---------- Comments (lazy; cached in IndexedDB by the background) ---------- */
    toggleComments(force) {
      this.commentsOpen = force ?? !this.commentsOpen;
      this.overlay.dataset.comments = this.commentsOpen ? 'open' : 'closed';
      this.commentsPanel.hidden = !this.commentsOpen; this.commentsPanel.dataset.side = settings.commentsSide;
      if (this.commentsOpen) { const p = this.currentPost(); if (p) this.loadComments(p); }
    }
    async loadComments(post) {
      if (this._commentsFor === post.id && this.commentsPanel.querySelector('.rif-comments-list')) return; // already shown
      this._commentsFor = post.id;
      this.commentsPanel.textContent = '';
      this.commentsPanel.append(
        el('div', { class: 'rif-comments-head' }, el('strong', {}, 'Comments'),
          el('a', { class: 'rif-comments-open', href: `https://www.reddit.com${post.permalink}`, target: '_blank', rel: 'noopener' }, 'Open thread ↗'),
          el('button', { class: 'rif-comments-x', title: 'Close (C)', onclick: () => this.toggleComments(false) }, '✕')));
      const list = el('div', { class: 'rif-comments-list' }, el('div', { class: 'rif-comments-loading' }, 'Loading comments…'));
      this.commentsPanel.append(list);
      try {
        // API_COMMENTS is rate-limited but cached; comments are fetched only when
        // the panel is opened — never prefetched alongside images.
        const res = await bg({ type: 'API_COMMENTS', id: post.id, permalink: post.permalink, sort: 'top' });
        if (res?.needsUpdate) { list.textContent = 'Reddit access needs updating — see the banner above.'; return; }
        if (res?.needLogin || res?.needAuth) { list.textContent = 'Log in to reddit.com in this tab, then reopen comments.'; return; }
        if (!res?.ok) throw new Error(`${res?.error || 'request failed'}${res?.status ? ' (HTTP ' + res.status + ')' : ''}`);
        const tree = res.data?.[1]?.data?.children || [];
        list.textContent = '';
        const top = tree.filter((c) => c.kind === 't1');
        if (!top.length) { list.append(el('div', { class: 'rif-comments-loading' }, 'No comments yet.')); return; }
        this.renderCommentBatches(list, top, post);
        const more = tree.find((c) => c.kind === 'more');
        if (more) this._pendingRootMore = { data: more.data, post };
      } catch { list.textContent = ''; list.append(el('div', { class: 'rif-comments-loading' }, 'Could not load comments. ', el('button', { class: 'rif-link-btn', onclick: () => { this._commentsFor = null; this.loadComments(post); } }, 'Retry'))); }
    }

    // Incremental rendering (simple windowing) so a post with hundreds of
    // comments doesn't jank on first open — render 25 at a time as you scroll.
    renderCommentBatches(list, top, post) {
      let i = 0; const BATCH = 25;
      const sentinel = el('div', { class: 'rif-comments-sentinel' });
      const renderNext = () => {
        for (let n = 0; n < BATCH && i < top.length; n++, i++) list.insertBefore(this.renderComment(top[i].data, post, 0), sentinel);
        if (i >= top.length) { io.disconnect(); sentinel.remove(); if (this._pendingRootMore) { list.append(this.renderMore(this._pendingRootMore.data, post, list)); this._pendingRootMore = null; } }
      };
      list.append(sentinel);
      const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) renderNext(); }, { root: list, rootMargin: '300px' });
      io.observe(sentinel); renderNext();
    }

    renderComment(c, post, depth) {
      const node = el('div', { class: 'rif-comment', dataset: { depth: String(Math.min(depth, 6)) } },
        el('div', { class: 'rif-comment-meta' }, el('span', { class: 'rif-comment-author', text: `u/${c.author}` }), el('span', { class: 'rif-comment-score', text: `▲ ${formatNum(c.score ?? 0)}` })),
        el('div', { class: 'rif-comment-body', text: c.body || '' }));
      const replies = c.replies?.data?.children?.filter((x) => x.kind === 't1') || [];
      const moreStub = c.replies?.data?.children?.find((x) => x.kind === 'more');
      const count = replies.length + (moreStub?.count || 0);
      if (count) {
        const wrap = el('div', { class: 'rif-replies', hidden: true });
        const label = (open) => `${open ? '▾' : '▸'} ${count} repl${count === 1 ? 'y' : 'ies'}`;
        const toggle = el('button', { class: 'rif-reply-toggle', text: label(false) });
        let built = false;
        toggle.addEventListener('click', () => { wrap.hidden = !wrap.hidden; toggle.textContent = label(!wrap.hidden); if (!built) { built = true; for (const rp of replies) wrap.append(this.renderComment(rp.data, post, depth + 1)); if (moreStub) wrap.append(this.renderMore(moreStub.data, post, wrap)); } });
        node.append(toggle, wrap);
      }
      return node;
    }
    renderMore(moreData, post, container) {
      const count = moreData.count || (moreData.children?.length ?? 0);
      const btn = el('button', { class: 'rif-more-comments', text: `Load ${count} more comment${count === 1 ? '' : 's'}` });
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Loading…';
        const res = await bg({ type: 'API_MORE', linkId: post.fullname, children: moreData.children || [], sort: 'top' });
        if (res?.ok) { btn.remove(); for (const t of res.things) if (t.kind === 't1') container.append(this.renderComment(t.data, post, 1)); }
        else { btn.disabled = false; btn.textContent = `Retry loading ${count} comments`; }
      });
      return btn;
    }

    /* ---------- Zoom / pan ---------- */
    resetZoom() { this.zoom = { scale: 1, x: 0, y: 0 }; this.applyZoom(); this.figure.classList.remove('rif-zoomed'); }
    applyZoom() { const img = this.buffers[this.active]?.img; if (img) img.style.transform = `translate(${this.zoom.x}px, ${this.zoom.y}px) scale(${this.zoom.scale})`; }
    toggleZoom() { if (this.zoom.scale > 1) this.resetZoom(); else { this.zoom.scale = 2; this.applyZoom(); this.figure.classList.add('rif-zoomed'); } }
    zoomBy(d) { const s = Math.min(6, Math.max(1, this.zoom.scale + d)); this.zoom.scale = s; if (s === 1) { this.zoom.x = 0; this.zoom.y = 0; } this.figure.classList.toggle('rif-zoomed', s > 1); this.applyZoom(); }

    /* ---------- Slideshow ---------- */
    toggleSlideshow(force) { const on = force ?? !this.slideshow; if (on) this.startSlideshow(); else this.stopSlideshow(); }
    startSlideshow() {
      this.stopSlideshow();
      this.slideshow = true;
      this.header.querySelector('.rif-slideshow-btn').replaceChildren(icon('pause'));
      this.restartSlideshowTimer({ first: true });
      toast(this.root, `Slideshow: ${this.slideshowImageSeconds()}s per image`);
    }
    stopSlideshow() { this.slideshow = false; clearTimeout(this._slideTimer); const b = this.header.querySelector('.rif-slideshow-btn'); if (b) b.replaceChildren(icon('play')); }
    slideshowImageSeconds() { return clampNum(settings.slideshowSeconds, 1, 120, DEFAULT_SETTINGS.slideshowSeconds); }
    slideshowFirstDelaySeconds() { return clampNum(settings.slideshowFirstDelaySeconds, 0, 120, DEFAULT_SETTINGS.slideshowFirstDelaySeconds); }
    slideshowTransitionMs() { return clampNum(settings.slideshowTransitionMs, 0, 3000, DEFAULT_SETTINGS.slideshowTransitionMs); }
    slideshowPausesOnHover() { return settings.slideshowPauseOnHover !== false; }
    restartSlideshowTimer({ first = false } = {}) {
      clearTimeout(this._slideTimer);
      if (!this.slideshow || (this._hovering && this.slideshowPausesOnHover())) return;
      const delaySeconds = first ? this.slideshowFirstDelaySeconds() : this.slideshowImageSeconds();
      this._slideTimer = setTimeout(() => this.next(), delaySeconds * 1000);
    }

    /* ---------- Help + Debug ---------- */
    toggleHelp(force) { const on = force ?? this.helpPanel.hidden; this.helpPanel.hidden = !on; }
    toggleDebug(force) {
      const on = force ?? this.debugPanel.hidden; this.debugPanel.hidden = !on;
      clearInterval(this._debugTimer);
      if (on) { this.refreshDebug(); this._debugTimer = setInterval(() => this.refreshDebug(), 1000); }
    }
    async refreshDebug() {
      const s = await bg({ type: 'CACHE_STATS' });
      const avg = this.loadTimes.length ? Math.round(this.loadTimes.reduce((a, b) => a + b, 0) / this.loadTimes.length) : 0;
      const total = this.hits + this.misses; const hitPct = total ? Math.round((this.hits / total) * 100) : 0;
      this.debugPanel.replaceChildren(
        el('div', { class: 'rif-debug-row' }, el('strong', {}, 'RIF debug'), el('button', { class: 'rif-debug-x', onclick: () => this.toggleDebug(false) }, '✕')),
        el('div', {}, `Image cache: ${(s?.imageBytes / 1048576 || 0).toFixed(1)} MB · ${s?.imageCount || 0} imgs`),
        el('div', {}, `Img hit/miss: ${this.hits}/${this.misses} (${hitPct}% hits)`),
        el('div', {}, `Reddit session calls: ${s?.api?.calls ?? 0} · budget left ${s?.api?.remaining ?? '?'}/${s?.api?.limit ?? '?'}`),
        el('div', {}, `Avg image load: ${avg} ms · prefetch in-flight ${s?.prefetch?.inflight ?? 0}`),
        el('div', { class: 'rif-debug-note' }, 'metadata = throttled · images/prefetch = CDN, unlimited'));
    }

    /* ---------- Settings live ---------- */
    applySettings() {
      const panelWidth = clampNum(settings.panelWidth, 280, 560, DEFAULT_SETTINGS.panelWidth);
      this.root.host.style.setProperty('--rif-panel-width', `${panelWidth}px`);
      this.root.host.style.setProperty('--rif-slide-ms', `${this.slideshowTransitionMs()}ms`);
      this.commentsPanel.dataset.side = settings.commentsSide;
      this.overlay.dataset.side = settings.commentsSide;
      if (this.sortSelect) this.sortSelect.value = this.sort;
      const blurNsfw = settings.nsfwBlur !== false;
      for (const post of this.posts) if (post.nsfw) post._blur = blurNsfw;
      const post = this.currentPost();
      if (post) {
        const blurred = Boolean(post._blur && !this.revealed.has(post.id));
        this.figure.classList.toggle('rif-blurred', blurred);
        this.revealBtn.hidden = !blurred;
      }
      this.applyTitleVisibility();
      if (this.slideshow) this.restartSlideshowTimer();
    }

    /** Show/hide the title caption bar per settings.showTitle. */
    applyTitleVisibility() {
      const on = settings.showTitle !== false;
      this.captionBar.hidden = !on;
      this.header.querySelector('.rif-title-btn')?.classList.toggle('active', on);
    }

    /** Toggle the title on/off and persist it (so it sticks across sessions). */
    async toggleTitle() {
      const next = settings.showTitle === false;
      this.setSetting('showTitle', next);
      this.syncSettingsPanel();
      toast(this.root, next ? 'Title shown' : 'Title hidden');
    }

    /* ---------- Interactions ---------- */
    bindStageInteractions() {
      this.figure.addEventListener('mouseenter', () => { this._hovering = true; if (this.slideshowPausesOnHover()) clearTimeout(this._slideTimer); });
      this.figure.addEventListener('mouseleave', () => { this._hovering = false; this.restartSlideshowTimer(); });
      this.viewport.addEventListener('dblclick', (e) => { e.preventDefault(); this.toggleZoom(); });
      this.stage.addEventListener('wheel', (e) => { e.preventDefault(); if (this.zoom.scale > 1 || e.ctrlKey) this.zoomBy(e.deltaY < 0 ? 0.3 : -0.3); else if (e.deltaY > 0) this.next(); else this.prev(); }, { passive: false });

      let dragging = false; let sx = 0; let sy = 0; let ox = 0; let oy = 0;
      this.viewport.addEventListener('pointerdown', (e) => { if (this.zoom.scale <= 1) return; dragging = true; sx = e.clientX; sy = e.clientY; ox = this.zoom.x; oy = this.zoom.y; this.viewport.setPointerCapture(e.pointerId); });
      this.viewport.addEventListener('pointermove', (e) => { if (!dragging) return; this.zoom.x = ox + (e.clientX - sx); this.zoom.y = oy + (e.clientY - sy); this.applyZoom(); });
      this.viewport.addEventListener('pointerup', () => { dragging = false; });

      let tx = 0; let ty = 0; let tActive = false;
      this.stage.addEventListener('touchstart', (e) => { if (this.zoom.scale > 1 || e.touches.length !== 1) return; tActive = true; tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
      this.stage.addEventListener('touchend', (e) => { if (!tActive) return; tActive = false; const dx = (e.changedTouches[0]?.clientX ?? tx) - tx; const dy = (e.changedTouches[0]?.clientY ?? ty) - ty; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) this.next(); else this.prev(); } }, { passive: true });
    }

    handleKey(e) {
      if (this.overlay.hidden) return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); this.toggleDebug(); return; }
      if (this.settingsPanel && !this.settingsPanel.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.toggleSettings(false); }
        return;
      }
      const tag = this.root.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key === 'Escape') this.root.activeElement.blur(); return; }
      const map = {
        ArrowRight: () => this.next(), l: () => this.next(), L: () => this.next(), ' ': () => this.next(),
        ArrowLeft: () => this.prev(), h: () => this.prev(), H: () => this.prev(),
        ArrowDown: () => this.goPost(1), ArrowUp: () => this.goPost(-1), Home: () => this.first(), End: () => this.last(),
        c: () => this.toggleComments(), C: () => this.toggleComments(), z: () => this.toggleZoom(), Z: () => this.toggleZoom(),
        s: () => this.toggleSlideshow(), S: () => this.toggleSlideshow(), b: () => this.toggleBatch(), B: () => this.toggleBatch(),
        g: () => this.toggleGrid(), G: () => this.toggleGrid(),
        d: () => this.downloadCurrent(), D: () => this.downloadCurrent(), a: () => this.downloadPost(), A: () => this.downloadPost(),
        u: () => this.copyUrl(), U: () => this.copyUrl(), o: () => this.openPost(), O: () => this.openPost(),
        t: () => this.toggleTitle(), T: () => this.toggleTitle(),
        '?': () => this.toggleHelp(), Escape: () => this.onEscape(),
      };
      const fn = map[e.key]; if (fn) { e.preventDefault(); e.stopPropagation(); fn(); }
    }
    onEscape() { if (!this.settingsPanel.hidden) return this.toggleSettings(false); if (!this.helpPanel.hidden) return this.toggleHelp(false); if (!this.debugPanel.hidden) return this.toggleDebug(false); if (this.gridMode) return this.closeGrid(); if (this.commentsOpen) return this.toggleComments(false); this.close(); }
  }

  /* ------------------------------------------------------------------ */
  /* Shadow host + FAB + boot                                           */
  /* ------------------------------------------------------------------ */
  let shadowRoot = null; let gallery = null; let fab = null; let uiPromise = null; let cssText = null;

  /** Apply a CSS string inside the shadow root via inline <style> (CSP-safe:
   *  Reddit allows `style-src 'unsafe-inline'`). Constructable stylesheets are
   *  tried first; both avoid the external-<link> path that Reddit's CSP blocks. */
  function injectCss(root, css, tag) {
    if (!css) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return;
    } catch { /* fall back to inline <style> */ }
    const style = document.createElement('style');
    if (tag) style.dataset.rif = tag;
    style.textContent = css;
    root.append(style);
  }

  /** Fetch + apply the full gallery.css asynchronously (background isn't under
   *  the page CSP). Failure is non-fatal — critical CSS already made the UI
   *  visible; we just log it so it's never a silent mystery. */
  async function applyFullCss(root) {
    if (cssText != null) { injectCss(root, cssText, 'full'); return; }
    try {
      const res = await bg({ type: 'GET_CSS' });
      cssText = (res && res.css) || '';
      if (!cssText) logErr('GET_CSS returned empty — is the background script alive?', res);
      injectCss(root, cssText, 'full');
    } catch (e) {
      logErr('GET_CSS failed (background not responding?). Using critical CSS only.', e);
    }
  }

  /*
   * The floating button is a PLAIN light-DOM element with fully inline styles,
   * mounted synchronously the moment the content script runs — no shadow DOM, no
   * stylesheet fetch, no background message. If the content script executes at
   * all, this button is visible. (The rich overlay is still shadow-DOM isolated
   * and built lazily on first click.)
   */
  function mountFab() {
    try {
      if (fab && fab.isConnected) return;
      fab = document.createElement('button');
      fab.id = 'rif-fab-hard';
      fab.type = 'button';
      fab.textContent = '📷 Gallery';
      fab.title = 'Image Flow — Start Gallery';
      fab.style.cssText =
        'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:11px 16px;' +
        'border:none;border-radius:999px;background:linear-gradient(135deg,#ff5700,#ff2d55);' +
        'color:#fff;font:600 14px system-ui,-apple-system,sans-serif;cursor:pointer;' +
        'box-shadow:0 6px 20px rgba(255,45,85,.45);display:inline-flex;align-items:center;gap:8px;';
      fab.addEventListener('click', () => startGallery());
      (document.body || document.documentElement).appendChild(fab);
      log('floating button mounted (bottom-right)');
    } catch (e) { logErr('could not mount floating button', e); }
  }

  function ensureUI() { if (!uiPromise) uiPromise = buildUI(); return uiPromise; }
  async function buildUI() {
    log('building gallery overlay');
    const host = el('div', { id: 'image-flow-host' });
    host.attachShadow({ mode: 'open' });
    shadowRoot = host.shadowRoot;
    (document.body || document.documentElement).append(host);
    // GUARANTEED visibility first — synchronous, no network, CSP-safe.
    injectCss(shadowRoot, CRITICAL_CSS, 'critical');
    gallery = new Gallery(shadowRoot);
    window.addEventListener('keydown', (e) => gallery.handleKey(e), true);
    api.runtime.onMessage.addListener((msg) => { if (msg?.type === 'RATE_LIMIT' && gallery && !gallery.overlay.hidden) rateLimitToast(msg.seconds); });
    // Layer the full stylesheet on top (async, best-effort).
    applyFullCss(shadowRoot);
    log('overlay ready');
  }
  let rlTimer = null;
  function rateLimitToast(seconds) {
    if (!gallery) return; const host = gallery.root.querySelector('.rif-toast'); if (!host) return;
    clearInterval(rlTimer);
    let s = Math.max(1, seconds || 1);
    const item = el('div', { class: 'rif-toast-item show', text: `Reddit rate limit reached, retrying in ${s}s…` });
    host.append(item);
    rlTimer = setInterval(() => { s--; if (s <= 0) { clearInterval(rlTimer); item.classList.remove('show'); setTimeout(() => item.remove(), 300); } else item.textContent = `Reddit rate limit reached, retrying in ${s}s…`; }, 1000);
  }
  function hideFab() { if (fab) fab.style.display = 'none'; }
  function showFab() { if (fab) fab.style.display = 'inline-flex'; }
  async function startGallery(opts = {}) {
    try {
      log('startGallery', opts);
      await loadSettings();
      await ensureUI();
      // Honor an explicit sub/kind from the popup; otherwise detect the feed
      // (subreddit OR /user/<name>/submitted) from the current page URL.
      const src = opts.sub ? { kind: opts.kind || 'subreddit', name: opts.sub } : (currentSource() || { kind: 'subreddit', name: 'pics' });
      await gallery.open({ sub: src.name, kind: src.kind, sort: opts.sort || settings.defaultSort });
    } catch (e) {
      logErr('startGallery failed', e);
      // Make sure the overlay is at least visible with an error, never silent.
      try { if (gallery) { gallery.overlay.hidden = false; gallery.showBanner(`Something went wrong opening the gallery: ${e?.message || e}. Try reloading the page.`, 'error'); } }
      catch { /* last resort */ }
    }
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'START_GALLERY') { startGallery({ sub: msg.sub, kind: msg.kind, sort: msg.sort }); return Promise.resolve({ ok: true }); }
    if (msg?.type === 'PING') return Promise.resolve({ ok: true, sub: currentSubreddit() });
    return false;
  });

  /** Keep the button present across Reddit's SPA re-renders (shreddit can wipe
   *  injected nodes). Re-mount if it vanished, unless the gallery is open. */
  function syncFab() {
    const galleryOpen = gallery && !gallery.overlay.hidden;
    if (galleryOpen) return;
    if (!fab || !fab.isConnected) mountFab();
  }

  async function checkPending() {
    try {
      const { pendingGallery } = await api.storage.local.get('pendingGallery');
      if (pendingGallery && Date.now() - pendingGallery.ts < 30000) {
        await api.storage.local.remove('pendingGallery');
        log('auto-opening from popup request', pendingGallery);
        startGallery({ sub: pendingGallery.sub, kind: pendingGallery.kind, sort: pendingGallery.sort });
      }
    } catch (e) { logErr('pendingGallery check failed', e); }
  }

  function boot() {
    log('content script booting on', location.href);
    mountFab();                 // 1) unmissable entry point, right now
    loadSettings();             // 2) warm settings (non-blocking)
    checkPending();             // 3) honor a popup launch, if any

    // Keep the button alive against SPA re-renders and follow SPA navigation.
    setInterval(syncFab, 1500);
    let lastUrl = location.href;
    setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; log('SPA navigation', lastUrl); syncFab(); } }, 800);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // Also mount immediately in case DOMContentLoaded already fired between checks.
  mountFab();
})();
