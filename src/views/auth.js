import { escapeHtml, parseError, showToast, slugify } from "../lib/ui.js";

function normalizeUsernameInput(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]/g, "");
}

function formatAuthError(error) {
  const message = parseError(error);
  if (String(message).toLowerCase().includes("rate limit")) {
    return `${message} If this keeps happening, disable "Confirm email" in Supabase Auth settings.`;
  }
  return message;
}

export function renderAuthScreen({
  root,
  mode = "login",
  pendingSlug = null,
  onLogin,
  onSignup,
  onGoLogin,
  onGoSignup,
  onGoRegisterAdmin
}) {
  root.innerHTML = `
    <main class="auth-wrap">
      <section class="auth-card">
        <div class="logo"><span class="logo-dot"></span> Chat now messaging app</div>
        <h1 class="headline">${mode === "login" ? "Welcome back" : "Create your user account"}</h1>
        <p class="subtext">
          ${pendingSlug ? `You are joining admin chat link: <strong>${escapeHtml(pendingSlug)}</strong>.` : "Sign in to continue Secure chatting."}
        </p>

        <form id="auth-form">
          ${mode === "signup"
      ? `
                <div class="field">
                  <label for="full-name">Full name</label>
                  <input id="full-name" name="full_name" placeholder="Your name" required />
                </div>
              `
      : ""
    }
          <div class="field">
            <label for="username">Username</label>
            <input
              id="username"
              name="username"
              placeholder="your_username"
              minlength="3"
              maxlength="30"
              required
            />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" type="password" name="password" minlength="6" required />
          </div>
          <div class="actions">
            <button class="btn btn-primary" type="submit">${mode === "login" ? "Login" : "Sign Up"}</button>
            <button class="btn btn-ghost" type="button" id="switch-auth">
              ${mode === "login" ? "Need an account?" : "Already have an account?"}
            </button>
          </div>
        </form>

        <hr style="border-color: rgba(255,255,255,0.1); margin: 20px 0;" />
        <div class="inline">
          <span class="muted">Want to onboard as admin?</span>
          <button class="btn-link" id="go-admin-register" type="button">Register as Admin</button>
        </div>
      </section>
    </main>
  `;

  const form = root.querySelector("#auth-form");
  let submitting = false;
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    const formData = new FormData(form);
    const username = normalizeUsernameInput(formData.get("username"));
    const password = String(formData.get("password") || "").trim();
    const submitBtn = form.querySelector('button[type="submit"]');
    submitting = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
      if (mode === "login") {
        await onLogin({ username, password });
        return;
      }
      const fullName = String(formData.get("full_name") || "").trim();
      await onSignup({ username, password, fullName });
    } catch (error) {
      showToast(formatAuthError(error), "error");
    } finally {
      submitting = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  const usernameInput = root.querySelector("#username");
  usernameInput?.addEventListener("input", () => {
    usernameInput.value = normalizeUsernameInput(usernameInput.value);
  });

  root.querySelector("#switch-auth")?.addEventListener("click", () => {
    if (mode === "login") onGoSignup();
    else onGoLogin();
  });

  root.querySelector("#go-admin-register")?.addEventListener("click", () => onGoRegisterAdmin());
}

export function renderAdminRegistrationScreen({
  root,
  onRegister,
  onGoLogin,
  onGoSignup
}) {
  root.innerHTML = `
    <main class="auth-wrap">
      <section class="auth-card">
        <div class="logo"><span class="logo-dot"></span> Chat now messaging app</div>
        <h1 class="headline">Register as Admin</h1>
        <p class="subtext">Create an admin account with a unique public chat link slug.</p>

        <form id="admin-register-form">
          <div class="grid-2">
            <div class="field">
              <label for="admin-name">Full name</label>
              <input id="admin-name" name="full_name" placeholder="Owner name" required />
            </div>
            <div class="field">
              <label for="admin-company">Company name</label>
              <input id="admin-company" name="company_name" placeholder="Acme Support" required />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label for="admin-username">Username</label>
              <input
                id="admin-username"
                name="username"
                placeholder="admin_username"
                minlength="3"
                maxlength="30"
                required
              />
            </div>
            <div class="field">
              <label for="admin-password">Password</label>
              <input id="admin-password" type="password" name="password" minlength="6" required />
            </div>
          </div>

          <div class="field">
            <label for="admin-slug">Unique slug</label>
            <input id="admin-slug" name="unique_slug" placeholder="acme-support" required />
          </div>

          <div class="field">
            <label for="admin-remark">Remark</label>
            <textarea id="admin-remark" name="remark" placeholder="Optional note"></textarea>
          </div>

          <div class="actions">
            <button class="btn btn-primary" type="submit">Register Admin</button>
            <button class="btn btn-ghost" type="button" id="back-login">Back to Login</button>
            <button class="btn btn-link" type="button" id="go-user-signup">Register as User Instead</button>
          </div>
        </form>
      </section>
    </main>
  `;

  const slugInput = root.querySelector("#admin-slug");
  slugInput?.addEventListener("input", () => {
    slugInput.value = slugify(slugInput.value);
  });
  const adminUsernameInput = root.querySelector("#admin-username");
  adminUsernameInput?.addEventListener("input", () => {
    adminUsernameInput.value = normalizeUsernameInput(adminUsernameInput.value);
  });

  const form = root.querySelector("#admin-register-form");
  let submitting = false;
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    const formData = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitting = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
      await onRegister({
        fullName: String(formData.get("full_name") || "").trim(),
        companyName: String(formData.get("company_name") || "").trim(),
        username: normalizeUsernameInput(formData.get("username")),
        password: String(formData.get("password") || "").trim(),
        uniqueSlug: String(formData.get("unique_slug") || "").trim(),
        remark: String(formData.get("remark") || "").trim()
      });
    } catch (error) {
      showToast(formatAuthError(error), "error");
    } finally {
      submitting = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  root.querySelector("#back-login")?.addEventListener("click", () => onGoLogin());
  root.querySelector("#go-user-signup")?.addEventListener("click", () => onGoSignup());
}
