// Offscreen document for playing notification sounds
// This runs independently of any tab, ensuring consistent audio playback

let audioContext = null;

// Initialize audio context on first use
function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  // Resume if suspended
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

// Pole conseguida - triumphant ascending arpeggio (major chord: C-E-G feel)
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

// Pole fallada - sad descending sound (minor feel)
function playFailSound() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  // Descending minor third: disappointing but not annoying
  const frequencies = [880, 698]; // A5 down to F5 (minor third down)
  const duration = 0.12;
  const gap = 0.06;

  frequencies.forEach((freq, i) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'sine'; // Softer for the sad sound
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

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'playSound' || message.action === 'playNewThreadSound') {
    playNewThreadSound();
    sendResponse({ success: true });
  } else if (message.action === 'playSuccessSound') {
    playSuccessSound();
    sendResponse({ success: true });
  } else if (message.action === 'playFailSound') {
    playFailSound();
    sendResponse({ success: true });
  }
  return true;
});

console.log('Polileo: Offscreen document ready for audio playback');
