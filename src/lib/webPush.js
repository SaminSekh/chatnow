/**
 * Web Push Subscription Manager
 *
 * Uses the browser's native Push API with VAPID keys.
 * No third-party push service needed — push delivery goes through
 * the browser vendor's push service (FCM for Chrome, Mozilla for Firefox, etc.)
 * which are all free.
 *
 * Flow:
 *  1. On login, call initWebPush(userId) — requests permission + subscribes
 *  2. The PushSubscription object is saved to Supabase push_subscriptions table
 *  3. When a message is sent, a Supabase Edge Function reads subscriptions for
 *     the recipient and sends a Web Push notification via the web-push protocol
 *  4. The service worker receives the push and shows the notification even when
 *     the app tab is closed or the user is away
 */

const STORAGE_KEY = "web_push_user_id";

/**
 * Convert a base64url VAPID public key to a Uint8Array
 * required by pushManager.subscribe()
 */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/**
 * Get the VAPID public key from app config
 */
function getVapidPublicKey() {
  return String(window.__APP_CONFIG__?.VAPID_PUBLIC_KEY || "").trim();
}

/**
 * Check if Web Push is supported in this browser
 */
export function isPushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Get the current push subscription if one exists
 */
export async function getCurrentSubscription() {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Subscribe to push notifications and return the subscription object.
 * Returns null if permission denied or push not supported.
 */
export async function subscribeToPush() {
  if (!isPushSupported()) {
    console.warn("[WebPush] Push not supported in this browser");
    return null;
  }

  const vapidKey = getVapidPublicKey();
  if (!vapidKey) {
    console.warn("[WebPush] VAPID_PUBLIC_KEY not set in app.config.js — push disabled");
    return null;
  }

  // Request notification permission
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    console.warn("[WebPush] Notification permission denied");
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.ready;

    // Reuse existing subscription if already subscribed
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
      });
    }

    return subscription;
  } catch (err) {
    console.error("[WebPush] Subscribe failed:", err);
    return null;
  }
}

/**
 * Unsubscribe from push notifications
 */
export async function unsubscribeFromPush() {
  const subscription = await getCurrentSubscription();
  if (!subscription) return false;
  try {
    await subscription.unsubscribe();
    return true;
  } catch (err) {
    console.error("[WebPush] Unsubscribe failed:", err);
    return false;
  }
}

/**
 * Initialize Web Push for a logged-in user.
 * Subscribes the browser and saves the subscription to Supabase.
 *
 * @param {string} userId - The authenticated user's ID
 * @param {Function} saveFn - async (userId, subscriptionJson) => void
 */
export async function initWebPush(userId, saveFn) {
  if (!isPushSupported()) return;
  if (!getVapidPublicKey()) return;

  try {
    const subscription = await subscribeToPush();
    if (!subscription) return;

    const subJson = subscription.toJSON();
    // Persist userId so the SW can reference it on push events
    localStorage.setItem(STORAGE_KEY, userId);

    await saveFn(userId, subJson);
    console.log("[WebPush] Subscription saved for user:", userId);
  } catch (err) {
    console.warn("[WebPush] initWebPush failed:", err);
  }
}

/**
 * Remove push subscription for a user on sign-out
 *
 * @param {string} userId
 * @param {Function} removeFn - async (userId, endpoint) => void
 */
export async function cleanupWebPush(userId, removeFn) {
  try {
    const subscription = await getCurrentSubscription();
    if (subscription) {
      await removeFn(userId, subscription.endpoint);
      await subscription.unsubscribe();
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn("[WebPush] cleanupWebPush failed:", err);
  }
}
