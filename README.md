# Role Chat PWA

Role-based realtime messaging app using Supabase.

## Runs Without Build Tools

This project is now browser-native, so it works directly with:
- VS Code Live Server
- GitHub Pages (static hosting)

No `npm install` is required for normal use.

## Quick Start (Live Server)

1. Open this folder in VS Code.
2. Edit `app.config.js` with your Supabase values.
3. Right-click `index.html` and click **Open with Live Server**.

## Database Migration (Required)

This app now uses username-based login/register.

Run [`supabase/schema.sql`](supabase/schema.sql) once in Supabase SQL Editor to:
- add `profiles.username`
- backfill usernames from existing emails
- keep usernames synced for new users

## Supabase Auth Setting (Important)

For username-based auth in this project, Supabase still uses an internal email format (`username@local.app`).

In Supabase Dashboard:
- `Authentication -> Providers -> Email`
- Turn off `Confirm email`

This avoids signup email throttling errors like `email rate limit exceeded` during testing.

## Supabase Config

Edit `app.config.js`:

```js
window.__APP_CONFIG__ = {
  SUPABASE_URL: "https://YOUR_PROJECT_ID.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY"
};
```

You can also copy `app.config.example.js` to `app.config.js` and fill it in.

## GitHub Pages Hosting

1. Push this project to GitHub.
2. Go to **Repo Settings -> Pages**.
3. Set:
   - Source: **Deploy from a branch**
   - Branch: **main** (or your branch)
   - Folder: **/(root)**
4. Save and wait for Pages to publish.

Your app will be available at:
- `https://YOUR_USERNAME.github.io/YOUR_REPO/`

## Notes

- Login and signup now use username (not email).
- Routes use hash URLs (example: `#/login`, `#/chat/your-slug`) so GitHub Pages refresh works.
- `icons/`, `manifest.json`, and `sw.js` are in project root for static hosting.
