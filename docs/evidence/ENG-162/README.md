# ENG-162 — final Astryx console slice

## Scope and provenance

This is isolated built-console Chromium fixture evidence, not deployed API,
real-provider, database, physical-device or screen-reader verification. No live
account mutations were exercised. Requests are intercepted with synthetic data;
one-time-key screenshots in the inherited harness replace fixture input values
with redacted text before capture and restore them afterward. Cookies/CSRF values
are fake sentinels and are not retained in reports or screenshots.

BEFORE assets are rebuilt from ENG-161 commit
`6819c79230221355046261a16bf5e314753eb46e`, with the same installed dependencies.
AFTER uses this branch's Vite output. Report revision fields identify the
precommit repository HEAD; exact build/asset hashes identify working-tree bytes.
[Bundle/source manifest](bundle-size.json) also records every console source and
package/lockfile hash, so those bytes can be checked against the submitted commit.
The advanced/shell build hash includes sorted URL names and bytes; the inherited
Apps/Agents harness uses relative asset filenames. Their hash algorithms differ;
the emitted per-asset manifest is the common byte-level comparison.

Implementation: GPT-6.1 Sol. Engineering plugin:
`08359024b405bf92afc3b4624675415384b67e5a`. Installed Astryx/Neutral 0.7.0 README,
declarations and component implementations were used rather than substituting
website APIs. There was no independent GPT-6 Astra review or human visual approval.
Those remain draft gates; the existing ENG-161 manual hold is unchanged.

## Results

| Report | Passed scenarios | Coverage |
| --- | ---: | --- |
| [Advanced BEFORE](advanced/before/metadata.json) | 24 | Actions, Functions and People at all four widths, both themes |
| [Advanced AFTER](advanced/after/metadata.json) | 49 | Same matrix plus exceptional states, validation, mutations and recovery |
| [Apps/Agents visuals](apps-agents/metadata.json) | 58 | Lists/details, exact sharing, key/modal recovery, light/dark/system |
| [Agent/access regression](agent-regression.json) | 67 | Identity/key lifecycle, ambiguous writes, consent, scope, expiry and keyboard |
| [Shell](shell/metadata.json) | 51 | Sign-in, navigation, settings, CSP, font, owner/member/agent and recovery |
| [People flow](access/flow-results.json) | 6 | Exact function/skill payloads, CSRF, revocation, denial, member and mobile |

Each screenshot manifest records route, viewport, theme and fixture status.
The primary matrix is 320/375/430/1440px with light/dark. Companion People flow
also exercises 390px. See [browser command results](browser-regression.json).

Advanced checks exercise required/min/step validation and Enter-submit, exact
connected-account/repository action payloads and pagination, pending controls,
provider errors and retries, native source/JSON pickers, imported executable flags,
rejected unsafe imports, saved publish version/digest, destructive cancellation,
modal errors and required pending states. Native dialogs make background controls
inert. Tab may visit browser chrome; no custom focus-trap design system was added.
Cancellation keeps the trigger; successful revoke returns focus to Refresh access.

Sample comparisons and review points:

- [Actions BEFORE, 375 light](advanced/before/actions-form-375-light.png)
  and [AFTER](advanced/after/actions-form-375-light.png).
- [Functions BEFORE, 320 dark](advanced/before/functions-draft-320-dark.png)
  and [AFTER](advanced/after/functions-draft-320-dark.png).
- [People BEFORE, 375 light](advanced/before/people-grant-375-light.png)
  and [AFTER](advanced/after/people-grant-375-light.png).
- [Revoke confirmation](advanced/after/people-revoke-dialog-375-light.png),
  [rejected revoke](advanced/after/people-revoke-error-375-light.png), and
  [delete error inside modal](advanced/after/functions-delete-error-375-dark.png).
- [Exact action grant summary](apps-agents/agents-detail-320-light.png) and
  [sign-in](shell/sign-in-320-light.png).

## Local checks and bundle cost

[Local validation](local-validation.json) records the required commands and their
exit codes. The standard suite passed 430 tests; 85 existing environment-gated
DB/provider tests were skipped, not passed. Package/schema checks are local, not
production migration tests. The secret scan is run after staging all new evidence
so its tracked-file scan includes this slice's artifacts.

Final bundle delta versus ENG-161: JS +106,951 bytes raw / +34,276 gzip;
CSS -9,646 / -2,141; fonts unchanged. See [measurements](bundle-size.json) for exact
asset checksums and gzip method. Installed Table/component runtime adds material
cost; Vite's >500kB chunk warning remains. Supported splitting/pruning and human
bundle-cost acceptance are review items, not an excuse to fork Astryx CSS here.

`src/console/style.css`, its import, the legacy cascade layer and all source
`legacy-route` wrappers are removed. Shared CSS now handles layout, wrapping and
44px geometry; native fields reuse the prior Astryx Field adapter. No dependency,
backend API, database migration, credential operation or authorization policy was
added. This evidence does not authorize merge, deployment or release.

## Reproduce

Use an existing Playwright module and Chromium installation. The executor used
its supported external browser route; no browser/test dependency was added to the
project. Override these paths on another machine:

```sh
export CAPYKIT_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
export CAPYKIT_CHROMIUM_PATH=/absolute/path/to/chrome-headless-shell
npm run build
node scripts/test-advanced-console.mjs
CAPYKIT_SHELL_EVIDENCE_DIR=docs/evidence/ENG-162/shell node scripts/test-astryx-shell.mjs
CAPYKIT_AGENT_EVIDENCE_FILE=docs/evidence/ENG-162/agent-regression.json node scripts/test-agent-setup.mjs
CAPYKIT_AGENT_VISUAL_DIR=docs/evidence/ENG-162/apps-agents CAPYKIT_AGENT_VISUAL_ONLY=1 node scripts/test-agent-setup.mjs
CAPYKIT_BROWSER_ARTIFACT_PREFIX=docs/evidence/ENG-162/access/flow node scripts/test-access-flow.mjs
```

For BEFORE, archive the baseline commit into a disposable checkout, install/reuse
the same locked dependencies and build it. Run the new advanced harness against
that output, without changing the production application or any accounts:

```sh
CAPYKIT_ADVANCED_BASELINE=1 CAPYKIT_CONSOLE_DIR=/absolute/path/to/baseline/dist/console node scripts/test-advanced-console.mjs
```
