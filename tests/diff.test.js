'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compareJsonTexts, compareValues, parseJsonText, encodePointerSegment, LIMITS } = require('../diff.js');

describe('invalid input both sides', () => {
  it('parses each side independently and reports both errors', () => {
    const result = compareJsonTexts('{not-json', '[also-not');
    assert.equal(result.ok, false);
    assert.ok(result.errors.before, 'expected before error');
    assert.ok(result.errors.after, 'expected after error');
    assert.notEqual(result.errors.before, '');
    assert.notEqual(result.errors.after, '');
  });

  it('treats empty text as invalid JSON', () => {
    const empty = parseJsonText('');
    assert.equal(empty.ok, false);
    assert.match(empty.error, /empty/i);

    const result = compareJsonTexts('', '1');
    assert.equal(result.ok, false);
    assert.ok(result.errors.before);
    assert.equal(result.errors.after, undefined);
  });

  it('accepts a valid primitive on one side while the other fails', () => {
    const result = compareJsonTexts('true', '{');
    assert.equal(result.ok, false);
    assert.equal(result.errors.before, undefined);
    assert.ok(result.errors.after);
  });
});

describe('identical payloads, key order, and root primitives', () => {
  it('returns an explicit identical result, not a blank object', () => {
    const result = compareJsonTexts('{"ok":true}', '{"ok":true}');
    assert.equal(result.ok, true);
    assert.equal(result.formatVersion, 1);
    assert.equal(result.comparison, 'index-based');
    assert.deepEqual(result.summary, {
      added: 0,
      removed: 0,
      type_changed: 0,
      value_changed: 0,
      total: 0,
    });
    assert.deepEqual(result.changes, []);
  });

  it('ignores object key order when values match', () => {
    const result = compareJsonTexts('{"b":1,"a":2}', '{"a":2,"b":1}');
    assert.equal(result.ok, true);
    assert.equal(result.summary.total, 0);
    assert.deepEqual(result.changes, []);
  });

  it('treats matching root primitives as identical', () => {
    assert.equal(compareJsonTexts('42', '42').summary.total, 0);
    assert.equal(compareJsonTexts('"hi"', '"hi"').summary.total, 0);
    assert.equal(compareJsonTexts('null', 'null').summary.total, 0);
    assert.equal(compareJsonTexts('false', 'false').summary.total, 0);
  });

  it('reports value_changed at the empty root pointer for different primitives', () => {
    const result = compareJsonTexts('"hello"', '"world"');
    assert.equal(result.ok, true);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '');
    assert.equal(result.changes[0].kind, 'value_changed');
    assert.equal(result.changes[0].before, 'hello');
    assert.equal(result.changes[0].after, 'world');
    assert.equal(result.summary.value_changed, 1);
    assert.equal(result.summary.total, 1);
  });
});

describe('null vs object and type changes', () => {
  it('distinguishes null from an empty object as a single type_changed at root', () => {
    const result = compareJsonTexts('null', '{}');
    assert.equal(result.ok, true);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '');
    assert.equal(result.changes[0].kind, 'type_changed');
    assert.equal(result.changes[0].before, null);
    assert.deepEqual(result.changes[0].after, {});
    assert.equal(result.changes[0].beforeType, 'null');
    assert.equal(result.changes[0].afterType, 'object');
    assert.equal(result.summary.type_changed, 1);
    assert.equal(result.summary.total, 1);
  });

  it('emits one type_changed entry and no contradictory child diffs', () => {
    const result = compareJsonTexts('{"a":1,"b":2}', '[1,2]');
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].kind, 'type_changed');
    assert.equal(result.changes[0].beforeType, 'object');
    assert.equal(result.changes[0].afterType, 'array');
    assert.deepEqual(result.changes[0].before, { a: 1, b: 2 });
    assert.deepEqual(result.changes[0].after, [1, 2]);
  });

  it('distinguishes null from an empty array', () => {
    const result = compareJsonTexts('null', '[]');
    assert.equal(result.changes[0].kind, 'type_changed');
    assert.equal(result.changes[0].beforeType, 'null');
    assert.equal(result.changes[0].afterType, 'array');
  });
});

describe('nested value_changed vs type_changed', () => {
  it('reports value_changed for a same-type nested primitive', () => {
    const result = compareJsonTexts('{"n":1}', '{"n":2}');
    assert.equal(result.ok, true);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '/n');
    assert.equal(result.changes[0].kind, 'value_changed');
    assert.equal(result.changes[0].before, 1);
    assert.equal(result.changes[0].after, 2);
    assert.equal(result.summary.value_changed, 1);
  });

  it('reports type_changed for number vs string at the same path', () => {
    const result = compareJsonTexts('{"n":1}', '{"n":"1"}');
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].kind, 'type_changed');
    assert.equal(result.changes[0].path, '/n');
    assert.equal(result.changes[0].before, 1);
    assert.equal(result.changes[0].after, '1');
    assert.equal(result.changes[0].beforeType, 'number');
    assert.equal(result.changes[0].afterType, 'string');
  });

  it('emits nested changes in deterministic sorted-key order', () => {
    const result = compareJsonTexts('{"z":1,"a":1}', '{"z":2,"a":2}');
    assert.deepEqual(result.changes.map((c) => c.path), ['/a', '/z']);
  });
});

describe('nested additions and removals', () => {
  it('records removed and added nested keys with before/after only when present', () => {
    const result = compareJsonTexts(
      '{"user":{"id":1,"name":"a"}}',
      '{"user":{"id":1,"role":"admin"}}',
    );
    assert.equal(result.ok, true);
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]));
    assert.equal(byPath['/user/name'].kind, 'removed');
    assert.equal(byPath['/user/name'].before, 'a');
    assert.equal(Object.prototype.hasOwnProperty.call(byPath['/user/name'], 'after'), false);
    assert.equal(byPath['/user/role'].kind, 'added');
    assert.equal(byPath['/user/role'].after, 'admin');
    assert.equal(Object.prototype.hasOwnProperty.call(byPath['/user/role'], 'before'), false);
    assert.equal(result.summary.added, 1);
    assert.equal(result.summary.removed, 1);
    assert.equal(result.summary.total, 2);
  });

  it('records an added container as one subtree entry', () => {
    const result = compareJsonTexts('{}', '{"meta":{"ok":true,"n":1}}');
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '/meta');
    assert.equal(result.changes[0].kind, 'added');
    assert.deepEqual(result.changes[0].after, { ok: true, n: 1 });
  });

  it('records a removed container as one subtree entry', () => {
    const result = compareJsonTexts('{"meta":{"ok":true,"n":1}}', '{}');
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '/meta');
    assert.equal(result.changes[0].kind, 'removed');
    assert.deepEqual(result.changes[0].before, { ok: true, n: 1 });
  });
});

describe('arrays are index-based', () => {
  it('compares shared indexes recursively and reports added tails', () => {
    const result = compareJsonTexts('[1,2]', '[1,3,4]');
    assert.deepEqual(result.changes, [
      { path: '/1', kind: 'value_changed', before: 2, after: 3 },
      { path: '/2', kind: 'added', after: 4 },
    ]);
    assert.equal(result.summary.value_changed, 1);
    assert.equal(result.summary.added, 1);
  });

  it('reports removed tail indexes', () => {
    const result = compareJsonTexts('[1,2,3]', '[1]');
    assert.deepEqual(result.changes, [
      { path: '/1', kind: 'removed', before: 2 },
      { path: '/2', kind: 'removed', before: 3 },
    ]);
  });

  it('records an added array element container as one subtree', () => {
    const result = compareJsonTexts('[]', '[{"id":1,"name":"x"}]');
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '/0');
    assert.equal(result.changes[0].kind, 'added');
    assert.deepEqual(result.changes[0].after, { id: 1, name: 'x' });
  });

  it('recurses into objects at shared array indexes', () => {
    const result = compareJsonTexts('[{"id":1}]', '[{"id":2}]');
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '/0/id');
    assert.equal(result.changes[0].kind, 'value_changed');
  });
});

describe('pointer escaping, empty keys, and prototype-named keys', () => {
  it('escapes ~ as ~0 and / as ~1, including empty object keys', () => {
    const result = compareJsonTexts(
      '{"a/b":1,"c~d":2,"":3}',
      '{"a/b":9,"c~d":2,"":4}',
    );
    const paths = result.changes.map((c) => c.path).sort();
    assert.deepEqual(paths, ['/', '/a~1b']);
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]));
    assert.equal(byPath['/a~1b'].kind, 'value_changed');
    assert.equal(byPath['/a~1b'].before, 1);
    assert.equal(byPath['/a~1b'].after, 9);
    assert.equal(byPath['/'].kind, 'value_changed');
    assert.equal(byPath['/'].before, 3);
    assert.equal(byPath['/'].after, 4);
  });

  it('escapes a changed tilde key and mixed ~/ as /c~0d and /~0~1', () => {
    assert.equal(encodePointerSegment('~'), '~0');
    assert.equal(encodePointerSegment('/'), '~1');
    assert.equal(encodePointerSegment('~/'), '~0~1');
    const result = compareJsonTexts(
      '{"c~d":1,"~/":2}',
      '{"c~d":9,"~/":3}',
    );
    assert.equal(result.ok, true);
    const paths = result.changes.map((c) => c.path).sort();
    assert.deepEqual(paths, ['/c~0d', '/~0~1']);
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]));
    assert.equal(byPath['/c~0d'].kind, 'value_changed');
    assert.equal(byPath['/c~0d'].before, 1);
    assert.equal(byPath['/c~0d'].after, 9);
    assert.equal(byPath['/~0~1'].kind, 'value_changed');
    assert.equal(byPath['/~0~1'].before, 2);
    assert.equal(byPath['/~0~1'].after, 3);
    assert.equal(byPath['/~0~1'].path, '/~0~1');
  });

  it('diffs own keys named __proto__ and constructor without walking the prototype', () => {
    const result = compareJsonTexts(
      '{"__proto__":{"x":1},"constructor":2}',
      '{"__proto__":{"x":2},"constructor":3}',
    );
    assert.equal(result.ok, true);
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]));
    assert.equal(byPath['/__proto__/x'].kind, 'value_changed');
    assert.equal(byPath['/__proto__/x'].before, 1);
    assert.equal(byPath['/__proto__/x'].after, 2);
    assert.equal(byPath['/constructor'].kind, 'value_changed');
    assert.equal(byPath['/constructor'].before, 2);
    assert.equal(byPath['/constructor'].after, 3);
    assert.equal(result.changes.length, 2);
  });

  it('treats an added __proto__ own key as a single added entry', () => {
    const result = compareJsonTexts('{}', '{"__proto__":{"polluted":false}}');
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '/__proto__');
    assert.equal(result.changes[0].kind, 'added');
    assert.deepEqual(result.changes[0].after, { polluted: false });
  });
});

describe('size, depth, and entry-cap guards', () => {
  it('rejects input over the documented 1MiB byte limit', () => {
    const big = `{"k":"${'x'.repeat(LIMITS.maxBytes)}"}`;
    const result = compareJsonTexts(big, '1');
    assert.equal(result.ok, false);
    assert.match(result.errors.before, /limit|byte|1048576|1\s*MiB/i);
    assert.equal(result.errors.after, undefined);
  });

  it('rejects nesting deeper than 100 and allows depth 100', () => {
    let allowed = '1';
    for (let i = 0; i < 100; i += 1) allowed = `{"a":${allowed}}`;
    const ok = compareJsonTexts(allowed, allowed);
    assert.equal(ok.ok, true);
    assert.equal(ok.summary.total, 0);

    let tooDeep = 'null';
    for (let i = 0; i < 101; i += 1) tooDeep = `{"a":${tooDeep}}`;
    const result = compareJsonTexts(tooDeep, '{"a":1}');
    assert.equal(result.ok, false);
    assert.match(result.errors.before, /depth|100|nested/i);
  });

  it('rejects a diff that would exceed the entry cap instead of truncating', () => {
    const n = LIMITS.maxEntries + 1;
    const before = {};
    const after = {};
    for (let i = 0; i < n; i += 1) {
      before[`k${i}`] = 0;
      after[`k${i}`] = 1;
    }
    const result = compareJsonTexts(JSON.stringify(before), JSON.stringify(after));
    assert.equal(result.ok, false);
    assert.match(String(result.errors.compare || result.errors.before || result.errors.after), /cap|limit|entr/i);
    assert.equal(result.changes, undefined);
  });

  it('compareValues reports the same entry-cap error for parsed objects', () => {
    const before = { a: 1 };
    const after = { a: 2 };
    const result = compareValues(before, after, { maxEntries: 0 });
    assert.equal(result.ok, false);
    assert.match(result.errors.compare, /cap|limit|entr/i);
  });
});

describe('JSON number overflow and unsafe integers', () => {
  it('rejects non-finite overflow such as 1e400 with a side-specific error', () => {
    const parsed = parseJsonText('1e400');
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /finite|overflow|infinity/i);

    const result = compareJsonTexts('1e400', '1');
    assert.equal(result.ok, false);
    assert.ok(result.errors.before);
    assert.match(result.errors.before, /finite|overflow|infinity/i);
    assert.equal(result.errors.after, undefined);
  });

  it('rejects nested and array non-finite numbers and includes a pointer', () => {
    const nested = parseJsonText('{"a":{"b":1e400}}');
    assert.equal(nested.ok, false);
    assert.match(nested.error, /\/a\/b/);
    assert.match(nested.error, /finite|overflow|infinity/i);

    const arr = parseJsonText('[1,-1e400]');
    assert.equal(arr.ok, false);
    assert.match(arr.error, /\/1/);
    assert.match(arr.error, /finite|overflow|infinity/i);

    const afterSide = compareJsonTexts('{"ok":true}', '{"items":[0,1e400]}');
    assert.equal(afterSide.ok, false);
    assert.equal(afterSide.errors.before, undefined);
    assert.match(afterSide.errors.after, /\/items\/1/);
  });

  it('rejects unsafe integers such as 9007199254740993 with a pointer', () => {
    const root = parseJsonText('9007199254740993');
    assert.equal(root.ok, false);
    assert.match(root.error, /safe integer/i);

    const nested = parseJsonText('{"n":9007199254740993}');
    assert.equal(nested.ok, false);
    assert.match(nested.error, /\/n/);
    assert.match(nested.error, /safe integer/i);

    const result = compareJsonTexts('{"n":9007199254740993}', '1');
    assert.equal(result.ok, false);
    assert.match(result.errors.before, /safe integer/i);
    assert.equal(result.errors.after, undefined);
  });

  it('allows boundary safe integers and ordinary decimals', () => {
    assert.equal(parseJsonText('9007199254740991').ok, true);
    assert.equal(parseJsonText('9007199254740991').value, 9007199254740991);
    assert.equal(parseJsonText('-9007199254740991').ok, true);
    assert.equal(parseJsonText('-9007199254740991').value, -9007199254740991);
    assert.equal(parseJsonText('0').ok, true);
    assert.equal(parseJsonText('1.5').ok, true);
    assert.equal(parseJsonText('1.5').value, 1.5);
    assert.equal(parseJsonText('0.1').ok, true);
    assert.equal(parseJsonText('-2.25').ok, true);
    assert.equal(parseJsonText('1e2').ok, true);
    const result = compareJsonTexts('{"x":1.25,"y":0.5}', '{"x":1.25,"y":0.5}');
    assert.equal(result.ok, true);
    assert.equal(result.summary.total, 0);
  });
});
