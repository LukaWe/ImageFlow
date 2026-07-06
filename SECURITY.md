# Security Policy

## Supported Versions

Security fixes are handled for the latest released version and the current
`main` branch.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Use GitHub's private vulnerability reporting for this repository if it is
enabled (Security → Report a vulnerability). If it is not enabled, open a public
GitHub issue that only states you have a security concern — without any technical
details — and ask the maintainer [@LukaWe](https://github.com/LukaWe) to open a
private channel. Do not post vulnerability details publicly.

Include as much of the following as possible:

- Affected extension version or commit.
- Firefox version and operating system.
- Steps to reproduce.
- Expected and actual behavior.
- Impact assessment.
- Whether the issue requires a logged-in Reddit session.
- Any proof-of-concept code or files needed to reproduce.

Do not include live Reddit session cookies, account passwords, OAuth tokens, or
other credentials. If a credential is accidentally exposed during testing,
revoke it before reporting.

## Response Expectations

The maintainer should acknowledge a valid private security report as soon as
practical, triage the impact, and coordinate a fix before public disclosure.

Public disclosure should wait until:

- A fix is committed.
- A release is available, when applicable.
- A reasonable remediation window has passed.

## Security-Relevant Areas

The most sensitive parts of this extension are:

- Reddit session detection through the `cookies` permission.
- Cross-origin fetches performed by the background script.
- Local metadata and image caches.
- Downloads and ZIP generation.
- Any future permission changes.

## Non-Security Issues

General bugs, feature requests, documentation fixes, and layout issues can be
reported through public GitHub issues.
