import { ROLES, ROUTES } from "./lib/constants.js";
import { navigate, parseRoute } from "./lib/router.js";
import { promptInstall, registerServiceWorker, setupInstallPrompt } from "./lib/pwa.js";
import { parseError, showToast } from "./lib/ui.js";
import {
  completePendingAdminRegistration,
  getSessionAndProfile,
  login,
  signOut,
  signupAdmin,
  signupUser
} from "./services/supabaseApi.js";
import { renderAdminRegistrationScreen, renderAuthScreen } from "./views/auth.js";
import { renderAdminDashboard } from "./views/adminDashboard.js";
import { renderSuperAdminDashboard } from "./views/superAdminDashboard.js";
import { renderUserDashboard } from "./views/userDashboard.js";
import { supabase } from "./lib/supabase.js";

const root = document.getElementById("app");

let installAvailable = false;
let cleanup = null;
let isRendering = false;
let renderQueued = false;

registerServiceWorker();
setupInstallPrompt((available) => {
  installAvailable = available;
  renderApp();
});

window.addEventListener("routechange", () => renderApp());
window.addEventListener("hashchange", () => renderApp());

supabase.auth.onAuthStateChange(() => {
  renderApp();
});

function withErrorScreen(message) {
  root.innerHTML = `
    <section class="auth-wrap">
      <article class="auth-card">
        <h1 class="headline">Something went wrong</h1>
        <p class="subtext">${message}</p>
        <button class="btn btn-primary" id="reload-page-btn">Reload</button>
      </article>
    </section>
  `;
  root.querySelector("#reload-page-btn")?.addEventListener("click", () => window.location.reload());
}

async function cleanCurrentView() {
  if (typeof cleanup === "function") {
    await cleanup();
    cleanup = null;
  }
}

async function onInstall() {
  try {
    return await promptInstall();
  } catch {
    return false;
  }
}

async function handleSignOut() {
  await signOut();
  navigate(ROUTES.LOGIN, { replace: true });
}

async function renderApp() {
  if (isRendering) {
    renderQueued = true;
    return;
  }
  isRendering = true;
  try {
    const route = parseRoute();
    const pendingChatSlug = route.name === "chat-link" ? route.slug : localStorage.getItem("pending_chat_slug");
    const authState = await getSessionAndProfile();

    if (!authState.session || !authState.profile) {
      if (pendingChatSlug) {
        localStorage.setItem("pending_chat_slug", pendingChatSlug);
      }
      await cleanCurrentView();
      if (route.name === "register-admin") {
        renderAdminRegistrationScreen({
          root,
          onGoLogin: () => navigate(ROUTES.LOGIN),
          onGoSignup: () => navigate(ROUTES.SIGNUP),
          onRegister: async ({ fullName, companyName, username, password, uniqueSlug, remark }) => {
            await signupAdmin({ fullName, companyName, username, password, uniqueSlug, remark });
            showToast("Admin registration submitted.");
            navigate(ROUTES.LOGIN);
          }
        });
        return;
      }

      const mode = route.name === "signup" ? "signup" : "login";
      renderAuthScreen({
        root,
        mode,
        pendingSlug: pendingChatSlug,
        onGoLogin: () => navigate(ROUTES.LOGIN),
        onGoSignup: () => navigate(ROUTES.SIGNUP),
        onGoRegisterAdmin: () => navigate(ROUTES.REGISTER_ADMIN),
        onLogin: async ({ username, password }) => {
          await login(username, password);
          showToast("Logged in successfully.");
        },
        onSignup: async ({ username, password, fullName }) => {
          await signupUser({ username, password, fullName });
          showToast("Sign-up complete. You can now log in.");
          navigate(ROUTES.LOGIN);
        }
      });
      return;
    }

    const pendingCompleted = await completePendingAdminRegistration(authState.user);
    if (pendingCompleted) {
      showToast("Admin registration completed.");
    }

    const refreshed = await getSessionAndProfile();
    const profile = refreshed.profile;
    const userChatSlug =
      route.name === "chat-link" ? route.slug : pendingChatSlug || localStorage.getItem("active_admin_slug") || "";

    localStorage.removeItem("pending_chat_slug");
    await cleanCurrentView();

    if (profile.role === ROLES.SUPER_ADMIN) {
      if (route.name === "chat-link") navigate(ROUTES.HOME, { replace: true });
      cleanup = await renderSuperAdminDashboard({
        root,
        profile,
        installAvailable,
        onInstall,
        onSignOut: handleSignOut
      });
      return;
    }

    if (profile.role === ROLES.ADMIN) {
      if (route.name === "chat-link") navigate(ROUTES.HOME, { replace: true });
      cleanup = await renderAdminDashboard({
        root,
        profile,
        installAvailable,
        onInstall,
        onSignOut: handleSignOut
      });
      return;
    }

    if (pendingChatSlug && route.name !== "chat-link") {
      navigate(`/chat/${encodeURIComponent(userChatSlug)}`, { replace: true });
    }

    cleanup = await renderUserDashboard({
      root,
      profile,
      chatSlug: userChatSlug,
      installAvailable,
      onInstall,
      onSignOut: handleSignOut
    });
  } catch (error) {
    console.error(error);
    withErrorScreen(parseError(error, "Unexpected application error"));
  } finally {
    isRendering = false;
    if (renderQueued) {
      renderQueued = false;
      queueMicrotask(() => renderApp());
    }
  }
}

renderApp();
