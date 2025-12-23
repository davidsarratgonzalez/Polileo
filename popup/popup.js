document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const statusEl = document.getElementById('status');
  const antifailDefaultEl = document.getElementById('antifailDefault');
  const autoLockDisabledEl = document.getElementById('autoLockDisabled');
  const hotkeyLockEl = document.getElementById('hotkeyLock');
  const hotkeyFocusEl = document.getElementById('hotkeyFocus');
  const hotkeySubmitEl = document.getElementById('hotkeySubmit');
  const hotkeyDeleteEl = document.getElementById('hotkeyDelete');

  // Advanced config elements
  const advancedToggle = document.getElementById('advancedToggle');
  const advancedContent = document.getElementById('advancedContent');
  const pollIntervalEl = document.getElementById('pollInterval');
  const threadCheckEl = document.getElementById('threadCheck');
  const pollIntervalValueEl = document.getElementById('pollIntervalValue');
  const threadCheckValueEl = document.getElementById('threadCheckValue');

  // Blacklist elements
  const blacklistToggle = document.getElementById('blacklistToggle');
  const blacklistContent = document.getElementById('blacklistContent');
  const blacklistInput = document.getElementById('blacklistInput');
  const blacklistAddBtn = document.getElementById('blacklistAddBtn');
  const blacklistList = document.getElementById('blacklistList');

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  // Default hotkeys
  const defaultHotkeys = {
    toggleLock: { key: 'Escape', ctrl: false, alt: false, meta: false, shift: false },
    focusReply: { key: 'Tab', ctrl: false, alt: false, meta: false, shift: false },
    submitReply: isMac
      ? { key: 's', ctrl: false, alt: false, meta: true, shift: false }
      : { key: 's', ctrl: false, alt: true, meta: false, shift: false },
    deletePost: isMac
      ? { key: 'Backspace', ctrl: false, alt: false, meta: true, shift: false }
      : { key: 'Backspace', ctrl: false, alt: true, meta: false, shift: false }
  };

  // Default timing values
  const defaultTimings = {
    pollInterval: 500,       // 500ms for forum polling
    threadCheck: 500         // 500ms for checking threads
  };

  let recordingElement = null;

  // Get initial status
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
      updateUI(response.isActive);
    }
  });

  // Load settings
  chrome.storage.local.get(['antifailDefault', 'autoLockDisabled', 'hotkeys', 'timings'], (result) => {
    antifailDefaultEl.checked = result.antifailDefault !== false;
    autoLockDisabledEl.checked = result.autoLockDisabled || false;

    const hotkeys = result.hotkeys || defaultHotkeys;
    updateHotkeyDisplay(hotkeyLockEl, hotkeys.toggleLock || defaultHotkeys.toggleLock);
    updateHotkeyDisplay(hotkeyFocusEl, hotkeys.focusReply || defaultHotkeys.focusReply);
    updateHotkeyDisplay(hotkeySubmitEl, hotkeys.submitReply || defaultHotkeys.submitReply);
    updateHotkeyDisplay(hotkeyDeleteEl, hotkeys.deletePost || defaultHotkeys.deletePost);

    // Load timing settings
    const timings = result.timings || defaultTimings;
    pollIntervalEl.value = timings.pollInterval || defaultTimings.pollInterval;
    threadCheckEl.value = timings.threadCheck || timings.threadWatchFast || defaultTimings.threadCheck;
    updateSliderDisplay(pollIntervalEl, pollIntervalValueEl);
    updateSliderDisplay(threadCheckEl, threadCheckValueEl);
  });

  // Save settings on change
  antifailDefaultEl.addEventListener('change', () => {
    chrome.storage.local.set({ antifailDefault: antifailDefaultEl.checked });
  });

  autoLockDisabledEl.addEventListener('change', () => {
    chrome.storage.local.set({ autoLockDisabled: autoLockDisabledEl.checked });
  });

  // Advanced toggle
  advancedToggle.addEventListener('click', () => {
    advancedToggle.classList.toggle('open');
    advancedContent.classList.toggle('open');
  });

  // Blacklist toggle
  blacklistToggle.addEventListener('click', () => {
    blacklistToggle.classList.toggle('open');
    blacklistContent.classList.toggle('open');
  });

  // Load and render blacklist
  function loadBlacklist() {
    chrome.storage.local.get(['titleBlacklist'], (result) => {
      const blacklist = result.titleBlacklist || [];
      renderBlacklist(blacklist);
    });
  }

  function renderBlacklist(blacklist) {
    blacklistList.innerHTML = '';
    blacklist.forEach((term, index) => {
      const li = document.createElement('li');
      li.className = 'blacklist-item';
      li.innerHTML = `
        <span>${term}</span>
        <button data-index="${index}" title="Eliminar">×</button>
      `;
      blacklistList.appendChild(li);
    });

    // Add click handlers for remove buttons
    blacklistList.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        removeBlacklistItem(parseInt(btn.dataset.index));
      });
    });
  }

  function addBlacklistItem(term) {
    if (!term.trim()) return;
    chrome.storage.local.get(['titleBlacklist'], (result) => {
      const blacklist = result.titleBlacklist || [];
      if (!blacklist.includes(term.trim())) {
        blacklist.push(term.trim());
        chrome.storage.local.set({ titleBlacklist: blacklist }, () => {
          renderBlacklist(blacklist);
          blacklistInput.value = '';
        });
      }
    });
  }

  function removeBlacklistItem(index) {
    chrome.storage.local.get(['titleBlacklist'], (result) => {
      const blacklist = result.titleBlacklist || [];
      blacklist.splice(index, 1);
      chrome.storage.local.set({ titleBlacklist: blacklist }, () => {
        renderBlacklist(blacklist);
      });
    });
  }

  // Blacklist event handlers
  blacklistAddBtn.addEventListener('click', () => {
    addBlacklistItem(blacklistInput.value);
  });

  blacklistInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addBlacklistItem(blacklistInput.value);
    }
  });

  // Load blacklist on popup open
  loadBlacklist();

  // Slider change handlers
  pollIntervalEl.addEventListener('input', () => {
    updateSliderDisplay(pollIntervalEl, pollIntervalValueEl);
    saveTimings();
  });

  threadCheckEl.addEventListener('input', () => {
    updateSliderDisplay(threadCheckEl, threadCheckValueEl);
    saveTimings();
  });

  function updateSliderDisplay(slider, valueEl) {
    valueEl.textContent = slider.value + 'ms';
  }

  function saveTimings() {
    const timings = {
      pollInterval: parseInt(pollIntervalEl.value),
      threadCheck: parseInt(threadCheckEl.value)
    };
    chrome.storage.local.set({ timings });
  }

  // Toggle button click
  toggleBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'toggle' }, (response) => {
      if (response) {
        updateUI(response.isActive);
      }
    });
  });

  // Hotkey recording
  hotkeyLockEl.addEventListener('click', () => startRecording(hotkeyLockEl));
  hotkeyFocusEl.addEventListener('click', () => startRecording(hotkeyFocusEl));
  hotkeySubmitEl.addEventListener('click', () => startRecording(hotkeySubmitEl));
  hotkeyDeleteEl.addEventListener('click', () => startRecording(hotkeyDeleteEl));

  function startRecording(element) {
    if (recordingElement) {
      recordingElement.classList.remove('recording');
    }
    recordingElement = element;
    element.classList.add('recording');
    element.textContent = 'Pulsa tecla...';
  }

  document.addEventListener('keydown', (e) => {
    if (!recordingElement) return;

    e.preventDefault();
    e.stopPropagation();

    // Cancel on Escape without modifiers
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      // If recording toggleLock, Escape IS the hotkey, otherwise cancel
      if (recordingElement.dataset.key !== 'toggleLock') {
        cancelRecording();
        return;
      }
    }

    // Ignore lone modifier keys
    if (['Control', 'Alt', 'Meta', 'Shift'].includes(e.key)) {
      return;
    }

    const hotkey = {
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      shift: e.shiftKey
    };

    saveHotkey(recordingElement.dataset.key, hotkey);
    updateHotkeyDisplay(recordingElement, hotkey);
    recordingElement.classList.remove('recording');
    recordingElement = null;
  });

  function cancelRecording() {
    if (!recordingElement) return;
    chrome.storage.local.get(['hotkeys'], (result) => {
      const hotkeys = result.hotkeys || defaultHotkeys;
      const key = recordingElement.dataset.key;
      updateHotkeyDisplay(recordingElement, hotkeys[key] || defaultHotkeys[key]);
      recordingElement.classList.remove('recording');
      recordingElement = null;
    });
  }

  function saveHotkey(name, hotkey) {
    chrome.storage.local.get(['hotkeys'], (result) => {
      const hotkeys = result.hotkeys || { ...defaultHotkeys };
      hotkeys[name] = hotkey;
      chrome.storage.local.set({ hotkeys });
    });
  }

  function updateHotkeyDisplay(element, hotkey) {
    const parts = [];
    if (hotkey.ctrl) parts.push('Ctrl');
    if (hotkey.alt) parts.push('Alt');
    if (hotkey.meta) parts.push(isMac ? 'Cmd' : 'Win');
    if (hotkey.shift) parts.push('Shift');

    let keyName = hotkey.key;
    if (keyName === ' ') keyName = 'Space';
    else if (keyName.length === 1) keyName = keyName.toUpperCase();

    parts.push(keyName);
    element.textContent = parts.join('+');
  }

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
