'use strict';

(function () {
  const api = window.WebhookLensDiff;
  if (!api) {
    document.getElementById('status').textContent = 'diff.js failed to load.';
    return;
  }

  const SYNTHETIC_BEFORE = {
    event: 'task.updated',
    synthetic: true,
    label: 'synthetic example',
    event_id: 'evt_synth_1001',
    occurred_at: '2026-03-14T09:12:00.000Z',
    workspace: { id: 'ws_demo', name: 'Example Workspace' },
    task: {
      id: 'task_42',
      title: 'Review onboarding checklist',
      status: 'in_progress',
      assignee: 'alex@example.test',
      priority: 2,
      temporary_note: 'draft reminder',
      tags: ['onboarding', 'docs'],
      fields: { estimate_minutes: 30 },
    },
  };

  const SYNTHETIC_AFTER = {
    event: 'task.updated',
    synthetic: true,
    label: 'synthetic example',
    event_id: 'evt_synth_1001',
    occurred_at: '2026-03-14T09:18:00.000Z',
    workspace: { id: 'ws_demo', name: 'Example Workspace' },
    task: {
      id: 'task_42',
      title: 'Review onboarding checklist',
      status: 'done',
      assignee: 'alex@example.test',
      priority: '1',
      tags: ['onboarding', 'docs', 'qa'],
      fields: { estimate_minutes: 25 },
      completed_at: '2026-03-14T09:18:00.000Z',
    },
  };

  const els = {
    beforeText: document.getElementById('before-text'),
    afterText: document.getElementById('after-text'),
    beforeFile: document.getElementById('before-file'),
    afterFile: document.getElementById('after-file'),
    beforeError: document.getElementById('before-error'),
    afterError: document.getElementById('after-error'),
    compare: document.getElementById('compare-btn'),
    example: document.getElementById('example-btn'),
    clear: document.getElementById('clear-btn'),
    status: document.getElementById('status'),
    count: document.getElementById('results-count'),
    filters: document.getElementById('filters'),
    results: document.getElementById('results'),
    copy: document.getElementById('copy-btn'),
    exportBtn: document.getElementById('export-btn'),
    sharePreview: document.getElementById('share-preview'),
    shareOriginalsWarning: document.getElementById('share-originals-warning'),
    copyMasked: document.getElementById('copy-masked-btn'),
    downloadMasked: document.getElementById('download-masked-btn'),
  };

  let maskSelection = api.emptyMaskSelection();
  let shareText = '';
  let current = null;
  let filter = 'all';
  let objectUrl = null;
  const fileReads = {
    before: { reader: null, generation: 0 },
    after: { reader: null, generation: 0 },
  };

  function setStatus(text) {
    els.status.textContent = text;
  }

  function setError(node, message) {
    node.textContent = message || '';
  }

  function disableExport(disabled) {
    els.copy.disabled = disabled;
    els.exportBtn.disabled = disabled;
    els.copyMasked.disabled = disabled;
    els.downloadMasked.disabled = disabled;
  }

  function invalidateShare() {
    maskSelection = api.emptyMaskSelection();
    shareText = '';
    els.sharePreview.textContent = '';
    els.shareOriginalsWarning.hidden = true;
    disableExport(true);
  }

  function refreshShare() {
    const doc = api.buildMaskedExportDocument(current, maskSelection);
    shareText = api.stringifyExportDocument(doc);
    els.sharePreview.textContent = shareText;
    els.shareOriginalsWarning.hidden = !doc.includesOriginalValues;
  }

  function isReading() {
    return fileReads.before.reader !== null || fileReads.after.reader !== null;
  }

  function syncPendingUi() {
    els.compare.disabled = isReading();
    if (isReading()) invalidateShare();
  }

  function abortSideRead(side) {
    const slot = fileReads[side];
    slot.generation += 1;
    const reader = slot.reader;
    slot.reader = null;
    if (reader && typeof reader.abort === 'function') {
      try {
        reader.abort();
      } catch (err) {
        // Ignore abort failures; generation invalidates late callbacks.
      }
    }
  }

  function abortAllReads() {
    abortSideRead('before');
    abortSideRead('after');
    syncPendingUi();
  }

  function clearResultsView() {
    while (els.results.firstChild) els.results.removeChild(els.results.firstChild);
    els.count.textContent = 'No comparison yet.';
    els.filters.querySelectorAll('[data-count]').forEach((node) => {
      node.textContent = '0';
    });
  }

  function markStale() {
    invalidateShare();
    if (!current && !els.results.firstChild) return;
    current = null;
    disableExport(true);
    clearResultsView();
    setStatus('Payloads changed. Compare again to refresh results. Copy and export are disabled.');
  }

  function stringifyValue(value) {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }

  function renderResults() {
    while (els.results.firstChild) els.results.removeChild(els.results.firstChild);
    if (!current || !current.ok) {
      els.count.textContent = 'No current diff.';
      return;
    }
    const changes = current.changes.filter((change) => filter === 'all' || change.kind === filter);
    els.count.textContent = `${changes.length} shown / ${current.summary.total} total`;
    if (current.summary.total === 0) {
      const empty = document.createElement('li');
      empty.className = 'change';
      empty.textContent = 'Identical. No differences.';
      els.results.appendChild(empty);
      return;
    }
    changes.forEach((change) => {
      const item = document.createElement('li');
      item.className = 'change';
      const top = document.createElement('div');
      top.className = 'change-top';
      const path = document.createElement('code');
      path.className = 'path';
      path.textContent = api.formatPointerDisplay(change.path);
      const badge = document.createElement('span');
      badge.className = `badge ${change.kind}`;
      badge.textContent = change.kind;
      top.appendChild(path);
      top.appendChild(badge);
      item.appendChild(top);
      if (Object.prototype.hasOwnProperty.call(change, 'before')) {
        const row = document.createElement('p');
        row.className = 'kv';
        row.textContent = `before: ${stringifyValue(change.before)}`;
        item.appendChild(row);
      }
      if (Object.prototype.hasOwnProperty.call(change, 'after')) {
        const row = document.createElement('p');
        row.className = 'kv';
        row.textContent = `after: ${stringifyValue(change.after)}`;
        item.appendChild(row);
      }
      if (change.kind === 'type_changed') {
        const row = document.createElement('p');
        row.className = 'kv';
        row.textContent = `types: ${change.beforeType} → ${change.afterType}`;
        item.appendChild(row);
      }
      ['before', 'after'].forEach((side) => {
        if (!Object.prototype.hasOwnProperty.call(change, side)) return;
        const label = document.createElement('label');
        label.className = 'share-selection';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.path = change.path;
        checkbox.dataset.unmaskSide = side;
        checkbox.checked = api.isOriginalIncluded(maskSelection, change.path, side);
        checkbox.addEventListener('change', () => {
          if (!current || isReading()) return;
          maskSelection.includeOriginals = maskSelection.includeOriginals.filter(entry =>
            entry.path !== change.path || entry.side !== side);
          if (checkbox.checked) maskSelection.includeOriginals.push({ path: change.path, side });
          refreshShare();
        });
        const text = document.createElement('span');
        text.textContent = `Include original ${side} value in share`;
        label.appendChild(checkbox);
        label.appendChild(text);
        item.appendChild(label);
      });
      els.results.appendChild(item);
    });
  }

  function applySummary(summary) {
    els.filters.querySelectorAll('[data-count]').forEach((node) => {
      const key = node.getAttribute('data-count');
      node.textContent = String(summary[key] || 0);
    });
  }

  function runCompare() {
    if (isReading()) {
      invalidateShare();
      setStatus('A file is still being read. Compare is disabled until reads finish or are cancelled.');
      return;
    }
    setError(els.beforeError, '');
    setError(els.afterError, '');
    const result = api.compareJsonTexts(els.beforeText.value, els.afterText.value);
    current = null;
    invalidateShare();
    if (!result.ok) {
      if (result.errors.before) setError(els.beforeError, result.errors.before);
      if (result.errors.after) setError(els.afterError, result.errors.after);
      if (result.errors.compare) setStatus(result.errors.compare);
      else setStatus('Comparison blocked by invalid or oversized input.');
      clearResultsView();
      return;
    }
    current = result;
    refreshShare();
    applySummary(result.summary);
    renderResults();
    disableExport(false);
    if (result.summary.total === 0) {
      setStatus('Payloads are identical.');
    } else {
      setStatus(`Compared. ${result.summary.total} change${result.summary.total === 1 ? '' : 's'}.`);
    }
  }

  function setFilter(next) {
    filter = next;
    els.filters.querySelectorAll('button[data-filter]').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-filter') === next ? 'true' : 'false');
    });
    if (current && current.ok) renderResults();
  }

  function loadTextFile(file, side) {
    const textarea = side === 'before' ? els.beforeText : els.afterText;
    const errorNode = side === 'before' ? els.beforeError : els.afterError;
    abortSideRead(side);
    markStale();
    disableExport(true);
    if (!file) {
      syncPendingUi();
      return;
    }
    if (file.size > api.LIMITS.maxBytes) {
      textarea.value = '';
      setError(errorNode, `File exceeds the ${api.LIMITS.maxBytes} byte limit (${file.size} bytes)`);
      syncPendingUi();
      return;
    }
    const generation = fileReads[side].generation;
    const reader = new FileReader();
    fileReads[side].reader = reader;
    setError(errorNode, '');
    setStatus(side === 'before' ? 'Reading BEFORE file…' : 'Reading AFTER file…');
    syncPendingUi();

    function isCurrent() {
      return fileReads[side].generation === generation && fileReads[side].reader === reader;
    }

    function finishRead() {
      if (fileReads[side].reader === reader) fileReads[side].reader = null;
      syncPendingUi();
    }

    reader.onload = function () {
      if (!isCurrent()) return;
      const text = String(reader.result || '');
      const parsed = api.parseJsonText(text);
      textarea.value = text;
      if (!parsed.ok) setError(errorNode, parsed.error);
      else setError(errorNode, '');
      markStale();
      finishRead();
    };
    reader.onerror = function () {
      if (!isCurrent()) return;
      setError(errorNode, 'Could not read that file.');
      markStale();
      finishRead();
    };
    reader.onabort = function () {
      if (!isCurrent()) return;
      finishRead();
    };
    reader.readAsText(file);
  }

  function loadSynthetic() {
    abortAllReads();
    els.beforeText.value = JSON.stringify(SYNTHETIC_BEFORE, null, 2);
    els.afterText.value = JSON.stringify(SYNTHETIC_AFTER, null, 2);
    setError(els.beforeError, '');
    setError(els.afterError, '');
    markStale();
    setStatus('Loaded synthetic example (self-owned demo task/event data, not from a company).');
    syncPendingUi();
  }

  function clearAll() {
    abortAllReads();
    els.beforeText.value = '';
    els.afterText.value = '';
    els.beforeFile.value = '';
    els.afterFile.value = '';
    setError(els.beforeError, '');
    setError(els.afterError, '');
    current = null;
    filter = 'all';
    setFilter('all');
    invalidateShare();
    clearResultsView();
    setStatus('Cleared.');
    syncPendingUi();
  }

  function exportText() {
    if (!current || !current.ok) return '';
    return JSON.stringify(api.buildExportDocument(current), null, 2);
  }

  function fallbackCopy(text) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(helper);
    return ok;
  }

  async function copyDiff(masked) {
    const text = masked ? shareText : exportText();
    const name = masked ? 'masked share' : 'full original diff';
    if (!text) {
      setStatus('Nothing to copy. Compare valid payloads first.');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        setStatus(`Copied the ${name} JSON.`);
        return;
      } catch (err) {
        // fall through
      }
    }
    if (fallbackCopy(text)) {
      setStatus(`Copied the ${name} JSON using a fallback.`);
      return;
    }
    setStatus('Clipboard is blocked in this browser. Use Export instead.');
  }

  function exportDiff(masked) {
    const text = masked ? shareText : exportText();
    const name = masked ? 'masked share' : 'full original diff';
    if (!text) {
      setStatus('Nothing to export. Compare valid payloads first.');
      return;
    }
    try {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const blob = new Blob([text], { type: 'application/json' });
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = masked ? 'webhook-lens-masked-diff.json' : 'webhook-lens-diff.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setStatus(`Started download of the ${name} JSON.`);
    } catch (err) {
      setStatus('Export failed in this browser.');
    }
  }

  els.compare.addEventListener('click', runCompare);
  els.example.addEventListener('click', loadSynthetic);
  els.clear.addEventListener('click', clearAll);
  els.copy.addEventListener('click', function () {
    copyDiff();
  });
  els.exportBtn.addEventListener('click', () => exportDiff(false));
  els.copyMasked.addEventListener('click', () => copyDiff(true));
  els.downloadMasked.addEventListener('click', () => exportDiff(true));
  els.beforeText.addEventListener('input', function () {
    abortSideRead('before');
    markStale();
    syncPendingUi();
  });
  els.afterText.addEventListener('input', function () {
    abortSideRead('after');
    markStale();
    syncPendingUi();
  });
  els.beforeFile.addEventListener('change', function () {
    loadTextFile(els.beforeFile.files[0], 'before');
  });
  els.afterFile.addEventListener('change', function () {
    loadTextFile(els.afterFile.files[0], 'after');
  });
  els.filters.addEventListener('click', function (event) {
    const btn = event.target.closest('button[data-filter]');
    if (!btn) return;
    setFilter(btn.getAttribute('data-filter'));
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BODY' || tag === 'HTML') {
      event.preventDefault();
      if (isReading()) {
        invalidateShare();
        setStatus('A file is still being read. Compare is disabled until reads finish or are cancelled.');
        return;
      }
      runCompare();
    }
  });
}());
