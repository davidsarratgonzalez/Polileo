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
