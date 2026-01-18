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
    : { key: 's', ctrl: false, alt: true, meta: false, shift: false },
  deletePost: isMac
    ? { key: 'Backspace', ctrl: false, alt: false, meta: true, shift: false }
    : { key: 'Backspace', ctrl: false, alt: true, meta: false, shift: false },
  togglePolileo: isMac
    ? { key: 'p', ctrl: false, alt: false, meta: true, shift: true }
    : { key: 'p', ctrl: false, alt: true, meta: false, shift: true }
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

  // Check togglePolileo hotkey
  if (matchesHotkey(e, currentHotkeys.togglePolileo)) {
    e.preventDefault();
    e.stopPropagation();
    safeSendMessage({ action: 'toggle' }, (response) => {
      if (response) updateButton(response.isActive);
    });
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

        // If it's our post, start cooldown and check if we got pole
        if (postAuthor && currentUser &&
            postAuthor.toLowerCase() === currentUser.toLowerCase()) {
          console.log('Polileo: This is OUR post! Starting cooldown and checking position...');
          try {
            chrome.storage.local.set({ lastPostTime: Date.now() });
          } catch {
            // Extension context invalidated
          }
          showCooldownBar();

          // Check if this post is the pole or not - immediately
          checkPostPositionAndOfferDelete(postId);
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
    console.log('Polileo: Submit button clicked, will check in 2s');
    // Wait a bit for the post to be submitted
    setTimeout(() => {
      if (!isExtensionContextValid()) return;
      try {
        chrome.storage.local.get(['lastPostTime'], (result) => {
          if (chrome.runtime.lastError) return;
          // If no recent post (within last 5 seconds), assume this click resulted in a post
          const timeSinceLastPost = Date.now() - (result.lastPostTime || 0);
          if (timeSinceLastPost > 5000) {
            console.log('Polileo: Submit click backup - starting cooldown');
            chrome.storage.local.set({ lastPostTime: Date.now() });
            showCooldownBar();

            // Find the newest post (likely ours) and check position
            const posts = document.querySelectorAll('[id^="post_message_"]');
            if (posts.length > 0) {
              const newestPost = posts[posts.length - 1];
              const postId = newestPost.id.replace('post_message_', '');
              console.log('Polileo: Submit backup - checking position for post', postId);
              checkPostPositionAndOfferDelete(postId);
            }
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

// Create cooldown bar element - fixed position, follows you on screen
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

  document.body.appendChild(bar);
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
        // Cooldown finished - remove immediately
        const bar = document.getElementById('polileo-cooldown');
        if (bar) {
          bar.remove();
        }
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


// Detect successful post via URL (posted=1 parameter)
const MAX_CACHED_POST_IDS = 100;

if (window.location.href.includes('posted=1')) {
  console.log('Polileo: ========== POSTED=1 DETECTED ==========');
  console.log('Polileo: Full URL:', window.location.href);

  // Extract post ID from URL
  const postIdMatch = window.location.href.match(/[?&]p=(\d+)/);
  const postId = postIdMatch ? postIdMatch[1] : null;
  console.log('Polileo: Extracted postId:', postId);

  if (postId) {
    try {
      chrome.storage.local.get(['postedIds'], (result) => {
        if (chrome.runtime.lastError) return;

        const postedIds = result.postedIds || [];

        // Only trigger cooldown if this post ID is not in cache
        if (!postedIds.includes(postId)) {
          console.log('Polileo: New post detected! Starting cooldown...');

          // Add to cache, keep max size
          postedIds.push(postId);
          while (postedIds.length > MAX_CACHED_POST_IDS) {
            postedIds.shift();
          }

          chrome.storage.local.set({
            lastPostTime: Date.now(),
            postedIds: postedIds
          });
          showCooldownBar();

          // Check our post's position immediately
          console.log('Polileo: Checking post position...');
          checkPostPositionAndOfferDelete(postId);
        } else {
          console.log('Polileo: PostId already in cache, skipping');
        }
      });
    } catch (e) {
      console.log('Polileo: Error in posted=1 handler:', e);
    }
  }
}

// Check post position and offer delete if not pole
function checkPostPositionAndOfferDelete(postId) {
  console.log('Polileo: === Checking position for post', postId, '===');

  // Find all postcount elements to understand the structure
  const allPostcounts = document.querySelectorAll('a[id^="postcount"]');
  console.log('Polileo: Found', allPostcounts.length, 'postcount elements');

  // Log first few for debugging
  allPostcounts.forEach((pc, i) => {
    if (i < 5) {
      console.log('Polileo:   postcount', i, ':', pc.id, pc.textContent.trim());
    }
  });

  // Find our post
  const ourPost = document.getElementById(`post_message_${postId}`);
  console.log('Polileo: Found our post element:', !!ourPost);

  if (!ourPost) {
    console.log('Polileo: Could not find post_message_' + postId + ' in DOM');
    // Try alternate: look in the hash
    console.log('Polileo: Hash is:', window.location.hash);
    return;
  }

  // Method 1: Find post container and its postcount
  let ourPosition = 0;
  let container = ourPost;

  // Go up until we find an element with id starting with "post" (but not post_message)
  for (let i = 0; i < 20 && container; i++) {
    container = container.parentElement;
    if (!container) break;

    // Check if this container has a postcount inside
    const postcountInContainer = container.querySelector('a[id^="postcount"]');
    if (postcountInContainer) {
      const match = postcountInContainer.id.match(/postcount(\d+)/);
      if (match) {
        ourPosition = parseInt(match[1]);
        console.log('Polileo: Found postcount', ourPosition, 'in container at level', i);
        break;
      }
    }

    // Also check if we reached a post wrapper
    if (container.id && container.id.match(/^post\d+$/) && !container.id.startsWith('post_message')) {
      console.log('Polileo: Reached post wrapper:', container.id);
    }
  }

  // Method 2: If not found, use all postcount elements and match by proximity
  if (!ourPosition) {
    console.log('Polileo: Method 1 failed, trying proximity match...');

    // Get our post's position in the viewport
    const ourRect = ourPost.getBoundingClientRect();

    let closestPostcount = null;
    let closestDistance = Infinity;

    allPostcounts.forEach(pc => {
      const pcRect = pc.getBoundingClientRect();
      // Calculate vertical distance
      const distance = Math.abs(pcRect.top - ourRect.top);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPostcount = pc;
      }
    });

    if (closestPostcount && closestDistance < 500) {
      const match = closestPostcount.id.match(/postcount(\d+)/);
      if (match) {
        ourPosition = parseInt(match[1]);
        console.log('Polileo: Found closest postcount', ourPosition, 'at distance', closestDistance);
      }
    }
  }

  // Method 3: Count all post_message elements and calculate position
  if (!ourPosition) {
    console.log('Polileo: Method 2 failed, counting posts...');
    const allPostMessages = document.querySelectorAll('[id^="post_message_"]');
    console.log('Polileo: Total post_message elements:', allPostMessages.length);

    for (let i = 0; i < allPostMessages.length; i++) {
      if (allPostMessages[i].id === `post_message_${postId}`) {
        // Calculate position based on page
        const pageMatch = window.location.href.match(/[?&]page=(\d+)/);
        const currentPage = pageMatch ? parseInt(pageMatch[1]) : 1;
        const postsPerPage = allPostMessages.length; // Use actual count
        ourPosition = (currentPage - 1) * 10 + i + 1; // Assume 10 per page for older pages
        console.log('Polileo: Calculated position:', ourPosition, '(page', currentPage, ', index', i, ')');
        break;
      }
    }
  }

  console.log('Polileo: === FINAL POSITION:', ourPosition, '===');

  // Decide what to do
  if (ourPosition > 2) {
    console.log('Polileo: NOT POLE! Showing delete toast...');
    showDeleteToast(postId);
  } else if (ourPosition === 2) {
    console.log('Polileo: POLE! Congratulations!');
  } else if (ourPosition === 1) {
    console.log('Polileo: This is the OP');
  } else {
    console.log('Polileo: Could not determine position - showing delete option anyway');
    // Show delete option anyway since we can't be sure
    showDeleteToast(postId);
  }
}

// Track current deletable post for hotkey
let currentDeletablePostId = null;

// Format hotkey for display
function formatHotkeyDisplay(hotkey) {
  const parts = [];
  if (hotkey.ctrl) parts.push('Ctrl');
  if (hotkey.alt) parts.push('Alt');
  if (hotkey.meta) parts.push(isMac ? '⌘' : 'Win');
  if (hotkey.shift) parts.push('Shift');

  let keyName = hotkey.key;
  if (keyName === 'Backspace') keyName = '⌫';
  else if (keyName === ' ') keyName = 'Space';
  else if (keyName.length === 1) keyName = keyName.toUpperCase();

  parts.push(keyName);
  return parts.join('+');
}

// Show delete toast for failed pole attempts
function showDeleteToast(postId) {
  console.log('Polileo: showDeleteToast called for post', postId);

  // Remove existing delete toast if any
  const existing = document.getElementById('polileo-delete-toast');
  if (existing) existing.remove();

  // Store for hotkey access
  currentDeletablePostId = postId;

  const deleteHotkey = currentHotkeys.deletePost || defaultHotkeys.deletePost;
  const deleteHotkeyHint = formatHotkeyDisplay(deleteHotkey);

  const toast = document.createElement('div');
  toast.id = 'polileo-delete-toast';
  toast.innerHTML = `
    <span>No conseguiste la pole</span>
    <button id="polileo-delete-btn">Borrar mensaje <kbd>${deleteHotkeyHint}</kbd></button>
  `;
  document.body.appendChild(toast);

  console.log('Polileo: Delete toast appended to body');

  // Handle delete button click
  document.getElementById('polileo-delete-btn').addEventListener('click', () => {
    deletePost(postId);
  });

  // Inject hotkey into iframe immediately so it works while focused on editor
  injectDeleteHotkeyIntoIframe();
}

// Hotkey for delete - uses configurable hotkey
function handleDeleteHotkey(e) {
  if (!currentDeletablePostId) return;

  const deleteHotkey = currentHotkeys.deletePost || defaultHotkeys.deletePost;
  if (matchesHotkey(e, deleteHotkey)) {
    e.preventDefault();
    e.stopPropagation();
    const deleteBtn = document.getElementById('polileo-delete-btn');
    if (deleteBtn && !deleteBtn.disabled) {
      deletePost(currentDeletablePostId);
    }
  }
}

// Listen on main document
document.addEventListener('keydown', handleDeleteHotkey);

// Also inject into editor iframe so hotkey works while typing
function injectDeleteHotkeyIntoIframe() {
  const iframe = getEditorIframe();
  if (!iframe) return;

  try {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    if (!iframeDoc) return;

    // Remove old listener if exists, then add fresh one
    iframeDoc.removeEventListener('keydown', handleDeleteHotkey);
    iframeDoc.addEventListener('keydown', handleDeleteHotkey);
    console.log('Polileo: Delete hotkey injected into iframe');
  } catch {
    // Cross-origin iframe
  }
}

// Inject on load and when iframe might be created
injectDeleteHotkeyIntoIframe();
const deleteHotkeyObserver = new MutationObserver(() => {
  injectDeleteHotkeyIntoIframe();
});
deleteHotkeyObserver.observe(document.body, { childList: true, subtree: true });

// Delete a post automatically - ROBUST VERSION
async function deletePost(postId) {
  const deleteBtn = document.getElementById('polileo-delete-btn');
  const toast = document.getElementById('polileo-delete-toast');
  const FETCH_TIMEOUT = 8000; // 8 seconds timeout

  const updateStatus = (text) => {
    if (deleteBtn) {
      deleteBtn.textContent = text;
      deleteBtn.disabled = true;
    }
  };

  // Helper for fetch with timeout
  const fetchWithTimeout = async (url, options = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        throw new Error('Timeout - servidor lento');
      }
      throw new Error('Error de red');
    }
  };

  updateStatus('Borrando...');

  try {
    const baseUrl = window.location.origin + '/foro';

    // ============================================
    // STEP 1: Get the delete confirmation page
    // vBulletin requires visiting the delete page first
    // ============================================
    const deletePageUrl = `${baseUrl}/editpost.php?do=editpost&p=${postId}`;
    console.log('Polileo: [DELETE] Step 1 - Fetching edit page:', deletePageUrl);

    const editResp = await fetchWithTimeout(deletePageUrl, { credentials: 'include' });
    if (!editResp.ok) {
      throw new Error(`No se pudo acceder al post (${editResp.status})`);
    }

    const editHtml = await editResp.text();

    // Check if we have delete permission (look for delete button/option)
    const hasDeleteOption = editHtml.includes('do=deletepost') ||
                            editHtml.includes('deletepost') ||
                            editHtml.includes('Borrar') ||
                            editHtml.includes('Delete');

    if (!hasDeleteOption) {
      console.log('Polileo: [DELETE] No delete option found in edit page');
      // Log a snippet for debugging
      console.log('Polileo: [DELETE] Edit page snippet:', editHtml.substring(0, 1000));
    }

    // Extract ALL form fields - vBulletin needs specific fields
    const securityTokenMatch = editHtml.match(/name="securitytoken"\s+value="([^"]+)"/);
    const postHashMatch = editHtml.match(/name="posthash"\s+value="([^"]+)"/);
    const poststarttime = editHtml.match(/name="poststarttime"\s+value="([^"]+)"/);
    const loggedinuser = editHtml.match(/name="loggedinuser"\s+value="([^"]+)"/);

    if (!securityTokenMatch) {
      throw new Error('Sin permisos para borrar (no security token)');
    }

    const securityToken = securityTokenMatch[1];
    console.log('Polileo: [DELETE] Got security token:', securityToken.substring(0, 20) + '...');

    // ============================================
    // STEP 2: Submit the delete request
    // ============================================
    updateStatus('Enviado...');

    const deleteUrl = `${baseUrl}/editpost.php`;
    const formData = new URLSearchParams();

    // Required fields
    formData.append('do', 'deletepost');
    formData.append('s', ''); // Session (usually empty)
    formData.append('securitytoken', securityToken);
    formData.append('p', postId);
    formData.append('deletepost', 'delete'); // The delete action

    // Optional fields that might help
    if (postHashMatch) formData.append('posthash', postHashMatch[1]);
    if (poststarttime) formData.append('poststarttime', poststarttime[1]);
    if (loggedinuser) formData.append('loggedinuser', loggedinuser[1]);
    formData.append('reason', ''); // Delete reason (optional)

    console.log('Polileo: [DELETE] Step 2 - Submitting delete to:', deleteUrl);
    console.log('Polileo: [DELETE] Form data:', formData.toString());

    const deleteResp = await fetchWithTimeout(deleteUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': window.location.origin,
        'Referer': deletePageUrl
      },
      body: formData.toString()
    });

    console.log('Polileo: [DELETE] Response status:', deleteResp.status);
    const deleteRespHtml = await deleteResp.text();

    // ============================================
    // STEP 3: Analyze the delete response
    // ============================================
    console.log('Polileo: [DELETE] Step 3 - Analyzing response...');

    // Check for success indicators in response
    const successIndicators = [
      'redirect',
      'window.location',
      'showthread.php',
      'El mensaje ha sido borrado',
      'Message deleted',
      'has been deleted',
      'borrado correctamente'
    ];

    const errorIndicators = [
      'error',
      'Error',
      'no tiene permiso',
      'permission',
      'not allowed',
      'invalid',
      'Invalid'
    ];

    const responseHasSuccess = successIndicators.some(ind =>
      deleteRespHtml.toLowerCase().includes(ind.toLowerCase())
    );
    const responseHasError = errorIndicators.some(ind =>
      deleteRespHtml.includes(ind) && !deleteRespHtml.includes('errorless')
    );

    console.log('Polileo: [DELETE] Response analysis - success indicators:', responseHasSuccess, 'error indicators:', responseHasError);
    console.log('Polileo: [DELETE] Response length:', deleteRespHtml.length);

    // If response has clear error, fail immediately
    if (responseHasError && !responseHasSuccess) {
      // Extract error message if possible
      const errorMatch = deleteRespHtml.match(/<div[^>]*class="[^"]*error[^"]*"[^>]*>([^<]+)</i);
      const errorMsg = errorMatch ? errorMatch[1].trim() : 'Error del servidor';
      throw new Error(errorMsg);
    }

    // ============================================
    // STEP 4: VERIFY deletion with multiple attempts
    // ============================================
    updateStatus('Verificando...');
    console.log('Polileo: [DELETE] Step 4 - Verifying deletion...');

    // Try verification multiple times with increasing delays
    const verifyDelays = [500, 1000, 1500]; // ms
    let verified = false;

    for (let i = 0; i < verifyDelays.length; i++) {
      await new Promise(resolve => setTimeout(resolve, verifyDelays[i]));

      console.log('Polileo: [DELETE] Verification attempt', i + 1);
      verified = await verifyPostDeleted(postId);

      if (verified) {
        console.log('Polileo: [DELETE] ✓ VERIFIED on attempt', i + 1);
        break;
      }
    }

    // ============================================
    // STEP 5: Show result
    // ============================================
    currentDeletablePostId = null;

    if (verified) {
      console.log('Polileo: [DELETE] ✓✓✓ POST DELETED SUCCESSFULLY ✓✓✓');
      if (toast) {
        toast.innerHTML = '<span>✓ Mensaje borrado</span>';
        toast.classList.add('success');
        setTimeout(() => {
          toast.classList.add('fade-out');
          setTimeout(() => toast.remove(), 500);
        }, 2000);
      }
    } else if (responseHasSuccess || deleteResp.ok) {
      // Response looked OK but verification failed - might be cache issue
      console.log('Polileo: [DELETE] Response OK but verification failed - probably deleted');
      if (toast) {
        toast.innerHTML = '<span>✓ Probablemente borrado - refresca para confirmar</span>';
        toast.classList.add('success');
        setTimeout(() => {
          toast.classList.add('fade-out');
          setTimeout(() => toast.remove(), 3000);
        }, 3000);
      }
    } else {
      // Uncertain - show manual link
      console.log('Polileo: [DELETE] Uncertain result');
      if (toast) {
        const manualUrl = `${baseUrl}/editpost.php?do=editpost&p=${postId}`;
        toast.innerHTML = `<span>No se pudo verificar</span><a href="${manualUrl}" target="_blank">Comprobar</a>`;
      }
    }

  } catch (e) {
    console.error('Polileo: [DELETE] Error:', e.message);
    if (toast) {
      const manualUrl = `${window.location.origin}/foro/editpost.php?do=editpost&p=${postId}`;
      toast.innerHTML = `<span>${e.message}</span><a href="${manualUrl}" target="_blank">Borrar manual</a>`;
    }
  }
}

// Verify that a post has been deleted by checking if it still exists
// IMPORTANT: We check the POST DIRECTLY, not the thread (which might be paginated)
async function verifyPostDeleted(postId) {
  try {
    const baseUrl = window.location.origin + '/foro';

    // ============================================
    // METHOD 1: Try to access the post directly via showthread.php?p=POSTID
    // This URL shows the specific post regardless of pagination
    // ============================================
    const postUrl = `${baseUrl}/showthread.php?p=${postId}&_=${Date.now()}`;
    console.log('Polileo: [VERIFY] Method 1 - Fetching post directly:', postUrl);

    const postResp = await fetch(postUrl, {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });

    // If we get a redirect to an error page or 404, post is deleted
    if (!postResp.ok) {
      console.log('Polileo: [VERIFY] Post URL returned', postResp.status, '- likely deleted');
      return true;
    }

    const postHtml = await postResp.text();

    // Check if the specific post content exists
    const postMessageExists = postHtml.includes(`id="post_message_${postId}"`);
    const postContainerExists = postHtml.includes(`id="post${postId}"`);

    console.log('Polileo: [VERIFY] Method 1 - post_message:', postMessageExists, 'post container:', postContainerExists);

    // If the post exists in the response, it's NOT deleted
    if (postMessageExists || postContainerExists) {
      console.log('Polileo: [VERIFY] ✗ Post STILL EXISTS (found in direct URL)');
      return false;
    }

    // ============================================
    // METHOD 2: Try to access the edit page
    // If we can't edit, the post is likely deleted
    // ============================================
    const editUrl = `${baseUrl}/editpost.php?do=editpost&p=${postId}&_=${Date.now()}`;
    console.log('Polileo: [VERIFY] Method 2 - Checking edit page:', editUrl);

    const editResp = await fetch(editUrl, {
      credentials: 'include',
      cache: 'no-store'
    });

    if (!editResp.ok) {
      console.log('Polileo: [VERIFY] Edit page returned', editResp.status, '- post deleted');
      return true;
    }

    const editHtml = await editResp.text();

    // Check for error indicators that mean post doesn't exist
    const postNotFound = editHtml.includes('Invalid Post') ||
                         editHtml.includes('mensaje no válido') ||
                         editHtml.includes('no existe') ||
                         editHtml.includes('not found') ||
                         editHtml.includes('ha sido borrado') ||
                         editHtml.includes('has been deleted');

    // Check if edit form exists (meaning post is still there)
    const editFormExists = editHtml.includes('name="message"') ||
                           editHtml.includes('vB_Editor') ||
                           editHtml.includes('do=updatepost');

    console.log('Polileo: [VERIFY] Method 2 - notFound:', postNotFound, 'editForm:', editFormExists);

    if (postNotFound) {
      console.log('Polileo: [VERIFY] ✓ Post confirmed DELETED (edit page says not found)');
      return true;
    }

    if (editFormExists) {
      console.log('Polileo: [VERIFY] ✗ Post STILL EXISTS (edit form available)');
      return false;
    }

    // ============================================
    // METHOD 3: Check the thread's last page to be absolutely sure
    // ============================================
    const tid = getThreadId();
    if (tid) {
      // Fetch with goto=lastpost to get the last page
      const lastPageUrl = `${baseUrl}/showthread.php?t=${tid}&goto=lastpost&_=${Date.now()}`;
      console.log('Polileo: [VERIFY] Method 3 - Checking last page:', lastPageUrl);

      const lastPageResp = await fetch(lastPageUrl, {
        credentials: 'include',
        cache: 'no-store'
      });

      if (lastPageResp.ok) {
        const lastPageHtml = await lastPageResp.text();
        const existsOnLastPage = lastPageHtml.includes(`id="post_message_${postId}"`);

        console.log('Polileo: [VERIFY] Method 3 - exists on last page:', existsOnLastPage);

        if (existsOnLastPage) {
          console.log('Polileo: [VERIFY] ✗ Post STILL EXISTS (found on last page)');
          return false;
        }
      }
    }

    // If we got here, we couldn't find the post anywhere
    console.log('Polileo: [VERIFY] ✓ Post appears to be DELETED (not found anywhere)');
    return true;

  } catch (e) {
    console.log('Polileo: [VERIFY] Error:', e.message);
    // On error, assume NOT deleted (safer)
    return false;
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

// Self-checking interval for this thread (content script doesn't sleep like service worker)
let selfCheckInterval = null;
let selfCheckRunning = false;

// Start self-checking for pole detection (independent of background script)
function startSelfChecking() {
  if (selfCheckInterval || selfCheckRunning) return;
  if (!isExtensionContextValid()) return;

  // Get check interval from settings
  try {
    chrome.storage.local.get(['timings'], (result) => {
      if (chrome.runtime.lastError || !isExtensionContextValid()) return;
      const checkInterval = result.timings?.threadCheck || 500;

      console.log('Polileo: Starting self-check every', checkInterval, 'ms');
      selfCheckRunning = true;

      selfCheckInterval = setInterval(() => {
        if (!isExtensionContextValid()) {
          stopSelfChecking();
          return;
        }
        if (poleAlreadyDetected) {
          stopSelfChecking();
          return;
        }
        selfCheckForPole();
      }, checkInterval);
    });
  } catch {
    // Extension context invalidated
  }
}

function stopSelfChecking() {
  if (selfCheckInterval) {
    clearInterval(selfCheckInterval);
    selfCheckInterval = null;
  }
  selfCheckRunning = false;
}

// Fetch thread and check for pole - with timeout and parallel requests
const POLE_CHECK_TIMEOUT = 1500; // 1.5 second timeout per request
let checkInFlight = false;

async function selfCheckForPole() {
  if (poleAlreadyDetected) return;
  if (checkInFlight) {
    console.log('Polileo: [SELF-CHECK] Previous check still in flight, firing parallel request anyway');
  }

  checkInFlight = true;

  try {
    // Race multiple requests - use the first one that responds
    const result = await raceRequests(threadId, 2); // Send 2 parallel requests

    if (!result || poleAlreadyDetected) {
      checkInFlight = false;
      return;
    }

    const { html } = result;

    // Count posts in the fetched HTML
    const postMatches = html.match(/id="post_message_\d+"/g);
    const postCount = postMatches ? postMatches.length : 0;

    if (postCount > 1 && !poleAlreadyDetected) {
      console.log('Polileo: [SELF-CHECK] *** POLE DETECTED *** Posts:', postCount);

      // Extract pole author
      const poleAuthor = extractPoleAuthorFromHtml(html);

      // Show notification
      showPoleDetectedNotification(poleAuthor);
      stopSelfChecking();
    }
  } catch (e) {
    // Network error, will retry next interval
  } finally {
    checkInFlight = false;
  }
}

// Race multiple fetch requests - returns first successful response
async function raceRequests(tid, count = 2) {
  const controllers = [];
  const promises = [];

  for (let i = 0; i < count; i++) {
    const controller = new AbortController();
    controllers.push(controller);

    // Add small stagger to avoid exact simultaneous requests
    const delay = i * 50;

    const promise = new Promise(async (resolve, reject) => {
      await new Promise(r => setTimeout(r, delay));

      // Set timeout to abort slow requests
      const timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error('Timeout'));
      }, POLE_CHECK_TIMEOUT);

      try {
        const resp = await fetch(
          `${window.location.origin}/foro/showthread.php?t=${tid}&_=${Date.now()}&r=${i}`,
          {
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal
          }
        );

        clearTimeout(timeoutId);

        if (!resp.ok) {
          reject(new Error(`HTTP ${resp.status}`));
          return;
        }

        const html = await resp.text();
        resolve({ html, requestIndex: i });
      } catch (e) {
        clearTimeout(timeoutId);
        reject(e);
      }
    });

    promises.push(promise);
  }

  try {
    // Promise.any returns the first fulfilled promise
    const result = await Promise.any(promises);

    // Abort remaining requests
    controllers.forEach(c => c.abort());

    return result;
  } catch (e) {
    // All requests failed
    console.log('Polileo: [SELF-CHECK] All requests failed');
    return null;
  }
}

// Extract pole author from HTML
function extractPoleAuthorFromHtml(html) {
  const postMatches = [...html.matchAll(/id="post_message_(\d+)"/g)];
  if (postMatches.length >= 2) {
    const secondPostStart = postMatches[1].index;
    const beforeSecondPost = html.substring(Math.max(0, secondPostStart - 3000), secondPostStart);
    const memberLinks = [...beforeSecondPost.matchAll(/member\.php\?u=\d+[^>]*>([^<]+)</g)];
    if (memberLinks.length > 0) {
      return memberLinks[memberLinks.length - 1][1].trim();
    }
  }
  return null;
}

if (threadId) {
  // Small delay to ensure DOM is fully ready
  setTimeout(() => {
    const postCount = countPostsInDOM();
    console.log('Polileo: Thread', threadId, 'has', postCount, 'posts');

    if (postCount === 1) {
      console.log('Polileo: *** NO POLE YET! *** Starting self-check and registering...');

      // START SELF-CHECKING (independent of background)
      startSelfChecking();

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

      // Also register with background (as backup)
      safeSendMessage({
        action: 'watchThread',
        threadId: threadId,
        initialCount: postCount
      }, (response) => {
        if (response?.success) {
          isRegistered = true;
          console.log('Polileo: ✓ Thread', threadId, 'registered with background');
        }
      });

      window.addEventListener('beforeunload', () => {
        stopSelfChecking();
        safeSendMessage({ action: 'unwatchThread', threadId: threadId });
      });
    } else if (postCount > 1) {
      // IMPORTANT: Mark pole as detected so we don't try to check later
      console.log('Polileo: Thread already has pole (', postCount, 'posts) - marking detected');
      poleAlreadyDetected = true;
      // Notify background to not watch this thread
      safeSendMessage({ action: 'polileoPageHasPole', hasPole: true });
    } else {
      console.log('Polileo: Could not count posts in thread');
    }
  }, 50);
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
    if (tid && !poleAlreadyDetected) {
      // FIRST: Check current DOM state - if there are already replies, DON'T start checking
      const currentPostCount = countPostsInDOM();
      console.log('Polileo: [VISIBILITY] Tab visible - DOM has', currentPostCount, 'posts');

      if (currentPostCount > 1) {
        // There's already a pole in the DOM! Mark as detected and don't check
        console.log('Polileo: [VISIBILITY] DOM already has pole - stopping all checks');
        poleAlreadyDetected = true;
        stopSelfChecking();
        safeSendMessage({ action: 'unwatchThread', threadId: tid });
        return;
      }

      // Only 1 post (OP) - safe to check
      if (!selfCheckRunning) {
        console.log('Polileo: [GUARDRAIL] Tab visible - restarting self-check');
        startSelfChecking();
      }
      // Also do immediate check
      selfCheckForPole();

      if (!isRegistered) {
        console.log('Polileo: [GUARDRAIL] Tab became visible - checking registration');
        checkAndRegisterThread();
      }
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

