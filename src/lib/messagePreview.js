import { MESSAGE_TYPES } from "./constants.js";
import { isLikelyUrl } from "./ui.js";

const MAX_PREVIEW_LENGTH = 90;

function clampText(text) {
  const cleaned = String(text || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.length <= MAX_PREVIEW_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}

export function getMessagePreview(message) {
  if (!message) return "No messages yet.";

  const content = clampText(message.content || "");
  if (content) return content;

  if (message.message_type === MESSAGE_TYPES.IMAGE) return "[Image]";
  if (message.message_type === MESSAGE_TYPES.VOICE) return "[Voice message]";
  if (message.message_type === MESSAGE_TYPES.LINK || isLikelyUrl(message.content)) return "[Link]";

  return "New message";
}
