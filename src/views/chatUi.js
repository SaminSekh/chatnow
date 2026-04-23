import { escapeHtml, formatDateTime, isLikelyUrl } from "../lib/ui.js";

export function renderMessageList(container, messages, currentUserId, options = {}) {
  if (!container) return;
  if (!messages.length) {
    container.innerHTML = `<p class="muted">No messages yet. Start the conversation.</p>`;
    return;
  }
  const deliveredMessageIds = options.deliveredMessageIds || new Set();

  container.innerHTML = messages
    .map((message) => {
      const isSelf = message.sender_id === currentUserId;
      const ticks = isSelf
        ? renderMessageTicks({
            isRead: !!message.is_read,
            isDelivered: deliveredMessageIds.has(message.id)
          })
        : "";
      return `
        <div class="message-bubble ${isSelf ? "message-self" : "message-other"}">
          ${renderMessageBody(message)}
          <div class="message-meta">
            <span>${formatDateTime(message.created_at)}</span>
            ${ticks}
          </div>
        </div>
      `;
    })
    .join("");

  ensureAutoScrollTracking(container);
  bindMediaLightbox(container);
}

function renderMessageTicks({ isRead, isDelivered }) {
  if (isRead) {
    return `<span class="msg-ticks msg-ticks-read" aria-label="Read">&#10003;&#10003;</span>`;
  }
  if (isDelivered) {
    return `<span class="msg-ticks msg-ticks-delivered" aria-label="Delivered">&#10003;&#10003;</span>`;
  }
  return `<span class="msg-ticks msg-ticks-sent" aria-label="Sent">&#10003;</span>`;
}

function renderMessageBody(message) {
  if (message.message_type === "image" && message.media_url) {
    return `
      ${message.content ? `<p>${renderMentions(message.content)}</p>` : ""}
      ${renderMediaTrigger({ url: message.media_url, type: "image", alt: "Shared image" })}
    `;
  }

  if (isVideoMessage(message) && message.media_url) {
    return `
      ${message.content ? `<p>${renderMentions(message.content)}</p>` : ""}
      ${renderMediaTrigger({ url: message.media_url, type: "video", alt: "Shared video" })}
    `;
  }

  if (message.message_type === "voice" && message.media_url) {
    return `
      ${message.content ? `<p>${renderMentions(message.content)}</p>` : ""}
      <div class="audio-pill">
        <audio controls src="${escapeHtml(message.media_url)}"></audio>
      </div>
    `;
  }

  // For link-typed messages, trust the message_type; for text messages, check if content looks like a URL
  const isLink = message.message_type === "link" || (message.message_type === "text" && isLikelyUrl(message.content));
  if (isLink && message.content) {
    const rawUrl = message.content.trim();
    if (isImageUrl(rawUrl)) {
      return renderMediaTrigger({ url: rawUrl, type: "image", alt: "Shared image" });
    }
    if (isVideoUrl(rawUrl)) {
      return renderMediaTrigger({ url: rawUrl, type: "video", alt: "Shared video" });
    }
    const safe = escapeHtml(rawUrl);
    return `
      <a class="link-chip" href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>
    `;
  }

  return `<p>${renderMentions(message.content || "")}</p>`;
}

function renderMentions(text) {
  if (!text) return "";
  const escaped = escapeHtml(text);
  // Matches @username where username is alphanumeric + underscores, at least 2 chars
  return escaped.replace(/@([a-zA-Z0-9_]{2,})/g, (match, username) => {
    return `<span class="mention-link" data-mention="${escapeHtml(username)}">${match}</span>`;
  });
}

function renderMediaTrigger({ url, type, alt }) {
  const safeUrl = escapeHtml(url || "");
  const safeAlt = escapeHtml(alt || "Shared media");
  if (type === "video") {
    return `
      <button class="media-trigger" type="button" data-media-lightbox="true" data-media-url="${safeUrl}" data-media-type="video" data-media-alt="${safeAlt}">
        <video class="media-thumb media-thumb-video" src="${safeUrl}" preload="metadata" muted playsinline></video>
      </button>
    `;
  }
  return `
    <button class="media-trigger" type="button" data-media-lightbox="true" data-media-url="${safeUrl}" data-media-type="image" data-media-alt="${safeAlt}">
      <img class="media-thumb" src="${safeUrl}" alt="${safeAlt}" />
    </button>
  `;
}

function isVideoMessage(message) {
  if (!message?.media_url) return false;
  const type = String(message.message_type || "").toLowerCase();
  if (type === "voice" || type === "audio") return false;
  if (type === "video") return true;
  return isVideoUrl(message.media_url);
}

function isImageUrl(url) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(String(url || ""));
}

function isVideoUrl(url) {
  return /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(String(url || ""));
}

function bindMediaLightbox(container) {
  if (!container || container.dataset.mediaLightboxBound === "true") return;
  container.dataset.mediaLightboxBound = "true";
  container.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-media-lightbox='true']");
    if (!trigger || !container.contains(trigger)) return;
    event.preventDefault();
    const mediaUrl = String(trigger.dataset.mediaUrl || "").trim();
    const mediaType = String(trigger.dataset.mediaType || "image").trim();
    const mediaAlt = String(trigger.dataset.mediaAlt || "Shared media").trim();
    if (!mediaUrl) return;
    openMediaLightbox({ mediaUrl, mediaType, mediaAlt });
  });
}

let activeMediaLightbox = null;

function openMediaLightbox({ mediaUrl, mediaType, mediaAlt }) {
  closeMediaLightbox();
  const backdrop = document.createElement("div");
  backdrop.className = "media-lightbox-backdrop";
  backdrop.innerHTML = `
    <div class="media-lightbox-dialog">
      <button class="btn btn-ghost media-lightbox-close" type="button" aria-label="Close media preview">Close</button>
      ${
        mediaType === "video"
          ? `<video class="media-lightbox-video" controls autoplay playsinline src="${escapeHtml(mediaUrl)}"></video>`
          : `<img class="media-lightbox-image" src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(mediaAlt)}" />`
      }
    </div>
  `;

  const onKeyDown = (event) => {
    if (event.key === "Escape") closeMediaLightbox();
  };

  backdrop.querySelector(".media-lightbox-close")?.addEventListener("click", closeMediaLightbox);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeMediaLightbox();
  });

  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKeyDown);
  activeMediaLightbox = { backdrop, onKeyDown };
}

function closeMediaLightbox() {
  if (!activeMediaLightbox) return;
  document.removeEventListener("keydown", activeMediaLightbox.onKeyDown);
  activeMediaLightbox.backdrop.remove();
  activeMediaLightbox = null;
}

export function scrollMessagesToBottom(container, options = {}) {
  if (!container) return;
  ensureAutoScrollTracking(container);
  const force = !!options.force;
  const shouldFollow = container.dataset.autoScrollFollow !== "false";
  if (!force && !shouldFollow) return;
  container.scrollTop = container.scrollHeight;
  container.dataset.autoScrollFollow = "true";
}

function ensureAutoScrollTracking(container) {
  if (!container || container.dataset.autoScrollBound === "true") return;
  container.dataset.autoScrollBound = "true";
  container.dataset.autoScrollFollow = "true";

  container.addEventListener("scroll", () => {
    container.dataset.autoScrollFollow = isNearBottom(container) ? "true" : "false";
  });
}

function isNearBottom(container, threshold = 72) {
  return container.scrollHeight - container.clientHeight - container.scrollTop <= threshold;
}

export function createVoiceRecorder({
  onReady,
  onStop,
  onError
}) {
  let mediaRecorder = null;
  let chunks = [];

  return {
    async start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        mediaRecorder.addEventListener("stop", () => {
          const blob = new Blob(chunks, { type: "audio/webm" });
          for (const track of stream.getTracks()) {
            track.stop();
          }
          onStop(blob);
        });
        mediaRecorder.start();
        onReady();
      } catch (error) {
        onError(error);
      }
    },
    stop() {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    },
    isRecording() {
      return mediaRecorder?.state === "recording";
    }
  };
}
