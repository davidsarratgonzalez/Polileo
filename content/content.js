// Create floating button
const btn = document.createElement('button');
btn.id = 'polileo-btn';
btn.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="Polileo">`;
btn.title = 'Polileo - Click to toggle';
document.body.appendChild(btn);

// Position button below subheader (if exists) or header, aligned with avatar
function updateButtonPosition() {
  const subheader = document.getElementById('subheader');
  const header = document.getElementById('header');
  const avatar = document.querySelector('.header-profile-image-span');
  const referenceEl = subheader || header;

  if (referenceEl) {
    const bottom = referenceEl.getBoundingClientRect().bottom;
    btn.style.top = (bottom + 10) + 'px';
  }

  // Align horizontally with avatar
  if (avatar) {
    const avatarRect = avatar.getBoundingClientRect();
    const avatarCenterX = avatarRect.left + avatarRect.width / 2;
    btn.style.left = (avatarCenterX - 25) + 'px'; // 25 = half button width
    btn.style.right = 'auto';
  }
}
updateButtonPosition();
window.addEventListener('resize', updateButtonPosition);

// Get initial state
chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
  if (response) updateButton(response.isActive);
});

// Listen for state changes from other tabs in same window
chrome.storage.onChanged.addListener((changes) => {
  if (changes.windowStates) {
    // Re-fetch status for this window
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
      if (response) updateButton(response.isActive);
    });
  }
});

// Toggle on click
btn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'toggle' }, (response) => {
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

// Detect if we just posted successfully
// Must come from newreply.php (referrer) AND have #post{ID} in URL
function detectSuccessfulPost() {
  // Check if we came from posting (referrer must be newreply.php)
  const referrer = document.referrer || '';
  const cameFromPosting = referrer.includes('newreply.php');

  if (!cameFromPosting) {
    console.log('Polileo: Referrer is not newreply.php, not a new post');
    return;
  }

  // Verify URL has #post{ID}
  const hashMatch = window.location.hash.match(/#post(\d+)/);
  if (!hashMatch) {
    console.log('Polileo: No #post hash in URL');
    return;
  }

  const postId = hashMatch[1];
  console.log('Polileo: Came from newreply.php with #post' + postId + ' - this is a NEW post!');

  // Record the timestamp NOW (this is when the post completed)
  const postTime = Date.now();
  console.log('Polileo: Recording post timestamp:', postTime);

  chrome.storage.local.set({ lastPostTime: postTime });

  // Start showing the cooldown bar
  showCooldownBar();
}

// Create cooldown bar element
function createCooldownBar() {
  if (document.getElementById('polileo-cooldown')) {
    return document.getElementById('polileo-cooldown');
  }

  const bar = document.createElement('div');
  bar.id = 'polileo-cooldown';
  bar.innerHTML = `
    <div id="polileo-cooldown-progress"></div>
    <span id="polileo-cooldown-text"></span>
  `;
  document.body.appendChild(bar);

  // Position below the Polileo button
  positionCooldownBar();
  return bar;
}

function positionCooldownBar() {
  const bar = document.getElementById('polileo-cooldown');
  if (!bar) return;

  const btnRect = btn.getBoundingClientRect();
  bar.style.top = (btnRect.bottom + 10) + 'px';
  bar.style.left = (btnRect.left + (btnRect.width - 50) / 2) + 'px';
}

// Show and update the cooldown bar
function showCooldownBar() {
  chrome.storage.local.get(['lastPostTime'], (result) => {
    if (!result.lastPostTime) return;

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
    const secondsLeft = Math.ceil(remaining / 1000);

    progress.style.width = percentage + '%';
    text.textContent = secondsLeft + 's';

    // Continue updating
    requestAnimationFrame(() => setTimeout(showCooldownBar, 100));
  });
}

// Initialize cooldown system on page load
detectSuccessfulPost();
showCooldownBar(); // Show existing cooldown if any

// Update cooldown bar position on resize
window.addEventListener('resize', positionCooldownBar);

// ============================================
// Thread monitoring - detect new replies
// ============================================

let poleAlreadyDetected = false;

// Check if we're on a thread page
function getThreadId() {
  const match = window.location.href.match(/showthread\.php\?t=(\d+)/);
  return match ? match[1] : null;
}

// Check if this thread was auto-opened by polileo
function isAutoOpenedByPolileo() {
  return window.location.href.includes('polileo=1');
}

// Count posts in the current DOM (the "frozen" state when page loaded)
function countPostsInDOM() {
  const selectors = [
    '[id^="post_message_"]',
    '[id^="postbit_wrapper_"]',
    'a[id^="postcount"]',
    '.postbitlegacy',
    '.postcontainer'
  ];

  for (const selector of selectors) {
    const posts = document.querySelectorAll(selector);
    if (posts.length > 0) {
      return posts.length;
    }
  }
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
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'poleDetected' && !poleAlreadyDetected) {
    showPoleDetectedNotification(msg.poleAuthor);
  } else if (msg.action === 'windowStatusChanged') {
    updateButton(msg.isActive);
  }
});

// Safe message sender (handles extension context invalidated)
function safeSendMessage(msg, callback) {
  try {
    chrome.runtime.sendMessage(msg, callback);
  } catch (e) {
    console.log('Polileo: Extension context invalidated');
  }
}

// If we're on ANY thread with only 1 post (no pole yet), enable anti-fail features
const threadId = getThreadId();

if (threadId) {
  const initialPostCount = countPostsInDOM();
  console.log('Polileo: Thread', threadId, 'has', initialPostCount, 'posts');

  // Only enable anti-fail if it's a valid pole opportunity (1 post = only OP)
  if (initialPostCount === 1) {
    console.log('Polileo: No pole yet! Enabling anti-fail features...');

    // Load settings and inject anti-fail checkbox
    chrome.storage.local.get(['antifailDefault'], (result) => {
      const antifailEnabled = result.antifailDefault !== false;
      injectAntiFailCheckbox(antifailEnabled);
    });

    // Start monitoring for new replies
    safeSendMessage({
      action: 'watchThread',
      threadId: threadId,
      initialCount: initialPostCount
    }, (response) => {
      console.log('Polileo: watchThread response:', response);
    });

    // Stop watching when leaving the page
    window.addEventListener('beforeunload', () => {
      safeSendMessage({ action: 'unwatchThread', threadId: threadId });
    });
  } else {
    console.log('Polileo: Thread already has pole, anti-fail not needed');
  }
}
