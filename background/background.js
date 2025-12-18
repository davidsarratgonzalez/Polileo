const FOROCOCHES_URL = 'https://www.forocoches.com/foro/forumdisplay.php?f=2';
const ALARM_NAME = 'polileo-keepalive';
const THREAD_WATCH_ALARM = 'polileo-thread-watch';
const MAX_OPENED_THREADS = 100;

// Timing defaults
const DEFAULT_TIMINGS = {
  pollInterval: 500,       // 500ms for forum polling
  threadWatchFast: 500,    // 500ms for active thread
  threadWatchSlow: 1000    // 1s for other threads
};

// Current timing values (loaded from storage)
let POLL_INTERVAL = DEFAULT_TIMINGS.pollInterval;
let THREAD_WATCH_FAST = DEFAULT_TIMINGS.threadWatchFast;
let THREAD_WATCH_SLOW = DEFAULT_TIMINGS.threadWatchSlow;

// Load timing settings from storage
chrome.storage.local.get(['timings'], (result) => {
  if (result.timings) {
    POLL_INTERVAL = result.timings.pollInterval || DEFAULT_TIMINGS.pollInterval;
    THREAD_WATCH_FAST = result.timings.threadWatchFast || DEFAULT_TIMINGS.threadWatchFast;
    THREAD_WATCH_SLOW = result.timings.threadWatchSlow || DEFAULT_TIMINGS.threadWatchSlow;
    console.log('Polileo BG: Loaded timings - poll:', POLL_INTERVAL, 'fast:', THREAD_WATCH_FAST, 'slow:', THREAD_WATCH_SLOW);
  }
});

// Listen for timing changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.timings) {
    const newTimings = changes.timings.newValue || DEFAULT_TIMINGS;
    POLL_INTERVAL = newTimings.pollInterval || DEFAULT_TIMINGS.pollInterval;
    THREAD_WATCH_FAST = newTimings.threadWatchFast || DEFAULT_TIMINGS.threadWatchFast;
    THREAD_WATCH_SLOW = newTimings.threadWatchSlow || DEFAULT_TIMINGS.threadWatchSlow;
    console.log('Polileo BG: Timings updated - poll:', POLL_INTERVAL, 'fast:', THREAD_WATCH_FAST, 'slow:', THREAD_WATCH_SLOW);

    // Restart timers with new values if watching
    if (watchedThreads.size > 0) {
      stopThreadWatching();
      startThreadWatching();
    }
  }
});

// Per-window state: { windowId: { isActive, openedThreads } }
const windowStates = new Map();
let pollTimer = null;

// Thread watching: { threadId: { tabId, initialCount, lastNotifiedCount } }
const watchedThreads = new Map();
let threadWatchFastTimer = null;  // Fast timer for active tab
let threadWatchSlowTimer = null;  // Slow timer for all threads

// Track tabs where pole was already taken (so we don't force lock on them)
const tabsWithPole = new Set();

// Load watched threads from storage on startup (in case service worker restarted)
chrome.storage.local.get(['watchedThreadsData'], (result) => {
  if (result.watchedThreadsData) {
    for (const [threadId, info] of Object.entries(result.watchedThreadsData)) {
      watchedThreads.set(threadId, info);
    }
    console.log('Polileo BG: Restored', watchedThreads.size, 'watched threads from storage');
    if (watchedThreads.size > 0) {
      startThreadWatching();
    }
  }
});

// Save watched threads when they change
function saveWatchedThreads() {
  const data = {};
  for (const [threadId, info] of watchedThreads) {
    data[threadId] = info;
  }
  chrome.storage.local.set({ watchedThreadsData: data });
}

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
  } else if (alarm.name === THREAD_WATCH_ALARM) {
    // Alarm fired - service worker may have been idle
    // Restart the setTimeout chains if there are threads to watch
    console.log('Polileo BG: Thread watch alarm fired, threads:', watchedThreads.size);
    if (watchedThreads.size > 0) {
      if (!threadWatchFastTimer) scheduleFastCheck();
      if (!threadWatchSlowTimer) scheduleSlowCheck();
    }
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
      console.log('Polileo BG: Toggle for windowId:', windowId);
      let state = windowStates.get(windowId);
      if (!state) {
        state = { isActive: false, openedThreads: new Set() };
        windowStates.set(windowId, state);
      }

      state.isActive = !state.isActive;
      console.log('Polileo BG: Window', windowId, 'isActive:', state.isActive);
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
    console.log('Polileo BG: watchThread request - threadId:', msg.threadId, 'tabId:', tabId, 'initialCount:', msg.initialCount);
    if (tabId && msg.threadId) {
      watchedThreads.set(msg.threadId, {
        tabId: tabId,
        initialCount: msg.initialCount || 0,
        lastNotifiedCount: msg.initialCount || 0
      });
      saveWatchedThreads();
      console.log('Polileo BG: Thread registered. Total watched:', watchedThreads.size);
      startThreadWatching();
    }
    sendResponse({ success: true });
    return true;
  } else if (msg.action === 'unwatchThread') {
    // Stop monitoring a thread
    watchedThreads.delete(msg.threadId);
    saveWatchedThreads();
    if (watchedThreads.size === 0) {
      stopThreadWatching();
    }
    sendResponse({ success: true });
    return true;
  } else if (msg.action === 'polileoPageHasPole') {
    // Track that this tab's polileo page already has a pole
    const tabId = sender.tab?.id;
    if (tabId && msg.hasPole) {
      tabsWithPole.add(tabId);
    }
    sendResponse({ success: true });
    return true;
  }
});

// Clean up tabsWithPole and watchedThreads when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabsWithPole.delete(tabId);

  // Also remove any watched threads for this tab
  for (const [threadId, info] of watchedThreads) {
    if (info.tabId === tabId) {
      watchedThreads.delete(threadId);
      console.log('Polileo BG: Removed watched thread', threadId, 'because tab closed');
    }
  }
  if (watchedThreads.size === 0) {
    stopThreadWatching();
  }
  saveWatchedThreads();
});

// Single global polling loop
function updatePolling() {
  const anyActive = [...windowStates.values()].some(s => s.isActive);
  console.log('Polileo BG: updatePolling() - anyActive:', anyActive, 'pollTimer:', !!pollTimer, 'windowStates size:', windowStates.size);

  if (anyActive && !pollTimer) {
    console.log('Polileo BG: Starting forum polling');
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.33 });
    poll();
  } else if (!anyActive && pollTimer) {
    console.log('Polileo BG: Stopping forum polling');
    chrome.alarms.clear(ALARM_NAME);
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function poll() {
  const activeWindows = [...windowStates.entries()].filter(([, s]) => s.isActive);
  console.log('Polileo BG: poll() called, activeWindows:', activeWindows.length);
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
      console.log('Polileo BG: Found', poles.length, 'potential poles');

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
            console.log('Polileo BG: Opening new pole:', pole.id, pole.title);
            state.openedThreads.add(pole.id);
            // Cleanup old threads if limit exceeded
            while (state.openedThreads.size > MAX_OPENED_THREADS) {
              const oldest = state.openedThreads.values().next().value;
              state.openedThreads.delete(oldest);
            }
            // Check if we should lock focus for this window
            const shouldLock = await shouldLockFocusForWindow(windowId);
            // Add polileo=1 param so content script knows this was auto-opened
            // If focus lock is ON, open in background (active: false)
            chrome.tabs.create({ url: `${pole.url}&polileo=1`, active: !shouldLock, windowId });
          } else {
            console.log('Polileo BG: Pole already opened:', pole.id);
          }
        }
      }
      saveStates();
    }
  } catch (e) {
    console.log('Polileo BG: Network error during poll:', e);
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

  console.log('Polileo BG: findPoles - found', titles.size, 'thread titles');

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

// Check if focus should be locked for a specific window
async function shouldLockFocusForWindow(windowId) {
  try {
    // Get the active tab in this window
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: windowId });

    // If active tab is a polileo-opened thread AND doesn't have pole yet, lock
    if (activeTab?.url?.includes('polileo=1') && !tabsWithPole.has(activeTab.id)) {
      return true;
    }
  } catch {
    // Window might not exist
  }

  // Otherwise check manual preference (default: unlocked)
  const { focusLockManual } = await chrome.storage.local.get(['focusLockManual']);
  return focusLockManual || false;
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
  if (threadWatchFastTimer && threadWatchSlowTimer) {
    console.log('Polileo BG: Thread watcher already running');
    return;
  }
  console.log('Polileo BG: Starting thread watcher (fast:', THREAD_WATCH_FAST, 'ms, slow:', THREAD_WATCH_SLOW, 'ms)');
  // Create alarm to keep service worker alive (minimum 0.5 min = 30 sec)
  chrome.alarms.create(THREAD_WATCH_ALARM, { periodInMinutes: 0.5 });
  // Start both timers
  scheduleFastCheck();
  scheduleSlowCheck();
}

function scheduleFastCheck() {
  if (watchedThreads.size === 0) {
    stopThreadWatching();
    return;
  }
  threadWatchFastTimer = setTimeout(async () => {
    await checkActiveThread();
    scheduleFastCheck();
  }, THREAD_WATCH_FAST);
}

function scheduleSlowCheck() {
  if (watchedThreads.size === 0) {
    stopThreadWatching();
    return;
  }
  threadWatchSlowTimer = setTimeout(async () => {
    await checkAllThreads();
    scheduleSlowCheck();
  }, THREAD_WATCH_SLOW);
}

function stopThreadWatching() {
  console.log('Polileo BG: Stopping thread watcher');
  if (threadWatchFastTimer) {
    clearTimeout(threadWatchFastTimer);
    threadWatchFastTimer = null;
  }
  if (threadWatchSlowTimer) {
    clearTimeout(threadWatchSlowTimer);
    threadWatchSlowTimer = null;
  }
  chrome.alarms.clear(THREAD_WATCH_ALARM);
}

// Fast check: only the active tab's thread (every 500ms)
async function checkActiveThread() {
  if (watchedThreads.size === 0) return;

  // Find active tab
  let activeTabId = null;
  try {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) tabs = await chrome.tabs.query({ active: true });
    activeTabId = tabs[0]?.id;
  } catch {
    return;
  }

  // Find thread for active tab
  for (const [threadId, info] of watchedThreads) {
    if (info.tabId === activeTabId) {
      await checkSingleThread(threadId, info);
      break;
    }
  }
}

// Slow check: all threads (every 2 seconds)
async function checkAllThreads() {
  if (watchedThreads.size === 0) return;

  console.log('Polileo BG: Checking all', watchedThreads.size, 'threads');
  const threadsToRemove = [];

  for (const [threadId, info] of watchedThreads) {
    // Check if tab still exists
    try {
      await chrome.tabs.get(info.tabId);
    } catch {
      console.log('Polileo: Tab closed for thread', threadId);
      threadsToRemove.push(threadId);
      continue;
    }

    await checkSingleThread(threadId, info);
  }

  // Cleanup
  for (const threadId of threadsToRemove) {
    watchedThreads.delete(threadId);
  }
  if (threadsToRemove.length > 0) {
    saveWatchedThreads();
  }
}

// Check a single thread for pole
async function checkSingleThread(threadId, info) {
  try {
    const resp = await fetch(
      `https://www.forocoches.com/foro/showthread.php?t=${threadId}&_=${Date.now()}`,
      { credentials: 'include', cache: 'no-store' }
    );

    if (!resp.ok) {
      console.log('Polileo: Fetch failed for', threadId);
      return;
    }

    const html = await resp.text();
    const currentCount = countPostsInHtml(html);

    if (currentCount > 1) {
      const poleAuthor = extractPoleAuthor(html);
      console.log('Polileo: *** POLE DETECTED *** Thread:', threadId, 'Author:', poleAuthor);

      // Notify the tab
      chrome.tabs.sendMessage(info.tabId, {
        action: 'poleDetected',
        currentCount: currentCount,
        poleAuthor: poleAuthor
      }).catch(() => {
        console.log('Polileo: Could not notify tab', info.tabId);
      });

      // Stop monitoring
      watchedThreads.delete(threadId);
      saveWatchedThreads();
    }
  } catch (e) {
    console.log('Polileo: Error checking', threadId, e);
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
