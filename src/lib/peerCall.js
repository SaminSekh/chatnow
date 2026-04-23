/**
 * PeerJS-based P2P Video/Voice Calling
 * 
 * Uses Supabase Realtime channels for signaling (call-request, call-accept, call-decline, call-end, sdp-exchange, ice-candidate)
 * and PeerJS for the actual WebRTC media connection.
 */

/**
 * Create a new PeerJS peer with a unique ID based on user ID
 * @param {string} userId - The user's ID to use as peer ID
 * @returns {Promise<Peer>} - The PeerJS peer instance
 */
export async function createPeer(userId) {
  return new Promise((resolve, reject) => {
    // Use user ID as peer ID for deterministic addressing
    const peerId = `chatnow_${userId}`;
    
    const peer = new Peer(peerId, {
      debug: 1, // Enable debug logging
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" }
        ]
      }
    });

    peer.on("open", (id) => {
      console.log("[PeerJS] Connected with ID:", id);
      resolve(peer);
    });

    peer.on("error", (err) => {
      console.error("[PeerJS] Error:", err);
      reject(err);
    });
  });
}

/**
 * Get user media (camera/microphone)
 * @param {boolean} isVideo - Whether to include video
 * @returns {Promise<MediaStream>} - The media stream
 */
export async function getUserMedia(isVideo) {
  const constraints = {
    audio: true,
    video: isVideo ? { 
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user"
    } : false
  };

  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Create a call UI container
 * @param {HTMLElement} container - The container element
 * @param {boolean} isVideo - Whether this is a video call
 * @returns {Object} - { localVideo, remoteVideo, controlsEl }
 */
export function createCallUI(container, isVideo) {
  container.innerHTML = `
    <div class="peer-call-container">
      <div class="peer-videos">
        <video id="peer-remote-video" autoplay playsinline></video>
        ${isVideo ? `<video id="peer-local-video" autoplay playsinline muted></video>` : ""}
      </div>
      <div class="peer-controls">
        <button class="peer-ctrl-btn" id="peer-toggle-audio" title="Toggle Microphone">
          <i class="fa-solid fa-microphone"></i>
        </button>
        ${isVideo ? `
          <button class="peer-ctrl-btn" id="peer-toggle-video" title="Toggle Camera">
            <i class="fa-solid fa-video"></i>
          </button>
        ` : ""}
        <button class="peer-ctrl-btn peer-end-btn" id="peer-end-call" title="End Call">
          <i class="fa-solid fa-phone-slash"></i>
        </button>
      </div>
      <div class="peer-call-status" id="peer-call-status">Connecting...</div>
    </div>
  `;

  return {
    localVideo: container.querySelector("#peer-local-video"),
    remoteVideo: container.querySelector("#peer-remote-video"),
    controlsEl: container.querySelector(".peer-controls"),
    statusEl: container.querySelector("#peer-call-status"),
    audioBtn: container.querySelector("#peer-toggle-audio"),
    videoBtn: container.querySelector("#peer-toggle-video"),
    endBtn: container.querySelector("#peer-end-call")
  };
}

/**
 * Attach media stream to video element
 * @param {HTMLVideoElement} videoEl - The video element
 * @param {MediaStream} stream - The media stream
 */
export function attachStream(videoEl, stream) {
  if (!videoEl || !stream) return;
  videoEl.srcObject = stream;
  videoEl.play().catch(e => console.warn("Video play failed:", e));
}

/**
 * Toggle audio track
 * @param {MediaStream} stream - The media stream
 * @param {HTMLElement} btn - The toggle button
 * @returns {boolean} - New muted state
 */
export function toggleAudio(stream, btn) {
  if (!stream) return false;
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return false;
  audioTrack.enabled = !audioTrack.enabled;
  btn.classList.toggle("muted", !audioTrack.enabled);
  btn.innerHTML = audioTrack.enabled 
    ? '<i class="fa-solid fa-microphone"></i>' 
    : '<i class="fa-solid fa-microphone-slash"></i>';
  return !audioTrack.enabled;
}

/**
 * Toggle video track
 * @param {MediaStream} stream - The media stream
 * @param {HTMLElement} btn - The toggle button
 * @returns {boolean} - New muted state
 */
export function toggleVideo(stream, btn) {
  if (!stream) return false;
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) return false;
  videoTrack.enabled = !videoTrack.enabled;
  btn.classList.toggle("muted", !videoTrack.enabled);
  btn.innerHTML = videoTrack.enabled 
    ? '<i class="fa-solid fa-video"></i>' 
    : '<i class="fa-solid fa-video-slash"></i>';
  return !videoTrack.enabled;
}

/**
 * Clean up call resources
 * @param {Peer} peer - The PeerJS peer
 * @param {MediaConnection} call - The active call
 * @param {MediaStream} localStream - The local media stream
 */
export function cleanupCall(peer, call, localStream) {
  if (call) {
    call.close();
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  // Don't destroy peer - we reuse it for multiple calls
}

/**
 * Generate a unique call ID from conversation ID
 * @param {string} conversationId - The conversation ID
 * @returns {string} - A call room ID
 */
export function getCallRoomId(conversationId) {
  return `call_${conversationId}`;
}
