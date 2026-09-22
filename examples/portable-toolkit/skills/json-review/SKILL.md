---
name: json-review
description: Validate local JSON syntax and review a document's structure without changing its contents.
---

# JSON review

Use this skill when asked to inspect or validate an existing JSON file.

1. Resolve the requested file path before changing directories.
2. From this skill's directory, run
   `node scripts/check-json.mjs /absolute/path/to/input.json`.
3. If validation succeeds, inspect only the fields needed for the user's task.
   Follow [the review checklist](references/checklist.md).
4. If formatting is requested and Prettier is available, use
   `prettier --check /absolute/path/to/input.json` to inspect formatting first.
   Use `--write` only when the user's request includes editing the file.

Do not include credential values or unrelated document contents in reports.
