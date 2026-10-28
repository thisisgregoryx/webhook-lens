'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.WebhookLensDiff = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LIMITS = Object.freeze({
    maxBytes: 1024 * 1024,
    maxDepth: 100,
    maxEntries: 5000,
    formatVersion: 1,
    maskedKind: 'webhook-lens-masked-diff',
    maskedSchemaVersion: 1,
    comparison: 'index-based',
  });

  const MASKED_EXPORT_WARNINGS = Object.freeze([
    'Field names, JSON pointers, types, and structure are retained and can identify data. This is not an anonymity guarantee.',
    'This document is a masked comparison, not a runnable webhook payload or example event.',
  ]);
  const MASKED_INCLUDES_ORIGINALS_WARNING = 'This share includes one or more original values because they were explicitly unmasked.';

  function emptyMaskSelection() {
    return { includeOriginals: [] };
  }

  function includedSideLookup(selection) {
    const included = Object.create(null);
    for (const entry of (selection && selection.includeOriginals) || []) {
      if (entry && typeof entry.path === 'string' && (entry.side === 'before' || entry.side === 'after')) {
        included[entry.path + '\0' + entry.side] = true;
      }
    }
    return included;
  }

  function isOriginalIncluded(selection, path, side) {
    return includedSideLookup(selection)[path + '\0' + side] === true;
  }

  function describeMaskedSide(change, side, included) {
    if (!Object.prototype.hasOwnProperty.call(change, side)) return { present: false };
    const redacted = included[change.path + '\0' + side] !== true;
    const description = { present: true, type: jsonType(change[side]), redacted };
    if (!redacted) description.value = change[side];
    return description;
  }

  function buildMaskedExportDocument(result, selection) {
    if (!result || !result.ok) return null;
    const included = includedSideLookup(selection);
    const changes = result.changes.map(change => ({
      path: change.path,
      kind: change.kind,
      before: describeMaskedSide(change, 'before', included),
      after: describeMaskedSide(change, 'after', included),
    }));
    const includesOriginalValues = changes.some(change =>
      change.before.redacted === false || change.after.redacted === false);
    const warnings = MASKED_EXPORT_WARNINGS.slice();
    if (includesOriginalValues) warnings.push(MASKED_INCLUDES_ORIGINALS_WARNING);
    return {
      kind: LIMITS.maskedKind,
      schemaVersion: LIMITS.maskedSchemaVersion,
      comparison: LIMITS.comparison,
      summary: result.summary,
      includesOriginalValues,
      warnings,
      changes,
    };
  }

  function utf8ByteLength(text) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).length;
    }
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function parseJsonText(text, options) {
    const maxBytes = (options && options.maxBytes) || LIMITS.maxBytes;
    if (typeof text !== 'string') {
      return { ok: false, error: 'Input must be text' };
    }
    if (text.trim() === '') {
      return { ok: false, error: 'Empty input is not valid JSON' };
    }
    const bytes = utf8ByteLength(text);
    if (bytes > maxBytes) {
      return {
        ok: false,
        error: `Input exceeds the ${maxBytes} byte limit (${bytes} bytes)`,
      };
    }
    try {
      const value = JSON.parse(text);
      const numbers = validateParsedNumbers(value);
      if (!numbers.ok) return numbers;
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'Invalid JSON' };
    }
  }

  function displayPointer(path) {
    return path === '' ? '(root)' : path;
  }

  function validateParsedNumbers(root) {
    const stack = [{ value: root, path: '' }];
    while (stack.length) {
      const item = stack.pop();
      const type = jsonType(item.value);
      if (type === 'number') {
        if (!Number.isFinite(item.value)) {
          return {
            ok: false,
            error: `Non-finite number at ${displayPointer(item.path)} (JSON overflow such as 1e400 becomes Infinity and is rejected)`,
          };
        }
        if (Number.isInteger(item.value) && !Number.isSafeInteger(item.value)) {
          return {
            ok: false,
            error: `Integer at ${displayPointer(item.path)} is outside the safe integer range (Number.isSafeInteger)`,
          };
        }
        continue;
      }
      if (type === 'array') {
        for (let i = item.value.length - 1; i >= 0; i -= 1) {
          stack.push({ value: item.value[i], path: `${item.path}/${i}` });
        }
        continue;
      }
      if (type === 'object') {
        const keys = Object.keys(item.value);
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i];
          stack.push({
            value: ownGet(item.value, key),
            path: `${item.path}/${encodePointerSegment(key)}`,
          });
        }
      }
    }
    return { ok: true };
  }

  function jsonType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function emptySummary() {
    return {
      added: 0,
      removed: 0,
      type_changed: 0,
      value_changed: 0,
      total: 0,
    };
  }

  function summarize(changes) {
    const summary = emptySummary();
    for (let i = 0; i < changes.length; i += 1) {
      const kind = changes[i].kind;
      if (Object.prototype.hasOwnProperty.call(summary, kind) && kind !== 'total') {
        summary[kind] += 1;
      }
      summary.total += 1;
    }
    return summary;
  }

  function measureDepth(value) {
    let max = 0;
    const stack = [{ value, depth: 0 }];
    while (stack.length) {
      const item = stack.pop();
      const type = jsonType(item.value);
      if (type !== 'object' && type !== 'array') {
        if (item.depth > max) max = item.depth;
        continue;
      }
      const next = item.depth + 1;
      if (next > max) max = next;
      if (type === 'array') {
        for (let i = 0; i < item.value.length; i += 1) {
          stack.push({ value: item.value[i], depth: next });
        }
      } else {
        const keys = Object.keys(item.value);
        for (let i = 0; i < keys.length; i += 1) {
          stack.push({ value: ownGet(item.value, keys[i]), depth: next });
        }
      }
    }
    return max;
  }

  function depthError(depth, maxDepth) {
    return `Payload nesting depth ${depth} exceeds the limit of ${maxDepth}`;
  }

  function GuardError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function pushChange(changes, entry, maxEntries) {
    if (changes.length >= maxEntries) {
      throw GuardError('DIFF_CAP', `Diff exceeds the ${maxEntries} entry cap`);
    }
    changes.push(entry);
  }

  function compareValues(before, after, options) {
    const opts = options || {};
    const maxDepth = opts.maxDepth == null ? LIMITS.maxDepth : opts.maxDepth;
    const maxEntries = opts.maxEntries == null ? LIMITS.maxEntries : opts.maxEntries;
    const beforeDepth = measureDepth(before);
    const afterDepth = measureDepth(after);
    const errors = {};
    if (beforeDepth > maxDepth) errors.before = depthError(beforeDepth, maxDepth);
    if (afterDepth > maxDepth) errors.after = depthError(afterDepth, maxDepth);
    if (errors.before || errors.after) {
      return { ok: false, errors };
    }
    const changes = [];
    try {
      walk(before, after, '', changes, { maxEntries });
    } catch (err) {
      if (err && err.code === 'DIFF_CAP') {
        return { ok: false, errors: { compare: err.message } };
      }
      throw err;
    }
    return {
      ok: true,
      formatVersion: LIMITS.formatVersion,
      comparison: LIMITS.comparison,
      summary: summarize(changes),
      changes,
    };
  }

  function encodePointerSegment(key) {
    return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function pointerJoin(parent, key) {
    return `${parent}/${encodePointerSegment(key)}`;
  }

  function ownKeys(obj) {
    return Object.keys(obj).sort();
  }

  function ownGet(obj, key) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    return desc ? desc.value : undefined;
  }

  function walk(before, after, path, changes, options) {
    const beforeType = jsonType(before);
    const afterType = jsonType(after);
    const maxEntries = options.maxEntries == null ? LIMITS.maxEntries : options.maxEntries;
    if (beforeType !== afterType) {
      pushChange(changes, {
        path,
        kind: 'type_changed',
        before,
        after,
        beforeType,
        afterType,
      }, maxEntries);
      return;
    }
    if (beforeType !== 'object' && beforeType !== 'array') {
      if (before !== after) {
        pushChange(changes, {
          path,
          kind: 'value_changed',
          before,
          after,
        }, maxEntries);
      }
      return;
    }
    if (beforeType === 'object') {
      const afterKeys = ownKeys(after);
      const beforeKeys = ownKeys(before);
      const union = [];
      const seen = Object.create(null);
      for (let i = 0; i < beforeKeys.length; i += 1) {
        const key = beforeKeys[i];
        if (!Object.prototype.hasOwnProperty.call(seen, key)) {
          seen[key] = true;
          union.push(key);
        }
      }
      for (let i = 0; i < afterKeys.length; i += 1) {
        const key = afterKeys[i];
        if (!Object.prototype.hasOwnProperty.call(seen, key)) {
          seen[key] = true;
          union.push(key);
        }
      }
      union.sort();
      for (let i = 0; i < union.length; i += 1) {
        const key = union[i];
        const childPath = pointerJoin(path, key);
        const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
        const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
        if (hasBefore && !hasAfter) {
          pushChange(changes, {
            path: childPath,
            kind: 'removed',
            before: ownGet(before, key),
          }, maxEntries);
          continue;
        }
        if (!hasBefore && hasAfter) {
          pushChange(changes, {
            path: childPath,
            kind: 'added',
            after: ownGet(after, key),
          }, maxEntries);
          continue;
        }
        walk(ownGet(before, key), ownGet(after, key), childPath, changes, options);
      }
      return;
    }
    const minLen = Math.min(before.length, after.length);
    for (let i = 0; i < minLen; i += 1) {
      walk(before[i], after[i], pointerJoin(path, String(i)), changes, options);
    }
    for (let i = minLen; i < after.length; i += 1) {
      pushChange(changes, {
        path: pointerJoin(path, String(i)),
        kind: 'added',
        after: after[i],
      }, maxEntries);
    }
    for (let i = minLen; i < before.length; i += 1) {
      pushChange(changes, {
        path: pointerJoin(path, String(i)),
        kind: 'removed',
        before: before[i],
      }, maxEntries);
    }
  }

  function compareJsonTexts(beforeText, afterText, options) {
    const before = parseJsonText(beforeText, options);
    const after = parseJsonText(afterText, options);
    if (!before.ok || !after.ok) {
      const errors = {};
      if (!before.ok) errors.before = before.error;
      if (!after.ok) errors.after = after.error;
      return { ok: false, errors };
    }
    return compareValues(before.value, after.value, options);
  }

  return {
    LIMITS,
    MASKED_EXPORT_WARNINGS,
    MASKED_INCLUDES_ORIGINALS_WARNING,
    buildMaskedExportDocument,
    stringifyExportDocument: function stringifyExportDocument(doc) {
      return JSON.stringify(doc, null, 2);
    },
    emptyMaskSelection,
    isOriginalIncluded,
    parseJsonText,
    compareJsonTexts,
    compareValues,
    jsonType,
    encodePointerSegment,
    measureDepth,
    formatPointerDisplay: function formatPointerDisplay(path) {
      return path === '' ? '(root)' : path;
    },
    buildExportDocument: function buildExportDocument(result) {
      if (!result || !result.ok) return null;
      return {
        formatVersion: result.formatVersion,
        comparison: LIMITS.comparison,
        summary: result.summary,
        changes: result.changes,
      };
    },
  };
}));
