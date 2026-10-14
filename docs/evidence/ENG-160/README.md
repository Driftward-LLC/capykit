# ENG-160 isolated browser evidence

## Recorded result

The baseline built console at repository HEAD
`71b392fd43b10d8ba6a8f4244fd1b628abda6ae7` passed 27 checks in a real
headless Chromium browser. There are 15 credential-free BEFORE screenshots,
including Apps and sign-in at desktop 1440px and mobile-emulated 375px.
The baseline is the existing fixed-dark design, even when the browser's
system preference is light.

Exact baseline build SHA-256:
`0665ec3da3393ad936a29954fd8b45681519a90ec606293dd91a908bd20b6cc0`.
The checksum covers the served index and its linked assets, sorted by path.
The harness snapshots those bytes before launching any scenario.

The Astryx build passed 49 focused browser checks with 31 AFTER screenshots.
It includes desktop and 320/375/430px Apps/sign-in in light/dark, public Google
entry in light/dark, recovery states and system preference evidence.
Exact AFTER build SHA-256:
`03b6d1a093dc144c07b9f08e7f50e36128f1d568834eb3e40f1d5a43f75f0648`.
AFTER hashes all served assets, including fonts, bootstrap and lazy chunks.
See [representative target](target) and [migration note](../../astryx-migration.md).

## Reproduction

From the repository root, before rebuilding the baseline:

```sh
CAPYKIT_SHELL_BASELINE=1 node scripts/test-astryx-shell.mjs
```

After building the Astryx source with `npm run build`:

```sh
node scripts/test-astryx-shell.mjs
```

Defaults reuse the supplied installed tools; no install is performed:

```text
Playwright: /opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs
Chromium: /opt/data/browser-fixtures/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell
Console: dist/console
```

Overrides are `CAPYKIT_PLAYWRIGHT_MODULE`, `CAPYKIT_CHROMIUM_PATH`, and
`CAPYKIT_CONSOLE_DIR`. Baseline mode is pinned to both the requested Git HEAD
and exact build bytes, preventing a rebuild from overwriting BEFORE evidence.
The harness returns nonzero on failed assertions and preserves failures in
phase-specific `metadata.json`; it does not silently skip failed scenarios.

## Coverage

Shared BEFORE/AFTER assertions exercise:

- Apps and native email sign-in at 320, 375, 430, and 1440px, no horizontal
  overflow, and in-bounds shell controls with 44px minimum targets.
- Native Tab reachability, Enter/Space activation, current-page semantics,
  and preserved tab URLs and unrelated query parameters. Functions and
  People access remain reachable through the actual secondary disclosure.
- Native email and OTP validation, preserved `email`/`code` IDs and OTP
  attributes, submission counts, pending disabled controls, invalid-code
  recovery, successful fixture sign-in, and no OTP persistence.
- Google available/unavailable and start failure, Tailscale denial/retry,
  session unavailable/retry, focus-triggered and application-response 401
  expiry, and logout failure followed by success.
- Owner, human member, and agent-identity visibility and member API boundaries.
- Session/Apps loading, empty and error evidence, with released held responses
  and real refresh recovery rather than fabricated final states.

The final AFTER harness also covers Google initiation to an intercepted synthetic
provider page, Google/email callback error cleanup, the shared Astryx create action
and unobscured focused native form content in a 420px-high mobile viewport.

AFTER additionally requires the real installed Astryx 0.7.0 Button's stable
class and mounted React component identity. Keyboard submits and pending
native disabled behavior are tested on those real controls. Appearance checks
cover light/dark screenshots at all four widths, live system-media changes,
explicit-mode precedence, reload persistence, unrelated-key preservation,
blocked localStorage, invalid-value fallback, and pre-React bootstrap with
the module response held. Keyboard focus must have a visible ring.
Figtree must actually load with the exact Neutral family, and the hosted CSP is
enforced: bootstrap, components and fonts must not cause policy violations.

Only mounted Astryx identity/appearance/bootstrap checks are disabled for
the legacy baseline. The BEFORE run does **not** verify Astryx components.

## Evidence and limits

`before/metadata.json` and `after/metadata.json` record the
Git HEAD, built-byte checksum, browser version, fixture inputs, request paths,
individual outcomes, screenshot routes, viewports, appearance, media preference,
and rendered theme attributes/colors. Git HEAD is not a claim that a dirty
source rebuild was produced from a clean commit; the build checksum identifies
its exact served bytes.

All page requests are intercepted. The application origin is
`https://capykit.example.test`; Google initiation permits only one exact synthetic
OAuth URL and fulfills it locally. Unexpected origins or API routes fail and
abort; nothing is forwarded to a live API or OAuth provider.
The only cookies are synthetic private/public
CSRF sentinels, and every mutation checks the appropriate CSRF header.
Synthetic account metadata is used throughout. Screenshots refuse filled
email/OTP fields. No credentials, request bodies, traces, HARs, or DOM dumps
are retained. Each scenario has a fresh browser context, and contexts and
browser are closed even on assertion failure. No local server is started.

This is same-model implementation-contributor evidence, **not** an independent
review. It proves an isolated fixture/browser path only: no deployment,
production session, real provider authorization, or physical-device pass.
The referenced verification plugin revision is
`08359024b405bf92afc3b4624675415384b67e5a`.

## PR #81 contrast repair — October 14, 2026

The only application change pairs the shared `button.danger` error fill with
`var(--color-on-error)` instead of fixed white. Installed Neutral 0.7.0 defines
that semantic foreground for both themes. Audited consumers are exact-key
replacement/revocation and action-grant revocation (`action-access.ts`), workspace
Google Drive disconnect (`apps.ts`), GitHub disconnect/discard (`connections.ts`),
personal-account disconnect (`personal-app.ts`), capability deletion (`library.ts`)
and function/skill grant revocation (`access.ts`). They inherit the same scoped
selector through the existing `main.ts` legacy-route wrappers; no route, consent,
CSRF, owner/tenant, provider credential or one-time-key logic changed.

The new regression opens actual built Apps → connected Google Drive → Disconnect
at 375px, checks the enabled 16px Confirm disconnect's computed opaque colors and
WCAG contrast ≥4.5:1 in light and dark, then keyboard-cancels. It never submits
the confirmation; both scenarios assert only GET/HEAD requests. Traffic remains
intercepted fixture traffic, with synthetic account metadata and sentinel cookies.

- [Red results](contrast-repair/red-results.json): the original build fails dark
  contrast at 1.5117144702:1; light passes at 11.8268598864:1.
- [Repaired results and screenshot provenance](contrast-repair/metadata.json):
  dark is `rgb(17, 17, 17)` on `rgb(255, 196, 190)` at 12.4911557947:1;
  light remains white on `rgb(118, 0, 12)` at 11.8268598864:1. Both pass.
- Credential-free [dark confirmation](contrast-repair/google-drive-confirm-disconnect-dark.png)
  and [light confirmation](contrast-repair/google-drive-confirm-disconnect-light.png).
- [Full shell browser rerun](contrast-repair/full-browser-results.json): 51/51
  scenarios pass, including the two new contrast checks. Full-run screenshots
  were generated in scratch; only the two focused repair screenshots are added.
  Original BEFORE, target and AFTER artifacts are preserved.
- [Existing agent-safety rerun](contrast-repair/agent-safety-results.json): 47/47
  fixture scenarios pass, retaining exact-consent, one-time-key disposal and
  ambiguous-write coverage.
- [Repository verification](contrast-repair/local-validation.json): `npm run lint`,
  `npm run typecheck`, `npm test`, `npm run build`, `npm run test:package` and
  `npm run check:schema` all exit 0. Unit results remain 404 passed / 85
  environment-gated skips. Runtime: Node v26.7.0, npm 11.19.0, Chromium 156.0.8078.4.

The starting remote HEAD is `5c7dec703422b6d22e0ad28cd095ddadce36b869`.
Metadata records that HEAD while the one-line CSS repair was uncommitted;
it does not claim a clean-head build. Exact repaired served-byte SHA-256 is
`8ec0f421bb2eb2fcc50bf77cc05df2fd2fa5d02d143a089a1f849c17b1b41a4e`.
The red-run served-byte checksum matches the original AFTER checksum above.
This repair was implemented by GPT-6.1 Sol, with no additional reviewer invoked.
Independent Astra pass 2 remains the coordinating session's gate. No production,
real-provider, physical-device, merge or deployment verification is claimed.

Reproduce the focused repair after `npm run build`:

```sh
CAPYKIT_SHELL_CONTRAST_ONLY=1 node scripts/test-astryx-shell.mjs
```

`CAPYKIT_SHELL_EVIDENCE_DIR` can redirect a full rerun to an isolated scratch
directory without overwriting the original AFTER artifacts.
