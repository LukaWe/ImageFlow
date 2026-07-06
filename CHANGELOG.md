# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning for public releases.

## [Unreleased]

### Added

- Initial public documentation, privacy, security, contributing, and disclaimer files.

### Changed

- Renamed the public project and extension branding to "Image Flow"; reddit.com is now described as the supported site rather than used as the project name.

## [0.1.0] - 2026-07-06

### Added

- Firefox Manifest V3 extension scaffold.
- Toolbar popup for selecting subreddit/user feed and sort order.
- Floating Gallery button on Reddit pages.
- Full-screen Shadow DOM gallery.
- Session-based Reddit access using the user's existing `reddit.com` login.
- First-run notice explaining the Reddit session model.
- Reddit listing support for subreddits and user submissions.
- Reddit comments drawer with lazy loading, reply expansion, and more-comments loading.
- Support for single image posts, Reddit galleries, Reddit-hosted video fallbacks, preview variants, and direct Imgur images.
- Keyboard, mouse, wheel, touch, and swipe navigation.
- Grid view with real square cells and colored same-post grouping.
- Batch selection mode with sequential downloads and local ZIP export.
- Image slideshow with configurable timing and transitions.
- Zoom, pan, title toggle, NSFW blur, and HD image controls.
- In-gallery settings overlay and full options page.
- Data saver mode and configurable cache cap.
- IndexedDB metadata cache.
- Cache Storage image cache with LRU pruning.
- Connection-aware image prefetching.
- Debug overlay with cache and request stats.
- Conservative Reddit metadata request throttling and exponential backoff.

### Security

- No hardcoded API keys, client secrets, or OAuth credentials.
- No developer-operated backend or analytics service.
- Explicit Mozilla data collection declaration set to no collected data.

### Legal

- Added MIT License.
- Added privacy policy, disclaimer, code of conduct, contributing guide, and security policy.
