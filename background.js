const api = typeof browser !== 'undefined' ? browser : chrome;

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: 'highlight-selection',
      title: 'Highlight selection',
      contexts: ['selection']
    });
    api.contextMenus.create({
      id: 'toggle-toolbar',
      title: 'Toggle Highlighty toolbar',
      contexts: ['page']
    });
    api.contextMenus.create({
      id: 'clear-highlights',
      title: 'Clear highlights on this page',
      contexts: ['page']
    });
    api.contextMenus.create({
      id: 'separator-1',
      type: 'separator',
      contexts: ['page', 'selection']
    });
    api.contextMenus.create({
      id: 'open-options',
      title: 'Highlighty settings…',
      contexts: ['page', 'selection']
    });
  });
});

api.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id === undefined) return;
  try {
    await api.tabs.sendMessage(tab.id, { type: 'show-toolbar' });
  } catch (err) {
    console.warn('[Highlighty]', err);
  }
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-options') {
    api.runtime.openOptionsPage();
    return;
  }
  if (!tab || tab.id === undefined) return;

  const map = {
    'highlight-selection': { type: 'highlight-selection' },
    'toggle-toolbar': { type: 'toggle-toolbar' },
    'clear-highlights': { type: 'clear-all' }
  };
  const msg = map[info.menuItemId];
  if (!msg) return;
  try {
    await api.tabs.sendMessage(tab.id, msg);
  } catch (err) {
    console.warn('[Highlighty]', err);
  }
});

if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(async (command) => {
    if (command !== 'highlight-selection') return;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) return;
    try {
      await api.tabs.sendMessage(tab.id, { type: 'highlight-selection' });
    } catch (err) {
      console.warn('[Highlighty]', err);
    }
  });
}