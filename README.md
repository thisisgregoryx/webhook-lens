# Webhook lens

Local, in-browser workbench for comparing two JSON webhook payloads. This is an independent experiment, not a product launch and not a claim of demand. This branch/PR is not the live demo; these changes are not a feature release. Commercial demand and revenue remain unproven.

Design and use-case hypotheses (not validated demand): [JSON Diff](https://jsondiff.com/) describes semantic JSON comparison; [DevUtils](https://devutils.com/) describes offline developer utilities. This UI and example data are original.

## Run the workbench

No package install. From this directory:

```bash
python3 -m http.server 8766 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8766/`.

`file://` may block the deferred scripts under the page CSP (`script-src 'self'`) in some browsers. Prefer the static server.

## Tests

```bash
# Lightweight schema slices (no packages):
node --test tests/mask.test.js

# Serialized, bounded focused gates in the author environment:
flock -w 120 /home/greg/state/heavy-job.lock timeout 120s node --test tests/diff.test.js tests/mask.test.js
flock -w 120 /home/greg/state/heavy-job.lock timeout 120s node --test tests/browser.masked.test.js
```

The browser test is required and does not skip or install anything. It uses Node's built-in `WebSocket` and `fetch` (Node 22+), and sandbox-enabled Chrome at `/home/greg/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`. It starts an ephemeral loopback static server serving only the four app assets and launches an isolated temporary browser profile, without attaching to an existing browser. It checks actual clipboard and downloaded file bytes using synthetic data only, and deterministically holds a real FileReader completion. Browser receipts and downloads go under `/home/greg/state/webhook-lens-mask-20261028/test-runs/`; only its owned profile, temporary directory and child processes are cleaned up. In another environment, adjust the Chrome/receipt paths in the test; missing Chrome fails the gate.

`diff.js` is a dependency-free UMD/CommonJS module (`module.exports` and `window.WebhookLensDiff`).

## API

```js
const {
  LIMITS,              // { maxBytes: 1048576, maxDepth: 100, maxEntries: 5000, formatVersion: 1, comparison: 'index-based' }
  parseJsonText,       // (text, options?) -> { ok, value } | { ok: false, error }
  compareJsonTexts,    // (beforeText, afterText, options?) -> result
  compareValues,       // (before, after, options?) -> result
  jsonType,            // null | array | object | string | number | boolean
  encodePointerSegment,
  formatPointerDisplay, // '' -> '(root)'
  buildExportDocument, // original formatVersion: 1
  buildMaskedExportDocument, // (successfulResult, selection?) -> masked doc; invalid result -> null
  stringifyExportDocument, // JSON.stringify(doc, null, 2)
  emptyMaskSelection,  // new { includeOriginals: [] }
  isOriginalIncluded, // (selection, path, side) -> boolean
  measureDepth,
} = require('./diff.js');
```

Successful compare:

```json
{
  "ok": true,
  "formatVersion": 1,
  "comparison": "index-based",
  "summary": { "added": 0, "removed": 0, "type_changed": 0, "value_changed": 0, "total": 0 },
  "changes": []
}
```

Each change has `path` (JSON Pointer), `kind` (`added` | `removed` | `type_changed` | `value_changed`), `before`/`after` only when present, and `beforeType`/`afterType` on type changes.

Failed compare:

```json
{
  "ok": false,
  "errors": {
    "before": "…",
    "after": "…",
    "compare": "…"
  }
}
```

Sides are parsed independently. Both errors are returned when both sides are invalid. Empty text is invalid. Clear in the UI returns the initial empty state without stale results.

## Export schema

The **Copy full original diff JSON** and **Export full original diff JSON** buttons write the full current diff with original values, ignoring category filters:

```json
{
  "formatVersion": 1,
  "comparison": "index-based",
  "summary": { "added": 0, "removed": 0, "type_changed": 0, "value_changed": 1, "total": 1 },
  "changes": [{ "path": "/task/status", "kind": "value_changed", "before": "in_progress", "after": "done" }]
}
```

Full original exports include sensitive before/after values. Both original and masked sharing actions are disabled for invalid or stale input, example loads, Clear, and pending file reads. Every new successful compare resets sharing to all values masked. Clipboard write uses the async clipboard API and falls back to `document.execCommand('copy')`; if both fail the UI says so instead of claiming success.

## Masked sharing schema

Compare first. The local diff and input buffers remain unchanged. Every original value is initially omitted from the separate share document. Use the per-side **Include original before/after value in share** checkboxes to explicitly include a changed side. Unchecking masks it again. Category filters only hide local rows: the preview and both export formats always include all changes.

The complete, scrollable JSON preview is the same string used by masked Copy and Download, serialized with `JSON.stringify(doc, null, 2)` (two spaces, no trailing newline). Download name: `webhook-lens-masked-diff.json`; full original download: `webhook-lens-diff.json`.

```json
{
  "kind": "webhook-lens-masked-diff",
  "schemaVersion": 1,
  "comparison": "index-based",
  "summary": { "added": 0, "removed": 0, "type_changed": 0, "value_changed": 1, "total": 1 },
  "includesOriginalValues": false,
  "warnings": [
    "Field names, JSON pointers, types, and structure are retained and can identify data. This is not an anonymity guarantee.",
    "This document is a masked comparison, not a runnable webhook payload or example event."
  ],
  "changes": [
    {
      "path": "/task/status",
      "kind": "value_changed",
      "before": { "present": true, "type": "string", "redacted": true },
      "after": { "present": true, "type": "string", "redacted": true }
    }
  ]
}
```

Each change always has `path`, `kind`, `before`, and `after`. Sides use exactly these forms:

| Side | Representation |
| --- | --- |
| Missing | `{ "present": false }` only |
| Masked present | `{ "present": true, "type": "number", "redacted": true }` (no `value` key) |
| Masked null | `{ "present": true, "type": "null", "redacted": true }` |
| Explicitly included | `{ "present": true, "type": "number", "redacted": false, "value": 2 }` |
| Explicitly included null | `{ "present": true, "type": "null", "redacted": false, "value": null }` |

`type` is one of `null`, `array`, `object`, `string`, `number`, `boolean`. Masked object/array sides omit the whole subtree; they never replace values with scalar placeholders. Explicitly including a container includes its entire original subtree. `path`, change `kind`, comparison and summary remain visible even when both sides are hidden. Root pointer is `""` and key segments escape `~` as `~0` and `/` as `~1`.

`includesOriginalValues` is true exactly when at least one present side has `redacted: false`. Then the preview document appends this warning, and the UI displays it prominently:

> This share includes one or more original values because they were explicitly unmasked.

The in-memory selection is `{ includeOriginals: [{ path: "/task/status", side: "after" }] }`. An empty or omitted selection masks every side; unknown paths and absent sides are ignored. It is never stored. Input edits, Clear, invalid comparison, loading an example and pending file reads discard the preview and selection; comparing again always starts fully masked.

Stable document key order is `kind`, `schemaVersion`, `comparison`, `summary`, `includesOriginalValues`, `warnings`, `changes`. Side order is `present`, then `type`, `redacted`, and optional `value`. This distinct schema is a masked bug-report comparison, **not a runnable webhook payload or synthetic example event**. Runnable synthetic sample inputs remain available separately through **Load synthetic example**.

Names, paths, types and structural information can identify data. Review every field name and full pointer in the exact preview before sharing. **There is no anonymity guarantee.** Masking does not sanitize names/paths or the originals you explicitly include. It applies after comparison and never edits the input buffers or the original diff.

## Semantics

- Own enumerable keys only, including `__proto__`, `constructor`, and `""`. Key order is not a difference. Traversal is sorted-key, then array index.
- JSON Pointer: `~` → `~0`, `/` → `~1`. Root path is `""`, shown as `(root)`.
- `null`, arrays, and objects are distinct types.
- Type change is one entry at that path; children are not also emitted.
- Added or removed objects/arrays are one entry at that path with the subtree value.
- Arrays are **index-based**. Shared indexes are compared recursively; extra tail indexes are added or removed. Reordering or inserting can cause many changes.
- Valid JSON primitives are allowed at the root.
- Numbers use ordinary JavaScript `Number` precision after `JSON.parse`. This is not lossless decimal support. Overflow to non-finite values (for example `1e400` → `Infinity`) and integers outside `Number.isSafeInteger` (for example `9007199254740993`) are rejected with a side-specific error and a JSON Pointer when the number is nested.

## Limits

Honest errors, no silent truncation:

| Limit | Value |
| --- | --- |
| Input size (paste or file) | 1 MiB (`1048576` bytes) |
| Nesting depth | 100 |
| Diff entries | 5000 |
| JSON numbers | Finite; integers must be `Number.isSafeInteger` |

## Privacy

Processing is entirely in the browser. No analytics, no `localStorage`, no application network requests (`connect-src 'none'`). The static server only serves these local files. Clipboard and download run only on explicit Copy/Export.

## Keyboard

`Ctrl+Enter` / `⌘+Enter` compares. Compare (button and shortcut) stays disabled while a local file read is pending. Native buttons and file inputs keep standard Enter/Space activation.

## Limitations

- Index-based arrays, not list-alignment / LCS.
- Deep or wide payloads hit the documented guards.
- The browser gate covers installed Chromium; other browsers are not exercised by it.
- Some browsers block clipboard without a user gesture or permission.
