// Keyboard shortcut → toggle in the current Meet tab.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-dust') return;
  const target = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target?.id) return;
  chrome.tabs.sendMessage(target.id, { type: 'toggle' }).catch(() => {});
});
