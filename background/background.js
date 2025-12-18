const FOROCOCHES_URL = 'https://www.forocoches.com/foro/forumdisplay.php?f=2';
const POLL_INTERVAL = 500;
const ALARM_NAME = 'polebot-keepalive';

// Per-window state: { windowId: { isActive, openedThreads } }
const windowStates = new Map();
let pollTimer = null;

// Load saved state on startup
chrome.storage.local.get(['windowStates'], (result) => {
  if (result.windowStates) {
    for (const [windowId, state] of Object.entries(result.windowStates)) {
      windowStates.set(parseInt(windowId), {
        isActive: state.isActive || false,
        openedThreads: new Set(state.openedThreads || [])
      });
    }
  }
  updatePolling();
});

// Alarm wakes up service worker if it sleeps
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    poll();
  }
});

// Clean up when window closes
chrome.windows.onRemoved.addListener((windowId) => {
  windowStates.delete(windowId);
  saveStates();
  updatePolling();
});

// Handle messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const getWindowId = async () => {
    if (sender.tab?.windowId) return sender.tab.windowId;
    const win = await chrome.windows.getCurrent();
    return win.id;
  };

  if (msg.action === 'toggle') {
    getWindowId().then(windowId => {
      let state = windowStates.get(windowId);
      if (!state) {
        state = { isActive: false, openedThreads: new Set() };
        windowStates.set(windowId, state);
      }

      state.isActive = !state.isActive;
      saveStates();
      updatePolling();
      updateBadge(windowId);
      sendResponse({ isActive: state.isActive });
    });
    return true;
  } else if (msg.action === 'getStatus') {
    getWindowId().then(windowId => {
      const state = windowStates.get(windowId);
      sendResponse({ isActive: state?.isActive || false });
    });
    return true;
  } else if (msg.action === 'clearHistory') {
    getWindowId().then(windowId => {
      const state = windowStates.get(windowId);
      if (state) {
        state.openedThreads.clear();
        saveStates();
      }
      sendResponse({ success: true });
    });
    return true;
  }
});

// Single global polling loop
function updatePolling() {
  const anyActive = [...windowStates.values()].some(s => s.isActive);

  if (anyActive && !pollTimer) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.33 });
    poll();
  } else if (!anyActive && pollTimer) {
    chrome.alarms.clear(ALARM_NAME);
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function poll() {
  const activeWindows = [...windowStates.entries()].filter(([, s]) => s.isActive);
  if (activeWindows.length === 0) {
    pollTimer = null;
    return;
  }

  try {
    const resp = await fetch(`${FOROCOCHES_URL}&_=${Date.now()}`, {
      credentials: 'include',
      cache: 'no-store'
    });

    if (resp.ok) {
      const html = await resp.text();
      const poles = findPoles(html);

      // Open poles in each active window (if not already opened in that window)
      for (const [windowId, state] of activeWindows) {
        // Check window still exists
        try {
          await chrome.windows.get(windowId);
        } catch {
          windowStates.delete(windowId);
          continue;
        }

        for (const pole of poles) {
          if (!state.openedThreads.has(pole.id)) {
            state.openedThreads.add(pole.id);
            chrome.tabs.create({ url: pole.url, active: true, windowId });
          }
        }
      }
      saveStates();
    }
  } catch {
    // Network error, continue polling
  }

  // Schedule next poll
  if ([...windowStates.values()].some(s => s.isActive)) {
    pollTimer = setTimeout(poll, POLL_INTERVAL);
  } else {
    pollTimer = null;
  }
}

function findPoles(html) {
  const poles = [];
  const seen = new Set();
  const titles = new Map();

  let m;
  const t1 = /thread_title_(\d+)[^>]*>([^<]+)</gi;
  while ((m = t1.exec(html))) titles.set(m[1], m[2].trim());

  const t2 = /showthread\.php\?t=(\d+)[^>]*>([^<]{3,})</gi;
  while ((m = t2.exec(html))) if (!titles.has(m[1])) titles.set(m[1], m[2].trim());

  const r = /whoposted[^"]*t=(\d+)[^>]*>(\d+)</gi;
  while ((m = r.exec(html))) {
    const [, id, count] = m;
    if (count === '0' && titles.has(id) && !seen.has(id)) {
      seen.add(id);
      poles.push({
        id,
        title: titles.get(id),
        url: `https://www.forocoches.com/foro/showthread.php?t=${id}`
      });
    }
  }

  return poles;
}

function saveStates() {
  const data = {};
  for (const [windowId, state] of windowStates) {
    data[windowId] = {
      isActive: state.isActive,
      openedThreads: [...state.openedThreads]
    };
  }
  chrome.storage.local.set({ windowStates: data });
}

async function updateBadge(windowId) {
  const state = windowStates.get(windowId);
  const isActive = state?.isActive || false;

  try {
    const tabs = await chrome.tabs.query({ windowId });
    for (const tab of tabs) {
      chrome.action.setBadgeText({ text: isActive ? 'ON' : '', tabId: tab.id });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId: tab.id });
    }
  } catch {
    // Window might not exist
  }
}
