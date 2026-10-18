/* Highlighty — shared colour picker module
 * Exposes window.HighlightyPicker.createPicker(mount, options).
 * Loaded before content.js (content script) and before options.js (options page).
 */
(() => {
  const PICKER_CSS = `
    .hlp-picker {
      position: fixed;
      display: none;
      width: 220px;
      padding: 10px;
      background: #ffffff;
      color: #222;
      border: 1px solid rgba(0,0,0,0.15);
      border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.1);
      font: 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      z-index: 2147483647;
      box-sizing: border-box;
    }
    .hlp-picker.open { display: block; }
    .hlp-picker.centered {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      max-width: calc(100vw - 32px);
      box-shadow: 0 12px 40px rgba(0,0,0,0.30), 0 2px 6px rgba(0,0,0,0.12);
    }

    .hlp-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.28);
      display: none;
      z-index: 2147483646;
    }
    .hlp-backdrop.open { display: block; }

    .hlp-sv {
      position: relative;
      width: 100%;
      height: 130px;
      border-radius: 6px;
      overflow: hidden;
      cursor: crosshair;
      touch-action: none;
    }
    .hlp-sv-base,
    .hlp-sv-sat,
    .hlp-sv-val {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .hlp-sv-base { background: #ff0000; }
    .hlp-sv-sat { background: linear-gradient(to right, #fff, transparent); }
    .hlp-sv-val { background: linear-gradient(to bottom, transparent, #000); }
    .hlp-sv-dot {
      position: absolute;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid #fff;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.3);
      transform: translate(-50%, -50%);
      pointer-events: none;
    }

    .hlp-hue {
      position: relative;
      width: 100%;
      height: 12px;
      margin-top: 10px;
      border-radius: 6px;
      background: linear-gradient(to right,
        #ff0000 0%, #ffff00 16.66%, #00ff00 33.33%, #00ffff 50%,
        #0000ff 66.66%, #ff00ff 83.33%, #ff0000 100%);
      cursor: pointer;
      touch-action: none;
    }
    .hlp-hue-handle {
      position: absolute;
      top: 50%;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #ff0000;
      border: 2px solid #fff;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.3);
      transform: translate(-50%, -50%);
      pointer-events: none;
    }

    .hlp-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(0,0,0,0.08);
    }
    .hlp-preview {
      display: block;
      width: 26px;
      height: 26px;
      border-radius: 5px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15);
      flex-shrink: 0;
      background: #fff176;
    }
    .hlp-hex {
      flex: 1;
      min-width: 0;
      padding: 5px 8px;
      border: 1px solid rgba(0,0,0,0.15);
      border-radius: 5px;
      font: inherit;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 12px;
      background: #ffffff;
      color: inherit;
      text-align: center;
      box-sizing: border-box;
    }

    .hlp-actions {
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }
    .hlp-add, .hlp-cancel {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid rgba(0,0,0,0.15);
      background: #f5f5f5;
      color: inherit;
      border-radius: 5px;
      cursor: pointer;
      font: inherit;
    }
    .hlp-add {
      background: #ffe97a;
      border-color: #e6d168;
      font-weight: 600;
    }
    .hlp-add:hover { background: #ffe25a; }
    .hlp-cancel:hover { background: #ebebeb; }

    @media (prefers-color-scheme: dark) {
      .hlp-picker {
        background: #2a2a2a;
        color: #eee;
        border-color: rgba(255,255,255,0.15);
        box-shadow: 0 6px 24px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3);
      }
      .hlp-picker.centered {
        box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 2px 6px rgba(0,0,0,0.4);
      }
      .hlp-footer { border-top-color: rgba(255,255,255,0.10); }
      .hlp-hex {
        background: #1e1e1e;
        border-color: rgba(255,255,255,0.18);
        color: #eee;
      }
      .hlp-add { background: #a89433; border-color: #8d7c2b; color: #fff; }
      .hlp-add:hover { background: #b8a23c; }
      .hlp-cancel { background: #3a3a3a; border-color: rgba(255,255,255,0.15); }
      .hlp-cancel:hover { background: #464646; }
    }
  `;

  /* ---------- colour math ---------- */

  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b]
      .map((n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    let s = m[1];
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16)
    };
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return { h, s, v: max };
  }

  /* ---------- factory ---------- */

  function createPicker(mount, options = {}) {
    if (!mount) throw new Error('[HighlightyPicker] mount is required');

    const useBackdrop = !!options.useBackdrop;
    const centered = !!options.centered;
    const positionAfter = typeof options.positionAfter === 'function'
      ? options.positionAfter
      : null;

    // Inject our styles into the mount exactly once. If the mount is a
    // shadow root, the CSS is scoped to it. If it's document.body, the
    // CSS applies globally — but we only ever create one picker there.
    const styleEl = document.createElement('style');
    styleEl.textContent = PICKER_CSS;
    mount.appendChild(styleEl);

    // ---- DOM ----

    let backdropEl = null;
    if (useBackdrop) {
      backdropEl = document.createElement('div');
      backdropEl.className = 'hlp-backdrop';
      mount.appendChild(backdropEl);
    }

    const el = document.createElement('div');
    el.className = 'hlp-picker' + (centered ? ' centered' : '');
    el.innerHTML = `
      <div class="hlp-sv">
        <div class="hlp-sv-base"></div>
        <div class="hlp-sv-sat"></div>
        <div class="hlp-sv-val"></div>
        <div class="hlp-sv-dot"></div>
      </div>
      <div class="hlp-hue">
        <div class="hlp-hue-handle"></div>
      </div>
      <div class="hlp-footer">
        <span class="hlp-preview" aria-hidden="true"></span>
        <input class="hlp-hex" type="text" spellcheck="false" maxlength="7"
               aria-label="Hex colour" placeholder="#fff176">
      </div>
      <div class="hlp-actions">
        <button class="hlp-cancel" type="button">Cancel</button>
        <button class="hlp-add" type="button">Add</button>
      </div>
    `;
    mount.appendChild(el);

    // Keystrokes inside the picker (hex field) must not reach the host page,
    // where shadow-DOM retargeting would make them look like body key presses
    // and trigger site shortcuts. Escape is handled by a document-level
    // capture listener, so it still works.
    ['keydown', 'keyup', 'keypress'].forEach((type) =>
      el.addEventListener(type, (e) => e.stopPropagation())
    );

    const svEl = el.querySelector('.hlp-sv');
    const svBaseEl = el.querySelector('.hlp-sv-base');
    const svDotEl = el.querySelector('.hlp-sv-dot');
    const hueEl = el.querySelector('.hlp-hue');
    const hueHandleEl = el.querySelector('.hlp-hue-handle');
    const previewEl = el.querySelector('.hlp-preview');
    const hexEl = el.querySelector('.hlp-hex');
    const addBtn = el.querySelector('.hlp-add');
    const cancelBtn = el.querySelector('.hlp-cancel');

    let hsv = { h: 50, s: 0.4, v: 1 };
    let onCommitFn = null;
    let onCancelFn = null;

    // ---- render ----

    function render(skipHexInput) {
      const { h, s, v } = hsv;
      svBaseEl.style.background = `hsl(${h}, 100%, 50%)`;

      const svRect = svEl.getBoundingClientRect();
      if (svRect.width && svRect.height) {
        svDotEl.style.left = (s * svRect.width) + 'px';
        svDotEl.style.top = ((1 - v) * svRect.height) + 'px';
      }

      const hueRect = hueEl.getBoundingClientRect();
      if (hueRect.width) {
        hueHandleEl.style.left = ((h / 360) * hueRect.width) + 'px';
      }
      hueHandleEl.style.background = `hsl(${h}, 100%, 50%)`;

      const rgb = hsvToRgb(h, s, v);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      previewEl.style.background = hex;

      if (!skipHexInput) hexEl.value = hex;
    }

    // ---- interaction ----

    function onSvPointerDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      updateSv(e.clientX, e.clientY);

      const onMove = (ev) => updateSv(ev.clientX, ev.clientY);
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    }

    function updateSv(clientX, clientY) {
      const rect = svEl.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
      hsv.s = rect.width ? x / rect.width : 0;
      hsv.v = rect.height ? 1 - (y / rect.height) : 1;
      render();
    }

    function onHuePointerDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      updateHue(e.clientX);

      const onMove = (ev) => updateHue(ev.clientX);
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    }

    function updateHue(clientX) {
      const rect = hueEl.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      hsv.h = rect.width ? (x / rect.width) * 360 : 0;
      render();
    }

    function onHexInput() {
      const rgb = hexToRgb(hexEl.value);
      if (!rgb) return;
      hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      render(true);
    }

    svEl.addEventListener('pointerdown', onSvPointerDown);
    hueEl.addEventListener('pointerdown', onHuePointerDown);
    hexEl.addEventListener('input', onHexInput);

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      const cb = onCommitFn;
      close();
      if (cb) cb(hex);
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cb = onCancelFn;
      close();
      if (cb) cb();
    });

    if (backdropEl) {
      backdropEl.addEventListener('pointerdown', (e) => {
        if (e.target !== backdropEl) return;
        const cb = onCancelFn;
        close();
        if (cb) cb();
      });
    }

    // ---- API ----

    function open(initialHex, onCommit, title, onCancel) {
      const rgb = hexToRgb(initialHex) || { r: 255, g: 241, b: 118 };
      hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      onCommitFn = onCommit || null;
      onCancelFn = onCancel || null;

      addBtn.textContent = title === 'Add colour' ? 'Add' : 'Save';

      el.classList.add('open');
      if (backdropEl) backdropEl.classList.add('open');

      // Wait a frame so the element has layout for measurement.
      requestAnimationFrame(() => {
        if (positionAfter) positionAfter(el);
        render();
        try { hexEl.focus({ preventScroll: true }); hexEl.select(); } catch {}
      });
    }

    function close() {
      el.classList.remove('open');
      if (backdropEl) backdropEl.classList.remove('open');
      onCommitFn = null;
      onCancelFn = null;
    }

    function isOpen() {
      return el.classList.contains('open');
    }

    function destroy() {
      try { el.remove(); } catch {}
      if (backdropEl) { try { backdropEl.remove(); } catch {} }
      try { styleEl.remove(); } catch {}
    }

    return { el, backdropEl, open, close, isOpen, destroy };
  }

  window.HighlightyPicker = { createPicker };
})();