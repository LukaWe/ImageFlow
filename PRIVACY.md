# Privacy Policy

Effective date: 2026-07-06

Image Flow is a Firefox browser extension for browsing Reddit-hosted and
Reddit-linked images in a faster gallery interface.

This policy describes what the extension reads, stores, and transmits.

## Summary

Image Flow does not send user data to the developer, does not use
analytics, and does not operate a remote backend.

The extension communicates only with Reddit/media hosts needed to display the
content the user asks to browse:

- `www.reddit.com`
- `old.reddit.com` and other `*.reddit.com` pages covered by the content script
- `i.redd.it`
- `preview.redd.it`
- other `*.redd.it` media hosts
- `i.imgur.com`

## Data the Extension Reads

The extension may read:

- The current Reddit page URL, to detect subreddit or user feed context.
- Reddit listing JSON for posts in the selected subreddit or user submissions feed.
- Reddit comment JSON when the comments drawer is opened.
- Reddit post metadata such as title, author name, subreddit name, score, comment count, permalink, post ID, creation time, NSFW flag, gallery item captions, image dimensions, and image URLs.
- Image/video files from allowed media hosts.
- Whether the user's browser has a `reddit_session` cookie for `reddit.com`, to determine login status.
- User settings stored by the extension.

The extension does not read Reddit passwords.

The extension does not store the value of the Reddit session cookie.

## Data Stored Locally

The extension stores the following data locally in Firefox:

| Storage location | Data |
| --- | --- |
| `browser.storage.local` | User settings, first-run notice flag, and short-lived popup launch handoff. |
| IndexedDB database `image-flow` | Cached listing/comment JSON metadata and image cache index entries. |
| Cache Storage cache `image-flow-images-v1` | Cached image/video HTTP responses from media hosts. |
| Firefox downloads | Image files or ZIP archives that the user explicitly downloads. |

Local cached data remains on the user's device unless the user clears extension
storage, clears browser site/add-on data, removes the extension, or uses the
extension's cache-clearing functionality if exposed by the UI.

## Data Sent Over the Network

The extension sends network requests to:

- `www.reddit.com/api/me.json` to check login status.
- `www.reddit.com/r/<subreddit>/<sort>.json` for subreddit listings.
- `www.reddit.com/user/<username>/submitted.json` for user submissions.
- `www.reddit.com/comments/<post_id>.json` for comments.
- `www.reddit.com/api/morechildren.json` for additional comments.
- Reddit and Imgur image/media hosts for image display, prefetch, caching, and downloads.

Requests to Reddit use the user's normal browser session where applicable. This
means Reddit may receive cookies and request metadata in the same way it does
when the user browses Reddit normally.

No data is sent to the extension developer.

No data is sold or shared by the extension developer.

## Authentication

The extension does not implement a separate OAuth flow and does not ask the user
for a Reddit API key, client ID, client secret, username, or password.

It checks whether the user is already logged in to `reddit.com` in Firefox and
uses browser requests with `credentials: "include"` for Reddit JSON endpoints.

## Downloads

When the user downloads an image or ZIP archive, Firefox's downloads manager
saves the selected content to the user's device. ZIP archives are built locally
inside the extension background context.

## Analytics and Tracking

The extension does not include:

- Analytics.
- Telemetry to the developer.
- Advertising SDKs.
- Remote logging.
- Tracking pixels.
- A developer-operated backend service.

## Third-Party Services

Reddit and Imgur may receive requests because they host the content being viewed
or downloaded. Their own privacy policies and terms apply to those services.

## Data Collection Declaration

For Mozilla add-on data collection purposes, this project declares no data
collection by the extension developer. The manifest uses:

```json
{
  "browser_specific_settings": {
    "gecko": {
      "data_collection_permissions": {
        "required": ["none"]
      }
    }
  }
}
```

This declaration means the extension does not collect or transmit user data to
the developer or a third-party analytics/backend service.

## Children

This extension is a general browser tool and is not directed at children.

## Changes to This Policy

Material privacy changes should be documented in this file, the README, and the
changelog. Permission or host changes should also be explained in the README's
permissions table.

## Contact

Use the repository issue tracker for privacy questions that do not involve a
security vulnerability. Report security-sensitive issues privately according to
[SECURITY.md](SECURITY.md).
