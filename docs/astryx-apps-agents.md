# Apps and Agents Astryx migration — ENG-161, slice 2

Refs Linear ENG-161. This starts from ENG-160's merged foundation at
`40af07ed2491c0193a47b4b940df3a9e4cc5dd89` on `main`, not a competing theme branch.

## Implementation boundary

Apps/provider choice, GitHub connections, personal accounts/sharing, Agents lists,
identity detail, grants, exact-key confirmation and one-time delivery now use the
installed Astryx 0.7.0 Neutral components. The existing Figtree assets, Theme,
light/dark/system mode, CSS layers, pinned packages and MIT notices are unchanged.
No backend, authorization, permissions, endpoint, database, deployment or provider
credential configuration changes are included. Actions, Functions and People are
still the third slice; embedded workspace action consoles retain `legacy-route`.
Apps and Agents no longer inherit that legacy control theme. Obsolete Apps/Agents
hand-styled controls were deleted rather than retained as parallel versions.

The published 0.7.0 component source/declarations, especially Field, ListItem,
Button, CheckboxInput, TextInput, FormLayout and Dialog, were inspected before use.
The official [theme](https://astryx.atmeta.com/docs/theme) and
[migration](https://astryx.atmeta.com/docs/migration) guidance was also read; the
version-matched installed APIs remain authoritative. No new package or lockfile
change is needed, and the backend retains its existing NodeNext typecheck.

Native selects, date/time pickers and constrained provider credential inputs stay
native inside real Astryx Fields. Their presentation reuses the package's exported
`inputWrapperStyles`, not a second handwritten control theme. The shared adapter
preserves IDs, labels/descriptions, exact values, native validation, password type,
length limits, disabled state and autocomplete restrictions. Composition CSS only
sizes/wraps content and interactive targets; Astryx owns the control appearance.

## Preserved safety and interaction

- Provider/account rows show explicit status and personal/shared/workspace identity.
  Missing deployment setup is separate from reconnect/expired/pending/failed state;
  ordinary users are not asked to create OAuth clients.
- Existing agent choice remains distinct from new identity creation. Duplicate names
  retain safe stable principal metadata; key creation does not grant action access.
- Exact-key replacement retains the same principal, sibling keys and all grants.
  Confirmation names the exact identity and key, and defaults focus to cancellation.
- Confirmation dialogs and their triggers stay mounted while open state changes,
  so Cancel/Escape restores the original trigger across Apps and Agents.
- One-time reveal is a focused Astryx form/card with named identity/key metadata,
  save-now instructions, explicit copy/manual fallback and separate saved consent.
  Navigation, page hiding, reload and inactivity still discard the plaintext.
- Ambiguous writes retain the existing reconciliation gates. No blind retry, secret
  persistence or external-client success inference is introduced. Missing client
  evidence remains “Not yet verified.” Workspace and personal grants stay separate.
- Workspace connection tests still use the signed-in owner session, not the agent
  key. Their result is not proof that an external client authenticated successfully.

## Verification and evidence

[Retained browser evidence](evidence/ENG-161/README.md) identifies exact served
Vite-byte SHA-256 fingerprints, repository HEAD, routes, viewports, appearance,
browser version and fixture provenance. BEFORE uses a separate build of the merged
foundation. AFTER covers 320/375/430/1440px, light/dark/system, keyboard interaction,
real dialog focus restoration, 44px touch targets, account/resource metadata and
empty/error/loading/reconnect states. One-time key screenshot values are masked;
only synthetic sentinel identities/keys are used and all API requests intercepted.
The existing ENG-154 lifecycle, grant/duplicate-name, clipboard failure and
ambiguous-write regressions remain runnable via `scripts/test-agent-setup.mjs`.

The ENG-160 destructive contrast regression now checks the installed destructive
Button, including compositing Neutral's translucent dark surface over its dialog.
The legacy semantic destructive foreground fix remains intact for unmigrated views.

To reproduce against an isolated build (not production):

```sh
npm ci
npm run build
node scripts/test-agent-setup.mjs
CAPYKIT_AGENT_VISUAL_ONLY=1 CAPYKIT_AGENT_VISUAL_DIR=docs/evidence/ENG-161/after node scripts/test-agent-setup.mjs
CAPYKIT_SHELL_EVIDENCE_DIR=docs/evidence/ENG-161/shell node scripts/test-astryx-shell.mjs
```

The harness reuses installed external Playwright/Chromium, with
`CAPYKIT_PLAYWRIGHT_MODULE` and `CAPYKIT_CHROMIUM_PATH` overrides. It does not install
browser dependencies or connect to live accounts. For BEFORE, build the exact base
revision in a separate directory, set `CAPYKIT_CONSOLE_DIR` to that console build,
`CAPYKIT_AGENT_BASELINE=1`, and use visual-only mode with a separate output
path.

[Bundle measurements](evidence/ENG-161/bundle-size.json) compare base and current
Vite assets using the same installed dependencies. The existing >500kB main-chunk
warning remains a draft performance-review gate; no unrelated bundling rewrite or
package upgrade is attempted. The existing dependency audit reported 15 findings
(4 low, 3 moderate, 6 high, 2 critical); this UI slice does not resolve that baseline.

Implementation model: GPT-6.1 Sol (`gpt-6.1-sol`). Installed engineering plugin
revision: `08359024b405bf92afc3b4624675415384b67e5a`; its instructions were read.
There is no tracked repository AGENTS.md. This is a reviewable draft, not
merge or production approval. Independent GPT-6 Astra review was unavailable
and was not
performed or claimed. Live backend/provider, physical-device and environment-gated
database verification remain unverified; fixtures are not substitutes for them.
