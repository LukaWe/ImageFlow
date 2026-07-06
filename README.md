# Image Flow

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Firefox 115+](https://img.shields.io/badge/Firefox-115%2B-orange.svg)](https://www.mozilla.org/firefox/)

Fast full-screen image browsing for reddit.com pages in Firefox, with a lightbox gallery, grid view, comments, slideshow, zoom, and local downloads.

> This is an independent, unofficial third-party extension. It is not affiliated with, endorsed by, sponsored by, or otherwise connected to Reddit, Inc.

## Screenshots and GIFs

Add screenshots before publishing the GitHub repository or Firefox Add-ons listing:

- `docs/screenshots/gallery.png`: full-screen gallery on a subreddit page, including the floating Gallery button entry point.
- `docs/screenshots/grid.png`: grid view showing same-post image grouping with colored borders and badges.
- `docs/screenshots/settings.png`: in-gallery settings overlay with slideshow controls visible.
- `docs/screenshots/comments.png`: comments drawer open beside an image.
- `docs/screenshots/flow.gif`: short GIF showing open gallery, navigate images, switch to grid, and start slideshow.

Avoid screenshots that expose private account names, private subreddits, NSFW content, messages, browser profile details, or API/session information.

## Features

- Floating Gallery button injected on `reddit.com` pages for one-click access.
- Toolbar popup for selecting a subreddit or user submissions feed and sort order.
- Full-screen Shadow DOM gallery isolated from Reddit page styles.
- Single-image posts, Reddit galleries, direct `i.redd.it`/`i.imgur.com` images, Reddit-hosted video fallbacks, and preview variants.
- Keyboard, mouse, wheel, touch, and swipe navigation.
- Per-post multi-image navigation with dots and lazy thumbnail strip.
- Real grid view where every image is its own square cell.
- Colored grouping in grid view so images from the same post are visually connected.
- Batch selection mode with sequential file download or local ZIP export.
- In-gallery comments drawer with lazy comment loading, reply expansion, and "load more" support.
- Search/filter across loaded post titles.
- Subreddit/user feed switching without leaving the gallery.
- Sort switching for Hot, New, Top, Rising, and Best.
- Configurable slideshow image duration, initial delay, transition duration, and hover pause.
- Zoom and pan support for still images.
- Optional NSFW blur until the user clicks to reveal.
- Optional title/caption bar.
- Data saver mode that reduces prefetching and prefers smaller preview images until HD is requested.
- Local metadata and image caching for faster browsing.
- Cache size cap with oldest-first image eviction.
- Session status banners for login, retry, and access-method failures.
- First-run notice explaining that the extension uses the user's existing Reddit session.
- Debug overlay with cache, request, prefetch, and image timing stats.

## How It Works

Image Flow is a Firefox Manifest V3 WebExtension. It has no bundler and no runtime third-party JavaScript libraries.

The extension is split into these parts:

| Component | File(s) | Responsibility |
| --- | --- | --- |
| Manifest | `manifest.json` | Declares Firefox support, permissions, background scripts, popup, options page, content script, and web-accessible CSS/icon resources. |
| Background event page | `src/background.js` | Routes messages, performs cross-origin Reddit/CDN requests, rate-limits Reddit metadata calls, caches data, creates downloads, builds ZIP files, opens options, and opens the first-run notice. |
| Auth helpers | `src/auth.js` | Checks the user's existing `reddit.com` session and builds Reddit `.json` URLs. |
| Cache manager | `src/cache-manager.js` | Stores listing/comment metadata in IndexedDB and image responses in Cache Storage with LRU pruning. |
| Prefetch worker | `src/prefetch.js` | Prefetches upcoming CDN images in the background using connection-aware limits and aborts stale work. |
| Content script | `src/content-script.js` | Injects the floating button and gallery UI into Reddit pages, normalizes posts, renders the gallery/grid/comments/settings, and talks to the background via `runtime.sendMessage`. |
| Gallery styles | `src/gallery.css` | Shadow DOM styles for the gallery, grid, settings overlay, comments drawer, and responsive layout. |
| Popup | `src/popup.html`, `src/popup.js` | Toolbar UI for choosing a feed/sort, checking session status, and launching the gallery. |
| Options | `src/options.html`, `src/options.js` | Persistent settings page and session status display. |
| First-run notice | `src/first-run-notice.html`, `src/first-run-notice.js` | One-time explanation of the session-based access model. |

### Runtime Flow

1. The content script runs on matching Reddit pages and mounts a plain floating Gallery button.
2. When the user starts the gallery, the content script loads local settings and builds the Shadow DOM overlay.
3. The content script asks the background for auth status.
4. The background checks for a `reddit_session` cookie and/or probes `https://www.reddit.com/api/me.json` using `credentials: "include"`.
5. Listing, comment, and "more comments" requests go through the background to Reddit `.json` endpoints.
6. The background self-throttles Reddit metadata calls to roughly 30 requests per minute and backs off on `429`, `403`, and repeated auth failures.
7. Listing and comment JSON responses are cached in IndexedDB with a short TTL.
8. Image bytes are fetched from CDN/image hosts through the background image broker, cached in Cache Storage, and returned to the content script as `Blob`s.
9. Downloads use the browser downloads API; ZIP export is built locally in the background with a small dependency-free ZIP writer.

The extension does not use a developer-operated backend, analytics service, or remote executable code.

## Installation

### Firefox Add-ons

Firefox Add-ons listing: `https://addons.mozilla.org/firefox/addon/REPLACE_WITH_SLUG/`

Replace the placeholder after the add-on is published.

### Temporary Install for Development

1. Open Firefox.
2. Go to `about:debugging`.
3. Select "This Firefox".
4. Click "Load Temporary Add-on...".
5. Select this repository's `manifest.json`.
6. Open a Reddit page such as `https://www.reddit.com/r/EarthPorn/`.
7. Click the floating Gallery button or use the toolbar popup.

Temporary add-ons are removed when Firefox restarts.

## Permissions Explained

| Permission or host permission | Why it is needed |
| --- | --- |
| `storage` | Stores settings, one-time first-run state, popup launch handoff, metadata cache index, and image cache bookkeeping locally in Firefox. |
| `downloads` | Saves individual images, sequential image downloads, and locally generated ZIP archives through Firefox's downloads manager. |
| `cookies` | Checks for the presence of the user's `reddit_session` cookie to determine whether Reddit is logged in. The cookie value is not stored by the extension. |
| `*://*.reddit.com/*` | Runs the content script on Reddit pages, opens Reddit login/post pages, and fetches `www.reddit.com` JSON listing/comment/session endpoints with the user's existing session. This also covers `old.reddit.com`. |
| `*://i.redd.it/*` | Fetches and caches Reddit-hosted image/video files. |
| `*://preview.redd.it/*` | Fetches and caches Reddit preview image variants used for thumbnails and data saver mode. |
| `*://*.redd.it/*` | Covers additional Reddit media/CDN subdomains and redirects. |
| `*://i.imgur.com/*` | Fetches and downloads direct Imgur image links commonly posted to Reddit. |

The extension uses the Tabs API for normal extension operations such as opening Reddit login pages, creating a Reddit tab from the popup, and messaging the active Reddit tab. It does not request the broad `tabs` permission in `manifest.json`.

The extension does not request `webRequest`, `scripting`, `activeTab`, `history`, `bookmarks`, `clipboardRead`, `clipboardWrite`, or `<all_urls>`.

## Configuration and Options

Settings are available from the extension options page and from the in-gallery settings overlay:

- Comments panel side: left or right.
- Default sort: Hot, New, Top, Rising, or Best.
- Show image title/caption bar.
- Blur NSFW images until clicked.
- Slideshow image duration.
- Slideshow first-switch delay.
- Slideshow transition duration.
- Pause slideshow on hover.
- Side panel width.
- Data saver mode.
- Image cache size cap.

All settings are stored in `browser.storage.local` and apply live where possible.

## Privacy and Data Handling

Short version: Image Flow does not send user data to the developer, and it does not use analytics.

The extension communicates with:

- `www.reddit.com` for session checks, listings, comments, and more-comments JSON requests.
- Reddit media hosts such as `i.redd.it`, `preview.redd.it`, and `*.redd.it` for image/video files.
- `i.imgur.com` for direct image links found in Reddit posts.

The extension stores locally:

- User preferences in `browser.storage.local`.
- A first-run notice flag in `browser.storage.local`.
- A short-lived popup launch request in `browser.storage.local`.
- Listing and comment JSON metadata in IndexedDB.
- Image/video HTTP responses in Cache Storage.
- Image cache index data in IndexedDB.

The extension reads:

- Reddit page URLs to detect subreddit or user feed context.
- Reddit listing/comment JSON returned by Reddit.
- Reddit-hosted or linked image/video URLs.
- The presence of the `reddit_session` cookie for login status.

The extension does not:

- Operate a remote server.
- Transmit browsing data to the developer.
- Sell or share user data.
- Inject remote scripts.
- Store Reddit cookies or passwords.
- Request Reddit API keys, client secrets, or OAuth credentials.

See [PRIVACY.md](PRIVACY.md) for the full policy.

## Development Setup

Requirements:

- Firefox 115 or newer.
- Node.js 18 or newer.
- npm 8 or newer.

```bash
git clone https://github.com/LukaWe/ImageFlow.git
cd ImageFlow
npm install
npm run lint
npm run build
```

Run with a temporary Firefox profile:

```bash
npm start
```

Build output is written to `web-ext-artifacts/`.

Useful checks:

```bash
node --check src/background.js
node --check src/content-script.js
node --check src/options.js
node --check src/popup.js
npm run lint
npm run build
```

## Dependencies and Licenses

Runtime dependencies bundled with the extension:

- None.

Development dependency:

| Package | Use | License |
| --- | --- | --- |
| `web-ext` | Firefox extension linting, running, building, and signing | MPL-2.0 |

`web-ext` and its transitive dependencies are development tooling only and are not bundled into the extension package.

No GPL or AGPL runtime dependency was found in the declared project dependencies.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, coding style, and review expectations.

Please do not report security vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

This project is licensed under the [MIT License](LICENSE).

## Disclaimer and Trademarks

This project is an independent, unofficial third-party browser extension. It is not affiliated with, endorsed by, sponsored by, or otherwise connected to Reddit, Inc.

"Reddit" and related marks are trademarks of Reddit, Inc. Other names, logos, and brands are property of their respective owners. The project name avoids the Reddit mark; documentation uses it only to identify compatibility with reddit.com.

See [DISCLAIMER.md](DISCLAIMER.md).

## Publishing and Policy Risks

Review these items before publishing to GitHub, AMO, or another public directory:

- The extension has been renamed to Image Flow to avoid using the Reddit mark as the project name. Continue to avoid Reddit logos, Snoo, and official wordmarks in icons or store assets.
- The icon appears custom and does not appear to include Reddit's official logo or Snoo mascot.
- The extension uses Reddit's logged-in website session and public `.json` endpoints. Bulk downloads or automated large-scale use may conflict with Reddit terms, API policies, rate limits, copyright expectations, or robots/content restrictions.
- Batch and ZIP download features should be presented as personal, interactive tools rather than scraping or archival automation.
- No hardcoded API keys, client secrets, OAuth credentials, tokens, or developer backends were found in the source.
- This repository includes local agent/tooling configuration (`.claude/`, `AGENTS.md`). Review whether those files should be included before a public GitHub push.
- Mozilla's data collection manifest declaration is set to `required: ["none"]`, matching the privacy policy that no user data is transmitted to the developer or a third-party backend.

## Acknowledgments

- Built with Firefox WebExtensions APIs.
- Developed and validated with Mozilla's `web-ext` tooling.
- Uses Reddit's website JSON endpoints and media CDN hosts to display content the user can already access in their own browser session.
