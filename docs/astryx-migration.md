# Capykit Astryx migration — ENG-160 through ENG-162

## Direction and source

Capykit keeps its product name, React/Vite, URLs and session/owner boundaries.
The maintained Astryx Neutral theme replaces the mint/green product palette:
Figtree typography, restrained neutral surfaces, semantic status colors and
Lucide icons. All three UI slices of ENG-159 are implemented; this is not a
business/API or authorization redesign.

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
That foundation slice established the shared shell. The final slice adapts the
remaining route controls to installed components, keeping native inputs/selects
inside Astryx Field slots where browser validation or file semantics matter.

## Pinned foundation

| Package | Version | Purpose |
| --- | --- | --- |
| `@astryxdesign/core` | 0.7.0 | Components, reset and component CSS |
| `@astryxdesign/theme-neutral` | 0.7.0 | Built theme, CSS and icon registry |
| `@stylexjs/stylex` | 0.19.1 | Compatible peer runtime, no new build plugin |
| `lucide-react` | 1.57.0 | Neutral's icon family |
| `@fontsource-variable/figtree` | 5.3.0 | Same-origin variable font assets |

These versions remain pinned in the manifest and lockfile. At foundation selection,
registry `latest` for core/Neutral was 0.7.0; the canary was not selected.
No unpublished or cross-repository component dependency is used. MIT/ISC/OFL
notices are retained in `docs/LICENSE.*` and included in the npm package.

`main.ts` imports the built Neutral theme, not an ejected/custom fork.
`shell.css` declares `reset, astryx-base, astryx-theme, capykit` before
reset/component/theme styles load. Shell CSS adjusts composition, geometry and
44px targets; component presentation comes from installed CSS/Neutral tokens.
ENG-162 removes `style.css`, its import, every `legacy-route` wrapper and the
legacy cascade layer after migrating their consumers. There is no retained
green/mint control stylesheet or parallel visual component system.

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

ENG-161 delivered Apps/Agents and their setup, key disposal, exact-access consent,
modal error recovery and ambiguous-write reconciliation. ENG-162 reuses those
flows; it does not reimplement them. Actions lists/forms/results, Functions
drafts/imports/inventories/publishing, People access, Appearance and email/OTP
fields now use the same installed primitives. Versioned action grant summaries
show the recipient as well as the exact action ID, account, resources and expiry.
People grants distinguish exact published version and provider scope from keys,
identity and authenticated-client evidence. No additional backend is introduced.

## Foundation evidence and cost (historical ENG-160)

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
No independent GPT-6 Astra review was available or performed for that slice.

## Final slice evidence and review limits (ENG-162)

[Retained evidence and reproduction](evidence/ENG-162/README.md) covers the final
slice against ENG-161 commit `6819c79230221355046261a16bf5e314753eb46e`:

- Advanced BEFORE: 24 fixture scenarios; AFTER: 49. Actions, native validation,
  account/repository payloads and CSRF, loading/empty/error/retry, file import,
  executable flags, exact publish version/digest, and safe delete/revoke dialogs.
- Apps/Agents visual regression: 58 scenarios; security/recovery regression: 67.
- Shell, sign-in and shared settings: 51 scenarios; People access flow: 6.
- 320/375/430/1440px, light/dark, system preference changes, saved appearance,
  keyboard activation, native modal inertness, cancellation and focus recovery.
  Screenshots carry route, viewport, theme, exact build hash and fixture provenance.
- The standard suite passes 430 tests; 85 environment-gated database/provider tests
  remain skipped. Required lint/typecheck/build/package/schema checks also pass.

[Final bundle delta](evidence/ENG-162/bundle-size.json), using the same dependencies:
JS +106,951 bytes raw / +34,276 gzip; CSS -9,646 / -2,141; font bytes unchanged.
The added installed Table/component runtime is material; Vite's >500kB chunk
warning remains a performance-review item. No dependency or lockfile changed.

No known UI slice remains on the legacy stylesheet. Live provider/backend,
database, physical-device, screen-reader and human visual approval are not proven
by these isolated Chromium fixtures. Native modal Tab can visit browser chrome;
tests verify background controls are inert rather than adding a custom focus trap.
Implementation used GPT-6.1 Sol and the plugin revision above. Independent
GPT-6 Astra review was not available/performed; that remains a draft review gate,
along with bundle-cost acceptance and ENG-161's existing manual hold. Nothing in
this slice merges, deploys, changes production settings or performs credential work.
