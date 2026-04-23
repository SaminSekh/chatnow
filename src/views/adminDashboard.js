import { MESSAGE_TYPES } from "../lib/constants.js";
import { getMessagePreview } from "../lib/messagePreview.js";
import {
  ensureDesktopPermission,
  loadNotificationPrefs,
  playNotificationSound,
  saveNotificationPrefs,
  showDesktopNotification
} from "../lib/notifications.js";
import { escapeHtml, formatDateTime, isLikelyUrl, parseError, showToast, openProfileLightbox } from "../lib/ui.js";
import {
  broadcastConversationEvent,
  clearConversationMessages,
  ensureConversationForAdmin,
  ensureDirectConversation,
  ensureSupportConversation,
  findProfileByUsername,
  getAdminById,
  getConversationMessages,
  getDashboardCounts,
  getDirectMessages,
  getSupportMessages,
  listAdminConversations,
  listAdminSubscriptions,
  listLatestConversationMessages,
  listPaymentMethods,
  listPayments,
  listProfilesByConversationWithAdmin,
  listUnifiedConversations,
  listUnifiedLatestMessages,
  listUnifiedUnreadCounts,
  listUnreadConversationCounts,
  markConversationRead,
  markDirectConversationRead,
  removeChannel,
  sendBulkMessage,
  sendDirectMessage,
  sendMessage,
  sendSupportMessage,
  submitPayment,
  subscribeToConversationMessages,
  subscribeToDirectMessages,
  subscribeToSupportMessages,
  updatePassword,
  updateProfile,
  uploadAvatar,
  deleteDirectConversation,
  deleteSupportConversation,
  uploadChatMedia,
  uploadVoiceBlob
} from "../services/supabaseApi.js";
import { createVoiceRecorder, renderMessageList, scrollMessagesToBottom } from "./chatUi.js";
import { initWebPush, cleanupWebPush } from "../lib/webPush.js";
import { savePushSubscription, removePushSubscription } from "../services/supabaseApi.js";

export async function renderAdminDashboard({ root, profile, installAvailable, onInstall, onSignOut }) {
  let counts = {};
  let adminMeta = null;
  let conversations = [];
  let contacts = [];
  let activeConversationId = null;
  let activeMessages = [];
  let messageChannel = null;
  let messagePoll = null;
  let messagesSidebarOpen = false;
  let conversationQuery = "";
  let chatSearchOpen = false;
  let chatSearchQuery = "";
  let activeTool = "messages";
  let mobileMessagesFocused = false;
  const hiddenChatIds = new Set(JSON.parse(localStorage.getItem(`hidden_chats:${profile.id}`) || "[]"));

  function unhideConversation(id) {
    if (hiddenChatIds.has(id)) {
      hiddenChatIds.delete(id);
      localStorage.setItem(`hidden_chats:${profile.id}`, JSON.stringify([...hiddenChatIds]));
    }
  }

  let subscriptions = [];
  let paymentMethods = [];
  let payments = [];

  let supportConversationId = null;
  let supportMessages = [];
  let supportChannel = null;
  let supportPoll = null;
  let conversationPoll = null;
  let peerTyping = false;
  let localTyping = false;
  let localTypingTimeout = null;
  let typingEchoTimeout = null;
  let lastTypingBroadcastAt = 0;
  let peerConnection = null;
  let localStream = null;
  let pendingIceCandidates = [];
  let callStartTime = null;
  let callTimerInterval = null;
  let outgoingRingAudio = null;
  let incomingRingAudio = null;
  let currentCallConversationId = null;
  let voicePulseCleanup = null;
  let peerInstance = null;
  let activeCall = null;
  let isVideoCall = false;
  const clearedConversationIds = new Set();
 
  async function ensureAudioUnlocked() {
    try {
      if (window._audioCtx && window._audioCtx.state !== "closed") {
        if (window._audioCtx.state === "suspended") await window._audioCtx.resume();
        return;
      }
      window._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await window._audioCtx.resume();
    } catch (e) {
      console.warn("Audio unlock failed:", e);
    }
  }
  const typingByConversation = new Map();
  const typingTimeoutByConversation = new Map();
  const conversationWatchChannels = new Map();
  const TYPING_IDLE_MS = 1400;
  const TYPING_REMOTE_TTL_MS = 1800;
  const TYPING_HEARTBEAT_MS = 500;

  const conversationMeta = new Map();
  const knownMessageIds = new Set();
  const deliveredMessageIds = new Set();
  const notificationScope = `admin:${profile.id}`;
  let notificationPrefs = loadNotificationPrefs(notificationScope);
  if ("Notification" in window && Notification.permission === "denied" && notificationPrefs.desktop) {
    notificationPrefs.desktop = false;
    saveNotificationPrefs(notificationScope, notificationPrefs);
  }

  function getConversationName(conv) {
    if (conv?.peer_name) return conv.peer_name;
    const p = conv?.peer || conv?.user;
    return p?.full_name || p?.username || "User";
  }

  function getConversationInitial(conversation) {
    const name = String(getConversationName(conversation) || "").trim();
    return (name.charAt(0) || "?").toUpperCase();
  }

  function isMobileViewport() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  function updateShellMobileState() {
    const shell = root.querySelector("#admin-shell");
    if (!shell) return;
    const hideRail = isMobileViewport() && activeTool === "messages" && mobileMessagesFocused;
    shell.classList.toggle("admin-mobile-chat-focus", hideRail);
  }

  function setRailActive(tool) {
    root.querySelectorAll("#admin-icon-rail [data-tool]").forEach((x) => {
      x.classList.toggle("active", x.dataset.tool === tool);
    });
  }

  function getDisplayedMessages() {
    const query = String(chatSearchQuery || "").trim().toLowerCase();
    if (!query) return activeMessages;
    return activeMessages.filter((message) => {
      const content = String(message?.content || "").toLowerCase();
      const kind = String(message?.message_type || "").toLowerCase();
      return content.includes(query) || kind.includes(query);
    });
  }

  function getFilteredConversations() {
    const query = String(conversationQuery || "").trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (hiddenChatIds.has(conversation.id)) return false;
      if (!query) return true;
      const name = getConversationName(conversation).toLowerCase();
      const meta = getConversationMeta(conversation.id);
      const preview = String(meta.preview || "").toLowerCase();
      return name.includes(query) || preview.includes(query);
    });
  }

  function getConversationMeta(conversationId) {
    return (
      conversationMeta.get(conversationId) || {
        preview: "No messages yet.",
        updatedAt: null,
        unreadCount: 0,
        lastMessageId: null
      }
    );
  }

  function setConversationMeta(conversationId, patch) {
    const current = getConversationMeta(conversationId);
    conversationMeta.set(conversationId, { ...current, ...patch });
  }

  function sortConversationsByRecent() {
    conversations.sort((a, b) => {
      const aMeta = getConversationMeta(a.id);
      const bMeta = getConversationMeta(b.id);
      const aTime = new Date(aMeta.updatedAt || a.updated_at || a.created_at || 0).getTime();
      const bTime = new Date(bMeta.updatedAt || b.updated_at || b.created_at || 0).getTime();
      return bTime - aTime;
    });
  }

  function applyMessageMeta(message, { markUnread = false } = {}) {
    if (!message?.conversation_id) return;
    const prev = getConversationMeta(message.conversation_id);
    const unreadCount = markUnread ? (prev.unreadCount || 0) + 1 : prev.unreadCount || 0;
    setConversationMeta(message.conversation_id, {
      preview: getMessagePreview(message),
      updatedAt: message.created_at || new Date().toISOString(),
      lastMessageId: message.id || prev.lastMessageId || null,
      unreadCount
    });
    if (message.id) knownMessageIds.add(message.id);
    sortConversationsByRecent();
  }

  function clearUnreadForConversation(conversationId) {
    const prev = getConversationMeta(conversationId);
    setConversationMeta(conversationId, { ...prev, unreadCount: 0 });
  }

  function isActiveConversationAtLatest() {
    const list = root.querySelector("#msg-list");
    if (!list) return false;
    return list.dataset.autoScrollFollow !== "false";
  }

  async function syncActiveConversationReadState() {
    if (!activeConversationId) return;
    if (!isActiveConversationAtLatest()) return;
    const meta = getConversationMeta(activeConversationId);
    if (!Number(meta.unreadCount || 0)) return;
    clearUnreadForConversation(activeConversationId);
    const convList = root.querySelector("#conv-list");
    if (convList) renderSidebarPanel(convList);
    await markConversationRead(activeConversationId, profile.id);
  }

  function renderTypingIndicator() {
    const el = root.querySelector("#msg-typing-indicator");
    const sub = root.querySelector("#msg-header-subtitle");
    if (!el) return;
    if (peerTyping) {
      el.textContent = "typing...";
      el.classList.add("active");
      if (sub) sub.classList.add("hidden");
    } else {
      el.textContent = "";
      el.classList.remove("active");
      if (sub) sub.classList.remove("hidden");
    }
  }

  function setPeerTyping(value) {
    peerTyping = !!value;
    renderTypingIndicator();
  }

  function setConversationTyping(conversationId, isTyping) {
    if (!conversationId) return;
    if (isTyping) {
      typingByConversation.set(conversationId, true);
      const existing = typingTimeoutByConversation.get(conversationId);
      if (existing) clearTimeout(existing);
      const timeoutId = setTimeout(() => {
        typingByConversation.delete(conversationId);
        typingTimeoutByConversation.delete(conversationId);
        if (conversationId === activeConversationId) setPeerTyping(false);
        const convList = root.querySelector("#conv-list");
        if (convList) renderSidebarPanel(convList);
      }, TYPING_REMOTE_TTL_MS);
      typingTimeoutByConversation.set(conversationId, timeoutId);
    } else {
      typingByConversation.delete(conversationId);
      const existing = typingTimeoutByConversation.get(conversationId);
      if (existing) clearTimeout(existing);
      typingTimeoutByConversation.delete(conversationId);
    }
  }

  function handleTypingEvent(payload) {
    if (!payload || payload.senderId === profile.id) return;
    const conversationId = payload.conversationId;
    if (!conversationId) return;
    if (payload.isTyping) {
      setConversationTyping(conversationId, true);
      if (conversationId === activeConversationId) {
        setPeerTyping(true);
        clearTimeout(typingEchoTimeout);
        typingEchoTimeout = setTimeout(() => setPeerTyping(false), TYPING_REMOTE_TTL_MS);
      }
    } else {
      setConversationTyping(conversationId, false);
      if (conversationId === activeConversationId) {
        setPeerTyping(false);
      }
    }
    const convList = root.querySelector("#conv-list");
    if (convList) renderSidebarPanel(convList);
  }

  async function publishTypingState(isTyping, force = false) {
    if (!activeConversationId || !messageChannel) return;
    if (isTyping) {
      const now = Date.now();
      if (!localTyping || force || now - lastTypingBroadcastAt >= TYPING_HEARTBEAT_MS) {
        await broadcastConversationEvent(messageChannel, "typing", {
          conversationId: activeConversationId,
          senderId: profile.id,
          isTyping: true
        });
        lastTypingBroadcastAt = now;
      }
      localTyping = true;
      clearTimeout(localTypingTimeout);
      localTypingTimeout = setTimeout(() => {
        publishTypingState(false, true).catch(() => { });
      }, TYPING_IDLE_MS);
      return;
    }
    if (!localTyping && !force) return;
    localTyping = false;
    clearTimeout(localTypingTimeout);
    await broadcastConversationEvent(messageChannel, "typing", {
      conversationId: activeConversationId,
      senderId: profile.id,
      isTyping: false
    });
    lastTypingBroadcastAt = Date.now();
  }

  async function publishInstantMessage(message) {
    if (!activeConversationId || !messageChannel || !message) return;
    await broadcastConversationEvent(messageChannel, "instant-message", {
      conversationId: activeConversationId,
      message
    });
  }

  function resetTypingState() {
    clearTimeout(typingEchoTimeout);
    clearTimeout(localTypingTimeout);
    localTyping = false;
    lastTypingBroadcastAt = 0;
    setPeerTyping(false);
    for (const timeoutId of typingTimeoutByConversation.values()) {
      clearTimeout(timeoutId);
    }
    typingTimeoutByConversation.clear();
    typingByConversation.clear();
  }

  function resetActiveTypingState() {
    clearTimeout(typingEchoTimeout);
    clearTimeout(localTypingTimeout);
    localTyping = false;
    lastTypingBroadcastAt = 0;
    setPeerTyping(false);
    setConversationTyping(activeConversationId, false);
  }

  function markMessageDelivered(messageId) {
    if (!messageId || deliveredMessageIds.has(messageId)) return;
    deliveredMessageIds.add(messageId);
    const list = root.querySelector("#msg-list");
    if (list) {
      renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
    }
  }

  async function sendDeliveryAck(channelRef, message) {
    if (!message?.id || !message?.conversation_id || message.sender_id === profile.id) return;
    await broadcastConversationEvent(channelRef, "message-delivered", {
      conversationId: message.conversation_id,
      messageId: message.id,
      recipientId: profile.id
    });
  }

  function handleDeliveryEvent(payload) {
    if (!payload?.messageId || payload.recipientId === profile.id) return;
    markMessageDelivered(payload.messageId);
  }

  async function maybeNotifyIncomingMessage(message, conversation) {
    if (!message || message.sender_id === profile.id) return;

    if (notificationPrefs.sound) {
      await playNotificationSound();
    }

    if (!notificationPrefs.desktop) return;
    if (document.visibilityState === "visible" && message.conversation_id === activeConversationId) return;

    const label = getConversationName(conversation);
    showDesktopNotification({
      title: `New message from ${label}`,
      body: getMessagePreview(message),
      tag: `admin-chat-${message.conversation_id}`
    });
  }

  async function handleSidebarIncomingMessage(message, channelRef = null) {
    if (!message || !message.conversation_id) return;
    unhideConversation(message.conversation_id);
    if (message.conversation_id === activeConversationId) return;
    if (message.id && knownMessageIds.has(message.id)) return;
    if (message.id) knownMessageIds.add(message.id);

    setConversationTyping(message.conversation_id, false);
    applyMessageMeta(message, { markUnread: message.sender_id !== profile.id });
    const conversation = conversations.find((item) => item.id === message.conversation_id);
    if (message.sender_id !== profile.id) {
      await sendDeliveryAck(channelRef, message);
      await maybeNotifyIncomingMessage(message, conversation);
    }
    const convList = root.querySelector("#conv-list");
    if (convList) renderSidebarPanel(convList);
  }

  async function syncConversationWatchChannels() {
    const validIds = new Set(conversations.map((c) => c.id));
    for (const [conversationId, channel] of conversationWatchChannels.entries()) {
      if (!validIds.has(conversationId) || conversationId === activeConversationId) {
        await removeChannel(channel);
        conversationWatchChannels.delete(conversationId);
        // Clean up any stale typing state for removed conversations
        const existingTimeout = typingTimeoutByConversation.get(conversationId);
        if (existingTimeout) clearTimeout(existingTimeout);
        typingTimeoutByConversation.delete(conversationId);
        typingByConversation.delete(conversationId);
      }
    }

    for (const conversation of conversations) {
      if (conversation.id === activeConversationId) continue;
      if (conversationWatchChannels.has(conversation.id)) continue;
      const subFn = conversation.type === "direct" ? subscribeToDirectMessages : subscribeToConversationMessages;
      let watchChannel = null;
      watchChannel = subFn(
        conversation.id,
        async (message) => {
          await handleSidebarIncomingMessage(message, watchChannel);
        },
        {
          onTyping: (payload) => handleTypingEvent(payload),
          onInstantMessage: async (payload) => {
            await handleSidebarIncomingMessage(payload.message, watchChannel);
          },
          onDelivery: (payload) => handleDeliveryEvent(payload),
          onCallRequest: (payload) => handleIncomingCall(payload, watchChannel),
          onCallAccept: (payload) => handleCallAccepted(payload),
          onCallDecline: (payload) => handleCallDeclined(payload),
          onCallEnd: (payload) => handleCallEnded(payload),
          onConversationDeleted: async () => {
            conversations = conversations.filter(c => c.id !== conversation.id);
            if (activeConversationId === conversation.id) {
              activeConversationId = null;
              stopMessagePoll();
            }
            await syncConversationMeta({ notify: false });
            await renderMessagesTab();
            showToast("A conversation has been deleted.");
          }
        }
      );
      conversationWatchChannels.set(conversation.id, watchChannel);
    }
  }

  async function syncConversationMeta({ notify = false } = {}) {
    conversations = await listUnifiedConversations(profile.id, "admin");
    const ids = conversations.map((c) => c.id);
    const types = Object.fromEntries(conversations.map((c) => [c.id, c.type]));

    if (!ids.length) {
      conversationMeta.clear();
      return;
    }

    const [latestMessages, unreadCounts] = await Promise.all([
      listUnifiedLatestMessages(ids, types),
      listUnifiedUnreadCounts(ids, profile.id, types)
    ]);

    const latestByConversation = new Map((latestMessages || []).map((item) => [item.conversation_id, item]));
    const unreadByConversation = new Map((unreadCounts || []).map((item) => [item.conversation_id, item.unread_count]));
    const currentIds = new Set(ids);

    for (const id of [...conversationMeta.keys()]) {
      if (!currentIds.has(id)) {
        conversationMeta.delete(id);
        setConversationTyping(id, false);
      }
    }

    for (const conv of conversations) {
      const latest = latestByConversation.get(conv.id);
      const previous = getConversationMeta(conv.id);
      const isActive = conv.id === activeConversationId;
      const isVisibleLatest = isActiveConversationAtLatest();
      const serverUnread = unreadByConversation.get(conv.id) || 0;
      const unreadCount = isActive ? (isVisibleLatest ? 0 : Math.max(previous.unreadCount || 0, serverUnread)) : serverUnread;

      if (latest && latest.id !== previous.lastMessageId) {
        unhideConversation(conv.id);
      }

      const next = {
        preview: latest ? getMessagePreview(latest) : "No messages yet.",
        updatedAt: latest?.created_at || conv.updated_at || conv.created_at,
        unreadCount,
        lastMessageId: latest?.id || null
      };
      conversationMeta.set(conv.id, next);

      if (latest?.id && !knownMessageIds.has(latest.id)) {
        if (notify && latest.sender_id !== profile.id) {
          await maybeNotifyIncomingMessage(latest, conv);
          knownMessageIds.add(latest.id);
        } else {
          knownMessageIds.add(latest.id);
        }
      }
    }

    sortConversationsByRecent();
    await syncConversationWatchChannels();
    const convList = root.querySelector("#conv-list");
    if (convList) renderSidebarPanel(convList);
  }

  function startConversationPoll() {
    stopConversationPoll();
    conversationPoll = setInterval(async () => {
      try {
        await syncConversationMeta({ notify: true });
      } catch (error) {
        console.warn("Conversation poll failed:", error);
      }
    }, 3000);
  }

  function stopConversationPoll() {
    if (conversationPoll) {
      clearInterval(conversationPoll);
      conversationPoll = null;
    }
  }

  async function loadData() {
    [counts, contacts, subscriptions, paymentMethods, payments, adminMeta] = await Promise.all([
      getDashboardCounts(profile.id, "admin"),
      listProfilesByConversationWithAdmin(profile.id),
      listAdminSubscriptions(profile.id),
      listPaymentMethods(true),
      listPayments({ adminId: profile.id }),
      getAdminById(profile.id)
    ]);
    // Pre-set activeConversationId BEFORE syncConversationMeta so that
    // syncConversationWatchChannels skips it from the start and never
    // creates a channel we'd immediately conflict with in openConversation.
    const [firstConv] = (await listUnifiedConversations(profile.id, "admin"));
    if (!activeConversationId && firstConv) {
      activeConversationId = firstConv.id;
    }
    await syncConversationMeta({ notify: false });
    if (activeConversationId) {
      await openConversation(activeConversationId);
    }
    try {
      supportConversationId = await ensureSupportConversation();
      supportMessages = await getSupportMessages(supportConversationId);
      await reconnectSupportChannel();
    } catch {
      supportConversationId = null;
    }
  }

  async function openConversation(conversationId) {
    await publishTypingState(false);
    resetActiveTypingState();
    activeConversationId = conversationId;
    const conv = conversations.find((c) => c.id === conversationId);
    const isDirect = conv?.type === "direct";

    const existingWatch = conversationWatchChannels.get(conversationId);
    if (existingWatch) {
      await removeChannel(existingWatch);
      conversationWatchChannels.delete(conversationId);
    }

    activeMessages = isDirect ? await getDirectMessages(conversationId) : await getConversationMessages(conversationId);
    for (const message of activeMessages) {
      if (message?.id) knownMessageIds.add(message.id);
      if (message?.is_read) deliveredMessageIds.add(message.id);
    }
    const last = activeMessages[activeMessages.length - 1];
    if (last) {
      applyMessageMeta(last, { markUnread: false });
    }
    clearUnreadForConversation(conversationId);
    if (isDirect) {
      await markDirectConversationRead(conversationId, profile.id);
    } else {
      await markConversationRead(conversationId, profile.id);
    }
    clearUnreadForConversation(conversationId);
    await reconnectMessageChannel();
    await syncConversationWatchChannels();
    startMessagePoll();
    const convList = root.querySelector("#conv-list");
    if (convList) renderSidebarPanel(convList);
  }

  async function refreshConversationMessages() {
    if (!activeConversationId) return;
    // Don't re-load messages for conversations that were cleared
    if (clearedConversationIds.has(activeConversationId)) return;
    const conv = conversations.find((c) => c.id === activeConversationId);
    const isDirect = conv?.type === "direct";
    const latest = isDirect ? await getDirectMessages(activeConversationId) : await getConversationMessages(activeConversationId);
    const isVisibleLatest = isActiveConversationAtLatest();
    const previousUnread = Number(getConversationMeta(activeConversationId).unreadCount || 0);
    let newHiddenIncomingCount = 0;
    for (const message of latest) {
      if (message?.id && !knownMessageIds.has(message.id) && message.sender_id !== profile.id) {
        await maybeNotifyIncomingMessage(message, conv);
        if (!isVisibleLatest) newHiddenIncomingCount += 1;
      }
      if (message?.id) knownMessageIds.add(message.id);
      if (message?.is_read) deliveredMessageIds.add(message.id);
    }
    activeMessages = latest;
    const last = latest[latest.length - 1];
    if (last) {
      setConversationMeta(activeConversationId, {
        preview: getMessagePreview(last),
        updatedAt: last.created_at || new Date().toISOString(),
        lastMessageId: last.id || null,
        unreadCount: isVisibleLatest ? 0 : previousUnread + newHiddenIncomingCount
      });
      sortConversationsByRecent();
    }
    if (isVisibleLatest && (previousUnread > 0 || newHiddenIncomingCount > 0)) {
      if (isDirect) await markDirectConversationRead(activeConversationId, profile.id);
      else await markConversationRead(activeConversationId, profile.id);
    }
    const list = root.querySelector("#msg-list");
    if (list) {
      renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
      scrollMessagesToBottom(list);
    }
    const convList = root.querySelector("#conv-list");
    if (convList) renderSidebarPanel(convList);
  }

  function startMessagePoll() {
    stopMessagePoll();
    if (!activeConversationId) return;
    messagePoll = setInterval(async () => {
      try {
        await refreshConversationMessages();
      } catch (error) {
        console.warn("Message poll failed:", error);
      }
    }, 3000);
  }

  function stopMessagePoll() {
    if (messagePoll) {
      clearInterval(messagePoll);
      messagePoll = null;
    }
  }

  async function reconnectMessageChannel() {
    const prevChannel = messageChannel;
    messageChannel = null;
    await removeChannel(prevChannel);
    if (!activeConversationId) return;
    const existingWatch = conversationWatchChannels.get(activeConversationId);
    if (existingWatch) {
      await removeChannel(existingWatch);
      conversationWatchChannels.delete(activeConversationId);
    }
    const handleIncomingMessage = async (message, channelRef = messageChannel) => {
      if (!message || message.conversation_id !== activeConversationId) return;
      unhideConversation(message.conversation_id);
      if (message.id && knownMessageIds.has(message.id)) return;
      if (message.id) knownMessageIds.add(message.id);
      setConversationTyping(activeConversationId, false);
      setPeerTyping(false);
      activeMessages.push(message);
      const incomingFromOther = message.sender_id !== profile.id;
      const isVisibleLatest = incomingFromOther ? isActiveConversationAtLatest() : true;
      applyMessageMeta(message, { markUnread: incomingFromOther && !isVisibleLatest });
      if (!incomingFromOther || isVisibleLatest) {
        clearUnreadForConversation(activeConversationId);
      }
      const list = root.querySelector("#msg-list");
      if (list) {
        renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
        scrollMessagesToBottom(list);
      }
      if (incomingFromOther) {
        await sendDeliveryAck(channelRef, message);
        const conv = conversations.find((item) => item.id === activeConversationId);
        await maybeNotifyIncomingMessage(message, conv);
        if (isVisibleLatest) {
          await markConversationRead(activeConversationId, profile.id);
        }
      }
      const convList = root.querySelector("#conv-list");
      if (convList) renderSidebarPanel(convList);
    };

    const conv = conversations.find((c) => c.id === activeConversationId);
    const isDirect = conv?.type === "direct";

    const subFn = isDirect ? subscribeToDirectMessages : subscribeToConversationMessages;

    messageChannel = subFn(
      activeConversationId,
      async (message) => {
        await handleIncomingMessage(message, messageChannel);
      },
      {
        onTyping: (payload) => handleTypingEvent(payload),
        onInstantMessage: async (payload) => {
          await handleIncomingMessage(payload.message, messageChannel);
        },
        onDelivery: (payload) => handleDeliveryEvent(payload),
        onCallRequest: (payload) => handleIncomingCall(payload, messageChannel),
        onCallAccept: (payload) => handleCallAccepted(payload),
        onCallDecline: (payload) => handleCallDeclined(payload),
        onCallEnd: (payload) => handleCallEnded(payload),
        onConversationDeleted: async () => {
          conversations = conversations.filter(c => c.id !== activeConversationId);
          activeConversationId = null;
          stopMessagePoll();
          await syncConversationMeta({ notify: false });
          await renderMessagesTab();
          showToast("This conversation has been deleted.");
        }
      }
    );
  }

  async function refreshSupportMessages() {
    if (!supportConversationId) return;
    supportMessages = await getSupportMessages(supportConversationId);
    const list = root.querySelector("#support-list");
    if (list) {
      renderMessageList(list, supportMessages, profile.id);
      scrollMessagesToBottom(list);
    }
  }

  function startSupportPoll() {
    stopSupportPoll();
    if (!supportConversationId) return;
    supportPoll = setInterval(async () => {
      try {
        await refreshSupportMessages();
      } catch (error) {
        console.warn("Support poll failed:", error);
      }
    }, 15000);
  }

  function stopSupportPoll() {
    if (supportPoll) {
      clearInterval(supportPoll);
      supportPoll = null;
    }
  }

  async function reconnectSupportChannel() {
    await removeChannel(supportChannel);
    if (!supportConversationId) return;
    supportChannel = subscribeToSupportMessages(supportConversationId, (message) => {
      supportMessages.push(message);
      const list = root.querySelector("#support-list");
      if (list) {
        renderMessageList(list, supportMessages, profile.id);
        scrollMessagesToBottom(list);
      }
    });
    startSupportPoll();
  }

  async function sendChatMessage(type, content = "", mediaUrl = null) {
    if (!activeConversationId) return;
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (!conv) return;

    await publishTypingState(false);
    const text = String(content || "").trim();
    if (!text && !mediaUrl) return;

    try {
      unhideConversation(activeConversationId);
      const isDirect = conv.type === "direct";
      const common = {
        conversationId: activeConversationId,
        senderId: profile.id,
        content: text,
        messageType: type === MESSAGE_TYPES.TEXT && isLikelyUrl(text) ? MESSAGE_TYPES.LINK : type,
        mediaUrl
      };

      const sent = isDirect ? await sendDirectMessage(common) : await sendMessage(common);
      activeMessages.push(sent);
      knownMessageIds.add(sent.id);
      applyMessageMeta(sent, { markUnread: false });
      broadcastConversationEvent(messageChannel, "instant-message", { message: sent });
      const list = root.querySelector("#msg-list");
      if (list) {
        renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
        scrollMessagesToBottom(list, { force: true });
      }
      const convList = root.querySelector("#conv-list");
      if (convList) renderSidebarPanel(convList);
    } catch (error) {
      showToast(parseError(error), "error");
    }
  }

  async function startChatWithUsernamePrompt() {
    const raw = window.prompt("Enter username to start chat");
    if (raw == null) return false;
    const username = String(raw || "").trim();
    if (!username) {
      showToast("Username is required.", "error");
      return false;
    }
    try {
      const target = await findProfileByUsername(username);
      if (!target) {
        showToast("Username not found.", "error");
        return false;
      }
      if (target.id === profile.id) {
        showToast("You cannot start chat with your own account.", "error");
        return false;
      }
      if (target.role !== "user") {
        showToast("Only user accounts can be added here.", "error");
        return false;
      }

      const conv = await ensureConversationForAdmin(profile.id, target.id);
      await syncConversationMeta({ notify: false });
      if (isMobileViewport()) {
        mobileMessagesFocused = true;
      }
      await openConversation(conv.id);
      await renderMessagesTab();
      showToast(`Chat opened with @${target.username || username.toLowerCase()}.`);
      return true;
    } catch (error) {
      showToast(parseError(error), "error");
      return false;
    }
  }

  async function sendSupport(type, content = "", mediaUrl = null) {
    if (!supportConversationId) return;
    const text = content.trim();
    if (!text && !mediaUrl) return;
    const sent = await sendSupportMessage({
      conversationId: supportConversationId,
      senderId: profile.id,
      content: text,
      messageType: type === MESSAGE_TYPES.TEXT && isLikelyUrl(text) ? MESSAGE_TYPES.LINK : type,
      mediaUrl
    });
    if (sent) {
      supportMessages.push(sent);
      const list = root.querySelector("#support-list");
      if (list) {
        renderMessageList(list, supportMessages, profile.id);
        scrollMessagesToBottom(list, { force: true });
      }
    }
    return sent;
  }

  function renderShell() {
    root.innerHTML = `
      <section class="dashboard admin-wa-shell" id="admin-shell">
        <aside class="admin-icon-rail" id="admin-icon-rail">
          <button class="admin-rail-btn active" data-tool="messages" aria-label="Chats"><i class="fa-solid fa-comment"></i></button>
          <button class="admin-rail-btn" data-tool="new-chat" aria-label="New chat"><i class="fa-solid fa-plus"></i></button>
          <button class="admin-rail-btn" data-tool="bulk" aria-label="Bulk message"><i class="fa-solid fa-bullhorn"></i></button>
          <button class="admin-rail-btn" data-tool="profile" aria-label="Profile"><i class="fa-solid fa-user"></i></button>
          <button class="admin-rail-btn" data-tool="settings" aria-label="Settings"><i class="fa-solid fa-gear"></i></button>
        </aside>
        <section class="panel admin-main-panel" id="admin-content"></section>
      </section>
    `;

    root.querySelectorAll("#admin-icon-rail [data-tool]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tool = btn.dataset.tool;
        activeTool = tool;
        if (tool !== "messages") {
          mobileMessagesFocused = false;
        }
        updateShellMobileState();
        setRailActive(tool);
        await renderMessagesTab();
      });
    });
  }

  function renderActiveToolInSidebar(container) {
    if (activeTool === "new-chat") {
      renderContactsTab(container, {
        onDone: async () => {
          activeTool = "messages";
          setRailActive("messages");
          messagesSidebarOpen = false;
          if (isMobileViewport()) {
            mobileMessagesFocused = true;
          }
          updateShellMobileState();
          await renderMessagesTab();
        }
      });
      return;
    }
    if (activeTool === "bulk") {
      renderBulkTab(container);
      return;
    }
    if (activeTool === "profile") {
      renderProfileTab(container);
      return;
    }
    if (activeTool === "settings") {
      renderSettingsTab(container);
      return;
    }
    renderConversationList(container);
  }

  function renderConversationList(container) {
    if (!container) return;
    const filtered = getFilteredConversations();
    const totalUnread = filtered.reduce((sum, c) => sum + Number(getConversationMeta(c.id).unreadCount || 0), 0);
    const controlsHtml = `
      <div class="chat-list-head">
        <h3>@${escapeHtml(profile.username || "Admin")}</h3>
        <span class="badge ${totalUnread > 0 ? "success" : ""}">${totalUnread > 0 ? totalUnread : filtered.length}</span>
      </div>
      <div class="chat-list-search">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input id="msg-search-all" type="text" placeholder="Search user or chat content..." value="${escapeHtml(
      conversationQuery
    )}" />
      </div>
    `;
    const listHtml = filtered.length
      ? filtered
        .map((conversation) => {
          const meta = getConversationMeta(conversation.id);
          const unreadCount = Number(meta.unreadCount || 0);
          const isTyping = typingByConversation.get(conversation.id);
          const previewText = isTyping ? "Typing..." : meta.preview || "No messages yet.";
          const avatarUrl = String(conversation?.user?.avatar_url || "");
          const peerProfile = conversation?.user || {};
          const profileData = encodeURIComponent(JSON.stringify({
            name: getConversationName(conversation),
            username: peerProfile.username || "",
            email: peerProfile.email || "",
            role: peerProfile.role || "user",
            avatar_url: avatarUrl,
            created_at: peerProfile.created_at || ""
          }));
          return `<article class="conversation-item ${conversation.id === activeConversationId ? "active" : ""}" data-id="${conversation.id
            }">
                <div class="conversation-row">
                  <div class="conversation-avatar profile-avatar-trigger" data-profile="${profileData}" title="View profile" role="button" tabindex="0" aria-label="View ${escapeHtml(getConversationName(conversation))}'s profile">
                    ${avatarUrl
              ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(getConversationName(conversation))}" />`
              : `<span>${escapeHtml(getConversationInitial(conversation))}</span>`
            }
                  </div>
                  <div class="conversation-main">
                    <div class="conversation-title-row">
                      <div class="conversation-name">${escapeHtml(getConversationName(conversation))}</div>
                      ${unreadCount > 0 ? `<span class="conversation-badge" title="${unreadCount} new messages">${unreadCount}</span>` : ""}
                    </div>
                    <div class="conversation-preview ${isTyping ? "typing" : ""}">${escapeHtml(previewText)}</div>
                    <div class="conversation-time">${formatDateTime(meta.updatedAt || conversation.updated_at)}</div>
                  </div>
                </div>
              </article>`;
        })
        .join("")
      : `<p class="muted" style="padding:12px;">No conversations yet.</p>`;
    container.innerHTML = `${controlsHtml}${listHtml}`;
  }

  function renderSidebarPanel(container) {
    if (!container) return;
    if (activeTool !== "messages") return;
    renderConversationList(container);
  }

  async function renderMessagesTab() {
    const content = root.querySelector("#admin-content");
    const isMessagesTool = activeTool === "messages";
    const isMobile = isMobileViewport();
    const listMode = isMobile && (!mobileMessagesFocused || !isMessagesTool);
    const selected = conversations.find((c) => c.id === activeConversationId);
    const selectedMeta = selected ? getConversationMeta(selected.id) : null;
    const showBackButton = isMobile && (mobileMessagesFocused || !isMessagesTool);
    const toolTitleMap = {
      "new-chat": "Contacts",
      bulk: "Bulk Message",
      profile: "Profile",
      settings: "Settings"
    };
    const headerTitle = isMessagesTool
      ? selected?.user?.full_name || selected?.user?.email || "Select chat"
      : toolTitleMap[activeTool] || "Tool";
    const headerSubTitle = isMessagesTool
      ? selected
        ? formatDateTime(selectedMeta?.updatedAt || selected.updated_at)
        : "Choose a conversation"
      : "Manage tools from the sidebar";
    content.innerHTML = `
      <div class="chat-layout ${!isMobile && messagesSidebarOpen ? "chat-layout-sidebar-open" : ""} ${listMode ? "admin-mobile-list-mode" : ""
      }">
        <button class="chat-backdrop" type="button" id="msg-sidebar-backdrop" aria-label="Close conversations"></button>
        <aside class="chat-sidebar" id="conv-list"></aside>
        <section class="chat-main">
          <header class="chat-header">
            <div class="chat-header-title">
              <button class="chat-menu-btn" type="button" id="msg-sidebar-toggle" aria-label="${showBackButton ? "Back to chats" : "Open conversations"
      }">
                ${showBackButton ? '<i class="fa-solid fa-arrow-left" aria-hidden="true"></i>' : "<span></span>"}
              </button>
              ${isMessagesTool && selected ? (() => {
                const hAvatarUrl = String(selected?.user?.avatar_url || selected?.peer?.avatar_url || "");
                const hInitial = escapeHtml(getConversationInitial(selected));
                const hPeer = selected?.user || selected?.peer || {};
                const hProfileData = encodeURIComponent(JSON.stringify({
                  name: getConversationName(selected),
                  username: hPeer.username || "",
                  role: hPeer.role || "user",
                  avatar_url: hAvatarUrl,
                  created_at: hPeer.created_at || ""
                }));
                return `<div class="chat-header-avatar profile-avatar-trigger" id="admin-header-avatar" data-profile="${hProfileData}" title="View profile" role="button" tabindex="0" aria-label="View profile">
                  ${hAvatarUrl ? `<img src="${hAvatarUrl}" alt="${hInitial}" />` : `<span>${hInitial}</span>`}
                </div>`;
              })() : ""}
              <div class="chat-header-copy">
                <strong>${headerTitle}</strong>
                <div class="chat-header-subtitle">
                  <span class="muted" id="msg-header-subtitle">${headerSubTitle}</span>
                  <span class="typing-indicator ${isMessagesTool && peerTyping ? "active" : ""}" id="msg-typing-indicator">
                    ${isMessagesTool && peerTyping ? "Typing..." : ""}
                  </span>
                </div>
              </div>
            </div>
            <div class="chat-header-tools">
              <button class="btn btn-ghost composer-icon-btn ${isMessagesTool && selected ? "" : "hidden"}" type="button" id="admin-voice-call-btn" aria-label="Voice Call">
                <i class="fa-solid fa-phone"></i>
              </button>
              <button class="btn btn-ghost composer-icon-btn ${isMessagesTool && selected ? "" : "hidden"}" type="button" id="admin-video-call-btn" aria-label="Video Call">
                <i class="fa-solid fa-video"></i>
              </button>
              <button class="btn btn-ghost composer-icon-btn ${isMessagesTool ? "" : "hidden"}" type="button" id="msg-chat-search-toggle" aria-label="Search in chat">
                <i class="fa-solid fa-magnifying-glass"></i>
              </button>
              <div class="dropdown ${selected ? "" : "hidden"}" id="chat-options-dropdown">
                <button class="btn btn-ghost composer-icon-btn" type="button" id="chat-options-btn" aria-label="Options">
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
                <div class="dropdown-content">
                  <button type="button" data-action="clear">Clear Chat</button>
                  <button type="button" data-action="remove">Remove Chat</button>
                  <button type="button" data-action="delete" class="text-danger">Delete Chat</button>
                </div>
              </div>
            </div>
          </header>
          <div class="chat-inline-search ${isMessagesTool && chatSearchOpen ? "" : "hidden"}">
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input id="msg-chat-search" type="text" placeholder="Search inside chat..." value="${escapeHtml(chatSearchQuery)}" />
          </div>
          <div class="message-list ${isMessagesTool ? "" : "hidden"}" id="msg-list"></div>
          <div class="panel ${isMessagesTool ? "hidden" : ""}" style="height:100%; display:grid; place-items:center;">
            <p class="muted" style="margin:0;">Tool panel opened in sidebar.</p>
          </div>
          <form class="composer whatsapp-composer ${isMessagesTool && selected ? "" : "hidden"}" id="msg-form">
            <input id="msg-image" class="composer-file" type="file" accept="image/*" />
            <button class="btn btn-secondary composer-icon-btn" type="button" id="msg-attach" aria-label="Attach image">
              <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
            </button>
            <input id="msg-input" class="composer-text" type="text" placeholder="Type a message..." />
            <button class="btn btn-secondary composer-icon-btn" type="button" id="msg-voice" data-recording="false" aria-label="Record voice">
              <i class="fa-solid fa-microphone" aria-hidden="true"></i>
            </button>
            <button class="btn btn-primary composer-send-btn" type="submit" id="msg-send" aria-label="Send message">
              <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
            </button>
          </form>
        </section>
      </div>
    `;
    updateShellMobileState();

    renderTypingIndicator();
    const convList = content.querySelector("#conv-list");
    if (isMessagesTool) {
      renderConversationList(convList);
    } else {
      renderActiveToolInSidebar(convList);
    }

    content.querySelector("#msg-sidebar-toggle")?.addEventListener("click", () => {
      if (!isMessagesTool) {
        activeTool = "messages";
        setRailActive("messages");
        if (isMobileViewport()) {
          mobileMessagesFocused = false;
        }
        updateShellMobileState();
        renderMessagesTab();
        return;
      }
      if (isMobileViewport()) {
        mobileMessagesFocused = false;
        messagesSidebarOpen = false;
        renderMessagesTab();
        return;
      }
      messagesSidebarOpen = !messagesSidebarOpen;
      renderMessagesTab();
    });

    content.querySelector("#msg-sidebar-backdrop")?.addEventListener("click", () => {
      messagesSidebarOpen = false;
      renderMessagesTab();
    });

    if (!isMessagesTool) return;

    convList.addEventListener("click", async (event) => {
      // Profile avatar click — open lightbox, don't open conversation
      const avatarTrigger = event.target.closest(".profile-avatar-trigger");
      if (avatarTrigger && convList.contains(avatarTrigger)) {
        event.stopPropagation();
        try {
          const profileData = JSON.parse(decodeURIComponent(avatarTrigger.dataset.profile || "{}"));
          openProfileLightbox(profileData);
        } catch {}
        return;
      }

      const row = event.target.closest("[data-id]");
      if (!row || !convList.contains(row)) return;
      messagesSidebarOpen = false;
      if (isMobileViewport()) {
        mobileMessagesFocused = true;
      }
      await openConversation(row.dataset.id);
      renderMessagesTab();
    });

    convList.querySelector("#msg-search-all")?.addEventListener("input", (event) => {
      conversationQuery = String(event.currentTarget.value || "");
      renderConversationList(convList);
    });

    // Header avatar click — open profile lightbox
    content.querySelector("#admin-header-avatar")?.addEventListener("click", (event) => {
      const trigger = event.currentTarget;
      try {
        const profileData = JSON.parse(decodeURIComponent(trigger.dataset.profile || "{}"));
        openProfileLightbox(profileData);
      } catch {}
    });

    content.querySelector("#msg-chat-search-toggle")?.addEventListener("click", () => {
      chatSearchOpen = !chatSearchOpen;
      if (!chatSearchOpen) chatSearchQuery = "";
      renderMessagesTab();
    });

    content.querySelector("#msg-chat-search")?.addEventListener("input", (event) => {
      chatSearchQuery = String(event.currentTarget.value || "");
      const list = content.querySelector("#msg-list");
      if (list) {
        renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
        scrollMessagesToBottom(list);
      }
    });

    const list = content.querySelector("#msg-list");
    renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
    scrollMessagesToBottom(list, { force: true });
    list?.addEventListener("scroll", () => {
      syncActiveConversationReadState().catch(() => { });
    });
    syncActiveConversationReadState().catch(() => { });

    // Handle @mention clicks — open a direct chat with that user
    list?.addEventListener("click", async (event) => {
      const mention = event.target.closest(".mention-link");
      if (!mention) return;
      const username = mention.dataset.mention;
      if (!username) return;
      if (username.toLowerCase() === (profile.username || "").toLowerCase()) {
        showToast("That's you!", "info");
        return;
      }
      try {
        showToast(`Looking up @${username}...`);
        const targetProfile = await findProfileByUsername(username);
        if (!targetProfile) {
          showToast(`User @${username} not found.`, "error");
          return;
        }
        if (targetProfile.id === profile.id) {
          showToast("That's you! You cannot start a chat with yourself.", "info");
          return;
        }
        const conversationId = await ensureDirectConversation(targetProfile.id);
        if (conversationId) {
          await syncConversationMeta({ notify: false });
          await openConversation(conversationId);
          messagesSidebarOpen = false;
          if (isMobileViewport()) mobileMessagesFocused = true;
          renderMessagesTab();
          showToast(`Chat opened with @${username}.`);
        }
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    const msgInput = content.querySelector("#msg-input");
    const msgVoiceBtn = content.querySelector("#msg-voice");
    const voiceIcon = `<i class="fa-solid fa-microphone" aria-hidden="true"></i>`;
    const stopIcon = `<i class="fa-solid fa-stop" aria-hidden="true"></i>`;
    function setVoiceBtnState(isRecording) {
      if (!msgVoiceBtn) return;
      msgVoiceBtn.dataset.recording = isRecording ? "true" : "false";
      msgVoiceBtn.classList.toggle("is-recording", isRecording);
      msgVoiceBtn.setAttribute("aria-label", isRecording ? "Stop recording" : "Record voice");
      msgVoiceBtn.innerHTML = isRecording ? stopIcon : voiceIcon;
    }
    msgInput?.addEventListener("input", () => {
      const hasText = String(msgInput.value || "").trim().length > 0;
      publishTypingState(hasText);
    });
    msgInput?.addEventListener("blur", () => {
      publishTypingState(false);
    });

    content.querySelector("#msg-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await sendChatMessage(MESSAGE_TYPES.TEXT, String(msgInput?.value || ""));
        if (msgInput) msgInput.value = "";
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    const msgImageInput = content.querySelector("#msg-image");
    content.querySelector("#msg-attach")?.addEventListener("click", () => {
      msgImageInput?.click();
    });

    msgImageInput?.addEventListener("change", async () => {
      const file = msgImageInput?.files?.[0];
      if (!file) return showToast("Choose image first.", "error");
      try {
        const mediaUrl = await uploadChatMedia(file, profile.id, "images");
        await sendChatMessage(MESSAGE_TYPES.IMAGE, "", mediaUrl);
        msgImageInput.value = "";
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    const recorder = createVoiceRecorder({
      onReady: () => {
        setVoiceBtnState(true);
      },
      onStop: async (blob) => {
        try {
          const mediaUrl = await uploadVoiceBlob(blob, profile.id, "voices");
          await sendChatMessage(MESSAGE_TYPES.VOICE, "", mediaUrl);
        } catch (error) {
          showToast(parseError(error), "error");
        } finally {
          setVoiceBtnState(false);
        }
      },
      onError: (error) => {
        setVoiceBtnState(false);
        showToast(parseError(error), "error");
      }
    });

    setVoiceBtnState(false);
    msgVoiceBtn?.addEventListener("click", async () => {
      if (msgVoiceBtn?.dataset.recording === "true") recorder.stop();
      else await recorder.start();
    });

    content.querySelector("#admin-voice-call-btn")?.addEventListener("click", async () => {
      await ensureAudioUnlocked();
      pendingIceCandidates = []; // Clear for new outgoing call
      const conv = conversations.find(c => c.id === activeConversationId);
      if (conv) await renderCallModal(conv, "voice");
    });

    content.querySelector("#admin-video-call-btn")?.addEventListener("click", async () => {
      await ensureAudioUnlocked();
      pendingIceCandidates = []; // Clear for new outgoing call
      const conv = conversations.find(c => c.id === activeConversationId);
      if (conv) await renderCallModal(conv, "video");
    });

    const optionsBtn = content.querySelector("#chat-options-btn");
    const optionsDropdown = content.querySelector("#chat-options-dropdown");
    optionsBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      optionsDropdown?.classList.toggle("show");
    });

    window.addEventListener("click", () => {
      optionsDropdown?.classList.remove("show");
    }, { once: false });

    optionsDropdown?.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const conv = conversations.find((c) => c.id === activeConversationId);
        if (!conv) return;

        if (action === "clear") {
          if (!confirm("Clear all messages in this chat?")) return;
          try {
            // Mark this conversation as cleared so the poll won't reload messages
            clearedConversationIds.add(conv.id);
            stopMessagePoll();
            await clearConversationMessages(conv.id, conv.type || "support");
            activeMessages = [];
            knownMessageIds.clear();
            optionsDropdown.classList.remove("show");
            showToast("Chat cleared.");
            await renderMessagesTab();
          } catch (err) {
            showToast(parseError(err), "error");
          }
        } else if (action === "remove") {
          if (confirm("Remove this chat from your list? The other person will still see it.")) {
            hiddenChatIds.add(conv.id);
            localStorage.setItem(`hidden_chats:${profile.id}`, JSON.stringify([...hiddenChatIds]));
            activeConversationId = null;
            optionsDropdown.classList.remove("show");
            await renderMessagesTab();
          }
        } else if (action === "delete") {
          if (confirm("Permanently delete this chat for everyone? This cannot be undone.")) {
            try {
              // Broadcast to the active channel AND any watch channel the other user may have
              await broadcastConversationEvent(messageChannel, "conversation-deleted", { conversationId: conv.id });
              const watchCh = conversationWatchChannels.get(conv.id);
              if (watchCh) await broadcastConversationEvent(watchCh, "conversation-deleted", { conversationId: conv.id });

              if (conv.type === "direct") {
                await deleteDirectConversation(conv.id);
              } else {
                await deleteSupportConversation(conv.id);
              }
              clearedConversationIds.add(conv.id);
              stopMessagePoll();
              activeConversationId = null;
              conversations = conversations.filter(c => c.id !== conv.id);
              optionsDropdown.classList.remove("show");
              await syncConversationMeta({ notify: false });
              await renderMessagesTab();
            } catch (error) {
              showToast(parseError(error), "error");
            }
          }
        }
      });
    });
  }

  function renderContactsTab(content = root.querySelector("#admin-content"), { onDone } = {}) {
    content.innerHTML = `
      <div class="inline" style="justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">Contacts</h3>
        <button class="btn btn-primary icon-btn" type="button" id="contacts-add-member" aria-label="Add New Member"><i class="fa-solid fa-plus"></i></button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Username</th><th>Action</th></tr></thead>
          <tbody>
            ${contacts.length
        ? contacts
          .map(
            (c) => `<tr>
                          <td>${c.full_name || "-"}</td>
                          <td>${c.username ? "@" + c.username : "-"}</td>
                          <td><button class="btn btn-secondary" data-chat="${c.id}">Open Chat</button></td>
                        </tr>`
          )
          .join("")
        : `<tr><td colspan="3" class="muted">No contacts yet.</td></tr>`
      }
          </tbody>
        </table>
      </div>
    `;

    content.querySelector("#contacts-add-member")?.addEventListener("click", async () => {
      const opened = await startChatWithUsernamePrompt();
      if (opened && typeof onDone === "function") await onDone();
    });

    content.querySelectorAll("[data-chat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const conv = await ensureConversationForAdmin(profile.id, btn.dataset.chat);
        await syncConversationMeta({ notify: false });
        if (isMobileViewport()) {
          mobileMessagesFocused = true;
        }
        await openConversation(conv.id);
        messagesSidebarOpen = false;
        renderMessagesTab();
        if (typeof onDone === "function") await onDone();
      });
    });
  }

  function renderBulkTab(content = root.querySelector("#admin-content")) {
    content.innerHTML = `
      <form id="bulk-form" class="stack">
        <h3 style="margin:0;">Bulk Message</h3>
        <textarea name="content" placeholder="Message content"></textarea>
        <div class="inline">
          <input id="bulk-image" type="file" accept="image/*" />
          <button class="btn btn-secondary" type="button" id="bulk-use-image">Attach Image</button>
          <button class="btn btn-secondary" type="button" id="bulk-record">Record Voice</button>
          <span class="muted" id="bulk-state">No media selected</span>
        </div>
        <div class="table-wrap" style="max-height:280px; overflow:auto;">
          <table>
            <thead><tr><th>Select</th><th>Name</th><th>Username</th></tr></thead>
            <tbody>
              ${contacts.length
        ? contacts
          .map(
            (c) => `<tr>
                            <td><input type="checkbox" name="recipient" value="${c.id}" /></td>
                            <td>${c.full_name || "-"}</td>
                            <td>${c.username ? "@" + c.username : "-"}</td>
                          </tr>`
          )
          .join("")
        : `<tr><td colspan="3" class="muted">No contacts.</td></tr>`
      }
            </tbody>
          </table>
        </div>
        <button class="btn btn-primary" type="submit">Send Bulk</button>
      </form>
    `;

    let mediaUrl = null;
    let mediaType = MESSAGE_TYPES.TEXT;
    const status = content.querySelector("#bulk-state");

    content.querySelector("#bulk-use-image")?.addEventListener("click", async () => {
      const file = content.querySelector("#bulk-image")?.files?.[0];
      if (!file) return showToast("Pick image first.", "error");
      mediaUrl = await uploadChatMedia(file, profile.id, "bulk-images");
      mediaType = MESSAGE_TYPES.IMAGE;
      status.textContent = `Image attached: ${file.name}`;
    });

    const recorder = createVoiceRecorder({
      onReady: () => (content.querySelector("#bulk-record").textContent = "Stop"),
      onStop: async (blob) => {
        mediaUrl = await uploadVoiceBlob(blob, profile.id, "bulk-voices");
        mediaType = MESSAGE_TYPES.VOICE;
        status.textContent = "Voice attached";
        content.querySelector("#bulk-record").textContent = "Record Voice";
      },
      onError: (error) => showToast(parseError(error), "error")
    });

    content.querySelector("#bulk-record")?.addEventListener("click", async () => {
      const btn = content.querySelector("#bulk-record");
      if (btn.textContent === "Stop") recorder.stop();
      else await recorder.start();
    });

    content.querySelector("#bulk-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      const ids = fd.getAll("recipient").map(String);
      const text = String(fd.get("content") || "").trim();
      if (!ids.length) return showToast("Select recipients.", "error");
      if (!text && !mediaUrl) return showToast("Add content or media.", "error");
      try {
        await sendBulkMessage({
          adminId: profile.id,
          recipientUserIds: ids,
          content: text,
          messageType: mediaUrl ? mediaType : isLikelyUrl(text) ? MESSAGE_TYPES.LINK : MESSAGE_TYPES.TEXT,
          mediaUrl
        });
        showToast(`Sent to ${ids.length} users.`);
        event.currentTarget.reset();
        status.textContent = "No media selected";
        mediaUrl = null;
        mediaType = MESSAGE_TYPES.TEXT;
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });
  }

  function renderSubscriptionTab(content = root.querySelector("#admin-content")) {
    const current = subscriptions[0];
    content.innerHTML = `
      <div class="stack">
        <div class="inline">
          <span class="badge">Plan: ${current?.plan?.name || "None"}</span>
          <span class="badge">Status: ${current?.status || "-"}</span>
          <span class="badge">End: ${current?.end_date || "-"}</span>
        </div>
        <form id="pay-form" class="stack">
          <h3 style="margin:0;">Submit Payment</h3>
          <div class="grid-2">
            <input type="number" step="0.01" min="0" name="amount" placeholder="Amount" required />
            <select name="method_id" required>
              <option value="">Payment method</option>
              ${paymentMethods.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}
            </select>
          </div>
          <div class="grid-2">
            <input name="transaction_id" placeholder="Transaction ID" />
            <input type="file" name="screenshot" accept="image/*" />
          </div>
          <button class="btn btn-primary" type="submit">Submit</button>
        </form>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
            <tbody>
              ${payments.length
        ? payments
          .map(
            (p) => `<tr><td>${formatDateTime(p.submitted_at)}</td><td>${p.amount}</td><td>${p.method?.name || "-"}</td><td>${p.status}</td></tr>`
          )
          .join("")
        : `<tr><td colspan="4" class="muted">No payment history.</td></tr>`
      }
            </tbody>
          </table>
        </div>
        <div class="panel">
          <h3 style="margin-top:0;">Support Chat</h3>
          <div class="message-list" id="support-list" style="min-height:200px;"></div>
          <form class="composer" id="support-form">
            <div class="composer-row">
              <input id="support-input" type="text" placeholder="Write to super admin..." />
              <button class="btn btn-primary" type="submit">Send</button>
            </div>
            <div class="composer-row">
              <input id="support-image" type="file" accept="image/*" />
              <button class="btn btn-secondary" type="button" id="support-send-image">Image</button>
              <button class="btn btn-secondary" type="button" id="support-voice">Voice</button>
            </div>
          </form>
        </div>
      </div>
    `;

    content.querySelector("#pay-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      const file = fd.get("screenshot");
      let screenshotUrl = null;
      if (file && file.size > 0) screenshotUrl = await uploadChatMedia(file, profile.id, "payment-screenshots");
      await submitPayment({
        admin_id: profile.id,
        method_id: String(fd.get("method_id") || ""),
        amount: Number(fd.get("amount")),
        transaction_id: String(fd.get("transaction_id") || "").trim() || null,
        screenshot_url: screenshotUrl,
        status: "pending"
      });
      showToast("Payment submitted.");
      payments = await listPayments({ adminId: profile.id });
      renderSubscriptionTab(content);
    });

    const list = content.querySelector("#support-list");
    renderMessageList(list, supportMessages, profile.id);
    scrollMessagesToBottom(list, { force: true });

    content.querySelector("#support-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = content.querySelector("#support-input");
      await sendSupport(MESSAGE_TYPES.TEXT, String(input.value || ""));
      input.value = "";
    });

    content.querySelector("#support-send-image")?.addEventListener("click", async () => {
      const file = content.querySelector("#support-image")?.files?.[0];
      if (!file) return showToast("Select image first.", "error");
      const mediaUrl = await uploadChatMedia(file, profile.id, "support-images");
      await sendSupport(MESSAGE_TYPES.IMAGE, "", mediaUrl);
      content.querySelector("#support-image").value = "";
    });

    const recorder = createVoiceRecorder({
      onReady: () => (content.querySelector("#support-voice").textContent = "Stop"),
      onStop: async (blob) => {
        const mediaUrl = await uploadVoiceBlob(blob, profile.id, "support-voices");
        await sendSupport(MESSAGE_TYPES.VOICE, "", mediaUrl);
        content.querySelector("#support-voice").textContent = "Voice";
      },
      onError: (error) => showToast(parseError(error), "error")
    });
    content.querySelector("#support-voice")?.addEventListener("click", async () => {
      const btn = content.querySelector("#support-voice");
      if (btn.textContent === "Stop") recorder.stop();
      else await recorder.start();
    });
  }

  function renderProfileTab(content = root.querySelector("#admin-content")) {
    const avatarPreview = profile.avatar_url
      ? `<img src="${escapeHtml(profile.avatar_url)}" alt="Avatar" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.16);" />`
      : `<div style="width:72px;height:72px;border-radius:50%;display:grid;place-items:center;border:1px solid rgba(255,255,255,0.16);color:var(--muted);">N/A</div>`;
    content.innerHTML = `
      <div class="stack">
        <div class="panel">
          <h3 style="margin-top:0;">Profile Details</h3>
          <div class="inline" style="align-items:center; gap:12px;">
            ${avatarPreview}
            <p class="muted" style="margin:0;">Update your profile name and avatar here.</p>
          </div>
          <div class="stack" style="margin-top:12px;">
            <div class="field">
              <label>User ID</label>
              <input value="${escapeHtml(profile.id || "")}" readonly />
            </div>
            <div class="field">
              <label>Username</label>
              <input value="${escapeHtml(profile.username || "-")}" readonly />
            </div>
          </div>
        </div>
        <form id="profile-form" class="stack">
          <h3 style="margin:0;">Edit Profile</h3>
          <div class="grid-2">
            <input name="full_name" value="${profile.full_name || ""}" placeholder="Full name" />
            <input name="avatar" type="file" accept="image/*" />
          </div>
          <button class="btn btn-primary" type="submit">Save Profile</button>
        </form>
        <div id="admin-profile-payment-section"></div>
      </div>
    `;

    content.querySelector("#profile-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      const payload = { full_name: String(fd.get("full_name") || "").trim() };
      const avatar = fd.get("avatar");
      if (avatar && avatar.size > 0) payload.avatar_url = await uploadAvatar(avatar, profile.id);
      const updated = await updateProfile(payload);
      Object.assign(profile, updated || {});
      showToast("Profile updated.");
      renderProfileTab(content);
    });

    const paymentMount = content.querySelector("#admin-profile-payment-section");
    if (paymentMount) {
      renderSubscriptionTab(paymentMount);
    }
  }

  async function handleIncomingCall(payload, channelRef) {
    console.log("Incoming call request received:", payload);
    try {
      if (!payload || payload.callerId === profile.id) return;
      
      if (currentCallConversationId === payload.conversationId) {
        console.log("Ignoring redundant call request for active conversation");
        return;
      }

      if (currentCallConversationId && currentCallConversationId !== payload.conversationId) {
        console.log("Declining incoming call: busy");
        await broadcastConversationEvent(channelRef, "call-decline", { 
          conversationId: payload.conversationId, 
          reason: "busy" 
        });
        return;
      }

      if (notificationPrefs.sound) {
        await playNotificationSound();
      }
      
      ensureAudioUnlocked(); // Don't await, show banner immediately
      playIncomingRing();
      const name = payload.callerName || "Unknown User";
      const initial = name.charAt(0).toUpperCase();
      const avatar = payload.callerAvatar;
      const conv = conversations.find(c => c.id === payload.conversationId);

      const onAccept = async () => {
        console.log("Accepting call...");
        await ensureAudioUnlocked();
        stopIncomingRing();
        banner.remove();

        // Signal acceptance with peer ID for direct P2P connection
        const signal = { 
          conversationId: payload.conversationId, 
          accepterId: profile.id,
          accepterPeerId: `chatnow_${profile.id}`,
          type: payload.type 
        };
        await broadcastConversationEvent(channelRef, "call-accept", signal);

        if (!activeConversationId || activeConversationId !== payload.conversationId) {
          await openConversation(payload.conversationId);
        }

        const callTarget = conv || { 
          id: payload.conversationId, 
          peer: { full_name: name, avatar_url: avatar } 
        };
        renderCallModal(callTarget, payload.type, false);
        console.log("[PeerJS] Starting incoming call...");
        await startPeerCall(payload.conversationId, payload.type === "video", true, payload.callerPeerId);
      };

      const onDecline = async () => {
        console.log("Declining call...");
        stopIncomingRing();
        banner.remove();
        await broadcastConversationEvent(channelRef, "call-decline", { 
          conversationId: payload.conversationId, 
          declinerId: profile.id 
        });
      };

      const banner = document.createElement("div");
      banner.className = "call-banner-overlay";
      banner.innerHTML = `
        <div class="call-banner-card">
          <div class="call-banner-avatar">
            ${avatar ? `<img src="${avatar}" alt="${name}" style="width:100%;height:100%;object-fit:cover;" />` : `<span>${initial}</span>`}
          </div>
          <div class="call-banner-info">
            <p class="call-banner-name">${escapeHtml(name)}</p>
            <p class="call-banner-type">${payload.type === "video" ? "Video Call..." : "Incoming Call..."}</p>
          </div>
          <div class="call-banner-actions">
            <button class="call-banner-btn decline" title="Decline"><i class="fa-solid fa-phone-slash"></i></button>
            <button class="call-banner-btn accept" title="Accept"><i class="fa-solid fa-phone"></i></button>
          </div>
        </div>
      `;
      console.log("Appending call banner to body...");
      document.body.appendChild(banner);
      banner.querySelector(".accept").onclick = onAccept;
      banner.querySelector(".decline").onclick = onDecline;
    } catch (err) {
      console.error("Error handling incoming call:", err);
    }
  }

  function startCallTimer() {
    clearInterval(callTimerInterval);
    const update = () => {
      // Target the peer-call-status element inside the active call UI
      const statusEl = document.getElementById("peer-call-status");
      if (statusEl && callStartTime) {
        const seconds = Math.floor((Date.now() - callStartTime) / 1000);
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        statusEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;
      }
    };
    update();
    callTimerInterval = setInterval(update, 1000);
  }

  async function sendCallLogMessage(status, type = "voice") {
    let durationText = "";
    if (callStartTime) {
      const seconds = Math.floor((Date.now() - callStartTime) / 1000);
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      durationText = ` - ${m}:${s.toString().padStart(2, "0")}`;
    }
    const icon = type === "video" ? "📹" : "📞";
    const prefix = status.toLowerCase().includes("missed") ? "📵" : icon;
    const text = `${prefix} ${status} (${type})${durationText}`;

    try {
      const cid = currentCallConversationId || activeConversationId;
      if (!cid) return;
      const conv = conversations.find(c => c.id === cid);
      const isDirect = conv?.type === "direct";
      const payload = { 
        conversationId: cid,
        senderId: profile.id,
        content: text, 
        messageType: MESSAGE_TYPES.TEXT 
      };
      if (isDirect) {
        await sendDirectMessage(payload);
      } else {
        await sendMessage(payload);
      }
    } catch (err) {
      console.warn("Failed to log call:", err);
    }
    callStartTime = null;
  }

  async function handleCallAccepted(payload) {
    console.log("Call accepted signal received:", payload);
    if (payload.accepterId === profile.id) return;
    
    stopOutgoingRing();
    currentCallConversationId = payload.conversationId;
    
    const modal = document.querySelector(".call-modal-overlay");
    if (modal) {
      console.log("[PeerJS] Transitioning caller UI to call...");
      modal.classList.remove("calling-mode");
      modal.innerHTML = `
        <div class="call-modal-content peer-call-mode" style="width: 100%; height: 100%; max-width: 100%; border-radius: 0; padding: 0; background: #000;">
          <div id="peer-call-frame" style="width:100%; height:100%; border-radius:0; overflow:hidden;"></div>
        </div>
      `;
    } else {
      console.warn("Call modal not found when acceptance received, rendering new one...");
      const conv = conversations.find(c => c.id === payload.conversationId);
      renderCallModal(conv || { id: payload.conversationId }, payload.type, false);
    }
    
    // Start PeerJS call with the accepter's peer ID
    await startPeerCall(payload.conversationId, payload.type === "video", false, payload.accepterPeerId);
  }

  function playIncomingRing() {
    stopIncomingRing();
    incomingRingAudio = new Audio("https://assets.mixkit.co/active_storage/sfx/1353/1353-preview.mp3");
    incomingRingAudio.loop = true;
    incomingRingAudio.play().catch(e => console.warn("Audio play blocked:", e));
  }

  function stopIncomingRing() {
    if (incomingRingAudio) {
      incomingRingAudio.pause();
      incomingRingAudio = null;
    }
  }

  function playOutgoingRing() {
    stopOutgoingRing();
    outgoingRingAudio = new Audio("https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3");
    outgoingRingAudio.loop = true;
    outgoingRingAudio.play().catch(e => console.warn("Audio play blocked:", e));
  }

  function stopOutgoingRing() {
    if (outgoingRingAudio) {
      outgoingRingAudio.pause();
      outgoingRingAudio = null;
    }
  }

  function handleCallDeclined(payload) {
    stopOutgoingRing();
    stopIncomingRing();
    sendCallLogMessage("Missed call", payload.type || "voice").catch(() => {});
    const modal = document.querySelector(".call-modal-overlay");
    if (modal) {
      const status = modal.querySelector(".call-modal-status");
      if (status) {
        status.textContent = "Call Declined";
        status.style.color = "#ff4d4d";
      }
      setTimeout(() => {
        cleanupWebRTC();
      }, 1800);
    } else {
      cleanupWebRTC();
    }
  }

  function handleCallEnded(payload) {
    cleanupWebRTC();
    const modal = root.querySelector(".call-modal-overlay");
    if (modal) {
      const status = modal.querySelector(".call-modal-status");
      if (status) status.textContent = "Call Ended";
      setTimeout(() => modal.remove(), 1500);
    }
  }

  async function startPeerCall(conversationId, isVideo, isIncoming = false, callerPeerId = null) {
    console.log("[PeerJS] Starting call for:", conversationId, "isVideo:", isVideo, "isIncoming:", isIncoming);
    
    if (typeof Peer === "undefined") {
      console.error("[PeerJS] Peer is not defined. Script might be blocked.");
      showToast("Call error: PeerJS not loaded. Check your internet.", "error");
      endCall();
      return;
    }

    const container = document.getElementById("peer-call-frame");
    if (!container) {
      console.error("[PeerJS] peer-call-frame not found in DOM");
      return;
    }

    isVideoCall = isVideo;

    try {
      // Create or reuse peer — handle unavailable-id (e.g. stale tab still holds the ID)
      if (!peerInstance || peerInstance.destroyed) {
        peerInstance = await new Promise((resolve, reject) => {
          const tryCreate = (id) => {
            const peer = new Peer(id, {
              debug: 1,
              config: {
                iceServers: [
                  { urls: "stun:stun.l.google.com:19302" },
                  { urls: "stun:stun1.l.google.com:19302" },
                  { urls: "stun:stun2.l.google.com:19302" }
                ]
              }
            });
            peer.on("open", () => resolve(peer));
            peer.on("error", (err) => {
              if (err.type === "unavailable-id") {
                // ID taken by a stale connection — retry with a timestamped fallback
                console.warn("[PeerJS] Peer ID taken, retrying with fallback ID...");
                peer.destroy();
                tryCreate(`chatnow_${profile.id}_${Date.now()}`);
              } else {
                reject(err);
              }
            });
          };
          tryCreate(`chatnow_${profile.id}`);
        });
        console.log("[PeerJS] Peer created with ID:", peerInstance.id);
      }

      // Get user media
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: isVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false
      });
      console.log("[PeerJS] Got local media stream");

      // Create call UI
      container.innerHTML = `
        <div class="peer-call-container ${!isVideo ? "voice-call" : ""}">
          <div class="peer-videos">
            <video id="peer-remote-video" autoplay playsinline></video>
            ${isVideo ? `<video id="peer-local-video" autoplay playsinline muted></video>` : ""}
            ${!isVideo ? `
              <div class="voice-avatar" id="voice-avatar">
                <i class="fa-solid fa-phone"></i>
              </div>
            ` : ""}
          </div>
          <div class="peer-controls">
            <button class="peer-ctrl-btn" id="peer-toggle-audio" title="Toggle Microphone">
              <i class="fa-solid fa-microphone"></i>
            </button>
            ${isVideo ? `
              <button class="peer-ctrl-btn" id="peer-toggle-video" title="Toggle Camera">
                <i class="fa-solid fa-video"></i>
              </button>
            ` : ""}
            <button class="peer-ctrl-btn peer-end-btn" id="peer-end-call" title="End Call">
              <i class="fa-solid fa-phone-slash"></i>
            </button>
          </div>
          <div class="peer-call-status" id="peer-call-status">Connecting...</div>
        </div>
      `;

      // Attach local video
      if (isVideo) {
        const localVideo = container.querySelector("#peer-local-video");
        if (localVideo) {
          localVideo.srcObject = localStream;
          localVideo.play().catch(e => console.warn("Local video play failed:", e));
        }
      }

      // Setup controls
      const audioBtn = container.querySelector("#peer-toggle-audio");
      const videoBtn = container.querySelector("#peer-toggle-video");
      const endBtn = container.querySelector("#peer-end-call");

      audioBtn?.addEventListener("click", () => {
        const audioTrack = localStream?.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = !audioTrack.enabled;
          audioBtn.classList.toggle("muted", !audioTrack.enabled);
          audioBtn.innerHTML = audioTrack.enabled 
            ? '<i class="fa-solid fa-microphone"></i>' 
            : '<i class="fa-solid fa-microphone-slash"></i>';
        }
      });

      videoBtn?.addEventListener("click", () => {
        const videoTrack = localStream?.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = !videoTrack.enabled;
          videoBtn.classList.toggle("muted", !videoTrack.enabled);
          videoBtn.innerHTML = videoTrack.enabled 
            ? '<i class="fa-solid fa-video"></i>' 
            : '<i class="fa-solid fa-video-slash"></i>';
        }
      });

      endBtn?.addEventListener("click", async () => {
        await endCall();
      });

      // Handle incoming calls on this peer
      peerInstance.on("call", (incomingCall) => {
        console.log("[PeerJS] Incoming call from:", incomingCall.peer);
        incomingCall.answer(localStream);
        incomingCall.on("stream", (remoteStream) => {
          console.log("[PeerJS] Got remote stream (incoming)");
          const remoteVideo = container.querySelector("#peer-remote-video");
          if (remoteVideo) {
            remoteVideo.srcObject = remoteStream;
            remoteVideo.play().catch(e => console.warn("Remote video play failed:", e));
          }
          const statusEl = container.querySelector("#peer-call-status");
          if (statusEl) statusEl.textContent = "Connected";
          callStartTime = Date.now();
          startCallTimer();
        });
        activeCall = incomingCall;
      });

      // If outgoing call, initiate the call
      if (!isIncoming && callerPeerId) {
        console.log("[PeerJS] Calling peer:", callerPeerId);
        const call = peerInstance.call(callerPeerId, localStream);
        
        call.on("stream", (remoteStream) => {
          console.log("[PeerJS] Got remote stream (outgoing)");
          const remoteVideo = container.querySelector("#peer-remote-video");
          if (remoteVideo) {
            remoteVideo.srcObject = remoteStream;
            remoteVideo.play().catch(e => console.warn("Remote video play failed:", e));
          }
          const statusEl = container.querySelector("#peer-call-status");
          if (statusEl) statusEl.textContent = "Connected";
          callStartTime = Date.now();
          startCallTimer();
        });

        call.on("close", () => {
          console.log("[PeerJS] Call closed");
          endCall();
        });

        call.on("error", (err) => {
          console.error("[PeerJS] Call error:", err);
          showToast("Call connection failed", "error");
          endCall();
        });

        activeCall = call;
      }

      // Setup audio analysis for voice indicator
      if (!isVideo) {
        attachVoicePulse(localStream);
      }

    } catch (err) {
      console.error("[PeerJS] Error starting call:", err);
      showToast("Could not start call: " + err.message, "error");
      endCall();
    }
  }

  async function endCall() {
    console.log("Ending call...");
    stopOutgoingRing();
    stopIncomingRing();
    const cid = currentCallConversationId || activeConversationId;
    currentCallConversationId = null;

    try {
      await broadcastConversationEvent(messageChannel, "call-end", { conversationId: cid });
      if (callStartTime) {
        await sendCallLogMessage("Call ended");
      }
    } catch (err) {
      console.warn("Error during endCall signaling:", err);
    } finally {
      cleanupWebRTC();
    }
  }

  function cleanupWebRTC() {
    stopOutgoingRing();
    stopIncomingRing();
    clearInterval(callTimerInterval);
    if (activeCall) {
      activeCall.close();
      activeCall = null;
    }
    if (voicePulseCleanup) {
      voicePulseCleanup();
      voicePulseCleanup = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    // Don't destroy peerInstance - reuse for future calls
    const remoteMedia = document.getElementById("admin-remote-call-media");
    if (remoteMedia) remoteMedia.remove();
    
    const modal = document.querySelector(".call-modal-overlay");
    if (modal) modal.remove();
    
    const banner = document.querySelector(".call-banner-overlay");
    if (banner) banner.remove();
  }

  async function renderCallModal(conversation, type = "voice", isOutgoing = true) {
    cleanupWebRTC();
    const name = getConversationName(conversation);
    const initial = getConversationInitial(conversation);
    const avatar = conversation.peer?.avatar_url || conversation.user?.avatar_url || null;

    const modal = document.createElement("div");
    modal.className = `call-modal-overlay ${isOutgoing ? "calling-mode" : ""}`;
    
    if (isOutgoing) {
      modal.innerHTML = `
        <div class="call-modal-content">
          <div class="call-modal-avatar">
            ${avatar ? `<img src="${avatar}" alt="${name}" />` : `<span>${initial}</span>`}
          </div>
          <h2 class="call-modal-name">${escapeHtml(name)}</h2>
          <div class="call-presence">
            <span class="presence-dot online"></span>
            <span>Online</span>
          </div>
          <p class="call-modal-status">Calling...</p>
          <div class="call-modal-actions">
            <button class="call-action-btn call-end" id="cancel-call-btn">
              <i class="fa-solid fa-phone-slash"></i>
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector("#cancel-call-btn").onclick = async () => {
        stopOutgoingRing();
        await endCall();
      };
    } else {
      // Receiver side (Accepted)
      modal.innerHTML = `
        <div class="call-modal-content peer-call-mode" style="width: 100%; height: 100%; max-width: 100%; border-radius: 0; padding: 0; background: #000;">
          <div id="peer-call-frame" style="width:100%; height:100%; border-radius:0; overflow:hidden;"></div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    if (isOutgoing) {
      currentCallConversationId = activeConversationId;
      playOutgoingRing();

      // Pre-create the peer so we can send the real peer ID in the signal
      if (!peerInstance || peerInstance.destroyed) {
        await new Promise((resolve) => {
          const tryCreate = (id) => {
            const peer = new Peer(id, {
              debug: 1,
              config: {
                iceServers: [
                  { urls: "stun:stun.l.google.com:19302" },
                  { urls: "stun:stun1.l.google.com:19302" },
                  { urls: "stun:stun2.l.google.com:19302" }
                ]
              }
            });
            peer.on("open", () => { peerInstance = peer; resolve(); });
            peer.on("error", (err) => {
              if (err.type === "unavailable-id") {
                peer.destroy();
                tryCreate(`chatnow_${profile.id}_${Date.now()}`);
              } else {
                console.error("[PeerJS] Pre-create error:", err);
                resolve(); // continue even if peer fails — startPeerCall will retry
              }
            });
          };
          tryCreate(`chatnow_${profile.id}`);
        });
      }

      broadcastConversationEvent(messageChannel, "call-request", {
        conversationId: activeConversationId,
        callerId: profile.id,
        callerPeerId: peerInstance?.id || `chatnow_${profile.id}`,
        callerName: profile.full_name || profile.username,
        callerAvatar: profile.avatar_url,
        type
      });
    }
  }

  function attachVoicePulse(stream) {
    if (!stream) return;
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let animationId = null;

      const checkVolume = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const avatar = root.querySelector(".call-modal-avatar");
        if (avatar) {
          avatar.classList.toggle("speaking", average > 15);
        }
        animationId = requestAnimationFrame(checkVolume);
      };

      checkVolume();
      voicePulseCleanup = () => {
        cancelAnimationFrame(animationId);
        audioContext.close().catch(() => { });
      };
    } catch (e) {
      console.warn("Audio analysis failed:", e);
    }
  }

  function renderSettingsTab(content = root.querySelector("#admin-content")) {
    const slug = adminMeta?.unique_slug || "your-slug";
    const chatLink = `${window.location.origin}${window.location.pathname}#/chat/${slug}`;
    content.innerHTML = `
      <div class="stack">
        <form id="password-form" class="stack">
          <h3 style="margin:0;">Security</h3>
          <input name="password" type="password" minlength="6" placeholder="New password" required />
          <button class="btn btn-secondary" type="submit">Update Password</button>
        </form>
        <div class="panel">
          <h3 style="margin-top:0;">Unique Chat Link</h3>
          <div class="inline">
            <input id="chat-link" value="${chatLink}" readonly />
            <button class="btn btn-secondary" type="button" id="copy-link">Copy</button>
          </div>
        </div>
        <div class="panel">
          <h3 style="margin-top:0;">App Settings</h3>
          <div class="stack">
            <button class="btn btn-secondary ${installAvailable ? "" : "hidden"}" id="settings-install" type="button">
              Install App
            </button>
            <label class="switch-inline">
              <input type="checkbox" id="settings-notify" ${notificationPrefs.desktop ? "checked" : ""} />
              Notify
            </label>
            <label class="switch-inline">
              <input type="checkbox" id="settings-sound" ${notificationPrefs.sound ? "checked" : ""} />
              Sound
            </label>
            <button class="btn btn-ghost" id="settings-signout" type="button">Sign Out</button>
          </div>
        </div>

        <div class="panel">
          <h3 style="margin:0 0 10px;">Export Chat History</h3>
          <p class="muted small" style="margin-bottom:10px;">Select conversations and date range to export as CSV.</p>
          <div class="stack">
            <div style="background: #2a2f32; border: 1px solid #3b4043; border-radius: 6px; padding: 10px; max-height: 150px; overflow-y: auto; margin-bottom: 10px; scrollbar-width: none;">
              <label class="switch-inline" style="margin-bottom: 8px; border-bottom: 1px solid #3b4043; padding-bottom: 5px;">
                <input type="checkbox" id="export-select-all" />
                <strong>Select All</strong>
              </label>
              <div id="export-chat-list" class="stack">
                ${conversations.map(c => `
                  <label class="switch-inline">
                    <input type="checkbox" class="export-chat-checkbox" value="${c.id}" />
                    ${escapeHtml(getConversationName(c))}
                  </label>
                `).join("")}
              </div>
            </div>
            <div class="inline" style="gap:10px;">
              <div style="flex:1;">
                <label class="muted small">From</label>
                <input type="date" id="export-from-date" class="composer-text" style="width:100%; background: #2a2f32; border: 1px solid #3b4043; color: white; padding: 8px; border-radius: 6px;" />
              </div>
              <div style="flex:1;">
                <label class="muted small">To</label>
                <input type="date" id="export-to-date" class="composer-text" style="width:100%; background: #2a2f32; border: 1px solid #3b4043; color: white; padding: 8px; border-radius: 6px;" />
              </div>
            </div>
            <button class="btn btn-primary" style="margin-top:15px; width:100%;" id="admin-settings-export">
              <i class="fa-solid fa-file-export" style="margin-right:8px;"></i> Export to CSV
            </button>
          </div>
        </div>
      </div>
    `;

    content.querySelector("#password-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      await updatePassword(String(fd.get("password") || ""));
      showToast("Password updated.");
      event.currentTarget.reset();
    });

    content.querySelector("#copy-link")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(String(content.querySelector("#chat-link").value || ""));
      showToast("Link copied.");
    });

    content.querySelector("#settings-install")?.addEventListener("click", async () => {
      const opened = await onInstall();
      if (opened) showToast("Install prompt opened.");
    });

    content.querySelector("#settings-notify")?.addEventListener("change", async (event) => {
      const enabled = !!event.currentTarget.checked;
      if (enabled) {
        const granted = await ensureDesktopPermission();
        if (!granted) {
          notificationPrefs.desktop = false;
          event.currentTarget.checked = false;
          saveNotificationPrefs(notificationScope, notificationPrefs);
          showToast("Browser notifications are blocked for this site.", "error");
          return;
        }
      }
      notificationPrefs.desktop = enabled;
      saveNotificationPrefs(notificationScope, notificationPrefs);
      showToast(enabled ? "Notifications enabled." : "Notifications turned off.");
    });

    content.querySelector("#settings-sound")?.addEventListener("change", (event) => {
      notificationPrefs.sound = !!event.currentTarget.checked;
      saveNotificationPrefs(notificationScope, notificationPrefs);
      showToast(notificationPrefs.sound ? "Message sound enabled." : "Message sound turned off.");
    });

    content.querySelector("#settings-signout")?.addEventListener("click", async () => {
      await onSignOut();
    });

    content.querySelector("#export-select-all")?.addEventListener("change", (event) => {
      const checked = !!event.currentTarget.checked;
      content.querySelectorAll(".export-chat-checkbox").forEach(cb => cb.checked = checked);
    });

    content.querySelector("#admin-settings-export")?.addEventListener("click", async () => {
      const selectedCheckboxes = content.querySelectorAll(".export-chat-checkbox:checked");
      const convIds = Array.from(selectedCheckboxes).map(cb => cb.value);
      const fromDate = content.querySelector("#export-from-date").value;
      const toDate = content.querySelector("#export-to-date").value;

      if (convIds.length === 0) return showToast("Please select at least one conversation to export.", "error");

      try {
        let allExportData = [];
        showToast("Generating export... Please wait.");

        for (const convId of convIds) {
          const conv = conversations.find(c => c.id === convId);
          const isDirect = conv?.type === "direct";
          let convData = isDirect
            ? await getDirectMessages(convId)
            : await getConversationMessages(convId);

          const convName = getConversationName(conv);
          convData = convData.map(m => ({ ...m, _convName: convName }));
          allExportData = allExportData.concat(convData);
        }

        if (fromDate) {
          const start = new Date(fromDate).getTime();
          allExportData = allExportData.filter(m => new Date(m.created_at).getTime() >= start);
        }
        if (toDate) {
          const end = new Date(toDate).getTime() + 86400000;
          allExportData = allExportData.filter(m => new Date(m.created_at).getTime() <= end);
        }

        if (allExportData.length === 0) return showToast("No messages found for the selected range.", "error");

        allExportData.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        const headers = ["Date", "Conversation", "Sender", "Type", "Content"];
        const rows = allExportData.map(m => [
          new Date(m.created_at).toLocaleString(),
          m._convName,
          m.sender_id === profile.id ? "Me" : "Other",
          m.message_type,
          (m.content || m.media_url || "").replace(/"/g, '""')
        ]);
        const csvContent = [headers, ...rows].map(r => `"${r.join('","')}"`).join("\n");

        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `chat_export_${new Date().toISOString().split("T")[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast("Export successful!");
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });
  }

  await loadData();
  renderShell();
  let wasMobileViewport = isMobileViewport();
  const handleViewportChange = () => {
    const isMobile = isMobileViewport();
    if (!isMobile) {
      mobileMessagesFocused = false;
      messagesSidebarOpen = false;
    }
    if (isMobile !== wasMobileViewport) {
      wasMobileViewport = isMobile;
      renderMessagesTab().catch(() => { });
      return;
    }
    wasMobileViewport = isMobile;
    updateShellMobileState();
  };
  window.addEventListener("resize", handleViewportChange);
  await renderMessagesTab();
  startConversationPoll();

  // Subscribe to Web Push so the admin gets notifications when the tab is closed
  initWebPush(profile.id, savePushSubscription).catch(() => {});

  return async () => {
    window.removeEventListener("resize", handleViewportChange);
    await publishTypingState(false);
    await removeChannel(messageChannel);
    await removeChannel(supportChannel);
    for (const channel of conversationWatchChannels.values()) {
      await removeChannel(channel);
    }
    conversationWatchChannels.clear();
    stopMessagePoll();
    stopSupportPoll();
    stopConversationPoll();
    currentCallConversationId = null;
    cleanupWebRTC();
    resetTypingState();
    // Destroy peer on full unmount so the ID is freed for the next session
    if (peerInstance && !peerInstance.destroyed) {
      peerInstance.destroy();
      peerInstance = null;
    }
    // Remove push subscription on sign-out
    cleanupWebPush(profile.id, removePushSubscription).catch(() => {});
  };
}
