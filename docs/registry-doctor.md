# Registry doctor report v0.1

`capykit doctor <registry.json>` validates one registry document and prints a
JSON report with this shape:

```json
{
  "format": "capykit.registryDoctor.v0.1",
  "ok": true,
  "checkedAt": "2026-08-15T00:00:00.000Z",
  "registry": { "id": "example", "name": "example" },
  "records": [
    {
      "recordType": "registry",
      "recordId": "registry.json",
      "severity": "info",
      "status": "pass",
      "code": "registry.load",
      "message": "Registry document loaded and validated."
    }
  ]
}
```

`ok` is false when any record has `severity: "error"` and `status: "fail"`.
The report never includes credential values. Schema, reference, secret-like,
and unsafe declaration failures are reported with paths and redacted messages.

Doctor checks are non-destructive:

- Registry loading validates the canonical schema, cross-record references,
  duplicate IDs, explicit overrides, and credential-like keys or values before
  activation.
- CLI executable and `command-available` health checks do metadata-only PATH
  lookups. The executable is never run, and lookup only occurs when the
  operator passes `--allow-command <name>`.
- Documentation checks validate HTTP(S) URL syntax without fetching the page.
- Unapproved executable checks are reported as `status: "skipped"` rather than
  being executed or guessed.

Example:

```bash
capykit doctor registry.json --allow-command git --path "$PATH"
```
