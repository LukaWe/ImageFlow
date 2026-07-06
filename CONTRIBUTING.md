# Contributing

Thanks for considering a contribution to Image Flow.

This project is a Firefox Manifest V3 WebExtension with plain JavaScript, HTML, CSS, and Mozilla `web-ext` tooling. There is no bundler and no runtime package dependency.

## Ways to Contribute

- Report reproducible bugs.
- Suggest focused feature improvements.
- Improve documentation, privacy text, or release notes.
- Improve accessibility, keyboard support, and responsive layout.
- Add targeted tests or validation scripts if the project grows test coverage.

## Before Opening an Issue

- Search existing issues first.
- Confirm the issue occurs with the latest commit or latest released version.
- Include Firefox version, operating system, and extension version.
- Include the Reddit page type where the issue happens, for example subreddit page, user submissions page, gallery post, video post, or comments drawer.
- Do not include private Reddit account details, private subreddit content, cookies, tokens, or browser profile data.

Security issues must not be reported in public issues. See [SECURITY.md](SECURITY.md).

## Issue Template Pointers

If GitHub issue templates are added later, use:

- Bug report for broken behavior, crashes, layout issues, or permission problems.
- Feature request for new capabilities or UX changes.
- Documentation issue for README, privacy, release, or setup improvements.
- Security report only through the private process in [SECURITY.md](SECURITY.md).

## Development Setup

```bash
git clone https://github.com/LukaWe/ImageFlow.git
cd ImageFlow
npm install
npm run lint
npm run build
```

Run in a temporary Firefox profile:

```bash
npm start
```

Manual temporary install:

1. Open Firefox.
2. Go to `about:debugging`.
3. Select "This Firefox".
4. Click "Load Temporary Add-on...".
5. Select `manifest.json`.

## Code Style

- Use plain JavaScript modules where the codebase already uses modules.
- Do not add a bundler unless there is a clear release reason.
- Do not add runtime dependencies for small utilities that can be implemented safely in a few lines.
- Keep content-script UI isolated in the Shadow DOM.
- Keep cross-origin network access in the background script.
- Keep Reddit metadata calls rate-limited and cached.
- Do not remove backoff, throttling, or user-facing auth warnings.
- Prefer local, dependency-free implementations for extension-package code.
- Avoid remote code, `eval`, inline remote scripts, or CDN JavaScript.
- Keep permissions narrow and document any new permission in README and PRIVACY.

## Pull Request Process

1. Create a focused branch.
2. Make the smallest change that solves the problem.
3. Update documentation when behavior, permissions, privacy, or settings change.
4. Run validation before opening the PR:

   ```bash
   node --check src/background.js
   node --check src/content-script.js
   node --check src/options.js
   node --check src/popup.js
   npm run lint
   npm run build
   ```

5. Describe what changed, why it changed, and how you tested it.
6. Include screenshots or short recordings for UI changes.
7. Call out any permission, privacy, rate-limit, trademark, or platform-policy implications.

## Commit Messages

Use short, imperative commit messages:

- `Fix grid cell sizing`
- `Add settings overlay`
- `Document privacy policy`

## Review Expectations

Maintainers may ask for changes when a PR:

- Adds unnecessary permissions.
- Sends data to a new host.
- Weakens privacy guarantees.
- Breaks Firefox MV3 compatibility.
- Removes throttling or backoff.
- Adds large runtime dependencies without a strong reason.
- Introduces UI that overlaps content or breaks keyboard navigation.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
