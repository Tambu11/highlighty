const api = typeof browser !== 'undefined' ? browser : chrome;

const SETTINGS_KEY = 'highlighty:settings';
const ERASER = '__eraser__';
const ERASER_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M16.24 3.56l4.95 4.94c.78.79.78 2.05 0 2.84L12 20.53a4.008 4.008 0 0 1-5.66 0' +
  'L2.81 17c-.78-.79-.78-2.05 0-2.84l10.6-10.6c.79-.78 2.05-.78 2.83 0zM4.22 15.58l3.54 3.53' +
  'c.78.79 2.04.79 2.83 0l3.53-3.53-4.95-4.95-4.95 4.95z"/></svg>';

const DEFAULT_PALETTE = [
  '#fff176', '#ffe082', '#ffcc80', '#ffab91',
  '#ef9a9a', '#f48fb1', '#ce93d8', '#b39ddb',
  '#9fa8da', '#90caf9', '#81d4fa', '#80deea',
  '#80cbc4', '#a5d6a7', '#c5e1a5', '#e6ee9c'
];

const DEFAULT_SETTINGS = {
  colors: [ERASER, ...DEFAULT_PALETTE],
  perLine: 4,
  deselect: {
    escape: true,
    middleClick: false,
    rightClick: false
  },
  scrollInvert: false,
  wordSnapping: true
};

let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let dragPayload = null;

/* ===================== storage ===================== */

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Validates whatever came out of storage (same rules as content.js).
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

async function load() {
  const data = await api.storage.sync.get(SETTINGS_KEY);
  Object.assign(settings, sanitizeSettings(data[SETTINGS_KEY]));
}

async function save() {
  await api.storage.sync.set({ [SETTINGS_KEY]: settings });
}

function nonEraserCount() {
  return settings.colors.filter((c) => c !== ERASER).length;
}

/* ===================== picker ===================== */

const picker = window.HighlightyPicker.createPicker(document.body, {
  useBackdrop: true,
  centered: true
});

/* ===================== per-line ===================== */

function renderPerLine() {
  document.querySelectorAll('#perLine button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.value) === settings.perLine));
  });
}

document.querySelectorAll('#perLine button').forEach((b) => {
  b.addEventListener('click', async () => {
    settings.perLine = Number(b.dataset.value);
    await save();
    renderPerLine();
  });
});

/* ===================== palette grid ===================== */

const gridEl = document.getElementById('grid');

// Firefox will not start a drag from (or inside) a <button>. Drag sources are
// therefore plain elements that behave like buttons for keyboard users.
function asButton(el) {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.click();
    }
  });
}

function clearOver() {
  gridEl.querySelectorAll('.cell.over').forEach((c) => c.classList.remove('over'));
}

function renderGrid() {
  gridEl.innerHTML = '';

  settings.colors.forEach((color, i) => {
    const isEraser = color === ERASER;
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.draggable = true;
    cell.dataset.index = String(i);

    const sw = document.createElement('div');
    sw.className = 'swatch';

    if (isEraser) {
      sw.classList.add('swatch-eraser');
      sw.innerHTML = ERASER_SVG;
      sw.title = 'Eraser — drag to move';
    } else {
      sw.style.backgroundColor = color;
      sw.title = 'Change colour';
      asButton(sw);
      sw.addEventListener('click', (e) => {
        e.preventDefault();
        picker.open(color, async (newColor) => {
          // Prefer the swatch's own index so duplicate colours edit the right one.
          const liveIndex = settings.colors[i] === color
            ? i
            : settings.colors.indexOf(color);
          if (liveIndex === -1) return;
          settings.colors[liveIndex] = newColor;
          await save();
          renderGrid();
        }, 'Edit colour');
      });
    }
    cell.appendChild(sw);

    if (!isEraser && nonEraserCount() > 1) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.title = 'Remove';
      rm.textContent = '×';
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const liveIndex = settings.colors[i] === color
          ? i
          : settings.colors.indexOf(color);
        if (liveIndex === -1) return;
        settings.colors.splice(liveIndex, 1);
        await save();
        renderGrid();
      });
      cell.appendChild(rm);
    }

    cell.addEventListener('dragstart', (e) => {
      dragPayload = { type: 'reorder', index: i };
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
      cell.classList.add('dragging');
    });
    cell.addEventListener('dragend', () => {
      dragPayload = null;
      cell.classList.remove('dragging');
      clearOver();
    });

    cell.addEventListener('dragover', (e) => {
      if (!dragPayload || dragPayload.type !== 'reorder') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearOver();
      cell.classList.add('over');
    });
    cell.addEventListener('dragleave', (e) => {
      if (!cell.contains(e.relatedTarget)) cell.classList.remove('over');
    });
    cell.addEventListener('drop', async (e) => {
      if (!dragPayload || dragPayload.type !== 'reorder') return;
      e.preventDefault();
      e.stopPropagation();
      cell.classList.remove('over');

      const from = dragPayload.index;
      const to = i;
      if (from === to) return;
      const [moved] = settings.colors.splice(from, 1);
      settings.colors.splice(to, 0, moved);
      dragPayload = null;
      await save();
      renderGrid();
    });

    gridEl.appendChild(cell);
  });
}

gridEl.addEventListener('dragover', (e) => {
  if (!dragPayload || dragPayload.type !== 'default') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';

  const cell = e.target.closest('.cell');
  clearOver();
  if (cell) cell.classList.add('over');
});

gridEl.addEventListener('dragleave', (e) => {
  if (!gridEl.contains(e.relatedTarget)) clearOver();
});

gridEl.addEventListener('drop', async (e) => {
  if (!dragPayload || dragPayload.type !== 'default') return;
  e.preventDefault();

  const color = dragPayload.color;
  const cell = e.target.closest('.cell');
  const index = cell ? Number(cell.dataset.index) : settings.colors.length;

  dragPayload = null;
  clearOver();

  settings.colors.splice(index, 0, color);
  await save();
  renderGrid();
});

/* ===================== defaults row ===================== */

const defaultsEl = document.getElementById('defaults');

function renderDefaults() {
  defaultsEl.innerHTML = '';

  for (const color of DEFAULT_PALETTE) {
    const sw = document.createElement('div');
    sw.className = 'default-swatch';
    asButton(sw);
    sw.style.backgroundColor = color;
    sw.title = `${color} — drag into your palette, or click to add`;
    sw.draggable = true;

    sw.addEventListener('dragstart', (e) => {
      dragPayload = { type: 'default', color };
      e.dataTransfer.setData('text/plain', color);
      e.dataTransfer.effectAllowed = 'copy';
      sw.classList.add('dragging');
    });
    sw.addEventListener('dragend', () => {
      dragPayload = null;
      sw.classList.remove('dragging');
      clearOver();
    });

    sw.addEventListener('click', async () => {
      settings.colors.push(color);
      await save();
      renderGrid();
    });

    defaultsEl.appendChild(sw);
  }
}

/* ===================== deselect + scroll options ===================== */

const deselectEscapeEl = document.getElementById('deselectEscape');
const deselectMiddleEl = document.getElementById('deselectMiddle');
const deselectRightEl = document.getElementById('deselectRight');
const scrollInvertEl = document.getElementById('scrollInvert');
const wordSnappingEl = document.getElementById('wordSnapping');

function renderDeselect() {
  deselectEscapeEl.checked = !!settings.deselect.escape;
  deselectMiddleEl.checked = !!settings.deselect.middleClick;
  deselectRightEl.checked = !!settings.deselect.rightClick;
  scrollInvertEl.checked = !!settings.scrollInvert;
  wordSnappingEl.checked = !!settings.wordSnapping;
}

deselectEscapeEl.addEventListener('change', async () => {
  settings.deselect.escape = deselectEscapeEl.checked;
  await save();
});
deselectMiddleEl.addEventListener('change', async () => {
  settings.deselect.middleClick = deselectMiddleEl.checked;
  await save();
});
deselectRightEl.addEventListener('change', async () => {
  settings.deselect.rightClick = deselectRightEl.checked;
  await save();
});
scrollInvertEl.addEventListener('change', async () => {
  settings.scrollInvert = scrollInvertEl.checked;
  await save();
});
wordSnappingEl.addEventListener('change', async () => {
  settings.wordSnapping = wordSnappingEl.checked;
  await save();
});

/* ===================== add button ===================== */

document.getElementById('add').addEventListener('click', () => {
  picker.open('#ffe082', async (color) => {
    settings.colors.push(color);
    await save();
    renderGrid();
  }, 'Add colour');
});

/* ===================== live sync ===================== */

// The toolbar (in any tab) writes the same settings blob. Pick up its changes
// so this page never saves a stale copy over them.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[SETTINGS_KEY]) return;
  const next = sanitizeSettings(changes[SETTINGS_KEY].newValue);
  if (JSON.stringify(next) === JSON.stringify(settings)) return; // our own save
  Object.assign(settings, next);
  renderPerLine();
  renderGrid();
  renderDeselect();
});

/* ===================== init ===================== */

(async () => {
  await load();
  renderPerLine();
  renderGrid();
  renderDefaults();
  renderDeselect();
})();