const FOROCOCHES_URL = 'https://www.forocoches.com/foro/forumdisplay.php?f=2';
const POLL_INTERVAL = 500;
const THREAD_WATCH_INTERVAL = 500;
const ALARM_NAME = 'polileo-keepalive';
const MAX_OPENED_THREADS = 100;

// Per-window state: { windowId: { isActive, openedThreads } }
const windowStates = new Map();
let pollTimer = null;

// Thread watching: { threadId: { tabId, initialCount, lastNotifiedCount } }
const watchedThreads = new Map();
let threadWatchTimer = null;

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

// When a tab is moved to a new window, notify it of the new window's status
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  const newWindowId = attachInfo.newWindowId;
  const state = windowStates.get(newWindowId);
  const isActive = state?.isActive || false;

  chrome.tabs.sendMessage(tabId, {
    action: 'windowStatusChanged',
    isActive: isActive
  }).catch(() => {
    // Tab might not have content script
  });
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
  } else if (msg.action === 'watchThread') {
    // Register a thread for monitoring
    const tabId = sender.tab?.id;
    if (tabId && msg.threadId) {
      watchedThreads.set(msg.threadId, {
        tabId: tabId,
        initialCount: msg.initialCount || 0,
        lastNotifiedCount: msg.initialCount || 0
      });
      startThreadWatching();
    }
    sendResponse({ success: true });
    return true;
  } else if (msg.action === 'unwatchThread') {
    // Stop monitoring a thread
    watchedThreads.delete(msg.threadId);
    if (watchedThreads.size === 0) {
      stopThreadWatching();
    }
    sendResponse({ success: true });
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
            // Cleanup old threads if limit exceeded
            while (state.openedThreads.size > MAX_OPENED_THREADS) {
              const oldest = state.openedThreads.values().next().value;
              state.openedThreads.delete(oldest);
            }
            // Add polileo=1 param so content script knows this was auto-opened
            chrome.tabs.create({ url: `${pole.url}&polileo=1`, active: true, windowId });
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

// ============================================
// Thread watching - detect new replies
// ============================================

function startThreadWatching() {
  if (threadWatchTimer) return;
  threadWatchTimer = setInterval(checkWatchedThreads, THREAD_WATCH_INTERVAL);
  checkWatchedThreads(); // Check immediately
}

function stopThreadWatching() {
  if (threadWatchTimer) {
    clearInterval(threadWatchTimer);
    threadWatchTimer = null;
  }
}

async function checkWatchedThreads() {
  if (watchedThreads.size === 0) {
    stopThreadWatching();
    return;
  }

  for (const [threadId, info] of watchedThreads) {
    try {
      // Check if tab still exists
      try {
        await chrome.tabs.get(info.tabId);
      } catch {
        console.log('Polileo: Tab no longer exists for thread', threadId);
        watchedThreads.delete(threadId);
        continue;
      }

      // Fetch the thread
      const resp = await fetch(
        `https://www.forocoches.com/foro/showthread.php?t=${threadId}&_=${Date.now()}`,
        { credentials: 'include', cache: 'no-store' }
      );

      if (!resp.ok) {
        console.log('Polileo: Fetch failed for thread', threadId, 'status:', resp.status);
        continue;
      }

      const html = await resp.text();
      const currentCount = countPostsInHtml(html);
      console.log('Polileo: Thread', threadId, 'has', currentCount, 'posts (initial:', info.initialCount, ')');

      // If more than 1 post, someone got the pole - notify and stop monitoring
      if (currentCount > 1) {
        // Extract the username of who got the pole
        const poleAuthor = extractPoleAuthor(html);
        console.log('Polileo: Pole detected! Author:', poleAuthor);

        // Send notification to the tab
        chrome.tabs.sendMessage(info.tabId, {
          action: 'poleDetected',
          currentCount: currentCount,
          poleAuthor: poleAuthor
        });

        // Stop monitoring this thread
        watchedThreads.delete(threadId);
        console.log('Polileo: Stopped monitoring thread', threadId);
      }
    } catch (e) {
      console.log('Polileo: Error checking thread', threadId, e);
    }
  }
}

function countPostsInHtml(html) {
  // Count post_message_ occurrences (most reliable for vBulletin)
  const matches = html.match(/id="post_message_\d+"/g);
  if (matches) return matches.length;

  // Fallback: count postcount links
  const postcountMatches = html.match(/id="postcount\d+"/g);
  if (postcountMatches) return postcountMatches.length;

  return 0;
}

function extractPoleAuthor(html) {
  // Find the second post (the pole) and extract its author
  // The second post is the pole (first reply after OP)

  // Method 1: Split by post markers and get the second post's author
  const postMatches = [...html.matchAll(/id="post_message_(\d+)"/g)];
  if (postMatches.length >= 2) {
    // Get the position of the second post
    const secondPostStart = postMatches[1].index;
    // Look backwards from that position for the username (in the post header)
    const beforeSecondPost = html.substring(Math.max(0, secondPostStart - 3000), secondPostStart);

    // Find the last member.php link before the post content (that's the author)
    const memberLinks = [...beforeSecondPost.matchAll(/member\.php\?u=\d+[^>]*>([^<]+)</g)];
    if (memberLinks.length > 0) {
      return memberLinks[memberLinks.length - 1][1].trim();
    }
  }

  // Method 2: Look for postcount2 marker and find nearby username
  const postcount2Match = html.match(/id="postcount2"/);
  if (postcount2Match) {
    const beforePost = html.substring(Math.max(0, postcount2Match.index - 3000), postcount2Match.index);
    const memberLinks = [...beforePost.matchAll(/member\.php\?u=\d+[^>]*>([^<]+)</g)];
    if (memberLinks.length > 0) {
      return memberLinks[memberLinks.length - 1][1].trim();
    }
  }

  // Method 3: Find all bigusername occurrences and get the second one
  const bigUserMatches = [...html.matchAll(/class="bigusername"[^>]*>\s*<[^>]+>([^<]+)</g)];
  if (bigUserMatches.length >= 2) {
    return bigUserMatches[1][1].trim();
  }

  return null;
}
