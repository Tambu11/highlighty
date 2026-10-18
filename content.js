/* Highlighty – content script */
(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const HL_CLASS = 'hl-ext-mark';
  const STORAGE_PREFIX = 'hl:';
  const TOOLBAR_KEY = 'highlighty:toolbar';
  const SETTINGS_KEY = 'highlighty:settings';
  const HOST_ID = 'highlighty-toolbar-host';
  const SLOT = 25;

  const ERASER = '__eraser__';
  const ERASER_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M16.24 3.56l4.95 4.94c.78.79.78 2.05 0 2.84L12 20.53a4.008 4.008 0 0 1-5.66 0' +
    'L2.81 17c-.78-.79-.78-2.05 0-2.84l10.6-10.6c.79-.78 2.05-.78 2.83 0zM4.22 15.58l3.54 3.53' +
    'c.78.79 2.04.79 2.83 0l3.53-3.53-4.95-4.95-4.95 4.95z"/></svg>';

  const DEFAULT_SETTINGS = {
    colors: [
      ERASER,
      '#fff176', '#ffe082', '#ffcc80', '#ffab91',
      '#ef9a9a', '#f48fb1', '#ce93d8', '#b39ddb',
      '#9fa8da', '#90caf9', '#81d4fa', '#80deea',
      '#80cbc4', '#a5d6a7', '#c5e1a5', '#e6ee9c'
    ],
    perLine: 4,
    deselect: {
      escape: true,
      middleClick: false,
      rightClick: false
    },
    scrollInvert: false,
    wordSnapping: true
  };

  const PASTELS = [
    '#fff59d', '#a5d6a7', '#90caf9', '#f48fb1',
    '#ffcc80', '#ce93d8', '#80cbc4', '#bcaaa4'
  ];

  // Matched against the text node's parent AND its ancestors (closest), so
  // e.g. <svg><text> and <select><option> are skipped too.
  const SKIP_SELECTOR =
    'script,style,noscript,textarea,title,iframe,canvas,svg,head,select,option';

  const BLOCK_TAGS = new Set([
    'P','DIV','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','PRE',
    'SECTION','ARTICLE','HEADER','FOOTER','ASIDE','NAV','TD','TH',
    'FIGURE','DD','DT','TABLE','UL','OL','FORM','FIELDSET'
  ]);

  /* ===================== state ===================== */

  let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  let activeColor = null;
  let toolbarHost = null;
  let barEl = null;
  let stripEl = null;
  let isDragging = false;
  let wheelAccum = 0;
  let wheelResetTimer = null;
  let picker = null;

  let toolbarState = {
    visible: false,
    left: null,
    top: null,
    orientation: 'horizontal',
    lineIndex: 0
  };

  /* ===================== helpers ===================== */

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
           String(Date.now()) + Math.random().toString(36).slice(2);
  }

  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  // Validates whatever came out of storage so malformed values can never
  // reach style strings or the DOM.
  function sanitizeSettings(loaded) {
    loaded = loaded && typeof loaded === 'object' ? loaded : {};

    let colors = Array.isArray(loaded.colors)
      ? loaded.colors.filter(
          (c) => c === ERASER || (typeof c === 'string' && HEX_RE.test(c))
        )
      : [];
    if (!colors.some((c) => c !== ERASER)) {
      colors = DEFAULT_SETTINGS.colors.slice();
    } else if (!colors.includes(ERASER)) {
      colors.unshift(ERASER);
    }

    return {
      colors,
      perLine: [3, 4, 5].includes(loaded.perLine)
        ? loaded.perLine
        : DEFAULT_SETTINGS.perLine,
      deselect: Object.assign({}, DEFAULT_SETTINGS.deselect, loaded.deselect || {}),
      scrollInvert: !!loaded.scrollInvert,
      wordSnapping: loaded.wordSnapping !== undefined ? !!loaded.wordSnapping : true
    };
  }

  // Firefox mouse wheels report deltaMode 1 (lines); Chrome reports pixels.
  function wheelPixels(e, d) {
    if (e.deltaMode === 1) return d * 16;
    if (e.deltaMode === 2) return d * 100;
    return d;
  }

  function nearestBlockAncestor(node) {
    let cur = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(cur.tagName)) {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  function getMarkColor(mark) {
    if (mark.dataset.hlColor) return mark.dataset.hlColor;
    const inline = mark.style.backgroundColor;
    if (inline) {
      const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(inline);
      if (m) {
        return '#' + [m[1], m[2], m[3]]
          .map((n) => (+n).toString(16).padStart(2, '0'))
          .join('');
      }
      return inline;
    }
    return '#fff176';
  }

  function makeMark(color) {
    const mark = document.createElement('mark');
    mark.className = HL_CLASS;
    mark.dataset.hlId = newId();
    mark.dataset.hlColor = color;
    mark.style.setProperty('background-color', color, 'important');
    mark.style.setProperty('color', 'inherit', 'important');
    mark.style.setProperty('padding', '0', 'important');
    return mark;
  }

  function parseCssColor(str) {
    if (!str) return null;
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(str);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    return null;
  }

  function adjustMarkTextColor(mark) {
    if (!mark.parentNode) return;
    try {
      const cs = getComputedStyle(mark);
      const fg = parseCssColor(cs.color);
      const bg = parseCssColor(cs.backgroundColor);
      if (!fg || !bg) return;

      // WCAG relative luminance (linearised sRGB)
      const lin = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      const lum = (c) =>
        0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const fgLum = lum(fg);
      const bgLum = lum(bg);
      const L1 = Math.max(fgLum, bgLum);
      const L2 = Math.min(fgLum, bgLum);
      const ratio = (L1 + 0.05) / (L2 + 0.05);

      if (ratio < 4.5) {
        const protectedEls = [];
        for (const el of mark.querySelectorAll('*')) {
          const els = getComputedStyle(el);
          const rawBg = els.backgroundColor;
          if (!rawBg || rawBg === 'transparent' ||
              rawBg === 'rgba(0, 0, 0, 0)') {
            continue;
          }
          protectedEls.push({ el, color: els.color });
        }

        mark.style.setProperty(
          'color',
          bgLum > 0.179 ? '#000000' : '#ffffff',
          'important'
        );

        for (const { el, color } of protectedEls) {
          el.style.setProperty('color', color, 'important');
        }
      }
    } catch { /* ignore */ }
  }

  function firstColour() {
    for (const c of settings.colors) {
      if (c && c !== ERASER) return c;
    }
    return '#fff176';
  }

  function nonEraserCount() {
    return settings.colors.filter((c) => c !== ERASER).length;
  }

  /* ===================== storage ===================== */

  // Query parameters that only record where a visitor came from. They differ
  // between visits to the very same page, so they must not be part of the key.
  const TRACKING_PARAM_RE =
    /^(utm_.*|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|ttclid|igshid|mc_cid|mc_eid|li_fat_id|_ga|_gl)$/i;

  // `search` is a query string including the leading "?". Returned untouched
  // (byte-for-byte) when there is nothing to strip, so keys of ordinary URLs
  // never change.
  function stripTrackingParams(search) {
    if (!search) return search;
    const kept = [];
    let removed = false;
    for (const part of search.slice(1).split('&')) {
      if (!part) continue;
      let name = part.split('=')[0];
      try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* keep raw */ }
      if (TRACKING_PARAM_RE.test(name)) { removed = true; continue; }
      kept.push(part);
    }
    if (!removed) return search;
    return kept.length ? '?' + kept.join('&') : '';
  }

  function pageKey() {
    return STORAGE_PREFIX + location.origin + location.pathname +
           stripTrackingParams(location.search);
  }

  async function loadRecords() {
    const data = await api.storage.local.get(pageKey());
    return data[pageKey()] || [];
  }

  // One-time migration (versions <= 1.0.2 keyed pages by their raw query
  // string): fold every stored key that differs only by tracking parameters
  // into its clean key, merging records by id. Nothing is discarded.
  const MIGRATION_FLAG = 'highlighty:keys-v2';

  async function migrateLegacyKeys() {
    const all = await api.storage.local.get(null);
    if (all[MIGRATION_FLAG]) return;

    const updates = {};
    const removals = [];
    for (const key of Object.keys(all)) {
      if (!key.startsWith(STORAGE_PREFIX) || !Array.isArray(all[key])) continue;
      const q = key.indexOf('?');
      if (q === -1) continue;
      const cleanKey = key.slice(0, q) + stripTrackingParams(key.slice(q));
      if (cleanKey === key) continue;

      const base = updates[cleanKey] || all[cleanKey] || [];
      const seen = new Set(base.map((r) => r.id));
      updates[cleanKey] = base.concat(all[key].filter((r) => !seen.has(r.id)));
      removals.push(key);
    }

    if (Object.keys(updates).length) await api.storage.local.set(updates);
    if (removals.length) await api.storage.local.remove(removals);
    await api.storage.local.set({ [MIGRATION_FLAG]: true });
  }

  async function saveRecords(records) {
    if (!records.length) {
      await api.storage.local.remove(pageKey());
      return;
    }
    await api.storage.local.set({ [pageKey()]: records });
  }

  // Rebuilds the stored list from the DOM, but never drops records that
  // simply haven't been restored on this page yet (late content, changed
  // text, ...). Only records whose marks were present before this operation
  // and are now gone (erased/merged/replaced) are removed.
  async function persistRecords(idsBefore) {
    const stored = await loadRecords();
    const prev = new Map(stored.map((r) => [r.id, r]));
    const current = rebuildRecords(prev);
    const currentIds = new Set(current.map((r) => r.id));
    const kept = stored.filter(
      (r) => !idsBefore.has(r.id) && !currentIds.has(r.id)
    );
    await saveRecords([...kept, ...current]);
  }

  async function loadToolbarState() {
    const data = await api.storage.local.get(TOOLBAR_KEY);
    return Object.assign({}, toolbarState, data[TOOLBAR_KEY] || {});
  }

  async function saveToolbarState() {
    await api.storage.local.set({ [TOOLBAR_KEY]: toolbarState });
  }

  async function loadSettings() {
    const data = await api.storage.sync.get(SETTINGS_KEY);
    return sanitizeSettings(data[SETTINGS_KEY]);
  }

  async function saveSettings() {
    await api.storage.sync.set({ [SETTINGS_KEY]: settings });
  }

  /* ===================== text index ===================== */

  function collectTextNodes(root) {
    const nodes = [];
    if (!root) return nodes;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function buildIndex(nodes) {
    let text = '';
    const spans = [];
    const map = new Map();
    for (const node of nodes) {
      const start = text.length;
      text += node.nodeValue;
      const span = { node, start, end: text.length };
      spans.push(span);
      map.set(node, span);
    }
    return { text, spans, map };
  }

  // Binary search for the span containing a character offset.
  function spanAtOffset(spans, offset) {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = spans[mid];
      if (offset < s.start) hi = mid - 1;
      else if (offset >= s.end) lo = mid + 1;
      else return s;
    }
    return null;
  }

  function findOccurrence(text, needle, occurrence) {
    let from = 0;
    let idx = -1;
    for (let i = 0; i <= occurrence; i++) {
      idx = text.indexOf(needle, from);
      if (idx === -1) return -1;
      from = idx + 1;
    }
    return idx;
  }

  function rangeFromOffsets(spans, start, end) {
    if (!spans.length) return null;
    const total = spans[spans.length - 1].end;
    if (start < 0 || end > total || start >= end) return null;

    const range = document.createRange();
    let started = false;

    for (const span of spans) {
      if (!started && start < span.end) {
        range.setStart(span.node, start - span.start);
        started = true;
      }
      if (started && end <= span.end) {
        range.setEnd(span.node, end - span.start);
        return range;
      }
    }
    return null;
  }

  function wrapRange(range, record) {
    const mark = makeMark(record.color);
    mark.dataset.hlId = record.id;

    try {
      range.surroundContents(mark);
    } catch {
      const fragment = range.extractContents();
      mark.appendChild(fragment);

      const sc = range.startContainer;
      const so = range.startOffset;
      if (sc.nodeType === Node.TEXT_NODE) {
        if (so <= 0) {
          sc.parentNode.insertBefore(mark, sc);
        } else if (so >= sc.nodeValue.length) {
          sc.parentNode.insertBefore(mark, sc.nextSibling);
        } else {
          const after = sc.splitText(so);
          after.parentNode.insertBefore(mark, after);
        }
      } else {
        sc.insertBefore(mark, sc.childNodes[so] || null);
      }
    }
    adjustMarkTextColor(mark);
    return mark;
  }

  function unwrapMark(mark) {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    try { parent.normalize(); } catch {}
  }

  function findIntersectingMarks(range) {
    const marks = document.querySelectorAll('mark.' + HL_CLASS);
    const out = [];
    for (const mark of marks) {
      try {
        if (range.intersectsNode(mark)) out.push(mark);
      } catch { /* ignore */ }
    }
    return out;
  }

  /* ===================== records ===================== */

  function rebuildRecords(prev) {
    const { text: full, map } = buildIndex(collectTextNodes(document.body));
    const records = [];

    document.querySelectorAll('mark.' + HL_CLASS).forEach((mark) => {
      const text = mark.textContent;
      if (!text) return;

      const innerText = collectTextNodes(mark)[0];
      const startSpan = innerText ? map.get(innerText) : null;
      if (!startSpan) return;
      const startOffset = startSpan.start;

      let occurrence = 0;
      let idx = full.indexOf(text);
      while (idx !== -1 && idx < startOffset) {
        occurrence++;
        idx = full.indexOf(text, idx + 1);
      }

      const endOffset = startOffset + text.length;
      const prefix = full.slice(Math.max(0, startOffset - 30), startOffset);
      const suffix = full.slice(endOffset, Math.min(full.length, endOffset + 30));

      records.push({
        id: mark.dataset.hlId,
        text,
        occurrence,
        prefix,
        suffix,
        color: getMarkColor(mark),
        createdAt: (prev && prev.get(mark.dataset.hlId) &&
                    prev.get(mark.dataset.hlId).createdAt) || Date.now()
      });
    });

    return records;
  }

  function mergeAdjacentMarks() {
    const isMark = (n) =>
      n && n.nodeType === Node.ELEMENT_NODE && n.classList &&
      n.classList.contains(HL_CLASS);

    let pass = true;
    while (pass) {
      pass = false;
      const marks = document.querySelectorAll('mark.' + HL_CLASS);
      for (const mark of marks) {
        if (!mark.parentNode) continue;

        let next = mark.nextSibling;
        while (next && next.nodeType === Node.TEXT_NODE && next.nodeValue.length === 0) {
          next = next.nextSibling;
        }
        if (!isMark(next)) continue;
        if (getMarkColor(mark) !== getMarkColor(next)) continue;

        while (next.firstChild) mark.appendChild(next.firstChild);
        next.parentNode.removeChild(next);
        pass = true;
      }
    }
  }

  function absorbWhitespaceMarks() {
    const marks = Array.from(document.querySelectorAll('mark.' + HL_CLASS));
    for (const mark of marks) {
      if (!mark.parentNode) continue;
      const text = mark.textContent || '';
      if (!/^\s+$/.test(text)) continue;

      const prevMark = prevMarkSibling(mark);
      const nextMark = nextMarkSibling(mark);
      if (!prevMark || !nextMark) continue;

      const prevColor = getMarkColor(prevMark);
      const nextColor = getMarkColor(nextMark);
      if (prevColor !== nextColor) continue;

      const curColor = getMarkColor(mark);
      if (curColor === prevColor) continue;

      mark.dataset.hlColor = prevColor;
      mark.style.setProperty('background-color', prevColor, 'important');
    }
  }

  function prevMarkSibling(node) {
    let sib = node.previousSibling;
    while (sib) {
      if (sib.nodeType === Node.ELEMENT_NODE && sib.classList &&
          sib.classList.contains(HL_CLASS)) {
        return sib;
      }
      if (sib.nodeType === Node.TEXT_NODE && sib.nodeValue.trim() !== '') return null;
      sib = sib.previousSibling;
    }
    return null;
  }

  function nextMarkSibling(node) {
    let sib = node.nextSibling;
    while (sib) {
      if (sib.nodeType === Node.ELEMENT_NODE && sib.classList &&
          sib.classList.contains(HL_CLASS)) {
        return sib;
      }
      if (sib.nodeType === Node.TEXT_NODE && sib.nodeValue.trim() !== '') return null;
      sib = sib.nextSibling;
    }
    return null;
  }

  function removeWhitespaceMarks() {
    const marks = Array.from(document.querySelectorAll('mark.' + HL_CLASS));
    for (const mark of marks) {
      if (!mark.parentNode) continue;
      if ((mark.textContent || '').trim() !== '') continue;
      unwrapMark(mark);
    }
  }

  /* ===================== restore ===================== */

  function findBestOccurrence(fullText, record) {
    const { text, occurrence, prefix, suffix } = record;
    if (!text) return -1;

    let bestIdx = -1;
    let bestScore = -1;
    let idx = fullText.indexOf(text);
    let currentOcc = 0;

    while (idx !== -1) {
      let score = 0;
      if (prefix) {
        const actualPrefix = fullText.slice(Math.max(0, idx - prefix.length), idx);
        if (actualPrefix.endsWith(prefix)) score += 2;
        else if (actualPrefix.endsWith(prefix.slice(-10))) score += 1;
      }
      if (suffix) {
        const actualSuffix = fullText.slice(idx + text.length, idx + text.length + suffix.length);
        if (actualSuffix.startsWith(suffix)) score += 2;
        else if (actualSuffix.startsWith(suffix.slice(0, 10))) score += 1;
      }

      if (score > bestScore || (score === bestScore && currentOcc === occurrence)) {
        bestScore = score;
        bestIdx = idx;
      }

      currentOcc++;
      idx = fullText.indexOf(text, idx + 1);
    }

    if (bestScore > 0) return bestIdx;
    return findOccurrence(fullText, text, occurrence || 0);
  }

  async function restore() {
    const records = await loadRecords();
    if (!records.length) return;

    const remaining = records.filter((r) => {
      try {
        return !document.querySelector(
          `mark.${HL_CLASS}[data-hl-id="${r.id}"]`
        );
      } catch {
        return true;
      }
    });
    if (!remaining.length) return;

    const { text, spans } = buildIndex(collectTextNodes(document.body));
    if (!text) return;

    const usedIndices = new Set();
    const jobs = [];
    for (const record of remaining) {
      const idx = findBestOccurrence(text, record);
      if (idx === -1) continue;
      
      if (usedIndices.has(idx)) continue;
      usedIndices.add(idx);
      
      const range = rangeFromOffsets(spans, idx, idx + record.text.length);
      if (range) jobs.push({ idx, range, record });
    }

    jobs.sort((a, b) => b.idx - a.idx);

    for (const job of jobs) {
      try {
        wrapRange(job.range, job.record);
      } catch (err) {
        console.warn('[Highlighty] could not restore highlight', err);
      }
    }

    absorbWhitespaceMarks();
    mergeAdjacentMarks();
    removeWhitespaceMarks();
  }

  /* ===================== selection ===================== */

  function firstTextDescendant(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return node;
    for (let i = 0; i < node.childNodes.length; i++) {
      const t = firstTextDescendant(node.childNodes[i]);
      if (t) return t;
    }
    return null;
  }

  function lastTextDescendant(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return node;
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      const t = lastTextDescendant(node.childNodes[i]);
      if (t) return t;
    }
    return null;
  }

  function resolveStartPoint(container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      return { node: container, offset };
    }
    const children = container.childNodes;
    for (let i = offset; i < children.length; i++) {
      const t = firstTextDescendant(children[i]);
      if (t) return { node: t, offset: 0 };
    }
    for (let i = offset - 1; i >= 0; i--) {
      const t = lastTextDescendant(children[i]);
      if (t) return { node: t, offset: t.nodeValue.length };
    }
    return null;
  }

  function resolveEndPoint(container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      return { node: container, offset };
    }
    const children = container.childNodes;
    for (let i = offset - 1; i >= 0; i--) {
      const t = lastTextDescendant(children[i]);
      if (t) return { node: t, offset: t.nodeValue.length };
    }
    for (let i = offset; i < children.length; i++) {
      const t = firstTextDescendant(children[i]);
      if (t) return { node: t, offset: 0 };
    }
    return null;
  }

  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const text = selection.toString();
    if (!text.trim()) return null;

    const index = buildIndex(collectTextNodes(document.body));

    const start = resolveStartPoint(range.startContainer, range.startOffset);
    const end = resolveEndPoint(range.endContainer, range.endOffset);
    if (!start || !end) return null;

    const startSpan = index.map.get(start.node);
    const endSpan = index.map.get(end.node);
    if (!startSpan || !endSpan) return null;

    const startOffset = startSpan.start + start.offset;
    const endOffset = endSpan.start + end.offset;

    if (endOffset <= startOffset) return null;

    return { text, startOffset, endOffset, index };
  }

  // Pass `spans` only while the DOM is unchanged since they were built.
  function selectionRangeFromOffsets(startOffset, endOffset, spans) {
    if (!spans) spans = buildIndex(collectTextNodes(document.body)).spans;
    return rangeFromOffsets(spans, startOffset, endOffset);
  }

  function effectiveBlockFor(node) {
    return nearestBlockAncestor(node) || document.body;
  }

  const CODE_LIKE_SELECTOR = 'code, pre, kbd, samp, var, tt';

  function closestCodeAncestor(node) {
    const el = node.parentElement;
    return el ? el.closest(CODE_LIKE_SELECTOR) : null;
  }

  function codeHasOwnBackground(codeEl) {
    const bg = getComputedStyle(codeEl).backgroundColor;
    return bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
  }

  function computeRanges(selStart, selEnd, index) {
    const { text, spans } = index || buildIndex(collectTextNodes(document.body));
    const ranges = [];

    const selSpans = spans.filter(
      (s) => s.end > selStart && s.start < selEnd
    );
    if (!selSpans.length) return ranges;

    const firstCode = closestCodeAncestor(selSpans[0].node);
    const lastCode = closestCodeAncestor(
      selSpans[selSpans.length - 1].node
    );
    const selectionInsideOneCode = !!firstCode && firstCode === lastCode;

    let currentBlock = null;
    let curStart = -1;
    let curEnd = -1;

    const pushCurrent = () => {
      if (currentBlock === null || curStart >= curEnd) return;
      if (text.slice(curStart, curEnd).trim() === '') return;
      ranges.push({ start: curStart, end: curEnd });
    };

    for (const span of selSpans) {
      if (!selectionInsideOneCode) {
        const code = closestCodeAncestor(span.node);
        if (code && codeHasOwnBackground(code)) {
          pushCurrent();
          currentBlock = null;
          curStart = -1;
          curEnd = -1;
          continue;
        }
      }

      const block = effectiveBlockFor(span.node);
      if (block !== currentBlock) {
        pushCurrent();
        currentBlock = block;
        curStart = Math.max(span.start, selStart);
      }
      curEnd = Math.min(span.end, selEnd);
    }

    pushCurrent();
    return ranges;
  }

  function splitMarkBySelection(mark, selRange) {
    const color = getMarkColor(mark);
    const markRange = document.createRange();
    markRange.selectNodeContents(mark);

    const startIn = markRange.isPointInRange(selRange.startContainer, selRange.startOffset);
    const endIn = markRange.isPointInRange(selRange.endContainer, selRange.endOffset);

    if (!startIn && !endIn) {
      unwrapMark(mark);
      return { leftMark: null, rightMark: null };
    }

    let leftRange = null;
    let rightRange = null;
    try {
      if (startIn) {
        leftRange = document.createRange();
        leftRange.setStart(markRange.startContainer, markRange.startOffset);
        leftRange.setEnd(selRange.startContainer, selRange.startOffset);
      }
      if (endIn) {
        rightRange = document.createRange();
        rightRange.setStart(selRange.endContainer, selRange.endOffset);
        rightRange.setEnd(markRange.endContainer, markRange.endOffset);
      }
    } catch (err) {
      console.warn('[Highlighty] could not compute split ranges', err);
      return { leftMark: null, rightMark: null };
    }

    let rightFrag = null;
    if (rightRange && !rightRange.collapsed) {
      try { rightFrag = rightRange.extractContents(); } catch { rightFrag = null; }
    }
    let leftFrag = null;
    if (leftRange && !leftRange.collapsed) {
      try { leftFrag = leftRange.extractContents(); } catch { leftFrag = null; }
    }

    const parent = mark.parentNode;
    if (!parent) return { leftMark: null, rightMark: null };
    const ref = mark.nextSibling;

    let leftMark = null;
    if (leftFrag && leftFrag.childNodes.length) {
      leftMark = makeMark(color);
      leftMark.appendChild(leftFrag);
      parent.insertBefore(leftMark, mark);
    }

    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);

    let rightMark = null;
    if (rightFrag && rightFrag.childNodes.length) {
      rightMark = makeMark(color);
      rightMark.appendChild(rightFrag);
      parent.insertBefore(rightMark, ref);
    }

    try { parent.normalize(); } catch {}

    if (leftMark) adjustMarkTextColor(leftMark);
    if (rightMark) adjustMarkTextColor(rightMark);

    return { leftMark, rightMark };
  }

  function snapToWordBounds(index, start, end) {
    const { text: fullText, spans } = index;
    const isWordChar = (ch) => ch && /[\p{L}\p{N}_]/u.test(ch);

    // Never let a word "continue" across a block boundary: the concatenated
    // text has no separators between e.g. <td>Name</td><td>Age</td>.
    const blockAt = (offset) => {
      const s = spanAtOffset(spans, offset);
      return s ? effectiveBlockFor(s.node) : null;
    };

    let newStart = start;
    let newEnd = end;

    if (newStart > 0 && newStart < fullText.length && isWordChar(fullText[newStart])) {
      const block = blockAt(newStart);
      while (
        newStart > 0 &&
        isWordChar(fullText[newStart - 1]) &&
        blockAt(newStart - 1) === block
      ) {
        newStart--;
      }
    }

    if (newEnd > 0 && newEnd < fullText.length && isWordChar(fullText[newEnd - 1])) {
      const block = blockAt(newEnd - 1);
      while (
        newEnd < fullText.length &&
        isWordChar(fullText[newEnd]) &&
        blockAt(newEnd) === block
      ) {
        newEnd++;
      }
    }

    return [newStart, newEnd];
  }

  async function highlightSelection(color) {
    if (!color) color = firstColour();

    const info = getSelectionInfo();
    if (!info) return { ok: false, reason: 'no-selection' };

    // One text index for the whole pre-mutation phase.
    const idx = info.index;
    const idsBefore = new Set(
      Array.from(document.querySelectorAll('mark.' + HL_CLASS), (m) => m.dataset.hlId)
    );

    let { startOffset, endOffset } = info;

    if (settings.wordSnapping) {
      [startOffset, endOffset] = snapToWordBounds(idx, startOffset, endOffset);
    }

    const ranges = computeRanges(startOffset, endOffset, idx);
    if (!ranges.length) return { ok: false, reason: 'no-ranges' };

    if (color === ERASER) {
      let anyIntersecting = false;
      for (const r of ranges) {
        const selRange = selectionRangeFromOffsets(r.start, r.end, idx.spans);
        if (!selRange) continue;
        if (findIntersectingMarks(selRange).length) {
          anyIntersecting = true;
          break;
        }
      }
      if (!anyIntersecting) return { ok: false, reason: 'nothing-to-erase' };
    }

    for (const r of ranges) {
      let selRange = selectionRangeFromOffsets(r.start, r.end);
      if (!selRange) continue;
      const intersecting = findIntersectingMarks(selRange);
      for (const mark of intersecting) {
        if (!mark.parentNode) continue;
        selRange = selectionRangeFromOffsets(r.start, r.end);
        if (!selRange) continue;
        try {
          splitMarkBySelection(mark, selRange);
        } catch (err) {
          console.warn('[Highlighty] split failed', err);
        }
      }

      if (color === ERASER) continue;

      selRange = selectionRangeFromOffsets(r.start, r.end);
      if (!selRange || selRange.collapsed) continue;

      const newMark = makeMark(color);
      let wrapped = false;
      let parentToNormalize = null;

      try {
        parentToNormalize = selRange.commonAncestorContainer;
        if (parentToNormalize.nodeType === Node.TEXT_NODE) {
          parentToNormalize = parentToNormalize.parentNode;
        }

        const frag = selRange.extractContents();
        newMark.appendChild(frag);

        const sc = selRange.startContainer;
        const so = selRange.startOffset;
        if (sc.nodeType === Node.TEXT_NODE) {
          if (so <= 0) {
            sc.parentNode.insertBefore(newMark, sc);
          } else if (so >= sc.nodeValue.length) {
            sc.parentNode.insertBefore(newMark, sc.nextSibling);
          } else {
            const after = sc.splitText(so);
            after.parentNode.insertBefore(newMark, after);
          }
        } else {
          sc.insertBefore(newMark, sc.childNodes[so] || null);
        }
        wrapped = true;
      } catch (err) {
        console.warn('[Highlighty] wrap failed', err);
      }

      if (wrapped && parentToNormalize) {
        try { parentToNormalize.normalize(); } catch {}
      }

      if (wrapped) adjustMarkTextColor(newMark);
    }

    absorbWhitespaceMarks();
    mergeAdjacentMarks();
    removeWhitespaceMarks();
    await persistRecords(idsBefore);

    window.getSelection().removeAllRanges();
    return { ok: true };
  }

  async function clearAll() {
    document.querySelectorAll('.' + HL_CLASS).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });

    await api.storage.local.remove(pageKey());
    return { ok: true };
  }

  /* ===================== auto-highlight ===================== */

  document.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return;
    if (!activeColor) return;
    if (isDragging) return;
    if (event.detail >= 3) return;

    if (toolbarHost && typeof event.composedPath === 'function') {
      if (event.composedPath().includes(toolbarHost)) return;
    }

    setTimeout(async () => {
      if (!activeColor) return;
      const info = getSelectionInfo();
      if (!info) return;
      await highlightSelection(activeColor);
    }, 0);
  }, true);

  /* ===================== wheel guard during drags ===================== */

  // The non-passive listener is only attached while a drag is in progress,
  // so it never slows down normal page scrolling.
  function wheelGuard(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function setDragging(value) {
    if (value === isDragging) return;
    isDragging = value;
    if (value) {
      window.addEventListener('wheel', wheelGuard, { capture: true, passive: false });
    } else {
      window.removeEventListener('wheel', wheelGuard, { capture: true });
    }
  }

  // If the window loses focus mid-drag, mouseup may never arrive.
  window.addEventListener('blur', () => {
    if (isDragging) setDragging(false);
  });

  /* ===================== deselect gestures ===================== */

  function deselect() {
    if (!activeColor) return false;
    activeColor = null;
    updateToolbarActiveState();
    return true;
  }

  function eventInsideToolbar(e) {
    if (!toolbarHost) return false;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(toolbarHost);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    if (picker && picker.isOpen()) {
      picker.close();
      return;
    }

    if (!settings.deselect.escape) return;
    deselect();
  }, true);

  let middleHandled = false;
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    if (!settings.deselect.middleClick) return;
    if (!activeColor) return;
    if (eventInsideToolbar(e)) return;

    middleHandled = true;
    e.preventDefault();
    e.stopPropagation();
    deselect();
  }, true);

  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    if (!middleHandled) return;
    middleHandled = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('contextmenu', (e) => {
    if (!settings.deselect.rightClick) return;
    if (!activeColor) return;
    if (eventInsideToolbar(e)) return;

    e.preventDefault();
    e.stopPropagation();
    deselect();
  }, true);

  document.addEventListener('pointerdown', (e) => {
    if (!picker || !picker.isOpen()) return;
    if (eventInsideToolbar(e)) return;
    picker.close();
  }, true);

  /* ===================== toolbar CSS ===================== */

  const TOOLBAR_CSS = `
    * { box-sizing: border-box; }

    .bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 6px;
      background: #ffffff;
      color: #222;
      border: 1px solid rgba(0,0,0,0.15);
      border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.1);
      font: 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      --per-line: 4;
    }

    .bar.vertical { flex-direction: column; }

    .bar.active {
      outline: 2px solid var(--hl-active, transparent);
      outline-offset: 2px;
    }

    .handle, .rotate, .settings, .close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      background: transparent;
      color: #666;
      border-radius: 5px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .handle { cursor: grab; }
    .handle:active { cursor: grabbing; }
    .handle:hover, .rotate:hover, .settings:hover, .close:hover {
      background: rgba(0,0,0,0.06);
      color: #222;
    }

    .viewport {
      width: calc(var(--per-line) * 25px);
      height: 25px;
      overflow: hidden;
      position: relative;
      flex-shrink: 0;
    }
    .bar.vertical .viewport {
      width: 25px;
      height: calc(var(--per-line) * 25px);
    }

    .strip {
      display: flex;
      flex-direction: row;
      transition: transform .18s ease;
      will-change: transform;
    }
    .bar.vertical .strip { flex-direction: column; }

    .slot {
      width: 25px;
      height: 25px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .swatch {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 2px solid transparent;
      padding: 0;
      cursor: pointer;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12);
      transition: transform .08s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .swatch:hover { transform: scale(1.1); }
    .swatch[aria-pressed="true"] { border-color: #333; }

    .swatch-eraser {
      background-color: #f0f0f0;
      color: #555;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.20);
    }
    .swatch-eraser:hover { background-color: #e5e5e5; }
    .swatch-eraser svg { width: 12px; height: 12px; display: block; }
    .swatch-eraser[aria-pressed="true"] {
      border-color: #333;
      color: #111;
    }

    .add {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid rgba(0,0,0,0.20);
      background: #ffffff;
      color: #888;
      cursor: pointer;
      flex-shrink: 0;
    }
    .add:hover { background: #f0f0f0; color: #222; }

    @media (prefers-color-scheme: dark) {
      .bar {
        background: #2a2a2a;
        color: #eee;
        border-color: rgba(255,255,255,0.15);
        box-shadow: 0 6px 24px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3);
      }
      .handle:hover, .rotate:hover, .settings:hover, .close:hover {
        background: rgba(255,255,255,0.10);
        color: #fff;
      }
      .swatch[aria-pressed="true"] { border-color: #eee; }
      .swatch-eraser {
        background-color: #3a3a3a;
        color: #bbb;
      }
      .swatch-eraser:hover { background-color: #444; }
      .swatch-eraser[aria-pressed="true"] { border-color: #eee; color: #fff; }

      .add {
        background: #2a2a2a;
        color: #aaa;
        border-color: rgba(255,255,255,0.22);
      }
      .add:hover { background: #3a3a3a; color: #fff; }
    }
  `;

  /* ===================== build ===================== */

  function buildToolbar() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = [
      'position:fixed',
      'top:20px',
      'right:20px',
      'left:auto',
      'bottom:auto',
      'z-index:2147483647',
      'pointer-events:auto',
      'margin:0',
      'padding:0'
    ].join(';') + ';';

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = TOOLBAR_CSS;
    shadow.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.setProperty('--per-line', String(settings.perLine));
    bar.innerHTML = `
      <button class="handle" type="button" title="Drag to move" aria-label="Drag to move">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M12 2 L15 6 L13 6 L13 11 L18 11 L18 9 L22 12 L18 15 L18 13 L13 13 L13 18 L15 18 L12 22 L9 18 L11 18 L11 13 L6 13 L6 15 L2 12 L6 9 L6 11 L11 11 L11 6 L9 6 Z"/>
        </svg>
      </button>
      <button class="rotate" type="button" title="Rotate toolbar" aria-label="Rotate toolbar">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3.5 12a8.5 8.5 0 0 1 14.4-6.1L21 8"/>
          <path d="M21 3.5V8h-4.5"/>
          <path d="M20.5 12a8.5 8.5 0 0 1-14.4 6.1L3 16"/>
          <path d="M3 20.5V16h4.5"/>
        </svg>
      </button>
      <div class="viewport"><div class="strip"></div></div>
      <button class="settings" type="button" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
      <button class="close" type="button" title="Close toolbar" aria-label="Close toolbar">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             stroke-width="2.6" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6 L18 18 M18 6 L6 18"/>
        </svg>
      </button>
    `;
    shadow.appendChild(bar);

    barEl = bar;
    stripEl = bar.querySelector('.strip');

    picker = window.HighlightyPicker.createPicker(shadow, {
      useBackdrop: false,
      centered: false,
      positionAfter: (pickerEl) => {
        const barRect = bar.getBoundingClientRect();
        const rect = pickerEl.getBoundingClientRect();
        const margin = 6;
        const isVertical = toolbarState.orientation === 'vertical';

        let left, top;
        if (isVertical) {
          left = barRect.right + margin;
          top = barRect.top;
          if (left + rect.width > window.innerWidth - 4) {
            left = barRect.left - rect.width - margin;
          }
        } else {
          left = barRect.left;
          top = barRect.bottom + margin;
          if (top + rect.height > window.innerHeight - 4) {
            top = barRect.top - rect.height - margin;
          }
        }

        left = Math.max(4, Math.min(left, window.innerWidth - rect.width - 4));
        top = Math.max(4, Math.min(top, window.innerHeight - rect.height - 4));
        pickerEl.style.left = left + 'px';
        pickerEl.style.top = top + 'px';
      }
    });

    bar.querySelector('.rotate').addEventListener('click', (e) => {
      e.stopPropagation();
      rotateToolbar();
    });

    bar.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation();
      activeColor = null;
      if (picker) picker.close();
      hideToolbar();
    });

    bar.querySelector('.settings').addEventListener('click', (e) => {
      e.stopPropagation();
      api.runtime.sendMessage({ type: 'open-options' });
    });

    const handle = bar.querySelector('.handle');
    handle.addEventListener('mousedown', (e) => startMoveDrag(e, host));

    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']
      .forEach((type) => bar.addEventListener(type, (e) => e.stopPropagation()));

    bar.addEventListener('mousemove', onBarMouseMove);
    bar.addEventListener('mouseleave', onBarMouseLeave);
    bar.addEventListener('pointerdown', onBarPointerDown);
    bar.addEventListener('wheel', onWheel, { passive: false });

    applyOrientation();
    renderStrip();
    updateToolbarActiveState();

    return host;
  }

  /* ===================== pagination ===================== */

  function lastLine() {
    const totalItems = settings.colors.length + 1; // +1 for the "+" button
    return Math.max(0, Math.ceil(totalItems / settings.perLine) - 1);
  }

  function pickDelta(e) {
    if (toolbarState.orientation === 'horizontal') {
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      return absX >= absY ? e.deltaX : e.deltaY;
    }
    return e.deltaY;
  }

  function onWheel(e) {
    if (e.ctrlKey) return;
    if (isDragging) return;
    let delta = wheelPixels(e, pickDelta(e));
    if (!delta) return;
    if (settings.scrollInvert && toolbarState.orientation === 'horizontal') {
      delta = -delta;
    }

    e.preventDefault();
    e.stopPropagation();

    wheelAccum += delta;
    clearTimeout(wheelResetTimer);
    wheelResetTimer = setTimeout(() => { wheelAccum = 0; }, 200);

    if (Math.abs(wheelAccum) < 40) return;
    const dir = Math.sign(wheelAccum);
    wheelAccum = 0;

    const max = lastLine();
    const next = Math.min(Math.max(0, toolbarState.lineIndex + dir), max);
    if (next !== toolbarState.lineIndex) {
      toolbarState.lineIndex = next;
      updateScroll();
      saveToolbarState();
    }
  }

  function updateScroll() {
    if (!stripEl) return;
    const max = lastLine();
    if (toolbarState.lineIndex > max) toolbarState.lineIndex = max;
    const offset = toolbarState.lineIndex * settings.perLine * SLOT;
    if (toolbarState.orientation === 'horizontal') {
      stripEl.style.transform = `translateX(-${offset}px)`;
    } else {
      stripEl.style.transform = `translateY(-${offset}px)`;
    }
  }

  /* ===================== rendering ===================== */

  function renderStrip() {
    if (!stripEl) return;
    stripEl.innerHTML = '';

    const totalItems = settings.colors.length + 1;
    const lines = Math.max(1, Math.ceil(totalItems / settings.perLine));
    const totalSlots = lines * settings.perLine;

    for (let i = 0; i < totalSlots; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';

      if (i === settings.colors.length) {
        // End of the colours: render the "+" button
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'add';
        addBtn.title = 'Add colour';
        addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5 V19 M5 12 H19"/></svg>`;
        
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (picker && picker.isOpen()) {
            picker.close();
          } else if (picker) {
            picker.open(pickNextPastel(), async (color) => {
              settings.colors.push(color);
              await saveSettings();
              toolbarState.lineIndex = lastLine();
              await saveToolbarState();
              renderStrip();
            }, 'Add colour');
          }
        });
        
        slot.appendChild(addBtn);
      } else if (i < settings.colors.length) {
        const color = settings.colors[i];
        const isEraser = color === ERASER;
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'swatch';
        sw.dataset.color = color;
        sw.dataset.index = String(i);
        sw.setAttribute('aria-pressed', String(color === activeColor));

        if (isEraser) {
          sw.classList.add('swatch-eraser');
          sw.innerHTML = ERASER_SVG;
          sw.title = 'Eraser';
        } else {
          sw.style.backgroundColor = color;
          sw.title = color;
        }

        attachSwatchInteraction(sw, i);

        sw.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isEraser) return;
          if (nonEraserCount() <= 1) return;
          if (!window.confirm(`Delete colour ${color}?`)) return;

          const liveIndex = settings.colors[i] === color
            ? i
            : settings.colors.indexOf(color);
          if (liveIndex === -1) return;
          settings.colors.splice(liveIndex, 1);
          if (activeColor && !settings.colors.includes(activeColor)) activeColor = null;
          saveSettings();
          toolbarState.lineIndex = Math.min(toolbarState.lineIndex, lastLine());
          saveToolbarState();
          renderStrip();
        });

        slot.appendChild(sw);
      }

      stripEl.appendChild(slot);
    }

    updateScroll();
    updateToolbarActiveState();
  }

  function updateToolbarActiveState() {
    if (!barEl) return;
    if (activeColor) {
      barEl.classList.add('active');
      const outlineColor = activeColor === ERASER ? '#888888' : activeColor;
      barEl.style.setProperty('--hl-active', outlineColor);
    } else {
      barEl.classList.remove('active');
      barEl.style.removeProperty('--hl-active');
    }
    if (stripEl) {
      // With duplicate colours, only mark the first matching swatch.
      let marked = false;
      stripEl.querySelectorAll('.swatch').forEach((el) => {
        const pressed = !marked && el.dataset.color === activeColor;
        if (pressed) marked = true;
        el.setAttribute('aria-pressed', String(pressed));
      });
    }
  }

  function applyOrientation() {
    if (!barEl) return;
    barEl.classList.toggle('vertical', toolbarState.orientation === 'vertical');
    barEl.style.setProperty('--per-line', String(settings.perLine));
    updateScroll();
  }

  async function rotateToolbar() {
    if (isDragging) return;
    if (picker) picker.close();
    toolbarState.orientation =
      toolbarState.orientation === 'horizontal' ? 'vertical' : 'horizontal';
    toolbarState.lineIndex = 0;
    await saveToolbarState();
    applyOrientation();
    if (toolbarHost) {
      const r = toolbarHost.getBoundingClientRect();
      setHostPosition(toolbarHost, r.left, r.top);
    }
  }

  /* ===================== pastel suggestion ===================== */

  function pickNextPastel() {
    const used = new Set(
      settings.colors
        .filter((c) => c && c !== ERASER)
        .map((c) => c.toLowerCase())
    );
    for (const c of PASTELS) {
      if (!used.has(c.toLowerCase())) return c;
    }
    return PASTELS[Math.floor(Math.random() * PASTELS.length)];
  }

  /* ===================== swatch interaction ===================== */

  function attachSwatchInteraction(el, startIndex) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      const startColor = settings.colors[startIndex];
      const startIsEraser = startColor === ERASER;
      let dragging = false;
      let ghost = null;
      let currentIndex = startIndex;
      let lastX = startX;
      let lastY = startY;

      const host = toolbarHost;
      try { host.setPointerCapture(pointerId); } catch {}

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (!dragging && Math.hypot(dx, dy) < 5) return;

        if (!dragging) {
          dragging = true;
          setDragging(true);
          ghost = document.createElement('div');
          const bg = startIsEraser ? '#f0f0f0' : startColor;
          const fg = startIsEraser ? '#555' : 'transparent';
          ghost.style.cssText = [
            'position:fixed',
            'width:20px', 'height:20px',
            'border-radius:50%',
            `background-color:${bg}`,
            `color:${fg}`,
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'pointer-events:none',
            'z-index:2147483647',
            'box-shadow:0 4px 12px rgba(0,0,0,.3)',
            'transform:translate(-50%,-50%)'
          ].join(';') + ';';
          if (startIsEraser) ghost.innerHTML = ERASER_SVG;
          document.body.appendChild(ghost);
        }

        ghost.style.left = ev.clientX + 'px';
        ghost.style.top = ev.clientY + 'px';
        lastX = ev.clientX;
        lastY = ev.clientY;

        // Only reorder live while the pointer is over the visible grid. When
        // the pointer leaves the viewport, the drop handler moves the swatch
        // to the adjacent row and paginates to it.
        if (isInsideViewport(ev.clientX, ev.clientY)) {
          const target = findSwatchUnder(ev.clientX, ev.clientY, currentIndex);
          if (target !== null && target !== currentIndex) {
            const [moved] = settings.colors.splice(currentIndex, 1);
            settings.colors.splice(target, 0, moved);
            currentIndex = target;
            renderStrip();
          }
        }
      };

      const onUp = async (ev) => {
        try { host.removeEventListener('pointermove', onMove); } catch {}
        try { host.removeEventListener('pointerup', onUp); } catch {}
        try { host.removeEventListener('pointercancel', onUp); } catch {}
        try { host.releasePointerCapture(pointerId); } catch {}
        if (ghost) ghost.remove();

        if (dragging) {
          // A pointerup (not pointercancel) outside the viewport means the
          // user dropped the swatch beyond the current page: move it to the
          // start of the next row (or the end of the previous one).
          const wasCancel = ev && ev.type === 'pointercancel';
          if (!wasCancel) {
            const x = ev && typeof ev.clientX === 'number' ? ev.clientX : lastX;
            const y = ev && typeof ev.clientY === 'number' ? ev.clientY : lastY;
            const dir = getOutsideDirection(x, y);

            if (dir !== 0) {
              const adjacentLine = toolbarState.lineIndex + dir;
              const maxLine = lastLine();

              if (adjacentLine >= 0 && adjacentLine <= maxLine) {
                const lineStart = adjacentLine * settings.perLine;
                // Dropping right/down → start of next line.
                // Dropping left/up  → end of previous line.
                const raw = dir > 0
                  ? lineStart
                  : Math.min(lineStart + settings.perLine - 1,
                             settings.colors.length - 1);
                const target = Math.max(0, Math.min(raw, settings.colors.length - 1));

                if (target !== currentIndex) {
                  const [moved] = settings.colors.splice(currentIndex, 1);
                  settings.colors.splice(target, 0, moved);
                }

                toolbarState.lineIndex = adjacentLine;
                renderStrip();
              }
            }
          }

          await saveSettings();
          setTimeout(() => setDragging(false), 0);
        } else {
          onSwatchClick(startColor);
        }
      };

      host.addEventListener('pointermove', onMove);
      host.addEventListener('pointerup', onUp);
      host.addEventListener('pointercancel', onUp);
    });
  }

  function findSwatchUnder(x, y, excludeIndex) {
    if (!stripEl) return null;

    // We check ALL swatches, even if they are currently hidden (clipped)
    // by the viewport. This allows the user to drag a colour past the edge
    // and drop it into a hidden row.
    const swatches = stripEl.querySelectorAll('.swatch');
    for (const sw of swatches) {
      const idx = Number(sw.dataset.index);
      if (idx === excludeIndex) continue;
      const r = sw.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
        return idx;
      }
    }
    return null;
  }

  // Whether (x, y) is over the visible part of the swatch strip.
  function isInsideViewport(x, y) {
    if (!stripEl || !stripEl.parentElement) return false;
    const vr = stripEl.parentElement.getBoundingClientRect();
    return x >= vr.left && x < vr.right && y >= vr.top && y < vr.bottom;
  }

  // 0 = inside viewport, -1 = before it, +1 = after it.
  // Only the primary axis matters (x for horizontal, y for vertical).
  function getOutsideDirection(x, y) {
    if (!stripEl || !stripEl.parentElement) return 0;
    const vr = stripEl.parentElement.getBoundingClientRect();
    if (toolbarState.orientation === 'vertical') {
      if (y < vr.top) return -1;
      if (y >= vr.bottom) return 1;
    } else {
      if (x < vr.left) return -1;
      if (x >= vr.right) return 1;
    }
    return 0;
  }

  function onSwatchClick(color) {
    activeColor = (activeColor === color) ? null : color;
    updateToolbarActiveState();
    if (activeColor) {
      const info = getSelectionInfo();
      if (info) highlightSelection(activeColor);
    }
  }

  /* ===================== resize drag ===================== */

  function inResizeZone(e) {
    if (!barEl) return false;
    if (e.target !== barEl) return false;
    const rect = barEl.getBoundingClientRect();
    if (toolbarState.orientation === 'vertical') {
      return e.clientY >= rect.bottom - 8;
    }
    return e.clientX >= rect.right - 8;
  }

  function onBarMouseMove(e) {
    if (!barEl || isDragging) return;
    if (inResizeZone(e)) {
      barEl.style.cursor = toolbarState.orientation === 'vertical'
        ? 'ns-resize'
        : 'ew-resize';
    } else {
      barEl.style.cursor = '';
    }
  }

  function onBarMouseLeave() {
    if (!barEl || isDragging) return;
    barEl.style.cursor = '';
  }

  function onBarPointerDown(e) {
    if (e.button !== 0) return;
    if (!inResizeZone(e)) return;
    e.preventDefault();
    e.stopPropagation();
    startResizeDrag(e);
  }

  function startResizeDrag(event) {
    if (picker) picker.close();
    setDragging(true);
    const isVertical = toolbarState.orientation === 'vertical';
    barEl.style.cursor = isVertical ? 'ns-resize' : 'ew-resize';

    const startX = event.clientX;
    const startY = event.clientY;
    const startPerLine = settings.perLine;

    const onMove = (e) => {
      const delta = isVertical ? (e.clientY - startY) : (e.clientX - startX);
      const steps = Math.round(delta / SLOT);
      const next = Math.min(5, Math.max(3, startPerLine + steps));
      if (next === settings.perLine) return;

      settings.perLine = next;
      barEl.style.setProperty('--per-line', String(next));

      const r = toolbarHost.getBoundingClientRect();
      setHostPosition(toolbarHost, r.left, r.top);
    };

    const onUp = async () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);

      barEl.style.cursor = '';

      const pixelOffset = toolbarState.lineIndex * startPerLine * SLOT;
      toolbarState.lineIndex = Math.min(
        Math.round(pixelOffset / (settings.perLine * SLOT)),
        lastLine()
      );
      updateScroll();

      await saveSettings();

      const r = toolbarHost.getBoundingClientRect();
      toolbarState.left = r.left;
      toolbarState.top = r.top;
      await saveToolbarState();

      setTimeout(() => setDragging(false), 0);
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  }

  /* ===================== move drag ===================== */

  function setHostPosition(host, left, top) {
    const w = host.offsetWidth || 0;
    const h = host.offsetHeight || 0;
    const maxLeft = Math.max(4, window.innerWidth - w - 4);
    const maxTop = Math.max(4, window.innerHeight - h - 4);
    const clampedLeft = Math.min(Math.max(4, left), maxLeft);
    const clampedTop = Math.min(Math.max(4, top), maxTop);
    host.style.left = clampedLeft + 'px';
    host.style.top = clampedTop + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  }

  function startMoveDrag(event, host) {
    event.preventDefault();
    event.stopPropagation();

    if (picker) picker.close();
    setDragging(true);

    const rect = host.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;

    const onMove = (e) => {
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      setHostPosition(host, startLeft + dx, startTop + dy);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      const r = host.getBoundingClientRect();
      toolbarState.left = r.left;
      toolbarState.top = r.top;
      saveToolbarState();
      setTimeout(() => setDragging(false), 0);
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

  function onWindowResize() {
    if (!toolbarHost) return;
    const r = toolbarHost.getBoundingClientRect();
    setHostPosition(toolbarHost, r.left, r.top);
  }

  /* ===================== show / hide ===================== */

  async function showToolbar() {
    if (!toolbarHost) {
      toolbarHost = buildToolbar();
      document.documentElement.appendChild(toolbarHost);

      if (toolbarState.left == null || toolbarState.top == null) {
        const r = toolbarHost.getBoundingClientRect();
        setHostPosition(toolbarHost, r.left, r.top);
        toolbarState.left = r.left;
        toolbarState.top = r.top;
      } else {
        setHostPosition(toolbarHost, toolbarState.left, toolbarState.top);
      }

      window.addEventListener('resize', onWindowResize);
    }
    toolbarState.visible = true;
    await saveToolbarState();
    return { ok: true, visible: true };
  }

  async function hideToolbar() {
    activeColor = null;
    if (toolbarHost) {
      window.removeEventListener('resize', onWindowResize);
      if (picker) { picker.destroy(); picker = null; }
      toolbarHost.remove();
      toolbarHost = null;
      barEl = null;
      stripEl = null;
    }
    toolbarState.visible = false;
    await saveToolbarState();
    return { ok: true, visible: false };
  }

  /* ===================== messaging ===================== */

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      switch (message && message.type) {
        case 'show-toolbar':
          sendResponse(await showToolbar());
          break;
        case 'hide-toolbar':
          sendResponse(await hideToolbar());
          break;
        case 'toggle-toolbar':
          sendResponse(toolbarHost ? await hideToolbar() : await showToolbar());
          break;
        case 'highlight-selection': {
          const colour =
            message.color ||
            (activeColor && activeColor !== ERASER ? activeColor : null) ||
            firstColour();
          sendResponse(await highlightSelection(colour));
          break;
        }
        case 'clear-all': {
          const hasMarks = document.querySelector('mark.' + HL_CLASS) !== null;
          const hasStored = (await loadRecords()).length > 0;
          if (hasMarks || hasStored) {
            const sure = window.confirm(
              'Remove all highlights on this page?\n\nThis cannot be undone.'
            );
            if (!sure) {
              sendResponse({ ok: false, reason: 'cancelled' });
              break;
            }
          }
          sendResponse(await clearAll());
          break;
        }
        default:
          sendResponse({ ok: false, reason: 'unknown-message' });
      }
    })().catch((err) => {
      console.warn('[Highlighty]', err);
      try { sendResponse({ ok: false, reason: 'error' }); } catch { /* already answered */ }
    });
    return true;
  });

  /* ===================== react to settings changes ===================== */

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[SETTINGS_KEY]) return;
    settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);

    if (activeColor && !settings.colors.includes(activeColor)) activeColor = null;

    if (barEl) {
      barEl.style.setProperty('--per-line', String(settings.perLine));
      renderStrip();
    }
  });

  /* ===================== init ===================== */

  (async () => {
    settings = await loadSettings();
    toolbarState = await loadToolbarState();
    if (toolbarState.visible) await showToolbar();

    try {
      await migrateLegacyKeys();
    } catch (err) {
      console.warn('[Highlighty] key migration failed, will retry next load', err);
    }

    await restore();
    setTimeout(restore, 400);
    setTimeout(restore, 1200);
    setTimeout(restore, 3000);
  })().catch((err) => console.warn('[Highlighty] init failed', err));
})();