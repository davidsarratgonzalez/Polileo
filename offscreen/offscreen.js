/**
 * Polileo - Offscreen Document (Audio Playback)
 *
 * Runs as a Manifest V3 offscreen document dedicated to playing notification sounds.
 * Uses Web Audio API (AudioContext + oscillators) for lightweight synthesized audio.
 *
 * Sound types:
 * - New thread: Two quick pips (neutral alert)
 * - Success: Ascending major arpeggio (pole achieved)
 * - Not pole: Descending minor chord (your attempt failed)
 * - Pole detected: Two descending tones (someone else got pole)
 *
 * Resilience:
 * - safePlay() wraps all sound calls: reports true/false to background (not just delivery)
 * - On AudioContext failure: auto-recreates context for the next attempt
 * - Global error/unhandledrejection handlers prevent document crashes
 * - Background retries sound up to 2x if this document reports failure
 * - Background auto-recreates this document if it dies (health check + on-demand)
 */

let audioContext = null;

// Initialize audio context on first use
function getAudioContext() {
  // Recreate if closed (system revoked audio resources) or not yet created
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  // Resume if suspended (e.g., browser autoplay policy)
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return audioContext;
}

// New thread found - neutral alert, two quick pips
function playNewThreadSound() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  const frequencies = [1300, 1300];
  const duration = 0.05;
  const gap = 0.03;

  frequencies.forEach((freq, i) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'square';
    oscillator.frequency.value = freq;

    const startTime = now + (i * (duration + gap));
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.15, startTime + 0.003);
    gainNode.gain.setValueAtTime(0.15, startTime + duration * 0.7);
    gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  });
}

// Pole achieved - triumphant ascending arpeggio (major chord: C-E-G feel)
function playSuccessSound() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  // Major chord ascending: ~C5, E5, G5 (triumphant feel)
  const frequencies = [523, 659, 784];
  const duration = 0.08;
  const gap = 0.04;

  frequencies.forEach((freq, i) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'sine'; // Cleaner, more pleasant for success
    oscillator.frequency.value = freq;

    const startTime = now + (i * (duration + gap));
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.2, startTime + 0.005);
    gainNode.gain.setValueAtTime(0.2, startTime + duration * 0.6);
    gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  });
}

// Your post was not pole - sad descending sound (you tried and failed)
// More dramatic: G4-Eb4-C4 descending minor chord
function playNotPoleSound() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  // Descending minor: G4-Eb4-C4 (disappointed feel, you tried and failed)
  const frequencies = [392, 311, 262];
  const duration = 0.12;
  const gap = 0.05;

  frequencies.forEach((freq, i) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.value = freq;

    const startTime = now + (i * (duration + gap));
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.18, startTime + 0.008);
    gainNode.gain.setValueAtTime(0.18, startTime + duration * 0.5);
    gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  });
}

// Someone else got the pole - informational alert (detection, not your attempt)
// Two quick descending tones: different from new thread sound
function playPoleDetectedSound() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  // Two descending tones: F5-D5 (informational, someone else got it)
  const frequencies = [698, 587];
  const duration = 0.08;
  const gap = 0.04;

  frequencies.forEach((freq, i) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'triangle'; // Softer, more neutral
    oscillator.frequency.value = freq;

    const startTime = now + (i * (duration + gap));
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.15, startTime + 0.005);
    gainNode.gain.setValueAtTime(0.15, startTime + duration * 0.6);
    gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  });
}

// Safe wrapper — returns true if sound played, false if error
function safePlay(fn) {
  try {
    fn();
    return true;
  } catch (e) {
    console.log('Polileo Offscreen: Sound error:', e.message);
    // Try to recover AudioContext for next attempt
    try {
      audioContext = new AudioContext();
    } catch { /* give up */ }
    return false;
  }
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const soundMap = {
    'playSound': playNewThreadSound,
    'playNewThreadSound': playNewThreadSound,
    'playSuccessSound': playSuccessSound,
    'playNotPoleSound': playNotPoleSound,
    'playPoleDetectedSound': playPoleDetectedSound
  };

  const fn = soundMap[message.action];
  if (fn) {
    const ok = safePlay(fn);
    sendResponse({ success: ok });
    return;
  }
  // Unknown action — don't hold the message channel open
});

// Prevent unhandled errors from crashing the offscreen document
window.addEventListener('error', (e) => {
  console.log('Polileo Offscreen: Uncaught error:', e.message);
  e.preventDefault();
});
window.addEventListener('unhandledrejection', (e) => {
  console.log('Polileo Offscreen: Unhandled rejection:', e.reason);
  e.preventDefault();
});

console.log('Polileo: Offscreen document ready for audio playback');
