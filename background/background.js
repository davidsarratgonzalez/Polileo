/**
 * Polileo - Background Service Worker
 *
 * Manages the core extension logic running as a Manifest V3 service worker:
 * - Forum polling: Periodically scans the forum for threads with 0 replies ("poles")
 * - Thread watching: Monitors open threads for new replies (pole detection)
 * - Sound playback: Coordinates audio notifications via offscreen document
 * - State management: Persists window states and watched threads to storage
 * - Guardrails: Multiple redundant systems ensure no poleable thread is missed
 * - Health checks: Self-healing timers that restart if any component dies
 *
 * Architecture:
 *   Service Worker <-> Content Script (per tab) <-> Offscreen Document (audio)
 *   Storage persists state across service worker restarts.
 *
 * File structure:
 *   1. Crash prevention (global error/rejection handlers)
 *   2. Offscreen document & sound playback functions
 *   3. Timing configuration (poll interval, thread check interval)
 *   4. State management (windowStates, watchedThreads, storage persistence)
 *   5. Chrome event listeners (alarms, windows, tabs)
 *   6. Message handler (toggle, getStatus, watchThread, sound requests, etc.)
 *   7. Guardrails (tab URL watcher + aggressive periodic scan)
 *   8. Forum polling loop (findPoles, open tabs, blacklist filtering)
 *   9. Badge management (per-tab, per-window, startup sync)
 *  10. Thread watching system (parallel checks, immediate reactivity on tab/window switch)
 *  11. HTML parsing helpers (countPostsInHtml, extractPoleAuthor)
 */

const FOROCOCHES_URL = 'https://www.forocoches.com/foro/forumdisplay.php?f=2';
const ALARM_NAME = 'polileo-keepalive';
const THREAD_WATCH_ALARM = 'polileo-thread-watch';
const MAX_OPENED_THREADS = 100;
const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

// ============================================
// CRASH PREVENTION & PERSISTENT LOGGING
// Logs survive service worker restarts via chrome.storage.local.
// On startup, prints the previous session's crash log (if any).
// ============================================
const SW_START_TIME = Date.now();
const SW_START_ISO = new Date().toISOString();
console.log('Polileo BG: ====== SERVICE WORKER STARTED ======', SW_START_ISO);

// --- Persistent crash log (survives SW restarts) ---
const MAX_CRASH_LOG_ENTRIES = 30;

function persistLog(type, message, stack) {
  try {
    chrome.storage.local.get(['_crashLog', '_swStartTime'], (result) => {
      if (chrome.runtime.lastError) return;
      const log = result._crashLog || [];
      log.push({
        ts: new Date().toISOString(),
        uptime: ((Date.now() - SW_START_TIME) / 1000).toFixed(1) + 's',
        type,
        message: String(message).substring(0, 500),
        stack: stack ? String(stack).substring(0, 500) : undefined
      });
      // Keep only the last N entries
      while (log.length > MAX_CRASH_LOG_ENTRIES) log.shift();
      chrome.storage.local.set({ _crashLog: log });
    });
  } catch {
    // Storage itself failed — nothing we can do
  }
}

// Crash restart detection for diagnostics
chrome.storage.local.get(['_swStartTime'], (result) => {
  if (chrome.runtime.lastError) return;
  const prevStart = result._swStartTime;
  if (prevStart) {
    const gap = SW_START_TIME - prevStart;
    console.log('Polileo BG: Previous SW started at', new Date(prevStart).toISOString(),
      '— gap:', (gap / 1000).toFixed(1) + 's');
    if (gap < 5000) {
      persistLog('CRASH_RESTART', `SW restarted after only ${(gap/1000).toFixed(1)}s gap`);
    }
  }
  chrome.storage.local.set({ _swStartTime: SW_START_TIME });
});

// Print previous crash logs on startup (both background + content errors)
chrome.storage.local.get(['_crashLog', '_contentErrorLog'], (result) => {
  if (chrome.runtime.lastError) return;

  const bgLog = result._crashLog;
  if (bgLog && bgLog.length > 0) {
    console.log('Polileo BG: === BACKGROUND CRASH LOG (' + bgLog.length + ' entries) ===');
    bgLog.forEach(entry => {
      console.log(`  [${entry.ts}] (uptime ${entry.uptime}) ${entry.type}: ${entry.message}`);
      if (entry.stack) console.log(`    Stack: ${entry.stack}`);
    });
    console.log('Polileo BG: === END BACKGROUND LOG ===');
  }

  const contentLog = result._contentErrorLog;
  if (contentLog && contentLog.length > 0) {
    console.log('Polileo BG: === CONTENT SCRIPT ERROR LOG (' + contentLog.length + ' entries) ===');
    contentLog.forEach(entry => {
      console.log(`  [${entry.ts}] ${entry.type}: ${entry.message}`);
      if (entry.url) console.log(`    URL: ${entry.url}`);
      if (entry.stack) console.log(`    Stack: ${entry.stack}`);
    });
    console.log('Polileo BG: === END CONTENT LOG ===');
  }
});

self.addEventListener('error', (event) => {
  const msg = event.error?.message || event.message || 'Unknown error';
  const stack = event.error?.stack;
  console.error('Polileo BG: UNHANDLED ERROR:', msg, stack);
  persistLog('ERROR', msg, stack);
});

self.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason?.message || String(event.reason) || 'Unknown rejection';
  const stack = event.reason?.stack;
  console.error('Polileo BG: UNHANDLED REJECTION:', msg, stack);
  persistLog('REJECTION', msg, stack);
  event.preventDefault(); // Prevent crash
});

// (Offscreen document is created eagerly on startup — see OFFSCREEN section below)

// ============================================
// CONTENT SCRIPT RE-INJECTION ON STARTUP
// When the service worker restarts after a crash, existing content scripts
// are orphaned (chrome.runtime.id becomes undefined permanently).
// The only way to recover is to re-inject the content script from here.
// ============================================
async function reinjectContentScripts() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.forocoches.com/*' });
    console.log('Polileo BG: [REINJECT] Found', tabs.length, 'forocoches tabs to re-inject');

    for (const tab of tabs) {
      if (!tab.id || tab.id === chrome.tabs.TAB_ID_NONE) continue;
      // Skip non-http tabs (chrome://, about://, etc.)
      if (!tab.url || !tab.url.startsWith('http')) continue;

      try {
        // Check if content script is alive by sending a ping
        await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
        // If we get here, content script is alive — no need to re-inject
        console.log('Polileo BG: [REINJECT] Tab', tab.id, 'content script alive, skipping');
      } catch {
        // Content script is dead/orphaned — re-inject
        console.log('Polileo BG: [REINJECT] Tab', tab.id, 'content script dead, re-injecting...');
        try {
          // Inject CSS first, then JS
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content/content.css']
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/content.js']
          });
          console.log('Polileo BG: [REINJECT] ✓ Tab', tab.id, 're-injected successfully');
          // Restore active state to the re-injected content script
          const state = windowStates.get(tab.windowId);
          const isActive = state?.isActive || false;
          if (isActive) {
            try {
              await chrome.tabs.sendMessage(tab.id, {
                action: 'windowStatusChanged',
                isActive: true
              });
              console.log('Polileo BG: [REINJECT] Restored active state to tab', tab.id);
            } catch { /* content script may not be ready yet */ }
          }
        } catch (e) {
          console.log('Polileo BG: [REINJECT] Failed to re-inject tab', tab.id, ':', e.message);
        }
      }
    }
  } catch (e) {
    console.log('Polileo BG: [REINJECT] Error during re-injection sweep:', e.message);
  }
}

// Run re-injection on startup, but only after storage is loaded so we can
// restore the correct active state to re-injected content scripts.
function reinjectWhenReady() {
  if (storageLoaded) {
    reinjectContentScripts();
  } else {
    setTimeout(reinjectWhenReady, 200);
  }
}
setTimeout(reinjectWhenReady, 500);

// ============================================
// OFFSCREEN DOCUMENT & SOUND PLAYBACK
// Uses Manifest V3 offscreen document for audio (service workers can't play audio).
//
// Architecture: EAGER CREATE + HEALTH CHECK
//   - Offscreen document is created once at startup (fire-and-forget)
//   - A periodic health check (every 30s) recreates it if it died
//   - Sound functions just sendMessage — no creation, no await, no blocking
//   - If offscreen is dead, a sound is missed but nothing crashes
//   - The health check recreates it so the next sound works
// ============================================

// Try to create the offscreen document. Fire-and-forget, never throws.
function tryCreateOffscreen() {
  // Use getContexts to check first (avoids noisy "already exists" errors)
  chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  }).then(contexts => {
    if (contexts.length > 0) {
      console.log('Polileo BG: Offscreen document already alive');
      return;
    }
    return chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play notification sounds for pole detection'
    });
  }).then(() => {
    console.log('Polileo BG: ✓ Offscreen document ready');
  }).catch(e => {
    // "Only a single offscreen document" = already exists = fine
    if (e.message && e.message.includes('single offscreen')) {
      console.log('Polileo BG: Offscreen document already exists (confirmed)');
    } else {
      console.log('Polileo BG: Offscreen creation failed (non-fatal):', e.message);
    }
  });
}

// Create offscreen eagerly on startup (small delay to let SW settle)
setTimeout(tryCreateOffscreen, 1000);

// Health check: recreate offscreen if it died (every 30s)
setInterval(() => {
  chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  }).then(contexts => {
    if (contexts.length === 0) {
      console.log('Polileo BG: [HEALTH] Offscreen document dead — recreating');
      tryCreateOffscreen();
    }
  }).catch(() => {
    // Can't check — try to create just in case
    tryCreateOffscreen();
  });
}, 30000);

// Fire-and-forget sound dispatch. Never awaits, never blocks, never throws.
function fireSound(action) {
  chrome.runtime.sendMessage({ action }).catch(() => {
    // Offscreen is dead — recreate it so the next sound works
    tryCreateOffscreen();
  });
}

// Helper to check if sound should play based on window active state
function shouldPlaySound(windowId) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(['soundOnlyWhenActive'], (result) => {
        if (chrome.runtime.lastError) return resolve(true);
        if (result.soundOnlyWhenActive === false) return resolve(true);
        const state = windowStates.get(windowId);
        resolve(state?.isActive || false);
      });
    } catch { resolve(true); }
  });
}

// Sound functions — all fire-and-forget, never block core
function playNotificationSound() {
  try {
    chrome.storage.local.get(['globalMute', 'soundEnabled'], (result) => {
      if (chrome.runtime.lastError) return;
      if (result.globalMute || result.soundEnabled === false) return;
      fireSound('playNewThreadSound');
    });
  } catch { /* non-fatal */ }
}

function playSuccessSound(windowId) {
  try {
    chrome.storage.local.get(['globalMute', 'soundSuccess', 'soundOnlyWhenActive'], (result) => {
      if (chrome.runtime.lastError) return;
      if (result.globalMute || result.soundSuccess === false) return;
      if (result.soundOnlyWhenActive !== false && windowId) {
        const state = windowStates.get(windowId);
        if (!state?.isActive) return;
      }
      fireSound('playSuccessSound');
    });
  } catch { /* non-fatal */ }
}

function playNotPoleSound(windowId) {
  try {
    chrome.storage.local.get(['globalMute', 'soundFail', 'soundOnlyWhenActive'], (result) => {
      if (chrome.runtime.lastError) return;
      if (result.globalMute || result.soundFail !== true) return;
      if (result.soundOnlyWhenActive !== false && windowId) {
        const state = windowStates.get(windowId);
        if (!state?.isActive) return;
      }
      fireSound('playNotPoleSound');
    });
  } catch { /* non-fatal */ }
}

// Debounce specific to pole-detected to prevent multiple detectors from spamming
let lastPoleDetectedTime = 0;

function playPoleDetectedSound(windowId, hasFocus = false) {
  try {
    if (!hasFocus) return;
    const now = Date.now();
    if (now - lastPoleDetectedTime < 500) return;
    lastPoleDetectedTime = now;

    chrome.storage.local.get(['globalMute', 'soundDetected'], (result) => {
      if (chrome.runtime.lastError) return;
      if (result.globalMute || result.soundDetected === false) return;
      fireSound('playPoleDetectedSound');
    });
  } catch { /* non-fatal */ }
}

// Timing defaults
const DEFAULT_TIMINGS = {
  pollInterval: 500,       // 500ms for forum polling
  threadCheck: 500         // 500ms for checking threads
};

// Current timing values (loaded from storage)
let POLL_INTERVAL = DEFAULT_TIMINGS.pollInterval;
let THREAD_CHECK_INTERVAL = DEFAULT_TIMINGS.threadCheck;

// Load timing settings from storage
chrome.storage.local.get(['timings'], (result) => {
  if (chrome.runtime.lastError) {
    console.log('Polileo BG: Error loading timings:', chrome.runtime.lastError);
    return;
  }
  if (result && result.timings) {
    POLL_INTERVAL = result.timings.pollInterval || DEFAULT_TIMINGS.pollInterval;
    THREAD_CHECK_INTERVAL = result.timings.threadCheck || result.timings.threadWatchFast || DEFAULT_TIMINGS.threadCheck;
    console.log('Polileo BG: Loaded timings - poll:', POLL_INTERVAL, 'threadCheck:', THREAD_CHECK_INTERVAL);
  }
});

// Listen for timing changes
chrome.storage.onChanged.addListener((changes) => {
  try {
    if (changes.timings) {
      const newTimings = changes.timings.newValue || DEFAULT_TIMINGS;
      POLL_INTERVAL = newTimings.pollInterval || DEFAULT_TIMINGS.pollInterval;
      THREAD_CHECK_INTERVAL = newTimings.threadCheck || newTimings.threadWatchFast || DEFAULT_TIMINGS.threadCheck;
      console.log('Polileo BG: Timings updated - poll:', POLL_INTERVAL, 'threadCheck:', THREAD_CHECK_INTERVAL);

      // Restart timer with new value if watching
      if (watchedThreads.size > 0) {
        stopThreadWatching();
        startThreadWatching();
      }
    }
  } catch (e) {
    console.log('Polileo BG: Error handling storage change:', e.message);
  }
});

// Per-window state: { windowId: { isActive, openedThreads } }
const windowStates = new Map();
let pollTimer = null;
let storageLoaded = false; // Flag to prevent badge updates before storage is loaded

// Thread watching: { threadId: { tabId, initialCount, lastNotifiedCount } }
const watchedThreads = new Map();
let threadWatchTimer = null;  // Single timer for all threads

// Track tabs where pole was already taken (so we don't force lock on them)
const tabsWithPole = new Set();

// Load watched threads from storage on startup (in case service worker restarted)
chrome.storage.local.get(['watchedThreadsData'], (result) => {
  if (chrome.runtime.lastError) {
    console.log('Polileo BG: Error loading watchedThreadsData:', chrome.runtime.lastError);
    return;
  }
  if (result && result.watchedThreadsData) {
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
  if (chrome.runtime.lastError) {
    console.log('Polileo BG: Error loading windowStates:', chrome.runtime.lastError);
    updatePolling();
    return;
  }
  if (result && result.windowStates) {
    for (const [windowId, state] of Object.entries(result.windowStates)) {
      windowStates.set(parseInt(windowId), {
        isActive: state.isActive || false,
        openedThreads: new Set(state.openedThreads || [])
      });
    }
  }
  storageLoaded = true; // Mark storage as loaded before updating badges
  console.log('Polileo BG: Storage loaded, windowStates:', windowStates.size, 'entries');
  updatePolling();
  // Update badges for all windows after restoring state
  updateAllBadges();
});

// Alarm wakes up service worker if it sleeps
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    poll();
  } else if (alarm.name === THREAD_WATCH_ALARM) {
    // Alarm fired - service worker may have been idle, restart timer
    console.log('Polileo BG: Thread watch alarm fired, threads:', watchedThreads.size);
    if (watchedThreads.size > 0 && !threadWatchTimer) {
      scheduleNextCheck();
    }
  }
});

// Clean up when window closes
chrome.windows.onRemoved.addListener((windowId) => {
  windowStates.delete(windowId);
  saveStates();
  updatePolling();
});

// When a new tab is created, set its badge based on window state
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id && tab.windowId) {
    updateTabBadge(tab.id, tab.windowId);
  }
});

// When a tab is moved to a new window, notify it and update badge
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  const newWindowId = attachInfo.newWindowId;
  const state = windowStates.get(newWindowId);
  const isActive = state?.isActive || false;

  // Update badge for the new window
  updateTabBadge(tabId, newWindowId);

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
    try {
      const win = await chrome.windows.getCurrent();
      return win.id;
    } catch {
      // No current window (e.g., all minimized) — use last focused
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      return win.id;
    }
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
    }).catch(e => {
      console.log('Polileo BG: Error in toggle:', e.message);
      sendResponse({ isActive: false });
    });
    return true;
  } else if (msg.action === 'getStatus') {
    // Wait for storage to load before responding, so we don't falsely report inactive
    const waitForStorage = () => new Promise((resolve) => {
      if (storageLoaded) return resolve();
      const check = setInterval(() => {
        if (storageLoaded) { clearInterval(check); clearTimeout(safety); resolve(); }
      }, 50);
      const safety = setTimeout(() => { clearInterval(check); resolve(); }, 3000);
    });
    waitForStorage().then(() => getWindowId()).then(windowId => {
      const state = windowStates.get(windowId);
      sendResponse({ isActive: state?.isActive || false });
    }).catch(e => {
      console.log('Polileo BG: Error in getStatus:', e.message);
      sendResponse({ isActive: false });
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
    }).catch(e => {
      console.log('Polileo BG: Error in clearHistory:', e.message);
      sendResponse({ success: false });
    });
    return true;
  } else if (msg.action === 'watchThread') {
    // Register a thread for monitoring
    const tabId = sender.tab?.id;
    const threadId = msg.threadId;
    console.log('Polileo BG: watchThread request - threadId:', threadId, 'tabId:', tabId, 'initialCount:', msg.initialCount);
    if (tabId && threadId) {
      watchedThreads.set(threadId, {
        tabId: tabId,
        initialCount: msg.initialCount || 0,
        lastNotifiedCount: msg.initialCount || 0
      });
      saveWatchedThreads();
      console.log('Polileo BG: Thread registered. Total watched:', watchedThreads.size);
      startThreadWatching();

      // IMMEDIATE first check for this thread
      setTimeout(async () => {
        console.log('Polileo BG: IMMEDIATE first check for new thread', threadId);
        await checkThreadNow(threadId);
      }, 100);  // Small delay to let page settle
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
  } else if (msg.action === 'requestSuccessSound') {
    // Fire-and-forget — respond immediately, sound plays in background
    playSuccessSound(sender.tab?.windowId);
    sendResponse({ success: true });
    return;
  } else if (msg.action === 'requestNotPoleSound') {
    playNotPoleSound(sender.tab?.windowId);
    sendResponse({ success: true });
    return;
  } else if (msg.action === 'requestPoleDetectedSound') {
    playPoleDetectedSound(null, msg.hasFocus || false);
    sendResponse({ success: true });
    return;
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

// ============================================
// GUARDRAILS — Redundant thread registration
// Two layers to ensure no poleable thread is missed:
//   1. Tab URL watcher: Detects navigation to thread pages
//   2. Aggressive periodic scan (200ms): Scans all tabs for unregistered threads
// Both are non-blocking and fire parallel checks.
// ============================================

// Extract thread ID from URL
function extractThreadIdFromUrl(url) {
  if (!url || !url.includes('forocoches.com')) return null;
  if (!url.includes('showthread.php')) return null;

  let match = url.match(/showthread\.php\?.*?t=(\d+)/);
  if (match) return match[1];

  match = url.match(/showthread\.php\/(\d+)/);
  if (match) return match[1];

  match = url.match(/[?&]t=(\d+)/);
  if (match) return match[1];

  return null;
}

// GUARDRAIL 1: Watch for tab URL changes - when a tab navigates to a thread
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only act when the page has finished loading
  if (changeInfo.status !== 'complete') return;

  // Always update badge when tab finishes loading (Chrome may have reset it)
  if (tab.windowId) {
    updateTabBadge(tabId, tab.windowId);
  }

  const threadId = extractThreadIdFromUrl(tab.url);
  if (!threadId) return;

  // Check if this thread is already being watched
  if (watchedThreads.has(threadId)) return;

  // Ask content script to check and register if needed
  console.log('Polileo BG: [GUARDRAIL] Tab navigated to thread', threadId, '- requesting check');
  chrome.tabs.sendMessage(tabId, { action: 'checkAndRegister' }).catch(() => {
    // Content script might not be ready yet
  });
});

// GUARDRAIL 2: Aggressive periodic scan - runs in parallel, never blocks
const GUARDRAIL_SCAN_INTERVAL = 200;  // Every 200ms
const GUARDRAIL_FETCH_TIMEOUT = 2000; // 2 second timeout per fetch
let guardrailScanTimer = null;

// Track threads currently being checked to avoid duplicate parallel checks
const threadsBeingChecked = new Set();

function startGuardrailScan() {
  if (guardrailScanTimer) return;
  console.log('Polileo BG: Starting guardrail scan (every', GUARDRAIL_SCAN_INTERVAL, 'ms)');
  guardrailScanTimer = setInterval(scanForUnwatchedThreads, GUARDRAIL_SCAN_INTERVAL);
}

function stopGuardrailScan() {
  if (guardrailScanTimer) {
    clearInterval(guardrailScanTimer);
    guardrailScanTimer = null;
  }
}

// Non-blocking scan - fires off parallel checks
async function scanForUnwatchedThreads() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.forocoches.com/*' });

    for (const tab of tabs) {
      const threadId = extractThreadIdFromUrl(tab.url);
      if (!threadId) continue;

      // Skip if already watched
      if (watchedThreads.has(threadId)) continue;

      // Skip if we know this tab has a pole already
      if (tabsWithPole.has(tab.id)) continue;

      // Skip if already being checked (parallel check in progress)
      if (threadsBeingChecked.has(threadId)) continue;

      // Fire off parallel check - don't await!
      checkThreadGuardrail(threadId, tab.id);
    }
  } catch (e) {
    // Silently ignore scan errors
  }
}

// Check a single thread with timeout - runs in parallel
async function checkThreadGuardrail(threadId, tabId) {
  // Mark as being checked
  threadsBeingChecked.add(threadId);

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GUARDRAIL_FETCH_TIMEOUT);

    const resp = await fetch(
      `https://www.forocoches.com/foro/showthread.php?t=${threadId}&_=${Date.now()}`,
      {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      }
    );

    if (!resp.ok) {
      clearTimeout(timeoutId);
      threadsBeingChecked.delete(threadId);
      return;
    }

    const html = await resp.text();
    clearTimeout(timeoutId);
    const postCount = countPostsInHtml(html);

    // Double-check it's not already watched (might have been registered while we fetched)
    if (watchedThreads.has(threadId)) {
      threadsBeingChecked.delete(threadId);
      return;
    }

    if (postCount === 1) {
      // No pole yet - register for watching!
      console.log('Polileo BG: [GUARDRAIL] ✓ Thread', threadId, 'has no pole - REGISTERING');
      watchedThreads.set(threadId, {
        tabId: tabId,
        initialCount: 1,
        lastNotifiedCount: 1
      });
      saveWatchedThreads();
      startThreadWatching();

      // Also notify content script to inject anti-fail UI
      chrome.tabs.sendMessage(tabId, { action: 'checkAndRegister' }).catch(() => {});
    } else if (postCount > 1) {
      // Already has pole - mark tab so we don't check again
      console.log('Polileo BG: [GUARDRAIL] Thread', threadId, 'already has pole');
      tabsWithPole.add(tabId);
    }
  } catch (e) {
    // Timeout or network error - silently ignore, will retry next interval
  } finally {
    // Always remove from being-checked set
    threadsBeingChecked.delete(threadId);
  }
}

// Start guardrail scan when extension loads
startGuardrailScan();

// HEALTH CHECK: Ensure guardrail scan is always running
setInterval(() => {
  if (!guardrailScanTimer) {
    console.log('Polileo BG: [HEALTH] ⚠️ Guardrail scan died! Restarting...');
    startGuardrailScan();
  }
}, 10000); // Check every 10 seconds

// Single global polling loop
function updatePolling() {
  const anyActive = [...windowStates.values()].some(s => s.isActive);
  console.log('Polileo BG: updatePolling() - anyActive:', anyActive, 'pollTimer:', !!pollTimer, 'windowStates size:', windowStates.size);

  if (anyActive && !pollTimer) {
    console.log('Polileo BG: Starting forum polling');
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.33 });
    poll();
    startPollHealthCheck();
  } else if (!anyActive && pollTimer) {
    console.log('Polileo BG: Stopping forum polling');
    chrome.alarms.clear(ALARM_NAME);
    clearTimeout(pollTimer);
    pollTimer = null;
    stopPollHealthCheck();
  }
}

// HEALTH CHECK: Ensure polling is running when it should be
let pollHealthCheckTimer = null;

function startPollHealthCheck() {
  if (pollHealthCheckTimer) return;
  console.log('Polileo BG: Starting poll health check');
  pollHealthCheckTimer = setInterval(() => {
    const anyActive = [...windowStates.values()].some(s => s.isActive);
    if (anyActive && !pollTimer) {
      console.log('Polileo BG: [HEALTH] ⚠️ Polling should be running but is not! Restarting...');
      poll();
    } else if (!anyActive && pollHealthCheckTimer) {
      // No active windows, stop health check
      stopPollHealthCheck();
    }
  }, 5000); // Check every 5 seconds
}

function stopPollHealthCheck() {
  if (pollHealthCheckTimer) {
    clearInterval(pollHealthCheckTimer);
    pollHealthCheckTimer = null;
    console.log('Polileo BG: Poll health check stopped');
  }
}

async function poll() {
  const activeWindows = [...windowStates.entries()].filter(([, s]) => s.isActive);
  console.log('Polileo BG: poll() called, activeWindows:', activeWindows.length);
  if (activeWindows.length === 0) {
    pollTimer = null;
    return;
  }

  let pollTimeoutId;
  try {
    const pollController = new AbortController();
    pollTimeoutId = setTimeout(() => pollController.abort(), 10000); // 10s timeout

    const resp = await fetch(`${FOROCOCHES_URL}&_=${Date.now()}`, {
      credentials: 'include',
      cache: 'no-store',
      signal: pollController.signal
    });

    if (resp.ok) {
      const html = await resp.text();
      clearTimeout(pollTimeoutId);
      const poles = findPoles(html);
      console.log('Polileo BG: Found', poles.length, 'potential poles');

      // Get blacklist from storage
      let titleBlacklist = [];
      try {
        const result = await chrome.storage.local.get(['titleBlacklist']);
        titleBlacklist = result.titleBlacklist || [];
      } catch {
        // Storage error, continue without blacklist
      }

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
            // Check blacklist
            const titleLower = pole.title.toLowerCase();
            const isBlacklisted = titleBlacklist.some(term =>
              titleLower.includes(term.toLowerCase())
            );

            if (isBlacklisted) {
              console.log('Polileo BG: BLACKLISTED, skipping:', pole.id, pole.title);
              state.openedThreads.add(pole.id); // Mark as opened so we don't check again
              continue;
            }

            console.log('Polileo BG: Opening new pole:', pole.id, pole.title);
            state.openedThreads.add(pole.id);
            // Cleanup old threads if limit exceeded
            while (state.openedThreads.size > MAX_OPENED_THREADS) {
              const oldest = state.openedThreads.values().next().value;
              state.openedThreads.delete(oldest);
            }
            // Play notification sound (fire-and-forget — never blocks core)
            playNotificationSound();
            // Open tab in the target window (with focus lock check)
            try {
              const shouldLock = await shouldLockFocusForWindow(windowId);
              await chrome.tabs.create({ url: `${pole.url}&polileo`, active: !shouldLock, windowId });
            } catch (tabErr) {
              // Window might have closed or Chrome UI state prevents tab creation — retry without windowId
              console.log('Polileo BG: tabs.create failed for window', windowId, ':', tabErr.message, '— retrying in last focused window');
              try {
                const fallbackWin = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
                await chrome.tabs.create({ url: `${pole.url}&polileo`, active: false, windowId: fallbackWin.id });
              } catch (e2) {
                console.log('Polileo BG: tabs.create fallback also failed:', e2.message);
              }
            }
          } else {
            console.log('Polileo BG: Pole already opened:', pole.id);
          }
        }
      }
      saveStates();
    }
  } catch (e) {
    clearTimeout(pollTimeoutId);
    console.log('Polileo BG: Error during poll:', e.message);
  } finally {
    // ALWAYS schedule next poll if there are active windows (even after errors)
    if ([...windowStates.values()].some(s => s.isActive)) {
      pollTimer = setTimeout(poll, POLL_INTERVAL);
    } else {
      pollTimer = null;
    }
  }
}

function findPoles(html) {
  const poles = [];
  const seen = new Set();
  const titles = new Map();

  let m;

  // Step 1: Extract thread titles
  const t1 = /thread_title_(\d+)[^>]*>([^<]+)</gi;
  while ((m = t1.exec(html))) titles.set(m[1], m[2].trim());

  const t2 = /showthread\.php\?t=(\d+)[^>]*>([^<]{3,})</gi;
  while ((m = t2.exec(html))) if (!titles.has(m[1])) titles.set(m[1], m[2].trim());

  console.log('Polileo BG: findPoles - found', titles.size, 'thread titles');

  // Step 2: Find threads with 0 replies (whoposted shows 0)
  const r = /whoposted[^"]*t=(\d+)[^>]*>(\d+)</gi;
  while ((m = r.exec(html))) {
    const [, id, count] = m;
    if (count === '0' && titles.has(id) && !seen.has(id)) {
      // Check if this thread is closed by looking for tema-closed near the thread_title
      // Search in a window of 2000 chars before thread_title_ID for tema-closed
      const titlePos = html.indexOf(`thread_title_${id}`);
      if (titlePos !== -1) {
        const windowStart = Math.max(0, titlePos - 2000);
        const windowBefore = html.substring(windowStart, titlePos);

        // Check if tema-closed appears in the window AND there's no other thread_title between them
        const lastClosedPos = windowBefore.lastIndexOf('tema-closed');
        if (lastClosedPos !== -1) {
          // Make sure no other thread_title appears between the closed icon and our thread
          const betweenClosedAndTitle = windowBefore.substring(lastClosedPos);
          if (!betweenClosedAndTitle.includes('thread_title_')) {
            console.log('Polileo BG: Skipping CLOSED thread:', id, titles.get(id));
            continue;
          }
        }
      }

      seen.add(id);
      poles.push({
        id,
        title: titles.get(id),
        url: `https://www.forocoches.com/foro/showthread.php?t=${id}`
      });
    }
  }

  console.log('Polileo BG: findPoles - returning', poles.length, 'poles');
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
    if (activeTab?.url && new URL(activeTab.url).searchParams.has('polileo') && !tabsWithPole.has(activeTab.id)) {
      return true;
    }
  } catch {
    // Window might not exist
  }

  // Otherwise check manual preference (default: unlocked)
  try {
    const { focusLockManual } = await chrome.storage.local.get(['focusLockManual']);
    return focusLockManual || false;
  } catch {
    return false;
  }
}

// Update badge for a single tab
function updateTabBadge(tabId, windowId) {
  // Don't update badges until storage is loaded (prevents race condition)
  if (!storageLoaded) {
    console.log('Polileo BG: Skipping badge update, storage not loaded yet');
    return;
  }

  const state = windowStates.get(windowId);
  const isActive = state?.isActive || false;

  try {
    chrome.action.setBadgeText({ text: isActive ? 'ON' : '', tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId: tabId });
  } catch {
    // Tab might not exist
  }
}

// Update badges for all tabs in a specific window
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

// Update badges for ALL windows (used on startup)
async function updateAllBadges() {
  for (const [windowId, state] of windowStates) {
    try {
      const tabs = await chrome.tabs.query({ windowId: parseInt(windowId) });
      for (const tab of tabs) {
        chrome.action.setBadgeText({ text: state.isActive ? 'ON' : '', tabId: tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId: tab.id });
      }
    } catch {
      // Window might not exist anymore
    }
  }
}

// ============================================
// THREAD WATCHING — Parallel polling of all watched threads
// Checks every thread at the configured interval (default 500ms).
// Fires all requests in parallel via Promise.allSettled for speed.
// On pole detection: notifies content script, plays sound, auto-cleans.
// ============================================

function startThreadWatching() {
  if (threadWatchTimer) {
    console.log('Polileo BG: Thread watcher already running');
    return;
  }
  console.log('Polileo BG: Starting thread watcher - interval:', THREAD_CHECK_INTERVAL, 'ms');
  // Create alarm to keep service worker alive
  chrome.alarms.create(THREAD_WATCH_ALARM, { periodInMinutes: 0.5 });
  // Start the timer
  scheduleNextCheck();
}

function scheduleNextCheck() {
  if (threadWatchTimer) clearTimeout(threadWatchTimer);
  if (watchedThreads.size === 0) {
    threadWatchTimer = null;
    return;
  }
  threadWatchTimer = setTimeout(async () => {
    await checkAllThreads();
    scheduleNextCheck();
  }, THREAD_CHECK_INTERVAL);
}

function stopThreadWatching() {
  console.log('Polileo BG: Stopping thread watcher');
  if (threadWatchTimer) {
    clearTimeout(threadWatchTimer);
    threadWatchTimer = null;
  }
  chrome.alarms.clear(THREAD_WATCH_ALARM);
}

// Check ALL watched threads - IN PARALLEL for speed
async function checkAllThreads() {
  if (watchedThreads.size === 0) return;

  const threadsToRemove = [];
  const checkPromises = [];

  for (const [threadId, info] of watchedThreads) {
    // Check if tab still exists (quick sync check via catch)
    const checkPromise = (async () => {
      try {
        await chrome.tabs.get(info.tabId);
      } catch {
        console.log('Polileo BG: Tab closed for thread', threadId);
        threadsToRemove.push(threadId);
        return;
      }

      // Check this thread - fire and don't wait
      await checkSingleThread(threadId, info);
    })();

    checkPromises.push(checkPromise);
  }

  // Wait for ALL checks to complete in parallel
  await Promise.allSettled(checkPromises);

  // Cleanup closed tabs
  for (const threadId of threadsToRemove) {
    watchedThreads.delete(threadId);
  }
  if (threadsToRemove.length > 0) {
    saveWatchedThreads();
  }
}

// Immediate check for a specific thread (used on tab switch, etc.)
async function checkThreadNow(threadId) {
  const info = watchedThreads.get(threadId);
  if (!info) return;
  console.log('Polileo BG: IMMEDIATE check for thread', threadId);
  await checkSingleThread(threadId, info);
}

// ============================================
// IMMEDIATE REACTIVITY — Tab/window switch triggers
// When the user switches tabs or windows, immediately check
// watched threads for that tab so detection feels instant.
// ============================================

// When user switches tabs - check immediately
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    if (watchedThreads.size === 0) return;

    const tabId = activeInfo.tabId;

    for (const [threadId, info] of watchedThreads) {
      if (info.tabId === tabId) {
        console.log('Polileo BG: 🎯 Tab activated -> thread', threadId);
        await checkThreadNow(threadId);
        return;
      }
    }
  } catch (e) {
    console.log('Polileo BG: Error in onActivated:', e.message);
  }
});

// When window focus changes - check immediately
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (watchedThreads.size === 0) return;

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (!activeTab) return;

    // Find if this tab has a watched thread
    for (const [threadId, info] of watchedThreads) {
      if (info.tabId === activeTab.id) {
        console.log('Polileo BG: 🎯 Window focused -> thread', threadId);
        await checkThreadNow(threadId);
        return;
      }
    }
  } catch (e) {
    // Window might not exist
  }
});

// Check a single thread for pole - with timeout
const THREAD_CHECK_TIMEOUT = 2000; // 2 second timeout

async function checkSingleThread(threadId, info) {
  const checkStart = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), THREAD_CHECK_TIMEOUT);

  try {
    const resp = await fetch(
      `https://www.forocoches.com/foro/showthread.php?t=${threadId}&_=${Date.now()}`,
      {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      }
    );

    if (!resp.ok) {
      clearTimeout(timeoutId);
      console.log('Polileo: ✗ Fetch failed for thread', threadId, '- status:', resp.status);
      return;
    }

    const html = await resp.text();
    clearTimeout(timeoutId);
    const currentCount = countPostsInHtml(html);
    const elapsed = Date.now() - checkStart;

    if (currentCount > 1) {
      const poleAuthor = extractPoleAuthor(html);
      console.log('Polileo: 🎯 *** POLE DETECTED *** Thread:', threadId, 'Posts:', currentCount, 'Author:', poleAuthor, '(', elapsed, 'ms)');

      // Notify the tab
      chrome.tabs.sendMessage(info.tabId, {
        action: 'poleDetected',
        currentCount: currentCount,
        poleAuthor: poleAuthor
      }).catch(() => {
        console.log('Polileo: Could not notify tab', info.tabId);
      });

      // Stop monitoring this thread
      watchedThreads.delete(threadId);
      saveWatchedThreads();
    } else {
      // Still only 1 post - no pole yet
      console.log('Polileo: ✓ Thread', threadId, '- still', currentCount, 'post (', elapsed, 'ms)');
    }
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      console.log('Polileo: ✗ Timeout checking thread', threadId, '(>', THREAD_CHECK_TIMEOUT, 'ms)');
    } else {
      console.log('Polileo: ✗ Error checking thread', threadId, '-', e.message);
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
