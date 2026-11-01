// The toolbar button opens the panel. Chrome shows it beside the page; Safari
// has no side panel, so there it opens in a narrow window of its own, at the
// right edge of the browser window (one panel window: a second click focuses it).
if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
else chrome.action.onClicked.addListener(openPanelWindow);

const PANEL_WIDTH = 420;

async function openPanelWindow() {
  const url = chrome.runtime.getURL('sidepanel.html');
  const windows = await chrome.windows.getAll({ populate: true });
  const open = windows.find((w) => w.tabs?.some((t) => t.url === url));
  if (open) return chrome.windows.update(open.id, { focused: true });
  const browser = await chrome.windows.getLastFocused();
  await chrome.windows.create({
    url,
    type: 'popup',
    width: PANEL_WIDTH,
    height: browser.height,
    top: browser.top,
    left: Math.max(0, browser.left + browser.width - PANEL_WIDTH),
  });
}
