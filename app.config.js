// WARNING: This file is served publicly and should NOT be committed to version control
// with real credentials. Add app.config.js to .gitignore and use app.config.example.js
// as the template. The Supabase anon key is safe to expose client-side by design, but
// your project URL identifies your Supabase project — keep it out of public repos.
window.__APP_CONFIG__ = {
  SUPABASE_URL: "https://qqlnlcgmlbnrcjbjjxtf.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxbG5sY2dtbGJucmNqYmpqeHRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MTA4ODksImV4cCI6MjA5MTk4Njg4OX0.3bU2SRS_zQPC_aZPQXmmBb1RQosW0xBeZ3X48TQVRH4",
  // Web Push (VAPID) — generate your own keys:
  //   npx web-push generate-vapid-keys
  // Paste the PUBLIC key here. Keep the PRIVATE key only in Supabase Edge Function secrets.
  VAPID_PUBLIC_KEY: ""
};
