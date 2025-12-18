document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusEl = document.getElementById('status');

  // Get initial status
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
      updateUI(response.isActive);
    }
  });

  // Toggle button click
  toggleBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'toggle' }, (response) => {
      if (response) {
        updateUI(response.isActive);
      }
    });
  });

  // Clear history button click
  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearHistory' }, (response) => {
      if (response && response.success) {
        // Visual feedback
        clearBtn.textContent = 'Cleared!';
        setTimeout(() => {
          clearBtn.textContent = 'Clear History';
        }, 1500);
      }
    });
  });

  function updateUI(isActive) {
    if (isActive) {
      statusEl.textContent = 'Active';
      statusEl.className = 'status active';
      toggleBtn.textContent = 'Deactivate';
      toggleBtn.className = 'toggle-btn deactivate';
    } else {
      statusEl.textContent = 'Inactive';
      statusEl.className = 'status inactive';
      toggleBtn.textContent = 'Activate';
      toggleBtn.className = 'toggle-btn activate';
    }
  }
});
