// Create floating button
const btn = document.createElement('button');
btn.id = 'polebot-btn';
btn.textContent = 'P';
btn.title = 'Polebot - Click to toggle';
document.body.appendChild(btn);

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
  btn.title = isActive ? 'Polebot ACTIVE - Click to stop' : 'Polebot OFF - Click to start';
}

// ============================================
// Thread monitoring - detect new replies
// ============================================

// Check if we're on a thread page
function getThreadId() {
  const match = window.location.href.match(/showthread\.php\?t=(\d+)/);
  return match ? match[1] : null;
}

// Check if this thread was auto-opened by polebot
function isAutoOpenedByPolebot() {
  return window.location.href.includes('polebot=1');
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
    submitBtn.dataset.polebotBlocked = 'true';
  }
}

// Check if anti-fail is enabled
function isAntiFailEnabled() {
  const checkbox = document.getElementById('polebot-antifail');
  return checkbox ? checkbox.checked : true;
}

// Inject anti-fail checkbox next to submit button
function injectAntiFailCheckbox() {
  const submitBtn = document.getElementById('qr_submit');
  if (!submitBtn || document.getElementById('polebot-antifail')) return;

  const container = document.createElement('label');
  container.id = 'polebot-antifail-container';
  container.innerHTML = `
    <input type="checkbox" id="polebot-antifail" checked>
    <span>Anti-fail</span>
  `;

  submitBtn.parentNode.insertBefore(container, submitBtn);
}

// Show notification when pole detected
function showPoleDetectedNotification() {
  const existing = document.getElementById('polebot-reply-alert');
  if (existing) existing.remove();

  // Block submit button
  blockSubmitButton();

  const alert = document.createElement('div');
  alert.id = 'polebot-reply-alert';
  alert.innerHTML = `
    <span>Ya hay pole</span>
    <button id="polebot-alert-close">×</button>
  `;
  document.body.appendChild(alert);

  document.getElementById('polebot-alert-close').addEventListener('click', () => {
    alert.remove();
  });
}

// Listen for notifications from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'poleDetected') {
    showPoleDetectedNotification();
  }
});

// Safe message sender (handles extension context invalidated)
function safeSendMessage(msg, callback) {
  try {
    chrome.runtime.sendMessage(msg, callback);
  } catch (e) {
    console.log('Polebot: Extension context invalidated');
  }
}

// If we're on a thread auto-opened by polebot with only 1 post, monitor it
const threadId = getThreadId();
if (threadId && isAutoOpenedByPolebot()) {
  const initialPostCount = countPostsInDOM();
  console.log('Polebot: Auto-opened thread', threadId, 'with', initialPostCount, 'posts');

  // Only monitor if it's a valid pole (1 post = only OP)
  if (initialPostCount === 1) {
    // Inject anti-fail checkbox
    injectAntiFailCheckbox();

    safeSendMessage({
      action: 'watchThread',
      threadId: threadId,
      initialCount: initialPostCount
    });

    // Stop watching when leaving the page
    window.addEventListener('beforeunload', () => {
      safeSendMessage({ action: 'unwatchThread', threadId: threadId });
    });
  } else {
    console.log('Polebot: Thread already has pole, not monitoring');
  }
}
