# Highlighty
<img width="370" height="350" alt="demo" src="https://github.com/user-attachments/assets/0d7847aa-3dd6-4dfe-888e-98d708b5ea9d" />

A lightweight browser extension for highlighting text on web pages, with a draggable, customisable toolbar.

Built for students and anyone else who reads a lot online and wants to mark things up without a heavy annotation tool.

**Note:** I designed the tool, chose the features, tested each change, and reported the bugs; the code itself is AI-generated.

## Features

- **Click-to-arm highlighting** — pick a colour, then every text selection you make gets highlighted in it. Click the colour again (or press `Escape`) to exit.
- **Word snapping** — selections automatically expand to cover whole words, so you never accidentally highlight half a word. (Can be disabled in settings).
- **Draggable, rotatable toolbar** — move it anywhere on the screen, and rotate it vertical if you prefer.
- **Customisable palette** — reorder colours, delete the ones you don't want, add your own with a built-in colour picker.
- **Resizable and paginated** — show 3-5 colours per line. Scroll the wheel over the toolbar to reach the rest.
- **Eraser** — a dedicated tool that removes highlights instead of adding them. Select part of a highlight to remove only that part.
- **Overlap-aware** — highlighting over an existing highlight recolours only the selected region. The surrounding parts keep their original colour.
- **Multi-block selections** — drag across paragraphs, list items and headings; the extension splits the selection cleanly so nothing breaks.
- **Code-aware** — inline `<code>` and `<pre>` blocks with their own background are skipped, so their styling stays intact.
- **Dark mode friendly** — text colour adapts to the actual rendered contrast, so highlights stay readable on dark sites.
- **Persistent and robust** — highlights are saved per URL and restored on page reload. The extension saves the surrounding text context to prevent highlights from jumping to the wrong spot if a page updates dynamically.
- **Quick settings access** — a gear icon on the toolbar opens the settings page instantly.
- **No tracking, no accounts** — everything stays on your device.

## Installation

### Firefox
[![Get the Add-on](https://img.shields.io/badge/Firefox-Get_the_Add--on-orange?logo=firefox)](https://addons.mozilla.org/firefox/addon/highlighty/)

Install Highlighty directly from the official Mozilla Add-ons store. It updates automatically and doesn't require Developer Mode.

*(Manual installation from the source code is no longer necessary for Firefox.)*

### Chrome, Brave, Edge (Manual Installation)
The extension is not yet published on the Chrome Web Store. To install it manually:
1. Click the green **Code** button above and choose **Download ZIP**.
2. Extract the ZIP.
3. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
4. Enable **Developer mode** (top right).
5. Click **Load unpacked** and select the extracted folder.

## How to use

1. **Open the toolbar** — click the Highlighty icon in your browser's toolbar.
2. **Pick a colour** — click a swatch. The toolbar gets a coloured outline to show the mode is active.
3. **Highlight text** — select any text with the mouse. It's highlighted immediately.
4. **Exit highlight mode** — click the swatch again, or press `Escape` (you can change this to `RMB` or `MMB` in the settings).
5. **Erase** — click the eraser swatch, then select the text you want to unhighlight.
6. **Add a colour** — scroll to the end of your colour list and click the `+` button.
7. **Open settings** — click the gear icon on the toolbar.
8. **Remove a colour** — right-click its swatch.
9. **Move the toolbar** — drag it by the four-arrow handle on the left.
10. **Rotate the toolbar** — click the rotation button to switch between horizontal and vertical.
11. **Resize the toolbar** — drag its outer edge (right edge when horizontal, bottom edge when vertical) to change the number of visible colours.

## Configuration

Open the extension's settings page from the gear icon on the toolbar, or via `chrome://extensions` → Highlighty → **Extension options**. From there you can:

- Toggle Word snapping.
- Choose how many colours show per line.
- Reorder, recolour or remove palette entries.
- Add default colours from the built-in palette.
- Choose which gestures exit highlight mode (`Escape`, middle mouse, right-click).
- Invert horizontal scroll direction on the toolbar.

## Known limitations

- **Triple-click paragraph selections** are intentionally skipped, to work around a Chromium DOM bug that can corrupt page layout.

  > **Workaround:** Triple-click the paragraph *first*, then select a color from the toolbar.
- **Contenteditable editors** (Google Docs, Notion, Gmail compose, etc.) are not supported — they manage their own DOM and ranges in ways the extension can't safely hook into.
- **Iframes and Shadow DOM** are not covered; only the top-level document is processed.
- **PDF files** are not supported. The built-in PDF viewer runs in an isolated context extensions cannot reach.
- **File URLs** (`file://`) require enabling "Allow access to file URLs" in the extension's details page.

## Development

The extension is plain JavaScript — no build step, no dependencies.

- `manifest.json` — extension manifest (Manifest V3).
- `background.js` — service worker: context menus, keyboard shortcut, toolbar toggle, opening settings.
- `content.js` — the toolbar, highlighting engine, and page-side logic.
- `content.css` — styles for `<mark>` elements inserted into pages.
- `picker.js` — shared colour picker module, used by both the toolbar and the options page.
- `options.html` / `options.js` — settings page.

To test changes: reload the extension from `chrome://extensions` and refresh any open tab.

## Support

Highlighty is free and always will be. If it's useful to you and you'd like to say thanks, you can [buy me a coffee](https://ko-fi.com/tambu11).

Found a bug or have an idea for a feature? [Send feedback here](https://forms.fillout.com/t/oFz2ehaPrnus).

## License

MIT — see [LICENSE](LICENSE).
