function normalizePath(path) {
  if (!path) return "/";
  let normalized = path.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

export function getCurrentPath() {
  const hash = window.location.hash;
  if (hash && hash.startsWith("#/")) return normalizePath(hash.slice(1));
  return normalizePath("/");
}

export function parseRoute() {
  const path = getCurrentPath();
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "chat" && segments[1]) {
    return { name: "chat-link", path, slug: decodeURIComponent(segments[1]) };
  }
  if (segments[0] === "login") return { name: "login", path };
  if (segments[0] === "signup") return { name: "signup", path };
  if (segments[0] === "register-admin") return { name: "register-admin", path };
  return { name: "home", path };
}

export function navigate(path, { replace = false } = {}) {
  const next = normalizePath(path);
  const current = getCurrentPath();
  if (next === current) return;
  const hash = `#${next}`;
  if (replace) {
    window.location.replace(hash);
  } else {
    window.location.hash = next;
  }
  window.dispatchEvent(new Event("routechange"));
}

