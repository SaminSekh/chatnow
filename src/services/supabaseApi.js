import { supabase } from "../lib/supabase.js";

const AVATAR_BUCKET = "avatars";
const CHAT_BUCKET = "chat-media";
const AUTH_EMAIL_DOMAIN = "local.app";

function normalizeSupabaseError(error) {
  if (!error) return null;
  if (error.message) {
    const msg = String(error.message).toLowerCase();
    if (msg.includes("email rate limit exceeded") || msg.includes("rate limit exceeded")) {
      return new Error(
        "Signup is rate-limited on this Supabase project. Use your own Supabase URL/Anon key in app.config.js, disable Confirm email, then try again."
      );
    }
    return new Error(error.message);
  }
  return new Error(String(error));
}

function assertNoError(error) {
  if (error) throw normalizeSupabaseError(error);
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]/g, "");
}

function assertValidUsername(username) {
  if (!username) {
    throw new Error("Username is required");
  }
  if (username.length < 3 || username.length > 30) {
    throw new Error("Username must be between 3 and 30 characters");
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(username)) {
    throw new Error("Username can use letters, numbers, dot, underscore, or hyphen");
  }
}

function usernameToAuthEmail(username) {
  return `${username}@${AUTH_EMAIL_DOMAIN}`;
}

function toAuthEmailFromLoginInput(identifier) {
  const input = String(identifier || "").trim().toLowerCase();
  if (!input) return "";
  if (input.includes("@")) return input;
  const username = normalizeUsername(input);
  assertValidUsername(username);
  return usernameToAuthEmail(username);
}

function deriveUsernameFromUser(user) {
  const fromMetadata = normalizeUsername(user?.user_metadata?.username || "");
  if (fromMetadata) return fromMetadata;
  return normalizeUsername(String(user?.email || "").split("@")[0]);
}

export async function getSessionAndProfile() {
  const {
    data: { session },
    error: sessionError
  } = await supabase.auth.getSession();
  assertNoError(sessionError);

  if (!session?.user) {
    return { session: null, user: null, profile: null };
  }

  let profile = null;
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  profile = data;
  if (!profile) {
    const derivedUsername = deriveUsernameFromUser(session.user);
    const insertPayload = {
      id: session.user.id,
      email: session.user.email,
      username: derivedUsername || null,
      full_name: session.user.user_metadata?.full_name || session.user.email?.split("@")[0] || "User",
      role: "user"
    };
    const { data: inserted, error: insertError } = await supabase
      .from("profiles")
      .insert(insertPayload)
      .select("*")
      .single();
    assertNoError(insertError);
    profile = inserted;
  }

  return { session, user: session.user, profile };
}

export async function login(usernameOrEmail, password) {
  const email = toAuthEmailFromLoginInput(usernameOrEmail);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  assertNoError(error);
  return data;
}

export async function signupUser({ username, password, fullName }) {
  const normalizedUsername = normalizeUsername(username);
  assertValidUsername(normalizedUsername);
  const email = usernameToAuthEmail(normalizedUsername);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName, username: normalizedUsername }
    }
  });
  assertNoError(error);
  return data;
}

export async function signupAdmin({ username, password, fullName, companyName, uniqueSlug, remark }) {
  const normalizedUsername = normalizeUsername(username);
  assertValidUsername(normalizedUsername);
  const email = usernameToAuthEmail(normalizedUsername);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        username: normalizedUsername
      }
    }
  });
  assertNoError(error);

  if (data.session?.user) {
    await registerSelfAsAdmin({ companyName, uniqueSlug, remark });
  } else {
    localStorage.setItem(
      `pending_admin_registration:${email}`,
      JSON.stringify({
        companyName,
        uniqueSlug,
        remark,
        createdAt: Date.now()
      })
    );
  }

  return data;
}

export async function completePendingAdminRegistration(user) {
  if (!user?.email) return false;
  const key = `pending_admin_registration:${user.email.toLowerCase()}`;
  const stored = localStorage.getItem(key);
  if (!stored) return false;

  try {
    const pending = JSON.parse(stored);
    await registerSelfAsAdmin({
      companyName: pending.companyName,
      uniqueSlug: pending.uniqueSlug,
      remark: pending.remark || null
    });
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.error("Pending admin registration failed:", error);
    return false;
  }
}

export async function registerSelfAsAdmin({ companyName, uniqueSlug, remark }) {
  const { error } = await supabase.rpc("register_self_as_admin", {
    p_company_name: companyName,
    p_unique_slug: uniqueSlug,
    p_remark: remark || null
  });
  assertNoError(error);
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  assertNoError(error);
}

export async function updateProfile(fields) {
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const payload = { ...fields };
  const { data, error } = await supabase
    .from("profiles")
    .update(payload)
    .eq("id", user.id)
    .select("*")
    .single();
  assertNoError(error);
  return data;
}

export async function updatePassword(newPassword) {
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  assertNoError(error);
  return data;
}

export async function sendPasswordResetEmail(email, redirectTo) {
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo
  });
  assertNoError(error);
  return data;
}

export async function uploadAvatar(file, userId) {
  const cleanName = file.name.replace(/[^\w.-]/g, "_");
  const path = `${userId}/${Date.now()}-${cleanName}`;
  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, { upsert: true });
  assertNoError(error);
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadChatMedia(file, userId, prefix = "media") {
  const cleanName = file.name.replace(/[^\w.-]/g, "_");
  const path = `${userId}/${prefix}/${Date.now()}-${cleanName}`;
  const { error } = await supabase.storage.from(CHAT_BUCKET).upload(path, file, { upsert: false });
  assertNoError(error);
  const { data } = supabase.storage.from(CHAT_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadVoiceBlob(blob, userId, prefix = "voice") {
  const path = `${userId}/${prefix}/${Date.now()}-${crypto.randomUUID()}.webm`;
  const { error } = await supabase.storage.from(CHAT_BUCKET).upload(path, blob, {
    upsert: false,
    contentType: "audio/webm"
  });
  assertNoError(error);
  const { data } = supabase.storage.from(CHAT_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function getAdminBySlug(slug) {
  const { data, error } = await supabase
    .from("admins")
    .select("id,company_name,unique_slug,remark,profile:profiles!admins_id_fkey(id,full_name,email,avatar_url)")
    .eq("unique_slug", slug.toLowerCase())
    .maybeSingle();
  assertNoError(error);
  return data;
}

export async function getAdminById(id) {
  const { data, error } = await supabase
    .from("admins")
    .select("id,company_name,unique_slug,remark,profile:profiles!admins_id_fkey(id,full_name,email,avatar_url)")
    .eq("id", id)
    .maybeSingle();
  assertNoError(error);
  return data;
}

export async function findProfileByUsername(username) {
  const normalizedUsername = normalizeUsername(username);
  assertValidUsername(normalizedUsername);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id,email,username,full_name,avatar_url,role")
    .eq("username", normalizedUsername)
    .maybeSingle();
  assertNoError(profileError);
  if (!profile) return null;

  const { data: admin, error: adminError } = await supabase
    .from("admins")
    .select("id,company_name,unique_slug,remark")
    .eq("id", profile.id)
    .maybeSingle();
  assertNoError(adminError);

  return {
    ...profile,
    admin: admin || null,
    is_admin: !!admin
  };
}

export async function ensureUserConversation(adminId) {
  const { data, error } = await supabase.rpc("get_or_create_user_conversation", {
    p_admin_id: adminId
  });
  assertNoError(error);
  return data;
}

export async function ensureDirectConversation(targetUserId) {
  const { data, error } = await supabase.rpc("get_or_create_direct_conversation", {
    p_target_user_id: targetUserId
  });
  assertNoError(error);
  return data;
}

export async function listDirectConversations(userId) {
  const { data, error } = await supabase
    .from("direct_conversations")
    .select(
      "id,member_a,member_b,created_at,updated_at,member_a_profile:profiles!direct_conversations_member_a_fkey(id,username,full_name,email,avatar_url),member_b_profile:profiles!direct_conversations_member_b_fkey(id,username,full_name,email,avatar_url)"
    )
    .or(`member_a.eq.${userId},member_b.eq.${userId}`)
    .order("updated_at", { ascending: false });
  assertNoError(error);
  return (data || []).map((row) => {
    const isA = row.member_a === userId;
    return {
      ...row,
      peer_id: isA ? row.member_b : row.member_a,
      peer: isA ? row.member_b_profile : row.member_a_profile
    };
  });
}

export async function getDirectMessages(conversationId) {
  const { data, error } = await supabase
    .from("direct_messages")
    .select("id,conversation_id,sender_id,content,message_type,media_url,is_read,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  assertNoError(error);
  return data || [];
}

export async function listLatestDirectMessages(conversationIds = []) {
  if (!conversationIds.length) return [];
  const { data, error } = await supabase
    .from("direct_messages")
    .select("id,conversation_id,sender_id,content,message_type,media_url,is_read,created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false })
    .limit(conversationIds.length * 5); // at most 5 messages per conversation to find the latest
  assertNoError(error);

  const latestByConversation = new Map();
  for (const row of data || []) {
    if (!latestByConversation.has(row.conversation_id)) {
      latestByConversation.set(row.conversation_id, row);
    }
  }
  return [...latestByConversation.values()];
}

export async function listUnreadDirectConversationCounts(conversationIds = [], viewerId) {
  if (!conversationIds.length) return [];
  const { data, error } = await supabase
    .from("direct_messages")
    .select("conversation_id")
    .in("conversation_id", conversationIds)
    .eq("is_read", false)
    .neq("sender_id", viewerId);
  assertNoError(error);

  const countsByConversation = new Map();
  for (const row of data || []) {
    const current = countsByConversation.get(row.conversation_id) || 0;
    countsByConversation.set(row.conversation_id, current + 1);
  }
  return [...countsByConversation.entries()].map(([conversation_id, unread_count]) => ({
    conversation_id,
    unread_count
  }));
}

export async function sendDirectMessage({ conversationId, senderId, content, messageType, mediaUrl }) {
  const payload = {
    conversation_id: conversationId,
    sender_id: senderId,
    content: content || null,
    message_type: messageType,
    media_url: mediaUrl || null
  };
  const { data, error } = await supabase.from("direct_messages").insert(payload).select("*").single();
  assertNoError(error);
  return data;
}

export async function markDirectConversationRead(conversationId, userId) {
  const { error } = await supabase
    .from("direct_messages")
    .update({ is_read: true })
    .eq("conversation_id", conversationId)
    .neq("sender_id", userId)
    .eq("is_read", false);
  assertNoError(error);
}

export function subscribeToDirectMessages(conversationId, onInsert, options = {}) {
  const channelName = `direct-messages:${conversationId}`;
  // Remove any existing channel with this name before creating a new one
  const existing = supabase.getChannels().find((ch) => ch.topic === `realtime:${channelName}`);
  if (existing) supabase.removeChannel(existing);

  const channel = supabase.channel(channelName, {
    config: {
      broadcast: { ack: false, self: false }
    }
  });
  channel.on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "direct_messages",
      filter: `conversation_id=eq.${conversationId}`
    },
    (payload) => {
      onInsert(payload.new);
    }
  );
  if (typeof options.onTyping === "function") {
    channel.on("broadcast", { event: "typing" }, (payload) => {
      options.onTyping(payload.payload || {});
    });
  }
  if (typeof options.onInstantMessage === "function") {
    channel.on("broadcast", { event: "instant-message" }, (payload) => {
      options.onInstantMessage(payload.payload || {});
    });
  }
  if (typeof options.onDelivery === "function") {
    channel.on("broadcast", { event: "message-delivered" }, (payload) => {
      options.onDelivery(payload.payload || {});
    });
  }
  if (typeof options.onConversationDeleted === "function") {
    channel.on("broadcast", { event: "conversation-deleted" }, (payload) => {
      options.onConversationDeleted(payload.payload || {});
    });
  }
  if (typeof options.onCallRequest === "function") {
    channel.on("broadcast", { event: "call-request" }, (payload) => {
      options.onCallRequest(payload.payload || {});
    });
  }
  if (typeof options.onCallAccept === "function") {
    channel.on("broadcast", { event: "call-accept" }, (payload) => {
      options.onCallAccept(payload.payload || {});
    });
  }
  if (typeof options.onCallDecline === "function") {
    channel.on("broadcast", { event: "call-decline" }, (payload) => {
      options.onCallDecline(payload.payload || {});
    });
  }
  if (typeof options.onCallEnd === "function") {
    channel.on("broadcast", { event: "call-end" }, (payload) => {
      options.onCallEnd(payload.payload || {});
    });
  }
  if (typeof options.onIceCandidate === "function") {
    channel.on("broadcast", { event: "ice-candidate" }, (payload) => {
      options.onIceCandidate(payload.payload || {});
    });
  }
  if (typeof options.onSdpExchange === "function") {
    channel.on("broadcast", { event: "sdp-exchange" }, (payload) => {
      options.onSdpExchange(payload.payload || {});
    });
  }
  channel.subscribe((status, error) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.error("Direct conversation subscription failed:", error || status);
    }
  });
  return channel;
}

export async function listAdminConversations(adminId) {
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id,user_id,admin_id,created_at,updated_at,user:profiles!conversations_user_id_fkey(id,full_name,email,avatar_url)"
    )
    .eq("admin_id", adminId)
    .order("updated_at", { ascending: false });
  assertNoError(error);
  return (data || []).map(c => ({
    ...c,
    type: "support",
    peer: c.user,
    peer_name: c.user?.full_name || "User"
  }));
}

export async function listUserConversations(userId) {
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id,user_id,admin_id,created_at,updated_at,admin:admins!conversations_admin_id_fkey(id,company_name,unique_slug,remark,profile:profiles!admins_id_fkey(id,full_name,email,avatar_url))"
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  assertNoError(error);
  return (data || []).map(c => ({
    ...c,
    type: "support",
    peer: c.admin?.profile || null,
    peer_name: c.admin?.company_name || c.admin?.profile?.full_name || "Admin"
  }));
}

export async function listUnifiedConversations(userId, role = "user") {
  const [directs, supports] = await Promise.all([
    listDirectConversations(userId),
    role === "admin" ? listAdminConversations(userId) : listUserConversations(userId)
  ]);

  const directMapped = directs.map((c) => ({
    ...c,
    type: "direct",
    peer_name: c.peer?.full_name || c.peer?.username || "User"
  }));

  const supportMapped = supports.map((c) => {
    if (role === "admin") {
      return {
        ...c,
        type: "support",
        peer: c.user,
        peer_name: c.user?.full_name || "Support User"
      };
    }
    return c; // listUserConversations already maps this
  });

  return [...directMapped, ...supportMapped].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

export async function listUnifiedLatestMessages(conversationIds = [], types = {}) {
  const directIds = conversationIds.filter((id) => types[id] === "direct");
  const supportIds = conversationIds.filter((id) => types[id] === "support");

  const [directLatest, supportLatest] = await Promise.all([
    listLatestDirectMessages(directIds),
    listLatestConversationMessages(supportIds)
  ]);

  return [...directLatest, ...supportLatest];
}

export async function listUnifiedUnreadCounts(conversationIds = [], viewerId, types = {}) {
  const directIds = conversationIds.filter((id) => types[id] === "direct");
  const supportIds = conversationIds.filter((id) => types[id] === "support");

  const [directUnread, supportUnread] = await Promise.all([
    listUnreadDirectConversationCounts(directIds, viewerId),
    listUnreadConversationCounts(supportIds, viewerId)
  ]);

  return [...directUnread, ...supportUnread];
}

export async function ensureConversationForAdmin(adminId, userId) {
  const { error } = await supabase
    .from("conversations")
    .upsert([{ admin_id: adminId, user_id: userId }], {
      onConflict: "user_id,admin_id"
    });
  assertNoError(error);
  const { data, error: fetchError } = await supabase
    .from("conversations")
    .select("id,user_id,admin_id,updated_at")
    .eq("admin_id", adminId)
    .eq("user_id", userId)
    .single();
  assertNoError(fetchError);
  return data;
}

export async function getConversationMessages(conversationId) {
  const { data, error } = await supabase
    .from("messages")
    .select("id,conversation_id,sender_id,content,message_type,media_url,is_read,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  assertNoError(error);
  return data || [];
}

export async function listLatestConversationMessages(conversationIds = []) {
  if (!conversationIds.length) return [];
  const { data, error } = await supabase
    .from("messages")
    .select("id,conversation_id,sender_id,content,message_type,media_url,is_read,created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false })
    .limit(conversationIds.length * 5); // at most 5 messages per conversation to find the latest
  assertNoError(error);

  const latestByConversation = new Map();
  for (const row of data || []) {
    if (!latestByConversation.has(row.conversation_id)) {
      latestByConversation.set(row.conversation_id, row);
    }
  }
  return [...latestByConversation.values()];
}

export async function listUnreadConversationCounts(conversationIds = [], viewerId) {
  if (!conversationIds.length) return [];
  const { data, error } = await supabase
    .from("messages")
    .select("conversation_id")
    .in("conversation_id", conversationIds)
    .eq("is_read", false)
    .neq("sender_id", viewerId);
  assertNoError(error);

  const countsByConversation = new Map();
  for (const row of data || []) {
    const current = countsByConversation.get(row.conversation_id) || 0;
    countsByConversation.set(row.conversation_id, current + 1);
  }
  return [...countsByConversation.entries()].map(([conversation_id, unread_count]) => ({
    conversation_id,
    unread_count
  }));
}

export async function sendMessage({ conversationId, senderId, content, messageType, mediaUrl }) {
  const payload = {
    conversation_id: conversationId,
    sender_id: senderId,
    content: content || null,
    message_type: messageType,
    media_url: mediaUrl || null
  };
  const { data, error } = await supabase.from("messages").insert(payload).select("*").single();
  assertNoError(error);
  return data;
}

export async function markConversationRead(conversationId, userId) {
  const { error } = await supabase
    .from("messages")
    .update({ is_read: true })
    .eq("conversation_id", conversationId)
    .neq("sender_id", userId)
    .eq("is_read", false);
  assertNoError(error);
}

export function subscribeToConversationMessages(conversationId, onInsert, options = {}) {
  const channelName = `messages:${conversationId}`;
  // Remove any existing channel with this name before creating a new one
  const existing = supabase.getChannels().find((ch) => ch.topic === `realtime:${channelName}`);
  if (existing) supabase.removeChannel(existing);

  const channel = supabase.channel(channelName, {
    config: {
      broadcast: { ack: false, self: false }
    }
  });
  channel.on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `conversation_id=eq.${conversationId}`
    },
    (payload) => {
      onInsert(payload.new);
    }
  );
  if (typeof options.onTyping === "function") {
    channel.on("broadcast", { event: "typing" }, (payload) => {
      options.onTyping(payload.payload || {});
    });
  }
  if (typeof options.onInstantMessage === "function") {
    channel.on("broadcast", { event: "instant-message" }, (payload) => {
      options.onInstantMessage(payload.payload || {});
    });
  }
  if (typeof options.onDelivery === "function") {
    channel.on("broadcast", { event: "message-delivered" }, (payload) => {
      options.onDelivery(payload.payload || {});
    });
  }
  if (typeof options.onConversationDeleted === "function") {
    channel.on("broadcast", { event: "conversation-deleted" }, (payload) => {
      options.onConversationDeleted(payload.payload || {});
    });
  }
  if (typeof options.onCallRequest === "function") {
    channel.on("broadcast", { event: "call-request" }, (payload) => {
      options.onCallRequest(payload.payload || {});
    });
  }
  if (typeof options.onCallAccept === "function") {
    channel.on("broadcast", { event: "call-accept" }, (payload) => {
      options.onCallAccept(payload.payload || {});
    });
  }
  if (typeof options.onCallDecline === "function") {
    channel.on("broadcast", { event: "call-decline" }, (payload) => {
      options.onCallDecline(payload.payload || {});
    });
  }
  if (typeof options.onCallEnd === "function") {
    channel.on("broadcast", { event: "call-end" }, (payload) => {
      options.onCallEnd(payload.payload || {});
    });
  }
  if (typeof options.onIceCandidate === "function") {
    channel.on("broadcast", { event: "ice-candidate" }, (payload) => {
      options.onIceCandidate(payload.payload || {});
    });
  }
  if (typeof options.onSdpExchange === "function") {
    channel.on("broadcast", { event: "sdp-exchange" }, (payload) => {
      options.onSdpExchange(payload.payload || {});
    });
  }
  channel.subscribe((status, error) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.error("Conversation subscription failed:", error || status);
    }
  });
  return channel;
}

export async function broadcastConversationEvent(channel, event, payload = {}) {
  const resolvedChannel = await channel;
  if (!resolvedChannel) return;
  try {
    console.log(`Broadcasting event "${event}" to channel...`, payload);
    const resp = await resolvedChannel.send({
      type: "broadcast",
      event,
      payload
    });
    console.log(`Broadcast "${event}" response:`, resp);
  } catch (error) {
    console.warn("Conversation broadcast failed:", error);
  }
}

export async function removeChannel(channel) {
  const resolvedChannel = await channel;
  if (!resolvedChannel) return;
  await supabase.removeChannel(resolvedChannel);
}

export async function listSubscriptionPlans() {
  const { data, error } = await supabase
    .from("subscription_plans")
    .select("*")
    .order("amount", { ascending: true });
  assertNoError(error);
  return data || [];
}

export async function createSubscriptionPlan(payload) {
  const { data, error } = await supabase.from("subscription_plans").insert(payload).select("*").single();
  assertNoError(error);
  return data;
}

export async function updateSubscriptionPlan(id, payload) {
  const { data, error } = await supabase
    .from("subscription_plans")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();
  assertNoError(error);
  return data;
}

export async function deleteSubscriptionPlan(id) {
  const { error } = await supabase.from("subscription_plans").delete().eq("id", id);
  assertNoError(error);
}

export async function listAdminSubscriptions(adminId = null) {
  let query = supabase
    .from("admin_subscriptions")
    .select("id,admin_id,plan_id,start_date,end_date,grace_days,status,created_at,plan:subscription_plans(*)")
    .order("created_at", { ascending: false });
  if (adminId) query = query.eq("admin_id", adminId);
  const { data, error } = await query;
  assertNoError(error);
  return data || [];
}

export async function createAdminSubscription(payload) {
  const { data, error } = await supabase.from("admin_subscriptions").insert(payload).select("*").single();
  assertNoError(error);
  return data;
}

export async function listPaymentMethods(activeOnly = false) {
  let query = supabase.from("payment_methods").select("*").order("name", { ascending: true });
  if (activeOnly) query = query.eq("is_active", true);
  const { data, error } = await query;
  assertNoError(error);
  return data || [];
}

export async function savePaymentMethod(payload, id = null) {
  if (id) {
    const { data, error } = await supabase
      .from("payment_methods")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();
    assertNoError(error);
    return data;
  }
  const { data, error } = await supabase.from("payment_methods").insert(payload).select("*").single();
  assertNoError(error);
  return data;
}

export async function deletePaymentMethod(id) {
  const { error } = await supabase.from("payment_methods").delete().eq("id", id);
  assertNoError(error);
}

export async function submitPayment(payload) {
  const { data, error } = await supabase.from("payments").insert(payload).select("*").single();
  assertNoError(error);
  return data;
}

export async function listPayments({ adminId = null, status = null, limit = 100, offset = 0 } = {}) {
  let query = supabase
    .from("payments")
    .select(
      "id,admin_id,method_id,amount,transaction_id,screenshot_url,status,submitted_at,reviewed_by,method:payment_methods!payments_method_id_fkey(id,name),admin:admins!payments_admin_id_fkey(id,company_name,unique_slug,profile:profiles!admins_id_fkey(id,full_name,email))"
    )
    .order("submitted_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (adminId) query = query.eq("admin_id", adminId);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  assertNoError(error);
  return data || [];
}

export async function reviewPayment(paymentId, status, reviewerId) {
  const { data, error } = await supabase
    .from("payments")
    .update({ status, reviewed_by: reviewerId })
    .eq("id", paymentId)
    .select("*")
    .single();
  assertNoError(error);
  return data;
}

export async function listAdminsDetailed(limit = 50, offset = 0) {
  const { data: admins, error: adminsError } = await supabase
    .from("admins")
    .select("id,company_name,unique_slug,remark,created_at,profile:profiles!admins_id_fkey(id,email,full_name,role,avatar_url)")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  assertNoError(adminsError);

  const adminIds = (admins || []).map((item) => item.id);
  if (adminIds.length === 0) return [];

  const { data: subscriptions, error: subsError } = await supabase
    .from("admin_subscriptions")
    .select("id,admin_id,plan_id,start_date,end_date,grace_days,status,created_at,plan:subscription_plans(id,name,amount,duration_days)")
    .in("admin_id", adminIds)
    .order("created_at", { ascending: false });
  assertNoError(subsError);

  const latestSubByAdmin = new Map();
  for (const sub of subscriptions || []) {
    if (!latestSubByAdmin.has(sub.admin_id)) {
      latestSubByAdmin.set(sub.admin_id, sub);
    }
  }

  return admins.map((admin) => ({
    ...admin,
    latest_subscription: latestSubByAdmin.get(admin.id) || null
  }));
}

export async function promoteUserToAdminByUsername({ username, companyName, uniqueSlug, remark, createdBy }) {
  const normalizedUsername = normalizeUsername(username);
  assertValidUsername(normalizedUsername);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id,email,username,role")
    .eq("username", normalizedUsername)
    .maybeSingle();
  assertNoError(profileError);
  if (!profile) throw new Error("No user profile found with this username");

  const { error: roleError } = await supabase.from("profiles").update({ role: "admin" }).eq("id", profile.id);
  assertNoError(roleError);

  const { error: adminError } = await supabase.from("admins").upsert(
    [
      {
        id: profile.id,
        company_name: companyName,
        unique_slug: uniqueSlug.toLowerCase(),
        remark: remark || null,
        created_by: createdBy
      }
    ],
    {
      onConflict: "id"
    }
  );
  assertNoError(adminError);
}

export async function updateAdminDetails(adminId, { companyName, uniqueSlug, remark, fullName }) {
  if (fullName) {
    const { error: profileError } = await supabase.from("profiles").update({ full_name: fullName }).eq("id", adminId);
    assertNoError(profileError);
  }
  const { error } = await supabase
    .from("admins")
    .update({
      company_name: companyName,
      unique_slug: uniqueSlug.toLowerCase(),
      remark: remark || null
    })
    .eq("id", adminId);
  assertNoError(error);
}

export async function removeAdmin(adminId) {
  const { error: deleteAdminError } = await supabase.from("admins").delete().eq("id", adminId);
  assertNoError(deleteAdminError);
  const { error: roleError } = await supabase.from("profiles").update({ role: "user" }).eq("id", adminId);
  assertNoError(roleError);
}

export async function fetchMessageOverview(days = 7) {
  const { data, error } = await supabase.rpc("admin_daily_message_counts", { p_days: days });
  assertNoError(error);
  return data || [];
}

export async function listSupportConversationsForAdmin(adminId) {
  const { data, error } = await supabase
    .from("support_conversations")
    .select("id,admin_id,super_admin_id,updated_at,super:profiles!support_conversations_super_admin_id_fkey(id,full_name,email)")
    .eq("admin_id", adminId)
    .order("updated_at", { ascending: false });
  assertNoError(error);
  return data || [];
}

export async function listSupportConversationsForSuper(superAdminId, limit = 50, offset = 0) {
  const { data, error } = await supabase
    .from("support_conversations")
    .select(
      "id,admin_id,super_admin_id,updated_at,admin:admins!support_conversations_admin_id_fkey(id,company_name,unique_slug,profile:profiles!admins_id_fkey(id,full_name,email))"
    )
    .eq("super_admin_id", superAdminId)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);
  assertNoError(error);
  return data || [];
}

export async function ensureSupportConversation(superAdminId = null) {
  const { data, error } = await supabase.rpc("get_or_create_support_conversation", {
    p_super_admin_id: superAdminId
  });
  assertNoError(error);
  return data;
}

export async function getSupportMessages(conversationId) {
  const { data, error } = await supabase
    .from("support_messages")
    .select("id,conversation_id,sender_id,content,message_type,media_url,is_read,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  assertNoError(error);
  return data || [];
}

export async function sendSupportMessage({ conversationId, senderId, content, messageType, mediaUrl }) {
  const payload = {
    conversation_id: conversationId,
    sender_id: senderId,
    content: content || null,
    message_type: messageType,
    media_url: mediaUrl || null
  };
  const { data, error } = await supabase.from("support_messages").insert(payload).select("*").single();
  assertNoError(error);
  return data;
}

export function subscribeToSupportMessages(conversationId, onInsert) {
  const channel = supabase.channel(`support-messages:${conversationId}:${crypto.randomUUID()}`);
  channel.on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "support_messages",
      filter: `conversation_id=eq.${conversationId}`
    },
    (payload) => {
      onInsert(payload.new);
    }
  );
  channel.subscribe((status, error) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.error("Support subscription failed:", error || status);
    }
  });
  return channel;
}

export async function sendBulkMessage({
  adminId,
  recipientUserIds,
  content = null,
  messageType = "text",
  mediaUrl = null
}) {
  if (!recipientUserIds.length) return { insertedMessages: 0 };

  const { data: bulkMessage, error: bulkError } = await supabase
    .from("bulk_messages")
    .insert({
      admin_id: adminId,
      content,
      media_url: mediaUrl,
      message_type: messageType
    })
    .select("*")
    .single();
  assertNoError(bulkError);

  const conversationRows = recipientUserIds.map((userId) => ({
    admin_id: adminId,
    user_id: userId
  }));

  const { error: upsertConversationError } = await supabase.from("conversations").upsert(conversationRows, {
    onConflict: "user_id,admin_id"
  });
  assertNoError(upsertConversationError);

  const { data: conversations, error: conversationsError } = await supabase
    .from("conversations")
    .select("id,user_id")
    .eq("admin_id", adminId)
    .in("user_id", recipientUserIds);
  assertNoError(conversationsError);

  const messages = (conversations || []).map((conversation) => ({
    conversation_id: conversation.id,
    sender_id: adminId,
    content,
    message_type: messageType,
    media_url: mediaUrl
  }));

  if (messages.length) {
    const { error: insertMessageError } = await supabase.from("messages").insert(messages);
    assertNoError(insertMessageError);
  }

  const recipients = recipientUserIds.map((userId) => ({
    bulk_message_id: bulkMessage.id,
    user_id: userId,
    delivered: true
  }));
  const { error: recipientError } = await supabase.from("bulk_message_recipients").insert(recipients);
  assertNoError(recipientError);

  return { bulkMessage, insertedMessages: messages.length };
}

export async function listProfilesByConversationWithAdmin(adminId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("user_id,user:profiles!conversations_user_id_fkey(id,full_name,email,avatar_url)")
    .eq("admin_id", adminId)
    .order("updated_at", { ascending: false });
  assertNoError(error);
  return (data || []).map((item) => item.user).filter(Boolean);
}

export async function deleteDirectConversation(conversationId) {
  // Delete messages first
  const msgRes = await supabase.from("direct_messages").delete().eq("conversation_id", conversationId);
  if (msgRes.error) console.warn("Error deleting direct messages:", msgRes.error);
  
  const res = await supabase.from("direct_conversations").delete().eq("id", conversationId);
  if (res.error) {
    console.error("Critical error deleting direct conversation:", res.error);
    throw normalizeSupabaseError(res.error);
  }
}

export async function deleteSupportConversation(conversationId) {
  // Delete messages first
  const msgRes = await supabase.from("support_messages").delete().eq("conversation_id", conversationId);
  if (msgRes.error) console.warn("Error deleting support messages:", msgRes.error);

  const res = await supabase.from("support_conversations").delete().eq("id", conversationId);
  if (res.error) {
    console.error("Critical error deleting support conversation:", res.error);
    throw normalizeSupabaseError(res.error);
  }
}

export async function getDashboardCounts(roleProfileId, role) {
  if (role === "admin") {
    const [convRes, paymentRes, supportRes] = await Promise.all([
      supabase.from("conversations").select("id", { count: "exact", head: true }).eq("admin_id", roleProfileId),
      supabase
        .from("payments")
        .select("id", { count: "exact", head: true })
        .eq("admin_id", roleProfileId)
        .eq("status", "pending"),
      supabase
        .from("support_conversations")
        .select("id", { count: "exact", head: true })
        .eq("admin_id", roleProfileId)
    ]);
    assertNoError(convRes.error);
    assertNoError(paymentRes.error);
    assertNoError(supportRes.error);
    return {
      conversations: convRes.count || 0,
      pendingPayments: paymentRes.count || 0,
      supportThreads: supportRes.count || 0
    };
  }

  if (role === "super_admin") {
    const [adminRes, paymentRes, msgRes] = await Promise.all([
      supabase.from("admins").select("id", { count: "exact", head: true }),
      supabase.from("payments").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    ]);
    assertNoError(adminRes.error);
    assertNoError(paymentRes.error);
    assertNoError(msgRes.error);
    return {
      admins: adminRes.count || 0,
      pendingPayments: paymentRes.count || 0,
      last24hMessages: msgRes.count || 0
    };
  }

  return {};
}

export async function clearConversationMessages(conversationId, type = "support") {
  let res1 = { error: null, data: [] };
  let res2 = { error: null, data: [] };

  if (type === "direct") {
    res2 = await supabase.from("direct_messages").delete().match({ conversation_id: conversationId }).select();
  } else if (type === "support") {
    res1 = await supabase.from("support_messages").delete().match({ conversation_id: conversationId }).select();
  } else {
    // "support" (admin↔user) messages live in the messages table
    res1 = await supabase.from("messages").delete().match({ conversation_id: conversationId }).select();
  }

  console.log(`Clear outcome for ${conversationId} (type=${type}): ${res1.data?.length || 0} + ${res2.data?.length || 0} rows deleted`);

  // Wait a moment for DB consistency before returning
  await new Promise(r => setTimeout(r, 500));

  if (res1.error) throw new Error(`DB Error: ${res1.error.message}`);
  if (res2.error) throw new Error(`DB Error: ${res2.error.message}`);
}

// =========================================
// Web Push Subscriptions
// =========================================

/**
 * Save (upsert) a push subscription for a user.
 * Uses the endpoint as the unique key so re-subscribing updates in place.
 */
export async function savePushSubscription(userId, subscriptionJson) {
  const payload = {
    user_id: userId,
    endpoint: subscriptionJson.endpoint,
    p256dh: subscriptionJson.keys?.p256dh || null,
    auth: subscriptionJson.keys?.auth || null,
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(payload, { onConflict: "endpoint" });
  assertNoError(error);
}

/**
 * Remove a push subscription by endpoint (called on sign-out).
 */
export async function removePushSubscription(userId, endpoint) {
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", userId)
    .eq("endpoint", endpoint);
  assertNoError(error);
}
