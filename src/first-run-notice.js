/*
 * Image Flow — first-run notice.
 * One-time page shown on install explaining that authentication uses the user's
 * existing reddit.com session. The background sets the `firstRunShown` flag and
 * opens this page once; here we just close it when acknowledged.
 */
const api = globalThis.browser || globalThis.chrome;

document.getElementById('ok').addEventListener('click', async () => {
  try { await api.storage.local.set({ firstRunShown: true }); } catch { /* already set by background */ }
  // Close this tab; fall back to navigating away if the browser blocks close().
  window.close();
  setTimeout(() => { location.href = 'https://www.reddit.com/r/EarthPorn/'; }, 150);
});
