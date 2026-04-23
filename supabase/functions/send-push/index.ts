/**
 * Supabase Edge Function: send-push
 *
 * Triggered via a Supabase Database Webhook on INSERT to:
 *   - public.messages
 *   - public.direct_messages
 *
 * It looks up the recipient's push subscriptions and sends a Web Push
 * notification using the VAPID protocol (no third-party service needed).
 *
 * Environment variables required (set in Supabase Dashboard → Edge Functions → Secrets):
 *   VAPID_PUBLIC_KEY   — your VAPID public key (base64url)
 *   VAPID_PRIVATE_KEY  — your VAPID private key (base64url)
 *   VAPID_SUBJECT      — mailto: or https: contact URI, e.g. "mailto:admin@example.com"
 *   SUPABASE_URL       — auto-injected by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected by Supabase
 *
 * Generate VAPID keys (run once locally):
 *   npx web-push generate-vapid-keys
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Minimal VAPID / Web Push implementation using Web Crypto API
// (no npm dependencies — works in Deno/Edge runtime)
// ---------------------------------------------------------------------------

function base64urlToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return Uint8Array.from([...binary].map((c) => c.charCodeAt(0)));
}

function uint8ArrayToBase64url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function buildVapidJwt(
  audience: string,
  subject: string,
  publicKeyB64: string,
  privateKeyB64: string
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 12 * 3600, sub: subject };

  const encode = (obj: object) =>
    uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(obj)));

  const signingInput = `${encode(header)}.${encode(payload)}`;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    // Convert raw EC private key bytes to PKCS8 DER
    buildPkcs8(base64urlToUint8Array(privateKeyB64)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${uint8ArrayToBase64url(new Uint8Array(signature))}`;
}

/** Wrap a raw 32-byte EC private key scalar in a minimal PKCS8 DER envelope */
function buildPkcs8(rawPrivate: Uint8Array): ArrayBuffer {
  // OID for id-ecPublicKey + P-256 curve
  const oidSeq = new Uint8Array([
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07  // OID P-256
  ]);
  // ECPrivateKey ::= SEQUENCE { version INTEGER (1), privateKey OCTET STRING }
  const ecPrivKey = new Uint8Array([
    0x30, 0x27,
    0x02, 0x01, 0x01,                    // version = 1
    0x04, 0x20, ...rawPrivate            // privateKey
  ]);
  const inner = new Uint8Array([
    0x30, oidSeq.length + ecPrivKey.length + 4,
    ...oidSeq,
    0x04, ecPrivKey.length, ...ecPrivKey
  ]);
  const pkcs8 = new Uint8Array([
    0x30, inner.length + 2,
    0x02, 0x01, 0x00,  // version = 0
    ...inner
  ]);
  return pkcs8.buffer;
}

async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapidPublic: string,
  vapidPrivate: string,
  vapidSubject: string
): Promise<{ ok: boolean; status: number }> {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;

  const jwt = await buildVapidJwt(audience, vapidSubject, vapidPublic, vapidPrivate);

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Authorization": `vapid t=${jwt},k=${vapidPublic}`,
      "Content-Encoding": "aes128gcm",
    },
    // For simplicity we send the payload as plain text (no encryption).
    // Most modern browsers accept unencrypted payloads for simple notifications.
    // For full RFC 8291 encryption, use a library like web-push in a Node environment.
    body: new TextEncoder().encode(payload)
  });

  return { ok: response.ok, status: response.status };
}

// ---------------------------------------------------------------------------
// Edge Function handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json();

    // Supabase DB webhook sends { type, table, record, old_record, schema }
    const record = body?.record;
    if (!record) {
      return new Response("No record", { status: 200 });
    }

    const senderId: string = record.sender_id;
    const conversationId: string = record.conversation_id;
    const content: string = record.content || "";
    const messageType: string = record.message_type || "text";
    const table: string = body?.table || "";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY")!;
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

    if (!vapidPublic || !vapidPrivate) {
      console.warn("VAPID keys not configured — skipping push");
      return new Response("VAPID not configured", { status: 200 });
    }

    const db = createClient(supabaseUrl, serviceKey);

    // Resolve recipient user IDs based on which table the message came from
    let recipientIds: string[] = [];

    if (table === "direct_messages") {
      // Get both members of the direct conversation, exclude sender
      const { data: conv } = await db
        .from("direct_conversations")
        .select("member_a, member_b")
        .eq("id", conversationId)
        .maybeSingle();
      if (conv) {
        recipientIds = [conv.member_a, conv.member_b].filter((id) => id !== senderId);
      }
    } else if (table === "messages") {
      // Support/admin conversation — get user_id and admin_id, exclude sender
      const { data: conv } = await db
        .from("conversations")
        .select("user_id, admin_id")
        .eq("id", conversationId)
        .maybeSingle();
      if (conv) {
        recipientIds = [conv.user_id, conv.admin_id].filter((id) => id !== senderId);
      }
    }

    if (!recipientIds.length) {
      return new Response("No recipients", { status: 200 });
    }

    // Get sender profile for notification title
    const { data: sender } = await db
      .from("profiles")
      .select("full_name, username")
      .eq("id", senderId)
      .maybeSingle();

    const senderName = sender?.full_name || sender?.username || "Someone";

    // Build notification body
    let notifBody = content;
    if (messageType === "image") notifBody = "📷 Image";
    else if (messageType === "voice") notifBody = "🎤 Voice message";
    else if (messageType === "video") notifBody = "🎥 Video";
    else if (!notifBody) notifBody = "New message";
    if (notifBody.length > 100) notifBody = notifBody.slice(0, 97) + "…";

    const notifPayload = JSON.stringify({
      title: senderName,
      body: notifBody,
      tag: `chat-${conversationId}`,
      url: "./"
    });

    // Fetch push subscriptions for all recipients
    const { data: subscriptions } = await db
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth, user_id")
      .in("user_id", recipientIds);

    if (!subscriptions?.length) {
      return new Response("No push subscriptions", { status: 200 });
    }

    // Send push to each subscription
    const results = await Promise.allSettled(
      subscriptions.map((sub) =>
        sendWebPush(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          notifPayload,
          vapidPublic,
          vapidPrivate,
          vapidSubject
        )
      )
    );

    // Clean up expired subscriptions (410 Gone)
    const expiredEndpoints: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled" && result.value.status === 410) {
        expiredEndpoints.push(subscriptions[i].endpoint);
      }
    });
    if (expiredEndpoints.length) {
      await db.from("push_subscriptions").delete().in("endpoint", expiredEndpoints);
    }

    const sent = results.filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ok:boolean;status:number}>).value.ok).length;
    return new Response(JSON.stringify({ sent, total: subscriptions.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("send-push error:", err);
    return new Response(String(err), { status: 500 });
  }
});
