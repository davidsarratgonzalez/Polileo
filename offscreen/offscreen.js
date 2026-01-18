// Offscreen document for playing notification sounds
// This runs independently of any tab, ensuring consistent audio playback

let audioContext = null;

// Initialize audio context on first use
function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

// Play an attention-grabbing "pip-pip-pip" notification sound
function playNotificationSound() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  // Resume context if suspended (browser autoplay policies)
  if (ctx.state === 'suspended') {
    ctx.resume();
  }

  // Two quick ascending pips - energetic and attention-grabbing
  const frequencies = [800, 1100]; // Ascending pattern
  const duration = 0.05;
  const gap = 0.03;

  frequencies.forEach((freq, i) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Square wave is more piercing/attention-grabbing than sine
    oscillator.type = 'square';
    oscillator.frequency.value = freq;

    const startTime = now + (i * (duration + gap));

    // Punchy envelope
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.15, startTime + 0.003); // Instant attack
    gainNode.gain.setValueAtTime(0.15, startTime + duration * 0.7);
    gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  });
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'playSound') {
    playNotificationSound();
    sendResponse({ success: true });
  }
  return true;
});

console.log('Polileo: Offscreen document ready for audio playback');
