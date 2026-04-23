import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const appConfig = window.__APP_CONFIG__ || {};
const supabaseUrl = String(appConfig.SUPABASE_URL || "").trim();
const supabaseAnonKey = String(appConfig.SUPABASE_ANON_KEY || "").trim();

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase config in app.config.js");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});
