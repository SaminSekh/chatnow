export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "-";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  } catch {
    return "-";
  }
}

export function formatDay(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

export function relativeTime(value) {
  if (!value) return "-";
  const now = Date.now();
  const deltaSeconds = Math.round((new Date(value).getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  const units = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1]
  ];

  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds || unit === "second") {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return "-";
}

export function isLikelyUrl(text = "") {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function slugify(value = "") {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function showToast(message, type = "success") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  root.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

export function avatarFallback(name = "") {
  const text = name.trim();
  if (!text) return "?";
  return text
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function parseError(error, fallback = "Something went wrong") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// Profile Picture Lightbox
// ---------------------------------------------------------------------------

let _activeProfileLightbox = null;

/**
 * Open a profile lightbox showing the avatar full-size + profile details.
 *
 * @param {object} profile
 * @param {string} [profile.name]       - Display name
 * @param {string} [profile.username]   - @username
 * @param {string} [profile.role]       - Role label (user / admin / super_admin)
 * @param {string} [profile.avatar_url] - Full avatar URL
 * @param {string} [profile.joined_at]  - ISO date string for "Member since"
 * @param {string} [profile.subtitle]   - Optional extra line (e.g. company name)
 */
export function openProfileLightbox(profile = {}) {
  closeProfileLightbox();

  const name       = String(profile.name || profile.username || "Unknown");
  const username   = profile.username ? `@${profile.username}` : "";
  const avatarUrl  = String(profile.avatar_url || "");
  const role       = String(profile.role || "");
  const joinedAt   = profile.joined_at || profile.created_at || "";
  const subtitle   = String(profile.subtitle || "");
  const initial    = (name.trim().charAt(0) || "?").toUpperCase();

  const roleLabel = { super_admin: "Super Admin", admin: "Admin", user: "User" }[role] || role;
  const roleClass = { super_admin: "role-super-admin", admin: "role-admin", user: "role-user" }[role] || "";

  const joinedText = joinedAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(joinedAt))
    : "";

  const backdrop = document.createElement("div");
  backdrop.className = "profile-lightbox-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", `Profile: ${escapeHtml(name)}`);

  backdrop.innerHTML = `
    <div class="profile-lightbox-card">
      <button class="profile-lightbox-close" aria-label="Close profile" type="button">
        <i class="fa-solid fa-xmark"></i>
      </button>

      <div class="profile-lightbox-avatar-wrap">
        ${avatarUrl
          ? `<img class="profile-lightbox-avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}" />`
          : `<div class="profile-lightbox-avatar profile-lightbox-avatar-initial">${escapeHtml(initial)}</div>`
        }
      </div>

      <div class="profile-lightbox-body">
        <h2 class="profile-lightbox-name">${escapeHtml(name)}</h2>
        ${username ? `<p class="profile-lightbox-username">${escapeHtml(username)}</p>` : ""}
        ${subtitle ? `<p class="profile-lightbox-subtitle">${escapeHtml(subtitle)}</p>` : ""}

        <div class="profile-lightbox-details">
          ${roleLabel ? `
            <div class="profile-lightbox-row">
              <i class="fa-solid fa-shield-halved profile-lightbox-icon"></i>
              <span class="profile-lightbox-badge ${roleClass}">${escapeHtml(roleLabel)}</span>
            </div>` : ""}
          ${joinedText ? `
            <div class="profile-lightbox-row">
              <i class="fa-solid fa-calendar profile-lightbox-icon"></i>
              <span>Member since ${escapeHtml(joinedText)}</span>
            </div>` : ""}
        </div>
      </div>
    </div>
  `;

  const close = () => closeProfileLightbox();
  const onKey = (e) => { if (e.key === "Escape") close(); };

  backdrop.querySelector(".profile-lightbox-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);

  // Animate in
  requestAnimationFrame(() => backdrop.classList.add("profile-lightbox-visible"));

  _activeProfileLightbox = { backdrop, onKey };
}

export function closeProfileLightbox() {
  if (!_activeProfileLightbox) return;
  document.removeEventListener("keydown", _activeProfileLightbox.onKey);
  _activeProfileLightbox.backdrop.remove();
  _activeProfileLightbox = null;
}

