// Check if extension context is still valid
function isExtensionContextValid() {
  try {
    return chrome.runtime && chrome.runtime.id;
  } catch {
    return false;
  }
}

// Create floating button
const btn = document.createElement('button');
btn.id = 'polileo-btn';
btn.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="Polileo">`;
btn.title = 'Polileo - Click to toggle';
document.body.appendChild(btn);

// Create lock button (focus lock)
const lockBtn = document.createElement('button');
lockBtn.id = 'polileo-lock-btn';
document.body.appendChild(lockBtn);

const lockIconSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>`;
const unlockIconSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>`;

// Detect if this page was opened by Polileo
const isPolileoPage = window.location.href.includes('polileo=1');

// Check if there's still a chance for pole (only 1 post = OP only)
const initialPostCount = countPostsInDOM();
const hasNoPoleYet = initialPostCount === 1;

console.log('Polileo: Page load check - isPolileoPage:', isPolileoPage, 'posts:', initialPostCount, 'hasNoPoleYet:', hasNoPoleYet);

// Local lock state for this page
let localLockState = false;
let useLocalLockState = false; // Whether to use local state or global

// Track if this thread is registered for watching (for guardrails)
let isRegistered = false;

// Initialize lock state based on settings
function initLockState() {
  try {
    chrome.storage.local.get(['autoLockDisabled', 'focusLockManual'], (result) => {
      if (chrome.runtime.lastError) return;

      const autoLockDisabled = result.autoLockDisabled || false;

      // Determine if we should use local lock state
      if (isPolileoPage && hasNoPoleYet && !autoLockDisabled) {
        // Auto-lock on polileo pages (unless disabled in settings)
        useLocalLockState = true;
        localLockState = true;
        updateLockButton(true);
      } else {
        // Use global lock state
        useLocalLockState = false;
        updateLockButton(result.focusLockManual || false);
      }

      console.log('Polileo: Lock state initialized - useLocal:', useLocalLockState, 'autoLockDisabled:', autoLockDisabled);
    });
  } catch {
    // Extension context invalidated
  }
}
initLockState();

// Tell background if this polileo page already has a pole
if (isPolileoPage && !hasNoPoleYet) {
  console.log('Polileo: This polileo page already has pole, using global lock state');
  safeSendMessage({ action: 'polileoPageHasPole', hasPole: true });
}

// Reload lock state (for visibility changes)
function loadLockState() {
  if (useLocalLockState) {
    updateLockButton(localLockState);
  } else {
    try {
      chrome.storage.local.get(['focusLockManual'], (result) => {
        if (chrome.runtime.lastError) return;
        updateLockButton(result.focusLockManual || false);
      });
    } catch {
      // Extension context invalidated
    }
  }
}

// Toggle lock on click
lockBtn.addEventListener('click', () => {
  if (useLocalLockState) {
    // Local state only (doesn't persist) - used on polileo pages when auto-lock is enabled
    localLockState = !localLockState;
    updateLockButton(localLockState);
  } else {
    // Global state: toggle and save to storage
    try {
      chrome.storage.local.get(['focusLockManual'], (result) => {
        if (chrome.runtime.lastError) return;
        const newState = !(result.focusLockManual || false);
        chrome.storage.local.set({ focusLockManual: newState });
        updateLockButton(newState);
      });
    } catch {
      // Extension context invalidated
    }
  }
});

// Re-check when tab becomes visible (for pages using global state)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !useLocalLockState) {
    loadLockState();
  }
});

function updateLockButton(isLocked) {
  lockBtn.innerHTML = isLocked ? lockIconSvg : unlockIconSvg;
  lockBtn.title = isLocked
    ? 'Focus bloqueado - nuevos hilos se abren en segundo plano'
    : 'Focus libre - nuevos hilos robarán el foco';
  lockBtn.className = isLocked ? 'locked' : 'unlocked';
}

// ============================================
// Hotkey handling
// ============================================

const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

const defaultHotkeys = {
  toggleLock: { key: 'Escape', ctrl: false, alt: false, meta: false, shift: false },
  focusReply: { key: 'Tab', ctrl: false, alt: false, meta: false, shift: false },
  submitReply: isMac
    ? { key: 's', ctrl: false, alt: false, meta: true, shift: false }
    : { key: 's', ctrl: false, alt: true, meta: false, shift: false }
};

let currentHotkeys = { ...defaultHotkeys };

// Load hotkeys from storage
function loadHotkeys() {
  if (!isExtensionContextValid()) return;
  try {
    chrome.storage.local.get(['hotkeys'], (result) => {
      if (chrome.runtime.lastError) return;
      if (result.hotkeys) {
        currentHotkeys = { ...defaultHotkeys, ...result.hotkeys };
      }
    });
  } catch {
    // Extension context invalidated
  }
}
loadHotkeys();

// Listen for hotkey changes
try {
  chrome.storage.onChanged.addListener((changes) => {
    if (!isExtensionContextValid()) return;
    if (changes.hotkeys) {
      currentHotkeys = { ...defaultHotkeys, ...changes.hotkeys.newValue };
    }
  });
} catch {
  // Extension context invalidated
}

// Hotkey listener
document.addEventListener('keydown', (e) => {
  // Don't trigger hotkeys when typing in input fields (except submit hotkey)
  const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) ||
                   document.activeElement.classList.contains('wysiwyg') ||
                   document.activeElement.closest('iframe');

  // Check toggleLock hotkey
  if (matchesHotkey(e, currentHotkeys.toggleLock) && !isTyping) {
    e.preventDefault();
    lockBtn.click();
    return;
  }

  // Check focusReply hotkey
  if (matchesHotkey(e, currentHotkeys.focusReply) && !isTyping) {
    e.preventDefault();
    focusReplyBox();
    return;
  }

  // Check submitReply hotkey (allow even when typing)
  if (matchesHotkey(e, currentHotkeys.submitReply)) {
    const submitBtn = getSubmitButton();
    if (submitBtn && !submitBtn.disabled) {
      e.preventDefault();
      submitBtn.click();
    }
    return;
  }
});

// Focus the reply text box (wysiwyg iframe)
function focusReplyBox() {
  const iframe = getEditorIframe();

  if (iframe) {
    // Scroll to the editor area
    iframe.scrollIntoView({ behavior: 'instant', block: 'center' });

    try {
      iframe.focus();
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      const body = iframeDoc.querySelector('body.wysiwyg') || iframeDoc.body;
      if (body) {
        body.focus();
      }
    } catch {
      // Cross-origin or other issue, just focus iframe
      iframe.focus();
    }
    return;
  }

  // Fallback: try textarea
  const textarea = document.querySelector('textarea[name="message"]') ||
                   document.querySelector('#qr_message');
  if (textarea) {
    textarea.scrollIntoView({ behavior: 'instant', block: 'center' });
    textarea.focus();
  }
}

// Get the editor iframe
function getEditorIframe() {
  return document.querySelector('iframe[id*="vB_Editor"]') ||
         document.querySelector('iframe.wysiwyg') ||
         document.querySelector('#vB_Editor_QR_editor');
}

// Get the submit button (quick reply OR full editor)
function getSubmitButton() {
  // Quick reply submit
  const qrSubmit = document.getElementById('qr_submit');
  if (qrSubmit) return qrSubmit;

  // Full editor submit (vB_Editor_001_save, vB_Editor_002_save, etc.)
  const fullSubmit = document.querySelector('input[id*="vB_Editor"][id*="_save"]');
  if (fullSubmit) return fullSubmit;

  // Fallback: any submit with name="sbutton"
  const sbutton = document.querySelector('input[name="sbutton"]');
  if (sbutton) return sbutton;

  return null;
}

// Inject hotkey listener into iframe for submit hotkey
function injectIframeHotkeyListener() {
  const iframe = getEditorIframe();
  if (!iframe) return;

  try {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    if (!iframeDoc || iframeDoc._polileoHotkeyInjected) return;

    iframeDoc._polileoHotkeyInjected = true;
    iframeDoc.addEventListener('keydown', (e) => {
      // Check submitReply hotkey
      if (matchesHotkey(e, currentHotkeys.submitReply)) {
        const submitBtn = getSubmitButton();
        if (submitBtn && !submitBtn.disabled) {
          e.preventDefault();
          submitBtn.click();
        }
      }
    });
  } catch {
    // Cross-origin iframe, can't inject
  }
}

// Try to inject on load and observe for iframe creation
injectIframeHotkeyListener();

// Re-inject when iframe might be created/recreated
const iframeObserver = new MutationObserver(() => {
  injectIframeHotkeyListener();
});
iframeObserver.observe(document.body, { childList: true, subtree: true });

function matchesHotkey(event, hotkey) {
  if (!hotkey) return false;

  const keyMatches = event.key.toLowerCase() === hotkey.key.toLowerCase();
  const ctrlMatches = event.ctrlKey === hotkey.ctrl;
  const altMatches = event.altKey === hotkey.alt;
  const metaMatches = event.metaKey === hotkey.meta;
  const shiftMatches = event.shiftKey === hotkey.shift;

  return keyMatches && ctrlMatches && altMatches && metaMatches && shiftMatches;
}

// Position button below subheader (if exists) or header, aligned with avatar
function updateButtonPosition() {
  const subheader = document.getElementById('subheader');
  const header = document.getElementById('header');
  const avatar = document.querySelector('.header-profile-image-span');
  const referenceEl = subheader || header;

  if (referenceEl) {
    const bottom = referenceEl.getBoundingClientRect().bottom;
    btn.style.top = (bottom + 10) + 'px';
    // Lock button below main button
    lockBtn.style.top = (bottom + 10 + 50 + 5) + 'px'; // btn height + gap
  }

  // Align horizontally with avatar
  if (avatar) {
    const avatarRect = avatar.getBoundingClientRect();
    const avatarCenterX = avatarRect.left + avatarRect.width / 2;
    btn.style.left = (avatarCenterX - 25) + 'px'; // 25 = half button width
    btn.style.right = 'auto';
    // Lock button centered under main button
    lockBtn.style.left = (avatarCenterX - 15) + 'px'; // 15 = half lock button width
    lockBtn.style.right = 'auto';
  }
}
updateButtonPosition();
window.addEventListener('resize', updateButtonPosition);

// Get initial state
safeSendMessage({ action: 'getStatus' }, (response) => {
  if (response) updateButton(response.isActive);
});

// Listen for state changes from other tabs in same window
try {
  chrome.storage.onChanged.addListener((changes) => {
    if (!isExtensionContextValid()) return;
    if (changes.windowStates) {
      // Re-fetch status for this window
      safeSendMessage({ action: 'getStatus' }, (response) => {
        if (response) updateButton(response.isActive);
      });
    }
  });
} catch {
  // Extension context invalidated
}

// Toggle on click
btn.addEventListener('click', () => {
  safeSendMessage({ action: 'toggle' }, (response) => {
    if (response) updateButton(response.isActive);
  });
});

function updateButton(isActive) {
  btn.className = isActive ? 'active' : 'inactive';
  btn.title = isActive ? 'Polileo ACTIVE - Click to stop' : 'Polileo OFF - Click to start';
}

// ============================================
// Cooldown system - track posts globally
// ============================================

const COOLDOWN_DURATION = 30000; // 30 seconds

// Detect successful posts by watching for new posts in the DOM
function setupPostDetector() {
  // Only on thread pages
  if (!getThreadId()) return;

  // Count initial posts
  let lastPostCount = countPostsInDOM();
  const currentUser = getCurrentUsername();

  console.log('Polileo: Post detector initialized. Initial posts:', lastPostCount, 'User:', currentUser);

  // Watch for new posts being added
  const observer = new MutationObserver((mutations) => {
    // Stop if extension context is invalidated
    if (!isExtensionContextValid()) {
      observer.disconnect();
      return;
    }

    const newPostCount = countPostsInDOM();

    if (newPostCount > lastPostCount) {
      console.log('Polileo: New post detected!', lastPostCount, '->', newPostCount);

      // Check if the newest post is from the current user
      const posts = document.querySelectorAll('[id^="post_message_"]');
      if (posts.length > 0) {
        const newestPost = posts[posts.length - 1];
        const postId = newestPost.id.replace('post_message_', '');

        // Find the author of this post - try multiple methods
        let postAuthor = null;

        // Method 1: Find the post container by ID (without underscore)
        const postContainer = document.getElementById(`post${postId}`) ||
                              document.getElementById(`post_${postId}`);
        if (postContainer) {
          const authorLink = postContainer.querySelector('a.bigusername, a[href*="member.php"]');
          postAuthor = authorLink?.textContent?.trim();
        }

        // Method 2: Search backwards in DOM from post_message element
        if (!postAuthor) {
          let parent = newestPost.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            const authorLink = parent.querySelector('a.bigusername, a[href*="member.php"]');
            if (authorLink) {
              postAuthor = authorLink.textContent?.trim();
              break;
            }
            parent = parent.parentElement;
          }
        }

        // Method 3: For quick reply posts, the author is always the current user
        if (!postAuthor && newestPost.closest('#posts')) {
          // If we just added a post and can't find author, assume it's ours
          postAuthor = currentUser;
          console.log('Polileo: Could not find author, assuming current user');
        }

        console.log('Polileo: Newest post author:', postAuthor, 'Current user:', currentUser, 'Post ID:', postId);

        // If it's our post, start cooldown
        if (postAuthor && currentUser &&
            postAuthor.toLowerCase() === currentUser.toLowerCase()) {
          console.log('Polileo: This is OUR post! Starting cooldown');
          try {
            chrome.storage.local.set({ lastPostTime: Date.now() });
          } catch {
            // Extension context invalidated
          }
          showCooldownBar();
        }
      }

      lastPostCount = newPostCount;
    }
  });

  // Observe the posts container
  const postsContainer = document.getElementById('posts') || document.body;
  observer.observe(postsContainer, {
    childList: true,
    subtree: true
  });

  console.log('Polileo: DOM observer active');
}

// Initialize post detector
setupPostDetector();

// Backup: also detect when submit button is clicked
function setupSubmitDetector() {
  const submitBtn = document.getElementById('qr_submit');
  if (!submitBtn) return;

  submitBtn.addEventListener('click', () => {
    console.log('Polileo: Submit button clicked, will check for cooldown in 2s');
    // Wait a bit for the post to be submitted, then start cooldown
    setTimeout(() => {
      if (!isExtensionContextValid()) return;
      // Check if a new post was added (the MutationObserver should have caught it, but just in case)
      try {
        chrome.storage.local.get(['lastPostTime'], (result) => {
          if (chrome.runtime.lastError) return;
          // If no recent post (within last 5 seconds), assume this click resulted in a post
          const timeSinceLastPost = Date.now() - (result.lastPostTime || 0);
          if (timeSinceLastPost > 5000) {
            console.log('Polileo: Submit click backup - starting cooldown');
            chrome.storage.local.set({ lastPostTime: Date.now() });
            showCooldownBar();
          }
        });
      } catch {
        // Extension context invalidated
      }
    }, 2000);
  });

  console.log('Polileo: Submit detector initialized');
}
setupSubmitDetector();

// Create cooldown bar element - inline next to submit button
function createCooldownBar() {
  if (document.getElementById('polileo-cooldown')) {
    return document.getElementById('polileo-cooldown');
  }

  const bar = document.createElement('div');
  bar.id = 'polileo-cooldown';
  bar.innerHTML = `
    <span id="polileo-cooldown-label">Cooldown</span>
    <div id="polileo-cooldown-timer">
      <span id="polileo-cooldown-text">30.0s</span>
      <div id="polileo-cooldown-progress-container">
        <div id="polileo-cooldown-progress"></div>
      </div>
    </div>
  `;

  // Insert next to submit button if possible, otherwise near anti-fail checkbox
  const submitBtn = document.getElementById('qr_submit');
  const antifailContainer = document.getElementById('polileo-antifail-container');

  if (antifailContainer) {
    antifailContainer.parentNode.insertBefore(bar, antifailContainer);
  } else if (submitBtn) {
    submitBtn.parentNode.insertBefore(bar, submitBtn);
  } else {
    document.body.appendChild(bar);
  }

  return bar;
}

// Show and update the cooldown bar
function showCooldownBar() {
  if (!isExtensionContextValid()) return;

  try {
    chrome.storage.local.get(['lastPostTime'], (result) => {
      if (!isExtensionContextValid() || chrome.runtime.lastError || !result.lastPostTime) return;

      const elapsed = Date.now() - result.lastPostTime;
      const remaining = COOLDOWN_DURATION - elapsed;

      if (remaining <= 0) {
        // Cooldown finished
        const bar = document.getElementById('polileo-cooldown');
        if (bar) bar.remove();
        return;
      }

      // Create bar if needed
      createCooldownBar();
      const progress = document.getElementById('polileo-cooldown-progress');
      const text = document.getElementById('polileo-cooldown-text');

      const percentage = (remaining / COOLDOWN_DURATION) * 100;
      const secondsLeft = (remaining / 1000).toFixed(1);

      progress.style.width = percentage + '%';
      text.textContent = secondsLeft + 's';

      // Continue updating
      requestAnimationFrame(() => setTimeout(showCooldownBar, 100));
    });
  } catch {
    // Extension context invalidated
  }
}


// Initialize cooldown tracking (always active)
showCooldownBar(); // Show existing cooldown if any

// Re-check cooldown when tab becomes visible (user switches back to tab)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    showCooldownBar();
  }
});

// Anti-fail features on threads with no pole yet (always active)
const threadId = getThreadId();
console.log('Polileo: URL:', window.location.href, '-> threadId:', threadId);

if (threadId) {
  // Small delay to ensure DOM is fully ready
  setTimeout(() => {
    const postCount = countPostsInDOM();
    console.log('Polileo: Thread', threadId, 'has', postCount, 'posts');

    if (postCount === 1) {
      console.log('Polileo: *** NO POLE YET! *** Registering for watching...');

      try {
        chrome.storage.local.get(['antifailDefault'], (result) => {
          if (chrome.runtime.lastError) return;
          const antifailEnabled = result.antifailDefault !== false;
          injectAntiFailCheckbox(antifailEnabled);
        });
      } catch {
        // Extension context invalidated - use default
        injectAntiFailCheckbox(true);
      }

      // Register thread for watching
      safeSendMessage({
        action: 'watchThread',
        threadId: threadId,
        initialCount: postCount
      }, (response) => {
        if (response?.success) {
          isRegistered = true;  // Mark as registered for guardrail checks
          console.log('Polileo: ✓ Thread', threadId, 'registered for watching');
        } else {
          console.log('Polileo: ✗ Failed to register thread', threadId, response);
        }
      });

      window.addEventListener('beforeunload', () => {
        safeSendMessage({ action: 'unwatchThread', threadId: threadId });
      });
    } else if (postCount > 1) {
      console.log('Polileo: Thread already has pole (', postCount, 'posts)');
    } else {
      console.log('Polileo: Could not count posts in thread');
    }
  }, 50);  // Small delay for DOM stability
}

// ============================================
// Thread monitoring - detect new replies
// ============================================

let poleAlreadyDetected = false;

// Check if we're on a thread page (robust URL matching)
function getThreadId() {
  const url = window.location.href;

  // Try multiple patterns
  // Pattern 1: showthread.php?t=123
  let match = url.match(/showthread\.php\?.*?t=(\d+)/);
  if (match) return match[1];

  // Pattern 2: showthread.php/123
  match = url.match(/showthread\.php\/(\d+)/);
  if (match) return match[1];

  // Pattern 3: t=123 anywhere in URL (fallback)
  match = url.match(/[?&]t=(\d+)/);
  if (match) return match[1];

  return null;
}

// Check if this thread was auto-opened by polileo
function isAutoOpenedByPolileo() {
  return window.location.href.includes('polileo=1');
}

// Count posts in the current DOM (the "frozen" state when page loaded)
function countPostsInDOM() {
  // Most reliable: post_message_ divs
  const postMessages = document.querySelectorAll('[id^="post_message_"]');
  if (postMessages.length > 0) {
    console.log('Polileo: countPostsInDOM found', postMessages.length, 'posts via post_message_');
    return postMessages.length;
  }

  // Fallback: postcount links
  const postcounts = document.querySelectorAll('a[id^="postcount"]');
  if (postcounts.length > 0) {
    console.log('Polileo: countPostsInDOM found', postcounts.length, 'posts via postcount');
    return postcounts.length;
  }

  // Fallback: postbit wrappers
  const postbits = document.querySelectorAll('[id^="post"]');
  const actualPosts = [...postbits].filter(el => /^post\d+$/.test(el.id));
  if (actualPosts.length > 0) {
    console.log('Polileo: countPostsInDOM found', actualPosts.length, 'posts via post wrapper');
    return actualPosts.length;
  }

  console.log('Polileo: countPostsInDOM found 0 posts!');
  return 0;
}

// Block the submit button
function blockSubmitButton() {
  const submitBtn = document.getElementById('qr_submit');
  if (submitBtn && !submitBtn.disabled && isAntiFailEnabled()) {
    submitBtn.disabled = true;
    submitBtn.value = 'BLOQUEADO - YA HAY POLE';
    submitBtn.style.background = '#666';
    submitBtn.style.border = 'none';
    submitBtn.style.cursor = 'not-allowed';
    submitBtn.dataset.polileoBlocked = 'true';
  }
}

// Check if anti-fail is enabled
function isAntiFailEnabled() {
  const checkbox = document.getElementById('polileo-antifail');
  return checkbox ? checkbox.checked : true;
}

// Inject anti-fail checkbox next to submit button
function injectAntiFailCheckbox(defaultEnabled) {
  const submitBtn = document.getElementById('qr_submit');
  if (!submitBtn || document.getElementById('polileo-antifail')) return;

  // Store original button state
  const originalValue = submitBtn.value;
  const originalBackground = submitBtn.style.background;
  const originalBorder = submitBtn.style.border;
  const originalCursor = submitBtn.style.cursor;

  const container = document.createElement('label');
  container.id = 'polileo-antifail-container';
  container.innerHTML = `
    <input type="checkbox" id="polileo-antifail" ${defaultEnabled ? 'checked' : ''}>
    <span>Anti-fail</span>
  `;

  submitBtn.parentNode.insertBefore(container, submitBtn);

  // Listen for checkbox changes to unblock/block button
  document.getElementById('polileo-antifail').addEventListener('change', (e) => {
    if (!e.target.checked) {
      // Unblock the button
      submitBtn.disabled = false;
      submitBtn.value = originalValue;
      submitBtn.style.background = originalBackground;
      submitBtn.style.border = originalBorder;
      submitBtn.style.cursor = originalCursor;
      submitBtn.dataset.polileoBlocked = 'false';
    } else if (submitBtn.dataset.polileoBlocked === 'false' && document.getElementById('polileo-reply-alert')) {
      // Re-block if pole was detected
      blockSubmitButton();
    }
  });
}

// Get current user's name from header
function getCurrentUsername() {
  try {
    // Method 1: Look for .username in header area
    const headerUsername = document.querySelector('.user-profile-menu-header .username');
    if (headerUsername) {
      console.log('Polileo: Found username via method 1');
      return headerUsername.textContent.trim();
    }

    // Method 2: Any .username element
    const usernameEl = document.querySelector('.username');
    if (usernameEl) {
      console.log('Polileo: Found username via method 2');
      return usernameEl.textContent.trim();
    }

    // Method 3: Look for "Hola, Username" pattern
    const holaMatch = document.body.innerHTML.match(/Hola,\s*([^<]+)</i);
    if (holaMatch) {
      console.log('Polileo: Found username via method 3');
      return holaMatch[1].trim();
    }

    console.log('Polileo: Could not find username');
  } catch (e) {
    console.log('Polileo: Error getting username', e);
  }
  return null;
}

// Show notification when pole detected
function showPoleDetectedNotification(poleAuthor) {
  console.log('Polileo: showPoleDetectedNotification called with author:', poleAuthor);

  if (poleAlreadyDetected) {
    console.log('Polileo: Already detected, skipping');
    return;
  }
  poleAlreadyDetected = true;

  try {
    const existing = document.getElementById('polileo-reply-alert');
    if (existing) existing.remove();

    // Check if the current user got the pole
    const currentUser = getCurrentUsername();
    console.log('Polileo: Current user:', currentUser, 'Pole author:', poleAuthor);

    // Normalize for comparison
    const normalizedPoleAuthor = poleAuthor ? poleAuthor.toLowerCase().trim() : '';
    const normalizedCurrentUser = currentUser ? currentUser.toLowerCase().trim() : '';
    const isOwnPole = normalizedPoleAuthor && normalizedCurrentUser &&
      normalizedPoleAuthor === normalizedCurrentUser;
    console.log('Polileo: Normalized comparison:', normalizedPoleAuthor, '===', normalizedCurrentUser, '→', isOwnPole);

    // Only block submit if it's not our own pole
    if (!isOwnPole) {
      blockSubmitButton();
    }

    // Auto-unlock focus lock on polileo pages (pole already taken, no need to stay locked)
    if (isPolileoPage) {
      localLockState = false;
      updateLockButton(false);
      // Notify background so it doesn't force lock on this tab anymore
      safeSendMessage({ action: 'polileoPageHasPole', hasPole: true });
    }

    const authorText = poleAuthor ? `Pole de ${poleAuthor}` : '¡Pole detectada!';

    const alert = document.createElement('div');
    alert.id = 'polileo-reply-alert';
    alert.innerHTML = `<span>${authorText}</span>`;

    if (isOwnPole) {
      alert.classList.add('success');
      console.log('Polileo: Creating SUCCESS toast (green, no refresh)');
    } else {
      // Add refresh button for other's poles
      const refreshBtn = document.createElement('button');
      refreshBtn.id = 'polileo-alert-refresh';
      refreshBtn.title = 'Recargar página';
      refreshBtn.textContent = '↻';
      refreshBtn.addEventListener('click', () => window.location.reload());
      alert.appendChild(refreshBtn);
      console.log('Polileo: Creating FAIL toast (red, with refresh)');
    }

    document.body.appendChild(alert);
    console.log('Polileo: Alert appended to body, className:', alert.className);

    // Position alert vertically centered with button and to its left
    try {
      const btnRect = btn.getBoundingClientRect();
      const btnCenterY = btnRect.top + btnRect.height / 2;
      const alertHeight = alert.offsetHeight;
      const alertTop = btnCenterY - alertHeight / 2;
      alert.style.top = alertTop + 'px';
      alert.style.left = 'auto';
      alert.style.right = (window.innerWidth - btnRect.left + 10) + 'px';
      console.log('Polileo: Alert positioned at top:', alertTop, 'right:', alert.style.right);
    } catch (posError) {
      console.log('Polileo: Error positioning alert, using defaults', posError);
      alert.style.top = '100px';
      alert.style.right = '70px';
    }

    console.log('Polileo: Alert created successfully, visible:', alert.offsetWidth > 0);
  } catch (e) {
    console.error('Polileo: Error showing notification', e);
  }
}

// Listen for notifications from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'poleDetected' && !poleAlreadyDetected) {
    showPoleDetectedNotification(msg.poleAuthor);
  } else if (msg.action === 'windowStatusChanged') {
    updateButton(msg.isActive);
  } else if (msg.action === 'checkAndRegister') {
    // GUARDRAIL: Background is asking us to verify/register this thread
    checkAndRegisterThread();
    sendResponse({ success: true });
  }
  return true;  // Keep channel open for async response
});

// ============================================
// GUARDRAIL: Check and register thread if needed
// ============================================

function checkAndRegisterThread() {
  const tid = getThreadId();
  if (!tid) return;

  // Don't re-register if already done
  if (isRegistered) {
    console.log('Polileo: [GUARDRAIL] Thread', tid, 'already registered, skipping');
    return;
  }

  // Don't register if pole already detected
  if (poleAlreadyDetected) {
    console.log('Polileo: [GUARDRAIL] Pole already detected, skipping registration');
    return;
  }

  const postCount = countPostsInDOM();
  console.log('Polileo: [GUARDRAIL] Checking thread', tid, '- posts:', postCount);

  if (postCount === 1) {
    console.log('Polileo: [GUARDRAIL] Thread', tid, 'has no pole - registering for watching');
    isRegistered = true;

    safeSendMessage({
      action: 'watchThread',
      threadId: tid,
      initialCount: postCount
    }, (response) => {
      if (response?.success) {
        console.log('Polileo: [GUARDRAIL] ✓ Thread', tid, 'registered');
      }
    });
  } else if (postCount > 1) {
    console.log('Polileo: [GUARDRAIL] Thread', tid, 'already has pole (', postCount, 'posts)');
    // Mark so we don't keep checking
    safeSendMessage({ action: 'polileoPageHasPole', hasPole: true });
  }
}

// GUARDRAIL: Re-check on visibility change
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const tid = getThreadId();
    if (tid && !poleAlreadyDetected && !isRegistered) {
      console.log('Polileo: [GUARDRAIL] Tab became visible - checking registration');
      setTimeout(checkAndRegisterThread, 100);
    }
  }
});

// Safe message sender (handles extension context invalidated)
function safeSendMessage(msg, callback) {
  if (!isExtensionContextValid()) return;

  try {
    chrome.runtime.sendMessage(msg, callback);
  } catch {
    console.log('Polileo: Extension context invalidated');
  }
}

