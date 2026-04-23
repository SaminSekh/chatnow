# Web Push Notifications Setup

This app uses the **browser-native Web Push API** with VAPID keys — completely free, no third-party service.

## How it works

1. When a user logs in, the browser asks for notification permission and registers a push subscription
2. The subscription is saved to the `push_subscriptions` Supabase table
3. A Supabase Database Webhook fires the `send-push` Edge Function whenever a new message is inserted
4. The Edge Function sends a Web Push notification to the recipient's browser via the browser vendor's push service (Google FCM for Chrome, Mozilla for Firefox — both free)
5. The service worker receives the push and shows the notification even when the tab is closed

---

## Step 1 — Generate VAPID keys (one-time)

```bash
npx web-push generate-vapid-keys
```

This outputs:
```
Public Key:  Bxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Private Key: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Step 2 — Add the public key to app.config.js

```js
window.__APP_CONFIG__ = {
  SUPABASE_URL: "...",
  SUPABASE_ANON_KEY: "...",
  VAPID_PUBLIC_KEY: "Bxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
};
```

---

## Step 3 — Add secrets to Supabase Edge Functions

In your Supabase Dashboard → **Edge Functions** → **Secrets**, add:

| Key | Value |
|-----|-------|
| `VAPID_PUBLIC_KEY` | Your public key from Step 1 |
| `VAPID_PRIVATE_KEY` | Your private key from Step 1 |
| `VAPID_SUBJECT` | `mailto:your@email.com` |

---

## Step 4 — Deploy the Edge Function

```bash
supabase functions deploy send-push
```

Or via the Supabase Dashboard → Edge Functions → Deploy from file.

---

## Step 5 — Run the SQL migration

In Supabase Dashboard → **SQL Editor**, run the new section at the bottom of `supabase/schema.sql`:

```sql
-- Creates the push_subscriptions table with RLS policies
```

---

## Step 6 — Create Database Webhooks

In Supabase Dashboard → **Database** → **Webhooks**, create two webhooks:

### Webhook 1: Direct Messages
- **Name**: `push-on-direct-message`
- **Table**: `public.direct_messages`
- **Events**: `INSERT`
- **URL**: `https://<your-project-ref>.supabase.co/functions/v1/send-push`
- **HTTP Headers**: `Authorization: Bearer <your-service-role-key>`

### Webhook 2: Support Messages
- **Name**: `push-on-message`
- **Table**: `public.messages`
- **Events**: `INSERT`
- **URL**: `https://<your-project-ref>.supabase.co/functions/v1/send-push`
- **HTTP Headers**: `Authorization: Bearer <your-service-role-key>`

---

## Notes

- Push notifications only fire when the **recipient's tab is not focused** (the app checks `document.visibilityState` before showing in-app notifications)
- On iOS Safari 16.4+, the app must be installed as a PWA (Add to Home Screen) for push to work
- Expired subscriptions (HTTP 410 responses) are automatically cleaned up by the Edge Function
