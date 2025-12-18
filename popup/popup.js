document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusEl = document.getElementById('status');
  const antifailDefaultEl = document.getElementById('antifailDefault');

  // Get initial status
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
      updateUI(response.isActive);
    }
  });

  // Load settings
  chrome.storage.local.get(['antifailDefault'], (result) => {
    // Default to true if not set
    antifailDefaultEl.checked = result.antifailDefault !== false;
  });

  // Save antifail setting on change
  antifailDefaultEl.addEventListener('change', () => {
    chrome.storage.local.set({ antifailDefault: antifailDefaultEl.checked });
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
