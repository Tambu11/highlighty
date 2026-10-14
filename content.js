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
    scrollInvert: false
  };

  const PASTELS = [
    '#fff59d', '#a5d6a7', '#90caf9', '#f48fb1',
    '#ffcc80', '#ce93d8', '#80cbc4', '#bcaaa4'
  ];

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TITLE', 'IFRAME', 'CANVAS', 'SVG', 'HEAD'
  ]);

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

  /**
   * After a mark is in the DOM, check whether the page's text colour is
   * readable against the mark's background. If not, force black or white
   * depending on the background's luminance.
   *
   * Uses the rendered colours of the page rather than OS theme detection,
   * so it works on dark sites without a prefers-color-scheme declaration,
   * and inside browsers that force-dark via CSS (e.g. Brave).
   */
  function adjustMarkTextColor(mark) {
    if (!mark.parentNode) return;
    try {
      const cs = getComputedStyle(mark);
      const fg = parseCssColor(cs.color);
      const bg = parseCssColor(cs.backgroundColor);
      if (!fg || !bg) return;

      const lum = (c) =>
        (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
      const fgLum = lum(fg);
      const bgLum = lum(bg);
      const L1 = Math.max(fgLum, bgLum);
      const L2 = Math.min(fgLum, bgLum);
      const ratio = (L1 + 0.05) / (L2 + 0.05);

      if (ratio < 4.5) {
        // Descendants with their own opaque background (e.g. <code>, <pre>)
        // paint over the mark's background. Their text sits on their own
        // colour, not ours, so forcing the contrast colour onto them would
        // make them unreadable. Snapshot their natural colour now, then
        // restore it after the mark's colour override propagates.
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
          bgLum > 0.5 ? '#000000' : '#ffffff',
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

  function pageKey() {
    return STORAGE_PREFIX + location.origin + location.pathname + location.search;
  }

  async function loadRecords() {
    const data = await api.storage.local.get(pageKey());
    return data[pageKey()] || [];
  }

  async function saveRecords(records) {
    await api.storage.local.set({ [pageKey()]: records });
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
    const loaded = data[SETTINGS_KEY] || {};

    let colors = Array.isArray(loaded.colors) && loaded.colors.length
      ? loaded.colors.slice()
      : DEFAULT_SETTINGS.colors.slice();

    if (!colors.includes(ERASER)) colors.unshift(ERASER);

    return {
      colors,
      perLine: [3, 4, 5].includes(loaded.perLine)
        ? loaded.perLine
        : DEFAULT_SETTINGS.perLine,
      deselect: Object.assign({}, DEFAULT_SETTINGS.deselect, loaded.deselect || {}),
      scrollInvert: !!loaded.scrollInvert
    };
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
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function buildIndex(nodes) {
    let text = '';
    const spans = [];
    for (const node of nodes) {
      const start = text.length;
      text += node.nodeValue;
      spans.push({ node, start, end: text.length });
    }
    return { text, spans };
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
    // normalize() merges adjacent text nodes and drops empty ones.
    // Safe here because all range work for this operation is done.
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

  function rebuildRecords() {
    const { text: full, spans } = buildIndex(collectTextNodes(document.body));
    const records = [];

    document.querySelectorAll('mark.' + HL_CLASS).forEach((mark) => {
      const range = document.createRange();
      range.selectNodeContents(mark);
      const text = range.toString();
      if (!text) return;

      let startSpan = null;
      let startOffsetInSpan = 0;

      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        startSpan = spans.find((s) => s.node === range.startContainer);
        startOffsetInSpan = range.startOffset;
      } else {
        const innerText = collectTextNodes(mark)[0];
        if (innerText) {
          startSpan = spans.find((s) => s.node === innerText);
        }
      }

      if (!startSpan) return;
      const startOffset = startSpan.start + startOffsetInSpan;

      let occurrence = 0;
      let idx = full.indexOf(text);
      while (idx !== -1 && idx < startOffset) {
        occurrence++;
        idx = full.indexOf(text, idx + 1);
      }

      records.push({
        id: mark.dataset.hlId,
        text,
        occurrence,
        color: getMarkColor(mark),
        createdAt: Date.now()
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

  /**
   * Unwrap any mark whose visible content is entirely whitespace.
   * Runs after absorbWhitespaceMarks and mergeAdjacentMarks have had
   * their chance — anything still whitespace-only is an orphan that
   * would render as a stray highlight and shouldn't be kept.
   */
  function removeWhitespaceMarks() {
    const marks = Array.from(document.querySelectorAll('mark.' + HL_CLASS));
    for (const mark of marks) {
      if (!mark.parentNode) continue;
      if ((mark.textContent || '').trim() !== '') continue;
      unwrapMark(mark);
    }
  }

  /* ===================== restore ===================== */

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

    const jobs = [];
    for (const record of remaining) {
      const idx = findOccurrence(text, record.text, record.occurrence || 0);
      if (idx === -1) continue;
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

  // Resolve a Range start point to a concrete text node + offset inside it.
  // Triple-click paragraph selections yield element containers, whose
  // offsets are child indices rather than character indices.
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

    const { text: full, spans } = buildIndex(collectTextNodes(document.body));

    const start = resolveStartPoint(range.startContainer, range.startOffset);
    const end = resolveEndPoint(range.endContainer, range.endOffset);
    if (!start || !end) return null;

    const startSpan = spans.find((s) => s.node === start.node);
    const endSpan = spans.find((s) => s.node === end.node);
    if (!startSpan || !endSpan) return null;

    const startOffset = startSpan.start + start.offset;
    const endOffset = endSpan.start + end.offset;

    if (endOffset <= startOffset) return null;

    return { text, startOffset, endOffset };
  }

  function selectionRangeFromOffsets(startOffset, endOffset) {
    const { spans } = buildIndex(collectTextNodes(document.body));
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

  /**
   * Given a selection [selStart, selEnd] in flattened-text offsets, return
   * one sub-range per block that the selection intersects. Each sub-range
   * is in the same flattened-text coordinate system, so the existing
   * helpers (selectionRangeFromOffsets, splitMarkBySelection, …) consume
   * them unchanged.
   *
   * Whitespace-only ranges are skipped: a <mark> containing just spaces
   * between block elements (e.g. between two <li>s) is invalid markup
   * and gets rendered as a line box, adding vertical space.
   */
  function computeRanges(selStart, selEnd) {
    const { text, spans } = buildIndex(collectTextNodes(document.body));
    const ranges = [];

    const selSpans = spans.filter(
      (s) => s.end > selStart && s.start < selEnd
    );
    if (!selSpans.length) return ranges;

    // If the whole selection sits inside a single code block, the user is
    // deliberately targeting the code. Don't exclude it in that case.
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
      // Skip text nodes inside a code-like element with its own background,
      // unless the whole selection is inside one code block. This keeps
      // the code's own background and text color intact — the code simply
      // isn't part of the highlight.
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

    // Whole mark inside the selection → just unwrap.
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

    // Extract right first — that keeps the left offsets valid.
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

    // Unwrap the middle — the original mark contains only the intersection.
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);

    let rightMark = null;
    if (rightFrag && rightFrag.childNodes.length) {
      rightMark = makeMark(color);
      rightMark.appendChild(rightFrag);
      parent.insertBefore(rightMark, ref);
    }

    try { parent.normalize(); } catch {}

    // The slices were just recreated; their contrast colour needs to be
    // reapplied. Without this, a slice in dark mode reverts to white text
    // until a page reload re-runs adjustMarkTextColor via wrapRange.
    if (leftMark) adjustMarkTextColor(leftMark);
    if (rightMark) adjustMarkTextColor(rightMark);

    return { leftMark, rightMark };
  }

  async function highlightSelection(color) {
    if (!color) color = firstColour();

    const info = getSelectionInfo();
    if (!info) return { ok: false, reason: 'no-selection' };

    const { startOffset, endOffset } = info;

    // Split the selection into per-block sub-ranges. A cross-block
    // selection wrapped as a single <mark> would clone partial block
    // elements (e.g. <p>) inside the mark, which the browser renders as
    // broken layout. By contrast, each per-block sub-range stays inside
    // one block and wraps cleanly.
    const ranges = computeRanges(startOffset, endOffset);
    if (!ranges.length) return { ok: false, reason: 'no-ranges' };

    // Eraser: bail out if nothing in the selection is highlighted.
    if (color === ERASER) {
      let anyIntersecting = false;
      for (const r of ranges) {
        const selRange = selectionRangeFromOffsets(r.start, r.end);
        if (!selRange) continue;
        if (findIntersectingMarks(selRange).length) {
          anyIntersecting = true;
          break;
        }
      }
      if (!anyIntersecting) return { ok: false, reason: 'nothing-to-erase' };
    }

    for (const r of ranges) {
      // Split any existing marks intersecting this sub-range.
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

      // Wrap this sub-range in its own new mark.
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

        // Insert manually rather than via Range.insertNode. Chromium's
        // insertNode can leave the document's internal range bookkeeping
        // corrupted, which shows up later as broken text layout on
        // subsequent selections.
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

    // Compact before saving.
    absorbWhitespaceMarks();
    mergeAdjacentMarks();
    removeWhitespaceMarks();
    const records = rebuildRecords();
    await saveRecords(records);

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
    if (!activeColor) return;
    if (isDragging) return;
    if (event.detail >= 3) return; // triple-click paragraph selections

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

  // Any wheel event that fires while a drag is in progress is suppressed,
  // regardless of what element it lands on. This is the belt-and-braces
  // counterpart to the `isDragging` guard inside onWheel.
  window.addEventListener('wheel', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true, passive: false });

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

    .handle, .rotate, .close {
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
    .handle:hover, .rotate:hover, .close:hover {
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
      .handle:hover, .rotate:hover, .close:hover {
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
      <button class="add" type="button" title="Add colour" aria-label="Add colour">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5 V19 M5 12 H19"/>
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

    bar.querySelector('.add').addEventListener('click', (e) => {
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
    return Math.max(0, Math.ceil(settings.colors.length / settings.perLine) - 1);
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
    // A trackpad gesture can fire wheel events while the user is dragging
    // the resize edge or the move handle. Ignore them so the drag doesn't
    // also page through the swatches.
    if (isDragging) return;
    let delta = pickDelta(e);
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

    const lines = Math.max(1, Math.ceil(settings.colors.length / settings.perLine));
    const totalSlots = lines * settings.perLine;

    for (let i = 0; i < totalSlots; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';

      const color = settings.colors[i];
      if (color) {
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

          const liveIndex = settings.colors.indexOf(color);
          if (liveIndex === -1) return;
          settings.colors.splice(liveIndex, 1);
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
      stripEl.querySelectorAll('.swatch').forEach((el) => {
        el.setAttribute('aria-pressed', String(el.dataset.color === activeColor));
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

      const host = toolbarHost;
      try { host.setPointerCapture(pointerId); } catch {}

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (!dragging && Math.hypot(dx, dy) < 5) return;

        if (!dragging) {
          dragging = true;
          isDragging = true;
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

        const target = findSwatchUnder(ev.clientX, ev.clientY, currentIndex);
        if (target !== null && target !== currentIndex) {
          const [moved] = settings.colors.splice(currentIndex, 1);
          settings.colors.splice(target, 0, moved);
          currentIndex = target;
          renderStrip();
        }
      };

      const onUp = async () => {
        try { host.removeEventListener('pointermove', onMove); } catch {}
        try { host.removeEventListener('pointerup', onUp); } catch {}
        try { host.removeEventListener('pointercancel', onUp); } catch {}
        try { host.releasePointerCapture(pointerId); } catch {}
        if (ghost) ghost.remove();

        if (dragging) {
          await saveSettings();
          setTimeout(() => { isDragging = false; }, 0);
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
    isDragging = true;
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
      // Don't call updateScroll here — the strip stays at its current
      // transform during the drag, so the visible swatches don't jump
      // around as the viewport widens/narrows. We snap on release.

      const r = toolbarHost.getBoundingClientRect();
      setHostPosition(toolbarHost, r.left, r.top);
    };

    const onUp = async () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);

      barEl.style.cursor = '';

      // Snap the strip to the nearest line boundary at the new perLine,
      // keeping the visible content roughly in place.
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

      setTimeout(() => { isDragging = false; }, 0);
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
    isDragging = true;

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
      setTimeout(() => { isDragging = false; }, 0);
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
        case 'clear-all':
          sendResponse(await clearAll());
          break;
        default:
          sendResponse({ ok: false, reason: 'unknown-message' });
      }
    })();
    return true;
  });

  /* ===================== react to settings changes ===================== */

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[SETTINGS_KEY]) return;
    const loaded = changes[SETTINGS_KEY].newValue || {};
    let colors = Array.isArray(loaded.colors) && loaded.colors.length
      ? loaded.colors.slice()
      : DEFAULT_SETTINGS.colors.slice();
    if (!colors.includes(ERASER)) colors.unshift(ERASER);

    settings = {
      colors,
      perLine: [3, 4, 5].includes(loaded.perLine)
        ? loaded.perLine
        : DEFAULT_SETTINGS.perLine,
      deselect: Object.assign({}, DEFAULT_SETTINGS.deselect, loaded.deselect || {}),
      scrollInvert: !!loaded.scrollInvert
    };

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

    await restore();
    setTimeout(restore, 400);
    setTimeout(restore, 1200);
    setTimeout(restore, 3000);
  })();
})();