# Webhook lens

Local, in-browser workbench for comparing two JSON webhook payloads. This is an independent experiment, not a product launch and not a claim of demand.

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
node --test tests/diff.test.js
```

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
  buildExportDocument,
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

Copy and Export write the **full** current diff, ignoring category filters:

```json
{
  "formatVersion": 1,
  "comparison": "index-based",
  "summary": { "added": 0, "removed": 0, "type_changed": 0, "value_changed": 1, "total": 1 },
  "changes": [{ "path": "/task/status", "kind": "value_changed", "before": "in_progress", "after": "done" }]
}
```

Exports include sensitive before/after values. They are disabled for invalid or stale input. Clipboard write uses the async clipboard API and falls back to `document.execCommand('copy')`; if both fail the UI says so instead of claiming success.

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
- UI is not covered by the Node tests.
- Some browsers block clipboard without a user gesture or permission.
