# Capykit Astryx migration — ENG-160, slice 1

## Direction and source

Capykit keeps its product name, React/Vite, URLs and session/owner boundaries.
The maintained Astryx Neutral theme replaces the mint/green product palette:
Figtree typography, restrained neutral surfaces, semantic status colors and
Lucide icons. This is the first slice of ENG-159, not a route-form redesign.

References inspected: [components](https://astryx.atmeta.com/components),
[theme](https://astryx.atmeta.com/docs/theme),
[migration](https://astryx.atmeta.com/docs/migration), and
[versioned source](https://github.com/facebook/astryx/tree/v0.7.0).
The installed 0.7.0 README, declarations and component source are the API oracle;
website APIs are not substituted for published package behavior. Mobbin was not
accessed by this executor; no inspection or human approval is claimed.

Before broad edits, the existing shell was captured and an isolated representative
was rendered using installed Neutral `Theme`, `Button`, `Card`, `Badge`,
`Banner` and `EmptyState` components. [Target screenshots](evidence/ENG-160/target)
show desktop Apps and 375px navigation, an app row, status, primary action and
empty/error treatment. This is an implementation target, not a human-approved mock.
The actual route row/forms remain native in this slice; the shared primary action,
shell/navigation, account controls, notices and sign-in use installed components.

## Pinned foundation

| Package | Version | Purpose |
| --- | --- | --- |
| `@astryxdesign/core` | 0.7.0 | Components, reset and component CSS |
| `@astryxdesign/theme-neutral` | 0.7.0 | Built theme, CSS and icon registry |
| `@stylexjs/stylex` | 0.19.1 | Compatible peer runtime, no new build plugin |
| `lucide-react` | 1.57.0 | Neutral's icon family |
| `@fontsource-variable/figtree` | 5.3.0 | Same-origin variable font assets |

These versions are pinned in the manifest and lockfile. Registry `latest` for
core/Neutral was 0.7.0; the 0.7.1 canary was deliberately not selected.
No unpublished or cross-repository component dependency is used. MIT/ISC/OFL
notices are retained in `docs/LICENSE.*` and included in the npm package.

`main.ts` imports the built Neutral theme, not an ejected/custom fork.
`shell.css` declares `reset, legacy, astryx-base, astryx-theme, capykit` before
reset/component/theme styles load. Shell CSS adjusts composition, geometry and
44px targets; component presentation comes from installed CSS/Neutral tokens.
Legacy selectors are isolated inside `@scope (.legacy-route)` in the lower
`legacy` layer. Their old palette uses Neutral tokens, not a second theme.
Obsolete shell/reset selectors were removed without rewriting route workflows.

`fonts.css` registers the package's variable assets as `Figtree`, the exact family
Neutral expects. Fontsource's default `Figtree Variable` family would otherwise
silently fall back. No Google Fonts request or CSP relaxation is needed.
The existing static asset handler additionally allows WOFF2 with its proper MIME;
its strict basename/traversal rules remain intact. No service, backend business
API, authorization policy, database, production setting or credential is added.

The browser entry/Apps modules are checked by `src/console/tsconfig.json` with
Bundler resolution, as required by 0.7.0's extensionless declarations. The server
and remaining tests retain NodeNext resolution. `npm run typecheck` runs both
checks; neither the browser nor the backend is left unchecked.

## Behavior and slice boundary

Apps / Agents / Actions remain primary, with Functions/publishing and People
access in the secondary native disclosure. Owner/member/agent visibility, query
parameters, callback handling and route callbacks retain their existing behavior.
The existing CSRF-aware `sessionFetch` / `writeRequest` paths are unchanged.

The compact Appearance selector supports light, dark and system using documented
`Theme.mode`. Only `capykit.appearance` is persisted; invalid values or denied
storage fall back to system. A synchronous same-origin bootstrap applies validated
mode before React/CSS without inline script or changing `script-src 'self'`.
Native email/OTP form validity and attributes are retained inside Astryx cards;
real Astryx submit buttons use `type` and `isDisabled`, not lookalike classes.

Remaining dependent slices: Apps search/filter/rows, connection and provider forms,
Agents/key reveal/grant forms, Actions/results, Functions/publishing, People access
and route-local alerts. Their business logic is not migrated here. Preserve the
PR #80 ambiguous-write recovery, one-time key disposal and exact-access consent
safeguards when adapting those controls.

## Evidence, cost and review limits

[Browser evidence](evidence/ENG-160/README.md) retains BEFORE/target/AFTER screenshots,
exact served-byte checksums, routes, viewports, themes and fixture provenance.
The focused browser harness passed 49 scenarios, including native keyboard/disabled
behavior of mounted Astryx buttons, actual Figtree loading, CSP, navigation at
320/375/430/1440px and focused create-form visibility at a 420px-high viewport.
The existing PR #80 browser regression harness also passed.

[Bundle measurements](evidence/ENG-160/bundle-size.json) compare a rebuilt clean
baseline with the implementation using the same Vite/dependencies. Total JS grew
204,583 bytes raw / 64,133 bytes gzip; CSS grew 213,937 / 35,205 bytes; fonts add
30,436 bytes. This includes the lazy Tooltip chunk and synchronous bootstrap.
Full supplied component CSS and the runtime cause a material increase and Vite's
500kB chunk warning. Supported pruning/splitting is a draft performance-review gate,
not a reason to silently fork the maintained stylesheet in this slice.

The standard suite passed 404 tests; 85 existing environment-gated tests were
skipped (database/provider infrastructure not provisioned for this UI slice).
`npm audit` still reported the baseline 15 findings; unrelated upgrades were not
attempted. No database/live-provider or physical-device pass is claimed.

Implementation model: GPT-6.1 Sol. Installed engineering plugin revision:
`08359024b405bf92afc3b4624675415384b67e5a`. No repository AGENTS.md was tracked.
No independent GPT-6 Astra review was available or performed. This remains a draft
for independent review and bundle-cost acceptance; nothing is merged or deployed.
