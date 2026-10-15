# ENG-161 browser evidence — fixture verification only

## Provenance and outcome

BEFORE is an isolated Vite rebuild of the merged ENG-160 foundation at
`40af07ed2491c0193a47b4b940df3a9e4cc5dd89`, using the same installed dependencies.
AFTER is the Apps/Agents implementation in this PR. Metadata explicitly distinguishes
repository HEAD from the SHA-256 of exact served build bytes. Captures were
made before committing the working tree. Routes, viewport,
light/dark/system mode, browser
version and fixture provenance are retained per capture.

- [BEFORE metadata](before/metadata.json): 8 scenarios passed, 16 screenshots.
- [AFTER metadata](after/metadata.json): 38 scenarios passed, 64 screenshots.
- [ENG-154 regressions](agent-regression.json): all 47 scenarios passed
  against the built console; duplicate identities, same-principal key
  replacement, sibling-key
  and grant retention, clipboard failure, secret disposal, synchronous duplicates,
  personal-account navigation and ambiguous-write reconciliation are preserved.
- [Shell/CSP/contrast regressions](shell/metadata.json): all 51 scenarios passed.
  The actual Astryx destructive confirmation meets 4.5:1 text contrast in both
  themes, including compositing the dark translucent background over the dialog.
- [Bundle comparison](bundle-size.json): JS grew 62,816 raw / 21,069 gzip bytes;
  CSS shrank 3,588 raw / 683 gzip bytes. Fonts are unchanged. The existing >500kB
  main-chunk warning remains a draft performance-review gate.

These are intercepted browser fixtures, not live backend/provider or physical-device
verification. Synthetic account identities, sentinel CSRF cookies and sentinel keys
are used. No traces, HAR, raw request bodies or credential-bearing DOM dumps are
retained. One-time key input values are replaced with a redaction marker only
for screenshot capture, then restored in the isolated fixture DOM. Browser
checks verify no sentinel credential persistence in local/session storage or request
bodies. No independent GPT-6 Astra review was available or performed.

The standard suite passed 412 tests; 85 existing environment-gated tests were skipped.
The six factory local commands passed; [local results](local-validation.json) retain
exact command text and actual exit codes. The public-repository secret check
is also required before publication. Existing npm audit findings are not
resolved by this UI slice. Implementation model: GPT-6.1 Sol. Plugin revision:
`08359024b405bf92afc3b4624675415384b67e5a`.

## Review samples

| Surface | BEFORE | AFTER |
| --- | --- | --- |
| Apps, 375px light | [Image](before/apps-list-375-light.png) | [Image](after/apps-list-375-light.png) |
| Apps, 375px dark | [Image](before/apps-list-375-dark.png) | [Image](after/apps-list-375-dark.png) |
| Agent detail, 375px light | [Image](before/agents-detail-375-light.png) | [Image](after/agents-detail-375-light.png) |
| Agent detail, 375px dark | [Image](before/agents-detail-375-dark.png) | [Image](after/agents-detail-375-dark.png) |
| Apps, desktop light | [Image](before/apps-list-1440-light.png) | [Image](after/apps-list-1440-light.png) |
| Agent detail, desktop dark | [Image](before/agents-detail-1440-dark.png) | [Image](after/agents-detail-1440-dark.png) |

Focused AFTER evidence:

- [Existing identity setup](after/agents-setup-375-light.png)
- [Exact-key confirmation](after/exact-key-dialog-375-dark.png)
- [One-time key reveal, masked](after/one-time-key-masked-375-light.png)
- [Personal exact sharing](after/personal-exact-sharing-375-dark.png)
- [GitHub reconnect confirmation](after/github-reconnect-dialog-375-light.png)
- [Deployment unavailable](after/drive-unavailable-375-light.png)
- [Reconnect required](after/drive-reconnect-375-dark.png)
- [Apps empty](after/connections-empty-375-light.png)
- [Apps error](after/connections-error-375-dark.png)
- [Agents loading](after/agents-loading-375-light.png)

The remaining 320/430px, desktop, system-mode and state captures are indexed
by the AFTER metadata. Assertions cover document overflow, in-bounds 44px
targets, keyboard
selection/consent, meaningful labels and Cancel/Escape restoration to original
triggers. Focused browser regressions do not authorize production mutations.

## Reproduction

See [migration notes](../../astryx-apps-agents.md) for exact commands and supported
external browser overrides. Preserve BEFORE; do not overwrite it with a current
build. The fixture origin is `https://capykit.example.test`; every browser request
is intercepted and unknown/external routes are aborted.

## Bounded PR #82 repair after review pass 1

The repair starts from exact remote head
`005eeb3c85ff07f5e84eb3db1673ab8c2b45dce2` on the existing branch. The PR body,
Linear reference and bridge marker remain unchanged. Only the supplied independent
review findings are addressed; this is still a draft, not merge or deployment
approval. Implementation is GPT-6.1 Sol through the managed bridge. No additional
independent review was launched; the coordinator owns Astra pass 2 of 2.

- Failed exact-key changes now close the native modal and focus Reload metadata.
  Uncertain writes remain paused, including after a failed reconciliation read.
  Recovery uses keyboard activation and never replays the write. Definite denial
  stays distinct from unknown completion; reopening/cancelling retains normal
  trigger focus restoration. The shared mutation path covers revoke failures too.
- Allowed access leads the selected identity view. Installed Astryx 0.7.0 Stack
  and Text separate app, action, account, resource scope, status and expiry. Exact
  IDs remain in expandable details and confirmations. The name and safe identity
  suffix are readable at narrow widths; normal Not yet verified is compact,
  neutral information, not a warning or a successful-client claim. Keys, history
  and the existing focused setup disclosure stay available below access.
- [Fresh BEFORE metadata](repair-before/metadata.json): 38 fixture scenarios,
  64 captures from the original PR head, including 320/375/430/1440px in both
  themes. A separate rebuild of that head matches every retained asset SHA-256.
- [Regression against the original head](repair-before-regression.json): the four
  lost-response/denied replacement cases fail at modal recovery, and the four
  changed hierarchy checks fail as expected. This is intentional RED evidence,
  not a claimed pass.
- [Fresh AFTER metadata](repair-after/metadata.json): 42 scenarios pass, 68
  captures. [Lifecycle regressions](repair-regression.json): all 51 scenarios pass,
  including four new exact-key recovery cases across light/dark, exactly one POST,
  exact principal/key targeting, unchanged sibling keys/grants/identities, failed
  read recovery, no blind retry and no secret visibility/persistence.
- [Fresh shell/CSP/contrast evidence](repair-shell/metadata.json): all 51 scenarios
  pass, including the existing destructive-button contrast checks.
- [Local validation](repair-local-validation.json): the six required commands
  pass. The unit suite remains 412 passed with 85 environment-gated skips. The
  existing bundle-size warning and dependency audit findings are not repaired.

BEFORE/AFTER agent detail captures at all four widths in both themes were visually
inspected, not inferred from passing assertions. Before: merged grant labels,
warning-heavy unknown status and a squeezed mobile name. After: separate readable
labels, neutral status, full-width mobile name and access before setup/keys.
Recovery screenshots show the modal closed and focus on Reload metadata. Browser
fixtures, not real accounts or physical devices, are the sole evidence. Every API
request is intercepted; one-time fixture values are redacted only when revealed.

Representative repair captures:

| Surface | BEFORE | AFTER |
| --- | --- | --- |
| Agent, 375px light | [Image](repair-before/agents-detail-375-light.png) | [Image](repair-after/agents-detail-375-light.png) |
| Agent, 320px dark | [Image](repair-before/agents-detail-320-dark.png) | [Image](repair-after/agents-detail-320-dark.png) |
| Agent, desktop dark | [Image](repair-before/agents-detail-1440-dark.png) | [Image](repair-after/agents-detail-1440-dark.png) |

- [Lost-response recovery, light](repair-after/exact-key-ambiguous-recovery-375-light.png)
- [Definite-denial recovery, dark](repair-after/exact-key-denied-recovery-375-dark.png)

Each capture's route, viewport, appearance, intercepted-fixture provenance and
served-build SHA-256 are in its metadata. The recorded repository HEAD is the
starting revision, not a claim that uncommitted repairs already had a commit SHA;
the asset hashes identify the exact bytes actually exercised.
