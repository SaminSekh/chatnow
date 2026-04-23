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
  ensureDirectConversation,
  findProfileByUsername,
  getAdminBySlug,
  getConversationMessages,
  getDirectMessages,
  listUnifiedConversations,
  listUnifiedLatestMessages,
  listUnifiedUnreadCounts,
  markConversationRead,
  markDirectConversationRead,
  removeChannel,
  sendDirectMessage,
  sendMessage,
  subscribeToConversationMessages,
  subscribeToDirectMessages,
  updatePassword,
  updateProfile,
  uploadAvatar,
  uploadChatMedia,
  deleteDirectConversation,
  deleteSupportConversation,
  uploadVoiceBlob
} from "../services/supabaseApi.js";
import { createVoiceRecorder, renderMessageList, scrollMessagesToBottom } from "./chatUi.js";
import { initWebPush, cleanupWebPush } from "../lib/webPush.js";
import { savePushSubscription, removePushSubscription } from "../services/supabaseApi.js";

export async function renderUserDashboard({
  root,
  profile,
  chatSlug,
  installAvailable,
  onInstall,
  onSignOut
}) {
  let activeTool = "messages";
  let conversations = [];
  let activeConversationId = null;
  let messages = [];
  let messageChannel = null;
  let messagePoll = null;
  let conversationPoll = null;
  let chatSidebarOpen = false;
  let mobileMessagesFocused = false;
  let conversationQuery = "";
  let chatSearchOpen = false;
  let chatSearchQuery = "";
  const hiddenChatIds = new Set(JSON.parse(localStorage.getItem(`hidden_chats:${profile.id}`) || "[]"));

  function unhideConversation(id) {
    if (hiddenChatIds.has(id)) {
      hiddenChatIds.delete(id);
      localStorage.setItem(`hidden_chats:${profile.id}`, JSON.stringify([...hiddenChatIds]));
    }
  }

  const conversationMeta = new Map();
  const knownMessageIds = new Set();
  const deliveredMessageIds = new Set();
  const clearedConversationIds = new Set();
  const notificationScope = `user:${profile.id}`;
  let notificationPrefs = loadNotificationPrefs(notificationScope);
  if ("Notification" in window && Notification.permission === "denied" && notificationPrefs.desktop) {
    notificationPrefs.desktop = false;
    saveNotificationPrefs(notificationScope, notificationPrefs);
  }

  let peerTyping = false;
  let typingEchoTimeout = null;
  let localTyping = false;
  let localTypingTimeout = null;
  let lastTypingBroadcastAt = 0;
  const typingByConversation = new Map();
  const typingTimeoutByConversation = new Map();
  const conversationWatchChannels = new Map();
  const TYPING_IDLE_MS = 1400;
  const TYPING_REMOTE_TTL_MS = 1800;
  const TYPING_HEARTBEAT_MS = 500;

  function isMobileViewport() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  function updateShellMobileState() {
    const shell = root.querySelector("#user-shell");
    if (!shell) return;
    const hideRail = isMobileViewport() && activeTool === "messages" && mobileMessagesFocused;
    shell.classList.toggle("admin-mobile-chat-focus", hideRail);
  }

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

  function setRailActive(tool) {
    root.querySelectorAll("#user-icon-rail [data-tool]").forEach((x) => {
      x.classList.toggle("active", x.dataset.tool === tool);
    });
  }

  function renderShell() {
    root.innerHTML = `
      <section class="dashboard admin-wa-shell user-wa-shell" id="user-shell">
        <aside class="admin-icon-rail" id="user-icon-rail">
          <button class="admin-rail-btn active" data-tool="messages" aria-label="Chats"><i class="fa-solid fa-comment"></i></button>
          <button class="admin-rail-btn" data-tool="users" aria-label="Users"><i class="fa-solid fa-plus"></i></button>
          <button class="admin-rail-btn" data-tool="profile" aria-label="Profile"><i class="fa-solid fa-user"></i></button>
          <button class="admin-rail-btn" data-tool="settings" aria-label="Settings"><i class="fa-solid fa-gear"></i></button>
        </aside>
        <section class="panel admin-main-panel" id="user-content"></section>
      </section>
    `;

    root.querySelectorAll("#user-icon-rail [data-tool]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tool = btn.dataset.tool;
        activeTool = tool;
        if (tool !== "messages") {
          mobileMessagesFocused = false;
        }
        updateShellMobileState();
        setRailActive(tool);
        await renderTab();
      });
    });
  }

  function getConversationName(conversation) {
    return (
      conversation?.peer?.full_name ||
      conversation?.peer?.username ||
      conversation?.peer_id ||
      "Unknown user"
    );
  }

  function getConversationInitial(conversation) {
    const name = String(getConversationName(conversation) || "").trim();
    return (name.charAt(0) || "?").toUpperCase();
  }

  function getDisplayedMessages() {
    const query = String(chatSearchQuery || "").trim().toLowerCase();
    if (!query) return messages;
    return messages.filter((message) => {
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
      tag: `user-chat-${message.conversation_id}`
    });
  }

  function renderTypingIndicator() {
    const el = root.querySelector("#user-typing-indicator");
    const sub = root.querySelector("#user-header-subtitle");
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
        const convList = root.querySelector("#user-conv-list");
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
    const convList = root.querySelector("#user-conv-list");
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

  function markMessageDelivered(messageId) {
    if (!messageId || deliveredMessageIds.has(messageId)) return;
    deliveredMessageIds.add(messageId);
    const list = root.querySelector("#user-message-list");
    if (list) {
      renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
    }
  }

  async function sendDeliveryAck(message) {
    if (!message?.id || !message?.conversation_id || message.sender_id === profile.id) return;
    await broadcastConversationEvent(messageChannel, "message-delivered", {
      conversationId: message.conversation_id,
      messageId: message.id,
      recipientId: profile.id
    });
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
      tag: `chat-${message.conversation_id}`
    });
  }

  function handleDeliveryEvent(payload) {
    if (!payload?.messageId || payload.recipientId === profile.id) return;
    markMessageDelivered(payload.messageId);
  }

  async function syncConversationMeta({ notify = false } = {}) {
    conversations = await listUnifiedConversations(profile.id, "user");
    const ids = conversations.map((item) => item.id);
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
      }
    }

    for (const conversation of conversations) {
      const latest = latestByConversation.get(conversation.id);
      const previous = getConversationMeta(conversation.id);
      const unreadCount = conversation.id === activeConversationId ? 0 : unreadByConversation.get(conversation.id) || 0;
      
      if (latest && latest.id !== previous.lastMessageId) {
        unhideConversation(conversation.id);
      }

      conversationMeta.set(conversation.id, {
        preview: latest ? getMessagePreview(latest) : "No messages yet.",
        updatedAt: latest?.created_at || conversation.updated_at || conversation.created_at,
        unreadCount,
        lastMessageId: latest?.id || null
      });

      if (latest?.id && !knownMessageIds.has(latest.id)) {
        if (notify && latest.sender_id !== profile.id) {
          await maybeNotifyIncomingMessage(latest, conversation);
        }
        knownMessageIds.add(latest.id);
      }
    }

    sortConversationsByRecent();
    await syncConversationWatchChannels();
    const convList = root.querySelector("#user-conv-list");
    if (convList) renderSidebarPanel(convList);
  }

  async function openConversation(conversationId) {
    await publishTypingState(false);
    resetTypingState();
    activeConversationId = conversationId;
    const conv = conversations.find((c) => c.id === conversationId);
    const isDirect = conv?.type === "direct";

    const existingWatch = conversationWatchChannels.get(conversationId);
    if (existingWatch) {
      await removeChannel(existingWatch);
      conversationWatchChannels.delete(conversationId);
    }

    messages = isDirect ? await getDirectMessages(conversationId) : await getConversationMessages(conversationId);
    for (const message of messages) {
      if (message?.id) knownMessageIds.add(message.id);
      if (message?.is_read) deliveredMessageIds.add(message.id);
    }
    const last = messages[messages.length - 1];
    if (last) applyMessageMeta(last, { markUnread: false });
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
    const convList = root.querySelector("#user-conv-list");
    if (convList) renderSidebarPanel(convList);
  }

  async function refreshConversationMessages() {
    if (!activeConversationId) return;
    // Don't re-load messages for conversations that were cleared
    if (clearedConversationIds.has(activeConversationId)) return;
    const conv = conversations.find((c) => c.id === activeConversationId);
    const isDirect = conv?.type === "direct";
    const latest = isDirect ? await getDirectMessages(activeConversationId) : await getConversationMessages(activeConversationId);
    for (const message of latest) {
      if (message?.id && !knownMessageIds.has(message.id) && message.sender_id !== profile.id) {
        await maybeNotifyIncomingMessage(message, conv);
      }
      if (message?.id) knownMessageIds.add(message.id);
      if (message?.is_read) deliveredMessageIds.add(message.id);
    }
    messages = latest;
    const last = latest[latest.length - 1];
    if (last) applyMessageMeta(last, { markUnread: false });
    clearUnreadForConversation(activeConversationId);
    const list = root.querySelector("#user-message-list");
    if (list) {
      renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
      scrollMessagesToBottom(list);
    }
    const convList = root.querySelector("#user-conv-list");
    if (convList) renderSidebarPanel(convList);
  }

  function startMessagePoll() {
    stopMessagePoll();
    if (!activeConversationId) return;
    messagePoll = setInterval(async () => {
      try {
        await refreshConversationMessages();
      } catch (error) {
        console.warn("User message poll failed:", error);
      }
    }, 3000);
  }

  function stopMessagePoll() {
    if (messagePoll) {
      clearInterval(messagePoll);
      messagePoll = null;
    }
  }

  function startConversationPoll() {
    stopConversationPoll();
    conversationPoll = setInterval(async () => {
      try {
        await syncConversationMeta({ notify: true });
      } catch (error) {
        console.warn("User conversation poll failed:", error);
      }
    }, 3000);
  }

  function stopConversationPoll() {
    if (conversationPoll) {
      clearInterval(conversationPoll);
      conversationPoll = null;
    }
  }

  async function reconnectMessageChannel() {
    await removeChannel(messageChannel);
    if (!activeConversationId) return;
    const handleIncomingMessage = async (message) => {
      if (!message || message.conversation_id !== activeConversationId) return;
      unhideConversation(message.conversation_id);
      if (message?.id && knownMessageIds.has(message.id)) return;
      if (message?.id) knownMessageIds.add(message.id);
      setPeerTyping(false);
      messages.push(message);
      applyMessageMeta(message, { markUnread: false });
      clearUnreadForConversation(activeConversationId);
      const list = root.querySelector("#user-message-list");
      if (list) {
        renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
        scrollMessagesToBottom(list);
      }
      if (message.sender_id !== profile.id) {
        await sendDeliveryAck(message);
        const conv = conversations.find((item) => item.id === activeConversationId);
        await maybeNotifyIncomingMessage(message, conv);
        await markDirectConversationRead(activeConversationId, profile.id);
      }
      const convList = root.querySelector("#user-conv-list");
      if (convList) renderSidebarPanel(convList);
    };

    const conv = conversations.find((c) => c.id === activeConversationId);
    const isDirect = conv?.type === "direct";

    const subFn = isDirect ? subscribeToDirectMessages : subscribeToConversationMessages;

    messageChannel = subFn(
      activeConversationId,
      async (message) => {
        await handleIncomingMessage(message);
      },
      {
        onTyping: (payload) => handleTypingEvent(payload),
        onInstantMessage: async (payload) => {
          await handleIncomingMessage(payload.message);
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
          await renderTab();
          showToast("This conversation has been deleted.");
        }
      }
    );
  }

  async function sendChatMessage({ type = MESSAGE_TYPES.TEXT, content = "", mediaUrl = null }) {
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
      messages.push(sent);
      knownMessageIds.add(sent.id);
      applyMessageMeta(sent, { markUnread: false });
      broadcastConversationEvent(messageChannel, "instant-message", { message: sent });
      const list = root.querySelector("#user-message-list");
      if (list) {
        renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
        scrollMessagesToBottom(list, { force: true });
      }
      const convList = root.querySelector("#user-conv-list");
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

      const conversationId = await ensureDirectConversation(target.id);
      await syncConversationMeta({ notify: false });
      await openConversation(conversationId);
      chatSidebarOpen = false;
      if (isMobileViewport()) {
        mobileMessagesFocused = true;
      }
      await renderTab();
      showToast(`Chat opened with @${target.username || username.toLowerCase()}.`);
      return true;
    } catch (error) {
      showToast(parseError(error), "error");
      return false;
    }
  }

  function renderConversationList(container) {
    if (!container) return;
    const filtered = getFilteredConversations();
    const totalUnread = filtered.reduce((sum, c) => sum + Number(getConversationMeta(c.id).unreadCount || 0), 0);

    // Only build the full controls HTML on first render (when the input doesn't exist yet).
    // On subsequent calls (e.g. triggered by search input) we skip re-rendering the header
    // so the input keeps focus and its typed value.
    if (!container.querySelector("#user-search-all")) {
      const controlsHtml = `
        <div class="chat-list-head">
          <h3>${escapeHtml(profile.username || "User")}</h3>
          <span class="badge ${totalUnread > 0 ? "success" : ""}" id="user-conv-badge">${totalUnread > 0 ? totalUnread : filtered.length}</span>
        </div>
        <div class="chat-list-search">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input id="user-search-all" type="text" placeholder="Search user or chat content..." value="${escapeHtml(conversationQuery)}" />
        </div>
        <div id="user-conv-items"></div>
      `;
      container.innerHTML = controlsHtml;

      container.querySelector("#user-search-all")?.addEventListener("input", (event) => {
        conversationQuery = String(event.currentTarget.value || "");
        renderConversationList(container);
      });
    }

    // Always update the badge count
    const badge = container.querySelector("#user-conv-badge");
    if (badge) {
      badge.textContent = totalUnread > 0 ? totalUnread : filtered.length;
      badge.className = `badge ${totalUnread > 0 ? "success" : ""}`;
    }

    // Only re-render the list items
    const itemsContainer = container.querySelector("#user-conv-items");
    if (!itemsContainer) return;

    const listHtml = filtered.length
      ? filtered
        .map((conversation) => {
          const meta = getConversationMeta(conversation.id);
          const unreadCount = Number(meta.unreadCount || 0);
          const avatarUrl = String(conversation?.peer?.avatar_url || "");
          const peerProfile = conversation?.peer || {};
          const profileData = encodeURIComponent(JSON.stringify({
            name: getConversationName(conversation),
            username: peerProfile.username || "",
            role: peerProfile.role || "user",
            avatar_url: avatarUrl,
            created_at: peerProfile.created_at || ""
          }));
          return `<article class="conversation-item ${conversation.id === activeConversationId ? "active" : ""}" data-id="${conversation.id}">
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
                    <div class="conversation-preview ${typingByConversation.has(conversation.id) ? "typing" : ""}">
                      ${typingByConversation.has(conversation.id) ? "typing..." : escapeHtml(meta.preview || "No messages yet.")}
                    </div>
                    <div class="conversation-time">${formatDateTime(meta.updatedAt || conversation.updated_at)}</div>
                  </div>
                </div>
              </article>`;
        })
        .join("")
      : `<p class="muted" style="padding:12px;">No conversations yet.</p>`;

    itemsContainer.innerHTML = listHtml;
  }

  async function maybeOpenFromLegacySlug(slug) {
    const safeSlug = String(slug || "").trim().toLowerCase();
    if (!safeSlug) return false;
    try {
      const admin = await getAdminBySlug(safeSlug);
      if (!admin?.id) return false;
      const conversationId = await ensureDirectConversation(admin.id);
      await syncConversationMeta({ notify: false });
      await openConversation(conversationId);
      return true;
    } catch {
      return false;
    }
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
      await sendDeliveryAck(message);
      await maybeNotifyIncomingMessage(message, conversation);
    }
    const convList = root.querySelector("#user-conv-list");
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
            await renderTab();
            showToast("A conversation has been deleted.");
          }
        }
      );
      conversationWatchChannels.set(conversation.id, watchChannel);
    }
  }

  function renderActiveToolInSidebar(container) {
    if (activeTool === "users") {
      renderUsersTab(container, {
        onDone: async () => {
          activeTool = "messages";
          setRailActive("messages");
          chatSidebarOpen = false;
          if (isMobileViewport()) {
            mobileMessagesFocused = true;
          }
          updateShellMobileState();
          await renderTab();
        }
      });
      return;
    }
    if (activeTool === "profile") {
      renderProfileTab(container);
      return;
    }
    if (activeTool === "settings") {
      renderSettingsTab(container);
    }
  }

  function renderSidebarPanel(container) {
    if (!container) return;
    if (activeTool !== "messages") return;
    renderConversationList(container);
  }

  function renderUsersTab(content = root.querySelector("#user-content"), { onDone } = {}) {
    const list = [...conversations];
    content.innerHTML = `
      <div class="inline" style="justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">Users</h3>
        <button class="btn btn-primary icon-btn" type="button" id="users-add-member" aria-label="Add New Member"><i class="fa-solid fa-plus"></i></button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Last Active</th><th>Action</th></tr></thead>
          <tbody>
            ${list.length
        ? list
          .map((conversation) => {
            const meta = getConversationMeta(conversation.id);
            return `<tr>
                        <td>${escapeHtml(getConversationName(conversation))}</td>
                        <td>${formatDateTime(meta.updatedAt || conversation.updated_at)}</td>
                        <td><button class="btn btn-secondary" data-chat="${conversation.id}">Open Chat</button></td>
                      </tr>`;
          })
          .join("")
        : `<tr><td colspan="3" class="muted">No users yet.</td></tr>`
      }
          </tbody>
        </table>
      </div>
    `;

    content.querySelector("#users-add-member")?.addEventListener("click", async () => {
      const opened = await startChatWithUsernamePrompt();
      if (opened && typeof onDone === "function") await onDone();
    });

    content.querySelectorAll("[data-chat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          if (isMobileViewport()) {
            mobileMessagesFocused = true;
          }
          chatSidebarOpen = false;
          await openConversation(btn.dataset.chat);
          await renderTab();
          if (typeof onDone === "function") await onDone();
        } catch (error) {
          showToast(parseError(error), "error");
        }
      });
    });
  }

  function renderProfileTab(content = root.querySelector("#user-content")) {
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
        <form id="user-profile-form">
          <h3 style="margin:0;">Edit Profile</h3>
          <div class="grid-2">
            <input name="full_name" value="${escapeHtml(profile.full_name || "")}" placeholder="Full name" />
            <input name="avatar" type="file" accept="image/*" />
          </div>
          <div class="actions">
            <button class="btn btn-primary" type="submit">Save Profile</button>
          </div>
        </form>
        <form id="user-password-form">
          <h3 style="margin:0;">Password</h3>
          <div class="field">
            <label>New password</label>
            <input name="password" type="password" minlength="6" required />
          </div>
          <button class="btn btn-secondary" type="submit">Update Password</button>
        </form>
      </div>
    `;

    content.querySelector("#user-profile-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const fullName = String(formData.get("full_name") || "").trim();
      const avatarFile = formData.get("avatar");

      try {
        const updates = { full_name: fullName };
        if (avatarFile && avatarFile.size > 0) {
          updates.avatar_url = await uploadAvatar(avatarFile, profile.id);
        }
        Object.assign(profile, await updateProfile(updates));
        showToast("Profile updated.");
        renderProfileTab(content);
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    content.querySelector("#user-password-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      try {
        await updatePassword(String(formData.get("password") || ""));
        showToast("Password updated.");
        event.currentTarget.reset();
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });
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

  function playIncomingRing() {
    stopIncomingRing();
    incomingRingAudio = new Audio("https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3");
    incomingRingAudio.loop = true;
    incomingRingAudio.play().catch(e => console.warn("Incoming ring blocked:", e));
  }

  function stopIncomingRing() {
    if (incomingRingAudio) {
      incomingRingAudio.pause();
      incomingRingAudio = null;
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

      // Resolve peer info for the voice call avatar
      const callConv = conversations.find(c => c.id === conversationId);
      const peerName = callConv?.peer?.full_name || callConv?.peer?.username || callConv?.user?.full_name || "Caller";
      const peerAvatar = callConv?.peer?.avatar_url || callConv?.user?.avatar_url || null;
      const peerInitial = peerName.charAt(0).toUpperCase();

      // Create call UI
      container.innerHTML = `
        <div class="peer-call-container ${!isVideo ? "voice-call" : ""}">
          <div class="peer-videos">
            <video id="peer-remote-video" autoplay playsinline></video>
            ${isVideo ? `<video id="peer-local-video" autoplay playsinline muted></video>` : ""}
            ${!isVideo ? `
              <div class="voice-call-info">
                <div class="voice-avatar" id="voice-avatar">
                  ${peerAvatar
                    ? `<img src="${peerAvatar}" alt="${peerName}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
                    : `<span>${peerInitial}</span>`
                  }
                </div>
                <div class="voice-peer-name">${peerName}</div>
              </div>
            ` : ""}
          </div>
          <div class="peer-controls">
            <button class="peer-ctrl-btn" id="peer-toggle-audio" title="Toggle Microphone">
              <i class="fa-solid fa-microphone"></i>
            </button>
            <button class="peer-ctrl-btn" id="peer-toggle-speaker" title="Toggle Loudspeaker">
              <i class="fa-solid fa-volume-high"></i>
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
      const speakerBtn = container.querySelector("#peer-toggle-speaker");
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

      // Loudspeaker toggle — routes remote audio between earpiece and loudspeaker
      let speakerEnabled = false;
      speakerBtn?.addEventListener("click", async () => {
        speakerEnabled = !speakerEnabled;
        speakerBtn.classList.toggle("speaker-on", speakerEnabled);
        speakerBtn.innerHTML = speakerEnabled
          ? '<i class="fa-solid fa-volume-high"></i>'
          : '<i class="fa-solid fa-volume-xmark"></i>';
        speakerBtn.title = speakerEnabled ? "Loudspeaker On" : "Loudspeaker Off";

        // On supported browsers (mainly mobile), switch audio output sink
        const remoteVideo = container.querySelector("#peer-remote-video");
        if (remoteVideo && typeof remoteVideo.setSinkId === "function") {
          try {
            if (speakerEnabled) {
              // Request available audio output devices and pick the speaker/default
              const devices = await navigator.mediaDevices.enumerateDevices();
              const speaker = devices.find(
                (d) => d.kind === "audiooutput" && /speaker|default/i.test(d.label)
              ) || devices.find((d) => d.kind === "audiooutput");
              if (speaker) await remoteVideo.setSinkId(speaker.deviceId);
            } else {
              // Route back to default (earpiece on mobile)
              await remoteVideo.setSinkId("");
            }
          } catch (err) {
            console.warn("setSinkId failed:", err);
          }
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
    const remoteMedia = document.getElementById("remote-call-media");
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
        audioContext.close().catch(() => {});
      };
    } catch (e) {
      console.warn("Audio analysis failed:", e);
    }
  }

  function renderSettingsTab(content = root.querySelector("#user-content")) {
    content.innerHTML = `
      <div class="stack">
        <h3 style="margin:0;">Settings</h3>
        <p class="muted" style="margin:0;">Signed in as ${escapeHtml(profile.username || "")}</p>
        <div class="inline">
          <button class="btn btn-secondary ${installAvailable ? "" : "hidden"}" type="button" id="user-settings-install">
            Install App
          </button>
          <button class="btn btn-ghost" type="button" id="user-settings-logout">Sign Out</button>
        </div>
        <div class="panel">
          <h3 style="margin:0 0 10px;">Chat Preferences</h3>
          <div class="stack">
            <label class="switch-inline">
              <input type="checkbox" id="user-settings-notify" ${notificationPrefs.desktop ? "checked" : ""} />
              Notify
            </label>
            <label class="switch-inline">
              <input type="checkbox" id="user-settings-sound" ${notificationPrefs.sound ? "checked" : ""} />
              Sound
            </label>
          </div>
        </div>
      </div>
    `;

    content.querySelector("#user-settings-install")?.addEventListener("click", async () => {
      const installed = await onInstall();
      if (installed) showToast("Install prompt opened.");
    });
    content.querySelector("#user-settings-logout")?.addEventListener("click", onSignOut);

    content.querySelector("#user-settings-notify")?.addEventListener("change", async (event) => {
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

    content.querySelector("#user-settings-sound")?.addEventListener("change", (event) => {
      notificationPrefs.sound = !!event.currentTarget.checked;
      saveNotificationPrefs(notificationScope, notificationPrefs);
      showToast(notificationPrefs.sound ? "Message sound enabled." : "Message sound turned off.");
    });
  }

  async function renderTab() {
    const content = root.querySelector("#user-content");
    if (!content) return;
    const isMessagesTool = activeTool === "messages";
    const isMobile = isMobileViewport();
    const listMode = isMobile && (!mobileMessagesFocused || !isMessagesTool);
    const selected = conversations.find((item) => item.id === activeConversationId);
    const selectedMeta = selected ? getConversationMeta(selected.id) : null;
    const showBackButton = isMobile && (mobileMessagesFocused || !isMessagesTool);
    const toolTitleMap = {
      users: "Users",
      profile: "Profile",
      settings: "Settings"
    };
    const headerTitle = isMessagesTool ? escapeHtml(selected ? getConversationName(selected) : "Select chat") : toolTitleMap[activeTool] || "Tool";
    const headerSubTitle = isMessagesTool
      ? selected
        ? formatDateTime(selectedMeta?.updatedAt || selected.updated_at)
        : "Choose a conversation"
      : "Manage tools from the sidebar";
    content.innerHTML = `
      <div class="chat-layout ${!isMobile && chatSidebarOpen ? "chat-layout-sidebar-open" : ""} ${listMode ? "admin-mobile-list-mode" : ""
      }">
        <button class="chat-backdrop" type="button" id="user-chat-sidebar-backdrop" aria-label="Close conversations"></button>
        <aside class="chat-sidebar" id="user-conv-list"></aside>
        <section class="chat-main">
          <header class="chat-header">
            <div class="chat-header-title">
              <button class="chat-menu-btn" type="button" id="user-chat-sidebar-toggle" aria-label="${showBackButton ? "Back to chats" : "Open conversations"
      }">
                ${showBackButton ? '<i class="fa-solid fa-arrow-left" aria-hidden="true"></i>' : "<span></span>"}
              </button>
              ${isMessagesTool && selected ? (() => {
                const hAvatarUrl = String(selected?.peer?.avatar_url || "");
                const hInitial = escapeHtml(getConversationInitial(selected));
                const hProfileData = encodeURIComponent(JSON.stringify({
                  name: getConversationName(selected),
                  username: selected?.peer?.username || "",
                  role: selected?.peer?.role || "user",
                  avatar_url: hAvatarUrl,
                  created_at: selected?.peer?.created_at || ""
                }));
                return `<div class="chat-header-avatar profile-avatar-trigger" id="user-header-avatar" data-profile="${hProfileData}" title="View profile" role="button" tabindex="0" aria-label="View profile">
                  ${hAvatarUrl ? `<img src="${hAvatarUrl}" alt="${hInitial}" />` : `<span>${hInitial}</span>`}
                </div>`;
              })() : ""}
              <div class="chat-header-copy">
                <strong>${headerTitle}</strong>
                <div class="chat-header-subtitle">
                  <span class="muted" id="user-header-subtitle">${headerSubTitle}</span>
                  <span class="typing-indicator ${isMessagesTool && peerTyping ? "active" : ""}" id="user-typing-indicator">
                    ${isMessagesTool && peerTyping ? "Typing..." : ""}
                  </span>
                </div>
              </div>
            </div>
            <div class="chat-header-tools">
              <button class="btn btn-ghost composer-icon-btn ${isMessagesTool && selected ? "" : "hidden"}" type="button" id="user-voice-call-btn" aria-label="Voice Call">
                <i class="fa-solid fa-phone"></i>
              </button>
              <button class="btn btn-ghost composer-icon-btn ${isMessagesTool && selected ? "" : "hidden"}" type="button" id="user-video-call-btn" aria-label="Video Call">
                <i class="fa-solid fa-video"></i>
              </button>
              <button class="btn btn-ghost composer-icon-btn ${isMessagesTool ? "" : "hidden"}" type="button" id="user-chat-search-toggle" aria-label="Search in chat">
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
            <input id="user-chat-search" type="text" placeholder="Search inside chat..." value="${escapeHtml(chatSearchQuery)}" />
          </div>
          <div id="user-message-list" class="message-list ${isMessagesTool ? "" : "hidden"}"></div>
          <div class="panel ${isMessagesTool ? "hidden" : ""}" style="height:100%; display:grid; place-items:center;">
            <p class="muted" style="margin:0;">Tool panel opened in sidebar.</p>
          </div>
          <form id="user-composer" class="composer whatsapp-composer ${isMessagesTool && selected ? "" : "hidden"}">
            <input id="user-image-input" class="composer-file" type="file" accept="image/*" />
            <button class="btn btn-secondary composer-icon-btn" type="button" id="user-attach-btn" aria-label="Attach image">
              <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
            </button>
            <input id="user-message-input" class="composer-text" type="text" placeholder="Type a message..." />
            <button class="btn btn-secondary composer-icon-btn" type="button" id="record-voice-btn" data-recording="false" aria-label="Record voice">
              <i class="fa-solid fa-microphone" aria-hidden="true"></i>
            </button>
            <button class="btn btn-primary composer-send-btn" type="submit" aria-label="Send message">
              <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
            </button>
          </form>
        </section>
      </div>
    `;
    updateShellMobileState();

    renderTypingIndicator();
    const convList = content.querySelector("#user-conv-list");
    if (isMessagesTool) {
      renderConversationList(convList);
    } else {
      renderActiveToolInSidebar(convList);
    }

    content.querySelector("#user-chat-sidebar-toggle")?.addEventListener("click", () => {
      if (!isMessagesTool) {
        activeTool = "messages";
        setRailActive("messages");
        if (isMobileViewport()) {
          mobileMessagesFocused = false;
        }
        updateShellMobileState();
        renderTab().catch(() => { });
        return;
      }
      if (isMobileViewport()) {
        mobileMessagesFocused = false;
        chatSidebarOpen = false;
        renderTab().catch(() => { });
        return;
      }
      chatSidebarOpen = !chatSidebarOpen;
      renderTab().catch(() => { });
    });

    content.querySelector("#user-chat-sidebar-backdrop")?.addEventListener("click", () => {
      chatSidebarOpen = false;
      renderTab().catch(() => { });
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
      chatSidebarOpen = false;
      if (isMobileViewport()) {
        mobileMessagesFocused = true;
      }
      await openConversation(row.dataset.id);
      await renderTab();
    });

    // Header avatar click — open profile lightbox
    content.querySelector("#user-header-avatar")?.addEventListener("click", (event) => {
      const trigger = event.currentTarget;
      try {
        const profileData = JSON.parse(decodeURIComponent(trigger.dataset.profile || "{}"));
        openProfileLightbox(profileData);
      } catch {}
    });

    content.querySelector("#user-chat-search-toggle")?.addEventListener("click", () => {
      chatSearchOpen = !chatSearchOpen;
      if (!chatSearchOpen) chatSearchQuery = "";
      renderTab().catch(() => { });
    });

    content.querySelector("#user-chat-search")?.addEventListener("input", (event) => {
      chatSearchQuery = String(event.currentTarget.value || "");
      const list = content.querySelector("#user-message-list");
      if (list) {
        renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
        scrollMessagesToBottom(list);
      }
    });

    const list = content.querySelector("#user-message-list");
    renderMessageList(list, getDisplayedMessages(), profile.id, { deliveredMessageIds });
    scrollMessagesToBottom(list, { force: true });

    // Handle @mention clicks
    list?.addEventListener("click", async (event) => {
      const mention = event.target.closest(".mention-link");
      if (!mention) return;
      
      const username = mention.dataset.mention;
      if (!username) return;

      if (username.toLowerCase() === profile.username.toLowerCase()) {
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

        console.log(`Mention lookup: @${username} -> ${targetProfile.id} (My ID: ${profile.id})`);

        if (targetProfile.id === profile.id) {
          showToast(`That's you (@${username})! You cannot start a chat with yourself.`, "info");
          return;
        }

        const conversationId = await ensureDirectConversation(targetProfile.id);
        if (conversationId) {
          await syncConversationMeta({ notify: false });
          await openConversation(conversationId);
          chatSidebarOpen = false;
          if (isMobileViewport()) {
            mobileMessagesFocused = true;
          }
          await renderTab();
          showToast(`Chat opened with @${username}.`);
        }
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    const composer = content.querySelector("#user-composer");
    const userInput = content.querySelector("#user-message-input");
    const userVoiceBtn = content.querySelector("#record-voice-btn");
    const voiceIcon = `<i class="fa-solid fa-microphone" aria-hidden="true"></i>`;
    const stopIcon = `<i class="fa-solid fa-stop" aria-hidden="true"></i>`;

    function setVoiceBtnState(isRecording) {
      if (!userVoiceBtn) return;
      userVoiceBtn.dataset.recording = isRecording ? "true" : "false";
      userVoiceBtn.classList.toggle("is-recording", isRecording);
      userVoiceBtn.setAttribute("aria-label", isRecording ? "Stop recording" : "Record voice");
      userVoiceBtn.innerHTML = isRecording ? stopIcon : voiceIcon;
    }

    userInput?.addEventListener("input", () => {
      const hasText = String(userInput.value || "").trim().length > 0;
      publishTypingState(hasText);
    });
    userInput?.addEventListener("blur", () => {
      publishTypingState(false);
    });

    composer?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = String(userInput?.value || "");
      try {
        await sendChatMessage({ content: text, type: MESSAGE_TYPES.TEXT });
        if (userInput) userInput.value = "";
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    const fileInput = content.querySelector("#user-image-input");
    content.querySelector("#user-attach-btn")?.addEventListener("click", () => {
      fileInput?.click();
    });

    fileInput?.addEventListener("change", async () => {
      const file = fileInput?.files?.[0];
      if (!file) return showToast("Please choose an image first.", "error");
      try {
        const mediaUrl = await uploadChatMedia(file, profile.id, "images");
        await sendChatMessage({ type: MESSAGE_TYPES.IMAGE, mediaUrl, content: "" });
        fileInput.value = "";
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    const recorder = createVoiceRecorder({
      onReady: () => setVoiceBtnState(true),
      onStop: async (blob) => {
        try {
          const mediaUrl = await uploadVoiceBlob(blob, profile.id, "voices");
          await sendChatMessage({ type: MESSAGE_TYPES.VOICE, mediaUrl, content: "" });
        } catch (error) {
          showToast(parseError(error), "error");
        } finally {
          setVoiceBtnState(false);
        }
      },
      onError: (error) => {
        setVoiceBtnState(false);
        showToast(parseError(error, "Microphone access denied"), "error");
      }
    });

    setVoiceBtnState(false);
    userVoiceBtn?.addEventListener("click", async () => {
      if (userVoiceBtn?.dataset.recording === "true") recorder.stop();
      else await recorder.start();
    });

    content.querySelector("#user-voice-call-btn")?.addEventListener("click", async () => {
      await ensureAudioUnlocked();
      pendingIceCandidates = []; // Clear for new outgoing call
      const conv = conversations.find(c => c.id === activeConversationId);
      if (conv) await renderCallModal(conv, "voice");
    });

    content.querySelector("#user-video-call-btn")?.addEventListener("click", async () => {
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
            messages = [];
            knownMessageIds.clear();
            optionsDropdown.classList.remove("show");
            showToast("Chat cleared.");
            await renderTab();
          } catch (err) {
            showToast(parseError(err), "error");
          }
        } else if (action === "remove") {
          if (confirm("Remove this chat from your list? The other person will still see it.")) {
            hiddenChatIds.add(conv.id);
            localStorage.setItem(`hidden_chats:${profile.id}`, JSON.stringify([...hiddenChatIds]));
            activeConversationId = null;
            optionsDropdown.classList.remove("show");
            await renderTab();
          }
        } else if (action === "delete") {
          if (confirm("Permanently delete this chat for everyone? This cannot be undone.")) {
            try {
              // Broadcast to active channel AND watch channel to ensure other user is notified
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
              await renderTab();
            } catch (error) {
              showToast(parseError(error), "error");
            }
          }
        }
      });
    });
  }

  renderShell();
  await syncConversationMeta({ notify: false });

  // Subscribe to Web Push so the user gets notifications when the tab is closed
  initWebPush(profile.id, savePushSubscription).catch(() => {});
  const openedLegacy = await maybeOpenFromLegacySlug(chatSlug);
  if (openedLegacy && isMobileViewport()) {
    mobileMessagesFocused = true;
  }
  if (!openedLegacy && !activeConversationId && conversations.length) {
    await openConversation(conversations[0].id);
  }
  await renderTab();
  startConversationPoll();

  return async () => {
    await publishTypingState(false);
    await removeChannel(messageChannel);
    for (const channel of conversationWatchChannels.values()) {
      await removeChannel(channel);
    }
    conversationWatchChannels.clear();
    stopMessagePoll();
    stopConversationPoll();
    resetTypingState();
    currentCallConversationId = null;
    cleanupWebRTC();
    // Destroy peer on full unmount so the ID is freed for the next session
    if (peerInstance && !peerInstance.destroyed) {
      peerInstance.destroy();
      peerInstance = null;
    }
    // Remove push subscription on sign-out
    cleanupWebPush(profile.id, removePushSubscription).catch(() => {});
  };
}
