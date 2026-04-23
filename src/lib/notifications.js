const STORAGE_PREFIX = "chat_notification_prefs";

const DEFAULT_PREFS = {
  desktop: true,
  sound: true
};

export function loadNotificationPrefs(scope) {
  const key = `${STORAGE_PREFIX}:${scope}`;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return {
      desktop: parsed?.desktop !== false,
      sound: parsed?.sound !== false
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveNotificationPrefs(scope, prefs) {
  const key = `${STORAGE_PREFIX}:${scope}`;
  localStorage.setItem(key, JSON.stringify({ desktop: !!prefs.desktop, sound: !!prefs.sound }));
}

export async function ensureDesktopPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const result = await Notification.requestPermission();
    return result === "granted";
  } catch {
    return false;
  }
}

export async function showDesktopNotification({ title, body, tag, url }) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  
  try {
    const registration = await navigator.serviceWorker.ready;
    if (registration) {
      await registration.showNotification(String(title || "New message"), {
        body: String(body || ""),
        tag: String(tag || "chat-now-msg"),
        icon: "./icons/icon-192.svg",
        badge: "./icons/icon-192.svg",
        data: { url: url || window.location.hash },
        vibrate: [100, 50, 100],
        silent: true
      });
    }
  } catch (err) {
    console.warn("Service Worker notification failed:", err);
    // Fallback to standard Notification for non-PWA environments
    try {
      new Notification(String(title || "New message"), {
        body: String(body || ""),
        tag: String(tag || "chat-now-msg"),
        silent: true
      });
    } catch {}
  }
}

let audioContext = null;

export async function playNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    if (audioContext.state === "suspended") await audioContext.resume();

    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(880, now);

    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.22);
  } catch {
    // Some browsers block autoplay audio until explicit gesture.
  }
}
