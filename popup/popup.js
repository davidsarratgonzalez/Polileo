document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const statusEl = document.getElementById('status');
  const antifailDefaultEl = document.getElementById('antifailDefault');
  const hotkeyLockEl = document.getElementById('hotkeyLock');
  const hotkeyFocusEl = document.getElementById('hotkeyFocus');
  const hotkeySubmitEl = document.getElementById('hotkeySubmit');

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  // Default hotkeys
  const defaultHotkeys = {
    toggleLock: { key: 'Escape', ctrl: false, alt: false, meta: false, shift: false },
    focusReply: { key: 'r', ctrl: false, alt: false, meta: false, shift: false },
    submitReply: isMac
      ? { key: 's', ctrl: false, alt: false, meta: true, shift: false }
      : { key: 's', ctrl: false, alt: true, meta: false, shift: false }
  };

  let recordingElement = null;

  // Get initial status
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
      updateUI(response.isActive);
    }
  });

  // Load settings
  chrome.storage.local.get(['antifailDefault', 'hotkeys'], (result) => {
    antifailDefaultEl.checked = result.antifailDefault !== false;

    const hotkeys = result.hotkeys || defaultHotkeys;
    updateHotkeyDisplay(hotkeyLockEl, hotkeys.toggleLock || defaultHotkeys.toggleLock);
    updateHotkeyDisplay(hotkeyFocusEl, hotkeys.focusReply || defaultHotkeys.focusReply);
    updateHotkeyDisplay(hotkeySubmitEl, hotkeys.submitReply || defaultHotkeys.submitReply);
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

  // Hotkey recording
  hotkeyLockEl.addEventListener('click', () => startRecording(hotkeyLockEl));
  hotkeyFocusEl.addEventListener('click', () => startRecording(hotkeyFocusEl));
  hotkeySubmitEl.addEventListener('click', () => startRecording(hotkeySubmitEl));

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
