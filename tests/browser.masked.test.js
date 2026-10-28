'use strict';
// No packages or shared browser: sandbox-enabled Chrome + built-in Node CDP client.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '..');
function isExecutableFile(candidate) {
  try {
    fsSync.accessSync(candidate, fsSync.constants.X_OK);
    return fsSync.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
function resolveChrome() {
  const specified = process.env.CHROME_BIN;
  if (specified) {
    if (isExecutableFile(specified)) return specified;
    throw new Error(`CHROME_BIN is not an executable browser: ${specified}`);
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'chromium');
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error('Missing browser executable: set CHROME_BIN to a sandbox-enabled Chrome or Chromium, or place chromium on PATH. This test does not download, install, or skip.');
}
function resolveArtifacts() {
  return process.env.WEBHOOK_LENS_TEST_ARTIFACTS || os.tmpdir();
}
async function until(fn, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(30);
  }
  throw new Error(`Timed out: ${message}`);
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (!msg.id) { events.push(msg); return; }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
    else slot.resolve(msg.result);
  };
  return {
    events,
    close: () => ws.close(),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const next = ++id;
        const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
        pending.set(next, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: next, method, params }));
      });
    },
  };
}

test('isolated browser masked sharing workflow', { timeout: 90000 }, async (t) => {
  const CHROME = resolveChrome();
  const receipts = resolveArtifacts();
  await fs.mkdir(receipts, { recursive: true });
  const owned = await fs.mkdtemp(path.join(receipts, 'browser-'));
  const downloads = path.join(owned, 'downloads');
  await fs.mkdir(downloads);
  // Keep the owned temp path short enough for Chromium's Unix socket limit.
  const browserTemp = await fs.mkdtemp(path.join(os.tmpdir(), 't-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!['index.html', 'app.js', 'diff.js', 'styles.css'].includes(name)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await fs.readFile(path.join(ROOT, name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${owned}/profile`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: browserTemp, XDG_CONFIG_HOME: path.join(owned, 'config'), XDG_CACHE_HOME: path.join(owned, 'cache') } });
  let stderr = '';
  chrome.stderr.on('data', data => { stderr += data; });
  let cdp;
  t.after(async () => {
    cdp?.close();
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(owned, 'chrome.stderr'), stderr);
    // Only remove the profile owned by this test. Keep receipts and actual downloads.
    await fs.rm(path.join(owned, 'profile'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await fs.rm(browserTemp, { recursive: true, force: true });
    console.log(`Browser artifacts: ${owned}`);
  });
  chrome.on('error', error => { stderr += String(error); });
  const port = await until(async () => {
    try { return (await fs.readFile(path.join(owned, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(`Chrome exited ${chrome.exitCode}: ${stderr}`); return false; }
  }, 'Chrome debugging port');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = await connect(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  const evaluate = async expression => {
    const reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Page.navigate', { url: origin });
  await until(() => evaluate(`document.readyState === 'complete' && !!window.WebhookLensDiff`), 'app load');
  assert.equal(await evaluate(`['copy-btn','export-btn','copy-masked-btn','download-masked-btn'].every(id => document.getElementById(id).disabled)`), true);
  await click('#example-btn');
  await click('#compare-btn');
  assert.equal(await evaluate(`!!document.querySelector('#share-preview')?.textContent`), true, 'successful comparison must show the complete masked share preview');
  const preview = () => evaluate(`document.querySelector('#share-preview').textContent`);
  const buffers = () => evaluate(`[document.querySelector('#before-text').value, document.querySelector('#after-text').value]`);
  const originalBuffers = await buffers();
  const initial = await preview();
  const doc = JSON.parse(initial);
  assert.equal(doc.changes.length, 7);
  assert.deepEqual(doc.changes.map(c => c.path).sort(), ['/occurred_at', '/task/completed_at', '/task/fields/estimate_minutes', '/task/priority', '/task/status', '/task/tags/2', '/task/temporary_note'].sort());
  assert.equal(doc.includesOriginalValues, false);
  assert.ok(doc.changes.every(c => ['before', 'after'].every(side => !Object.hasOwn(c[side], 'value'))));
  const api = require('../diff.js');
  assert.equal(initial, api.stringifyExportDocument(api.buildMaskedExportDocument(api.compareJsonTexts(...originalBuffers))));
  await fs.writeFile(path.join(owned, 'masked-preview.json'), initial);
  assert.match(await evaluate(`document.querySelector('#share-warning').textContent`), /not an anonymity guarantee/);
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await evaluate(`window.nativeCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
      window.lastDownloadBlobBytes = blob.text();
      return window.nativeCreateObjectURL.call(URL, blob);
    };`);
  const copyBytes = async (button) => {
    await evaluate(`document.querySelector('#status').textContent = ''`);
    await click(button);
    await until(() => evaluate(`document.querySelector('#status').textContent.startsWith('Copied')`), 'clipboard write');
    return evaluate('navigator.clipboard.readText()');
  };
  const downloadBytes = async (button, filename) => {
    const destination = path.join(downloads, filename);
    await fs.rm(destination, { force: true });
    await click(button);
    const bytes = await until(async () => { try { return await fs.readFile(destination, 'utf8'); } catch { return false; } }, 'actual downloaded file');
    assert.equal(bytes, await evaluate('window.lastDownloadBlobBytes'), 'actual file bytes match the delegated original Blob');
    return bytes;
  };
  assert.equal(await copyBytes('#copy-masked-btn'), initial);
  assert.equal(await downloadBytes('#download-masked-btn', 'webhook-lens-masked-diff.json'), initial);
  const toggle = (pointer, side) => evaluate(`Array.from(document.querySelectorAll('[data-unmask-side]')).find(el => el.dataset.path === ${JSON.stringify(pointer)} && el.dataset.unmaskSide === ${JSON.stringify(side)}).click()`);
  await toggle('/task/status', 'after');
  const included = await preview();
  assert.equal(JSON.parse(included).changes.find(c => c.path === '/task/status').after.value, 'done');
  assert.equal(JSON.parse(included).changes.filter(c => Object.hasOwn(c.before, 'value') || Object.hasOwn(c.after, 'value')).length, 1);
  assert.equal(await evaluate(`document.querySelector('#share-originals-warning').hidden`), false);
  assert.equal(await copyBytes('#copy-masked-btn'), included);
  assert.equal(await downloadBytes('#download-masked-btn', 'webhook-lens-masked-diff.json'), included);
  await click('[data-filter="added"]');
  assert.equal(await evaluate(`document.querySelectorAll('#results > li').length`), 2);
  assert.equal(await preview(), included);
  assert.equal(await copyBytes('#copy-masked-btn'), included);
  assert.equal(await downloadBytes('#download-masked-btn', 'webhook-lens-masked-diff.json'), included);
  assert.equal(JSON.parse(await copyBytes('#copy-btn')).changes.length, 7);
  assert.equal(JSON.parse(await downloadBytes('#export-btn', 'webhook-lens-diff.json')).changes.length, 7);
  await click('[data-filter="all"]');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-unmask-side]')).find(el => el.dataset.path === '/task/status' && el.dataset.unmaskSide === 'after').checked`), true);
  await toggle('/task/status', 'after');
  assert.equal(await preview(), initial);
  assert.equal(await evaluate(`document.querySelector('#share-originals-warning').hidden`), true);
  assert.deepEqual(await buffers(), originalBuffers);
  assert.match(await evaluate(`document.querySelector('#copy-btn').textContent`), /full original/);
  const full = JSON.stringify(api.buildExportDocument(api.compareJsonTexts(...originalBuffers)), null, 2);
  assert.equal(await copyBytes('#copy-btn'), full);
  assert.equal(await downloadBytes('#export-btn', 'webhook-lens-diff.json'), full);
  assert.equal(JSON.parse(full).formatVersion, 1);
  assert.equal(JSON.parse(full).changes.find(c => c.path === '/task/status').before, 'in_progress');
  console.log('PASS: exact complete preview, real clipboard, actual downloads, selective include/remask, filters, unchanged originals');

  const setInputs = (before, after) => evaluate(`(() => {
    for (const [id, value] of [['before-text', ${JSON.stringify(before)}], ['after-text', ${JSON.stringify(after)}]]) {
      const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  const disabled = async () => {
    assert.equal(await preview(), '');
    assert.equal(await evaluate(`['copy-btn','export-btn','copy-masked-btn','download-masked-btn'].every(id => document.getElementById(id).disabled)`), true);
    assert.equal(await evaluate(`document.querySelector('#share-originals-warning').hidden`), true);
  };
  const reset = async () => { await click('#example-btn'); await click('#compare-btn'); assert.equal(await preview(), initial); };
  for (const action of ['edit', 'clear', 'invalid', 'example', 'compare-again']) {
    await reset();
    await toggle('/task/status', 'after');
    if (action === 'edit') await evaluate(`document.querySelector('#before-text').value += ' '; document.querySelector('#before-text').dispatchEvent(new Event('input'))`);
    if (action === 'clear') await click('#clear-btn');
    if (action === 'invalid') {
      // Direct programmatic assignment exercises runCompare invalidation independently of input events.
      await evaluate(`document.querySelector('#before-text').value = '{'`);
      await click('#compare-btn');
      assert.notEqual(await evaluate(`document.querySelector('#before-error').textContent`), '');
    }
    if (action === 'example') await click('#example-btn');
    if (action === 'compare-again') { await click('#compare-btn'); assert.equal(await preview(), initial); }
    else await disabled();
  }
  console.log('PASS: edit, clear, invalid compare, example load and new compare revoke selection');

  await reset();
  await toggle('/task/status', 'after');
  const fileText = '{"file_synthetic":true}';
  // Delegate the real native read, holding only its completion callback. No fixture replacement.
  await evaluate(`window.NativeFileReader = window.FileReader;
    window.FileReader = class extends window.NativeFileReader {
      readAsText(file) {
        const completion = this.onload;
        this.onload = event => { window.releaseRead = () => completion.call(this, event); };
        super.readAsText(file);
      }
    };
    window.startHeldFile = () => {
      window.releaseRead = null;
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(fileText)}], 'synthetic.json', { type: 'application/json' }));
      const input = document.querySelector('#before-file');
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    };
    window.startHeldFile();`);
  await until(() => evaluate(`typeof window.releaseRead === 'function'`), 'real FileReader completion held');
  await disabled();
  assert.equal(await evaluate(`document.querySelector('#compare-btn').disabled`), true);
  assert.deepEqual(await buffers(), originalBuffers);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
  await disabled();
  await evaluate('window.releaseRead()');
  assert.equal((await buffers())[0], fileText);
  assert.equal(await evaluate(`document.querySelector('#compare-btn').disabled`), false);
  await disabled();
  await click('#compare-btn');
  assert.equal(JSON.parse(await preview()).includesOriginalValues, false);
  await evaluate('window.startHeldFile()');
  await until(() => evaluate(`typeof window.releaseRead === 'function'`), 'second held native read');
  await click('#clear-btn');
  await evaluate('window.releaseRead()');
  assert.deepEqual(await buffers(), ['', '']);
  await disabled();
  await evaluate('window.FileReader = window.NativeFileReader');
  console.log('PASS: deterministic pending native FileReader, shortcut blocked, completion stays stale, clear rejects late completion');

  const fixtures = [
    ['{"gone":null}', '{"new":null}', ['/gone', '/new']],
    ['null', '{}', ['']],
    ['1', '2', ['']],
    ['false', 'true', ['']],
    ['{"same":true}', '{"same":true}', []],
    ['{"a/b":1,"c~d":1,"":0,"__proto__":{"x":1},"constructor":1}', '{"a/b":2,"c~d":2,"":1,"__proto__":{"x":2},"constructor":2}', ['/', '/__proto__/x', '/a~1b', '/constructor', '/c~0d']],
    ['{"removed":[{"hidden":"old"}]}', '{"added":{"hidden":"new"},"array":[{"child":true}]}', ['/removed', '/added', '/array']],
    ['{}', '{"__proto__":{"secret":true}}', ['/__proto__']],
    ['{"<img src=x onerror=alert(1)>":"<svg onload=alert(2)>"}', '{"<img src=x onerror=alert(1)>":"<b>synthetic</b>"}', ['/<img src=x onerror=alert(1)>']],
  ];
  for (const [before, after, pointers] of fixtures) {
    await setInputs(before, after);
    await disabled();
    await click('#compare-btn');
    const result = api.compareJsonTexts(before, after);
    const expected = api.stringifyExportDocument(api.buildMaskedExportDocument(result));
    assert.equal(await preview(), expected);
    const parsed = JSON.parse(expected);
    for (const pointer of pointers) assert.ok(parsed.changes.some(c => c.path === pointer));
    assert.equal(await evaluate(`document.querySelectorAll('#results img, #results svg, #results b').length`), 0);
    assert.deepEqual(await buffers(), [before, after]);
    for (const change of parsed.changes) {
      for (const side of ['before', 'after']) {
        if (!change[side].present) continue;
        await toggle(change.path, side);
        const unmasked = JSON.parse(await preview()).changes.find(c => c.path === change.path)[side];
        assert.deepEqual(unmasked, { present: true, type: api.jsonType(result.changes.find(c => c.path === change.path)[side]), redacted: false, value: result.changes.find(c => c.path === change.path)[side] });
        await toggle(change.path, side);
        assert.equal(await preview(), expected);
      }
    }
  }
  console.log('PASS: null/absent, root, escaped pointers, hostile keys/strings, object/array subtrees and include/remask on each present side');
  const longOriginal = 'synthetic-☃-<b>-'.repeat(4000);
  await setInputs('{"long":null}', JSON.stringify({ long: longOriginal }));
  await click('#compare-btn');
  await toggle('/long', 'after');
  const longPreview = await preview();
  assert.equal(JSON.parse(longPreview).changes[0].after.value, longOriginal);
  assert.equal(await copyBytes('#copy-masked-btn'), longPreview);
  assert.equal(await downloadBytes('#download-masked-btn', 'webhook-lens-masked-diff.json'), longPreview);
  await fs.writeFile(path.join(owned, 'large-exact-preview.json'), longPreview);
  console.log('PASS: large Unicode original is complete, with preview/clipboard/Blob/file byte parity');
  const browserRequests = cdp.events.filter(event => event.method === 'Network.requestWillBeSent').map(event => event.params.request.url);
  assert.ok(browserRequests.length >= 4);
  assert.ok(browserRequests.every(url => url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:' + origin)), JSON.stringify(browserRequests));
  assert.ok(requests.every(url => ['/', '/app.js', '/diff.js', '/styles.css'].includes(url)), JSON.stringify(requests));
  await fs.writeFile(path.join(owned, 'requests.json'), JSON.stringify({ browserRequests, staticRequests: requests }, null, 2));
  console.log('PASS: page requests confined to static loopback assets, data icon and owned download blobs');
});
