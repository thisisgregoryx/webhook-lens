'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../diff.js');
const compare = api.compareJsonTexts;

test('default share omits both original numbers with explicit metadata', () => {
  const result = compare('{"n":1}', '{"n":2}');
  const doc = api.buildMaskedExportDocument?.(result);
  assert.equal(doc?.kind, 'webhook-lens-masked-diff', 'comparison must produce a distinct masked share document');
  assert.equal(doc.schemaVersion, 1);
  assert.equal('formatVersion' in doc, false);
  assert.deepEqual(doc.changes, [{ path: '/n', kind: 'value_changed', before: { present: true, type: 'number', redacted: true }, after: { present: true, type: 'number', redacted: true } }]);
  assert.equal(doc.includesOriginalValues, false);
  assert.equal(doc.warnings.length, 2);
});

test('removed null remains present null while absent side has no other metadata', () => {
  const doc = api.buildMaskedExportDocument(compare('{"a":null}', '{}'));
  assert.deepEqual(doc.changes[0].after, { present: false });
  assert.deepEqual(doc.changes[0].before, { present: true, type: 'null', redacted: true });
  assert.equal(JSON.stringify(doc).includes('"value":null'), false);
});

// Coverage-only: generic type description already implements slice 3.
test('root null to object retains type change and summary', () => {
  const doc = api.buildMaskedExportDocument(compare('null', '{}'));
  assert.deepEqual(doc.changes[0], { path: '', kind: 'type_changed', before: { present: true, type: 'null', redacted: true }, after: { present: true, type: 'object', redacted: true } });
  assert.equal(doc.summary.type_changed, 1);
});

test('only explicitly included present sides carry originals and warning', () => {
  const selection = { includeOriginals: [{ path: '/n', side: 'after' }, { path: '/missing', side: 'before' }] };
  const doc = api.buildMaskedExportDocument(compare('{"n":1}', '{"n":2}'), selection);
  assert.deepEqual(doc.changes[0].after, { present: true, type: 'number', redacted: false, value: 2 });
  assert.equal('value' in doc.changes[0].before, false);
  assert.equal(doc.includesOriginalValues, true);
  assert.equal(doc.warnings.at(-1), api.MASKED_INCLUDES_ORIGINALS_WARNING);
});

// Coverage-only slices 5–8: the side schema already omits subtrees and preserves diff identity.
test('added/removed object and array sides omit their whole subtrees', () => {
  for (const [before, after, side, type] of [
    ['{}', '{"meta":{"ok":true,"secret":1}}', 'after', 'object'],
    ['{"meta":[{"secret":1}]}', '{}', 'before', 'array'],
    ['[]', '[[{"secret":1}]]', 'after', 'array'],
  ]) {
    const doc = api.buildMaskedExportDocument(compare(before, after));
    assert.deepEqual(doc.changes[0][side], { present: true, type, redacted: true });
    assert.doesNotMatch(JSON.stringify(doc), /secret|"ok"/);
  }
});

test('hidden changes retain path, kind, comparison, summary; original diff is unchanged', () => {
  const before = '{"task":{"status":"in_progress"}}';
  const after = '{"task":{"status":"done"}}';
  const result = compare(before, after);
  const snapshot = JSON.stringify(result);
  const original = api.buildExportDocument(result);
  const doc = api.buildMaskedExportDocument(result);
  assert.equal(doc.changes[0].path, '/task/status');
  assert.equal(doc.changes[0].kind, 'value_changed');
  assert.deepEqual(doc.summary, result.summary);
  assert.equal(doc.comparison, 'index-based');
  assert.equal(JSON.stringify(result), snapshot);
  assert.deepEqual(compare(before, after), result);
  assert.equal(original.formatVersion, 1);
  assert.equal(original.changes[0].before, 'in_progress');
  assert.equal(original.changes[0].after, 'done');
});

test('root, escaped pointers and hostile own keys serialize and select exactly', () => {
  const fixtures = [
    ['1', '2', ''],
    ['{"a/b":1,"c~d":2,"":0}', '{"a/b":2,"c~d":3,"":1}', '/a~1b'],
    ['{"__proto__":{"x":1},"constructor":2}', '{"__proto__":{"x":2},"constructor":3}', '/__proto__/x'],
    ['{}', '{"__proto__":{"secret":1}}', '/__proto__'],
  ];
  for (const [before, after, path] of fixtures) {
    const doc = api.buildMaskedExportDocument(compare(before, after), { includeOriginals: [{ path, side: 'after' }] });
    const change = doc.changes.find(c => c.path === path);
    assert.equal(change.after.redacted, false);
    assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
    assert.equal(doc.changes.filter(c => c.after.redacted === false).length, 1);
  }
  const doc = api.buildMaskedExportDocument(compare('{}', '{"a":null}'), { includeOriginals: [{ path: '/a', side: 'before' }, { path: '/unknown', side: 'after' }] });
  assert.equal(doc.includesOriginalValues, false);
  assert.deepEqual(doc.changes[0].before, { present: false });
  const nullDoc = api.buildMaskedExportDocument(compare('null', 'true'), { includeOriginals: [{ path: '', side: 'before' }] });
  assert.deepEqual(nullDoc.changes[0].before, { present: true, type: 'null', redacted: false, value: null });
  assert.deepEqual(api.emptyMaskSelection(), { includeOriginals: [] });
  assert.equal(api.buildMaskedExportDocument({ ok: false }), null);
  assert.equal(api.buildMaskedExportDocument(null), null);
});

test('canonical string includes full paths and matches JSON.stringify bytes', () => {
  const doc = api.buildMaskedExportDocument(compare('{"a/b":1}', '{"a/b":2}'));
  assert.equal(api.stringifyExportDocument?.(doc), JSON.stringify(doc, null, 2));
});
