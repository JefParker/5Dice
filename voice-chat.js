// voice-chat.js
// WebRTC mesh voice chat for game rooms (2-6 players), signaled over Firebase.
//
// Semantics (by design):
//   MIC button     — turning it ON shares your microphone with everyone in the
//                    room's voice mesh. The button shows YOUR mic state; a ring
//                    around it means someone ELSE's mic is on.
//   SPEAKER button — turning it ON plays everyone else's audio to you. The
//                    button shows YOUR speaker state; a ring around it means
//                    someone else in the room has their speaker on.
//
// You participate in the mesh while either toggle is on. Speaker-only members
// join receive-only (no mic permission prompt); turning the mic on later
// upgrades the connection via renegotiation ("perfect negotiation" pattern, so
// simultaneous offers between two peers can never wedge a connection).

(function () {
  'use strict';

  const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  const micBtn = document.getElementById('btn-toggle-mic');
  const spkBtn = document.getElementById('btn-toggle-speaker');
  if (!micBtn || !spkBtn) return;

  let voiceRoomId = null;   // room whose voice channel we're attached to
  let micOn = false;
  let speakerOn = false;
  let joined = false;       // are we advertised in voice/members?
  let localStream = null;   // mic MediaStream (exists only while mic is on)
  let members = {};         // last members snapshot from Firebase
  const peers = new Map();  // remotePeerId -> { pc, audioEl, polite, makingOffer, ignoreOffer }

  const backend = () => window.firebaseGameBackend;
  const participating = () => micOn || speakerOn;

  // ---------- Button UI ----------

  function setBtnState(btn, onIconId, offIconId, isOn) {
    btn.classList.toggle('on', isOn);
    btn.classList.toggle('off', !isOn);
    const onIcon = document.getElementById(onIconId);
    const offIcon = document.getElementById(offIconId);
    if (onIcon) onIcon.classList.toggle('hidden', !isOn);
    if (offIcon) offIcon.classList.toggle('hidden', isOn);
  }

  function updateButtons() {
    setBtnState(micBtn, 'icon-mic-on', 'icon-mic-off', micOn);
    setBtnState(spkBtn, 'icon-speaker-on', 'icon-speaker-off', speakerOn);

    // Rings: does anyone ELSE have their mic / speaker on?
    let otherMic = false, otherSpeaker = false;
    for (const id in members) {
      if (id === window.myPeerId || !members[id]) continue;
      if (members[id].mic) otherMic = true;
      if (members[id].speaker) otherSpeaker = true;
    }
    micBtn.classList.toggle('remote-active', otherMic);
    spkBtn.classList.toggle('remote-active', otherSpeaker);
    micBtn.title = otherMic ? 'Toggle Microphone (a player’s mic is on)' : 'Toggle Microphone';
    spkBtn.title = otherSpeaker ? 'Toggle Speaker (a player’s speaker is on)' : 'Toggle Speaker';
  }

  // ---------- Mesh membership ----------

  async function joinMesh() {
    if (joined || !voiceRoomId || !backend()) return;
    joined = true;
    try {
      await backend().voiceJoin(voiceRoomId, window.myPeerId, {
        name: window.myName || '',
        mic: micOn,
        speaker: speakerOn
      });
    } catch (e) {
      joined = false;
      console.error('voice join failed:', e);
      if (window.showToast) window.showToast('Could not join voice — check your connection.', '#dc3545');
      throw e;
    }
  }

  async function publishState() {
    if (!joined || !voiceRoomId || !backend()) return;
    backend().voiceUpdateState(voiceRoomId, window.myPeerId, { mic: micOn, speaker: speakerOn })
      .catch(e => console.error('voice state update failed:', e));
  }

  function leaveMesh() {
    if (voiceRoomId && backend() && joined) {
      backend().voiceLeave(voiceRoomId, window.myPeerId).catch(() => {});
    }
    joined = false;
    for (const id of [...peers.keys()]) closePeer(id);
    stopMicStream();
  }

  function stopMicStream() {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
  }

  // ---------- Peer connections (perfect negotiation) ----------

  function createPeer(remoteId) {
    if (peers.has(remoteId)) return peers.get(remoteId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = {
      pc,
      audioEl: null,
      // The lexicographically smaller peerId is the "polite" peer: on an offer
      // collision it rolls back and accepts the other side's offer.
      polite: String(window.myPeerId) < String(remoteId),
      makingOffer: false,
      ignoreOffer: false
    };
    peers.set(remoteId, peer);

    // One reusable audio slot per connection. Starting recvonly means a
    // speaker-only member never needs mic permission; replaceTrack upgrades it.
    const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    peer.transceiver = transceiver;
    if (localStream && micOn) {
      transceiver.direction = 'sendrecv';
      transceiver.sender.replaceTrack(localStream.getAudioTracks()[0]);
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(remoteId, { description: pc.localDescription });
      } catch (e) {
        console.error('voice negotiation failed:', e);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(remoteId, { candidate });
    };

    pc.ontrack = ({ track, streams }) => {
      if (!peer.audioEl) {
        const el = document.createElement('audio');
        el.autoplay = true;
        el.dataset.voicePeer = remoteId;
        document.body.appendChild(el);
        peer.audioEl = el;
      }
      peer.audioEl.srcObject = streams[0] || new MediaStream([track]);
      peer.audioEl.muted = !speakerOn;
      peer.audioEl.play().catch(() => { /* will start on the next user gesture */ });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Drop and let the members listener rebuild it if we're both still here.
        closePeer(remoteId);
        if (participating() && members[remoteId]) createPeer(remoteId);
      }
    };

    return peer;
  }

  function closePeer(remoteId) {
    const peer = peers.get(remoteId);
    if (!peer) return;
    peers.delete(remoteId);
    try { peer.pc.close(); } catch (e) {}
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
  }

  function sendSignal(toPeerId, payload) {
    if (!voiceRoomId || !backend()) return;
    backend().sendVoiceSignal(voiceRoomId, toPeerId, window.myPeerId, JSON.stringify(payload))
      .catch(e => console.error('voice signal send failed:', e));
  }

  async function handleSignal(signal) {
    if (!participating()) return; // stray signal after we left the mesh
    let payload;
    try { payload = JSON.parse(signal.data); } catch (e) { return; }
    const remoteId = signal.from;
    const peer = createPeer(remoteId);
    const pc = peer.pc;

    try {
      if (payload.description) {
        const description = payload.description;
        const offerCollision = description.type === 'offer' &&
          (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal(remoteId, { description: pc.localDescription });
        }
      } else if (payload.candidate) {
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.error('voice signal handling failed:', e);
    }
  }

  function onMembersUpdate(newMembers) {
    members = newMembers || {};
    updateButtons();

    if (!participating()) {
      // Not in the mesh: no connections to manage, just the rings above.
      for (const id of [...peers.keys()]) closePeer(id);
      return;
    }
    // Connect to every other advertised member; drop connections to the departed.
    for (const id in members) {
      if (id !== window.myPeerId && members[id]) createPeer(id);
    }
    for (const id of [...peers.keys()]) {
      if (!members[id]) closePeer(id);
    }
  }

  // ---------- Toggles ----------

  async function toggleMic() {
    if (!voiceRoomId) return;
    if (!micOn) {
      // Need the microphone before we advertise it as on.
      if (!localStream) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        } catch (e) {
          console.error('Microphone access failed:', e);
          if (window.showToast) window.showToast('Microphone access was blocked. Allow it in your browser to talk.', '#dc3545');
          return;
        }
      }
      micOn = true;
      await joinMesh().catch(() => { micOn = false; stopMicStream(); });
      if (!micOn) { updateButtons(); return; }
      const track = localStream.getAudioTracks()[0];
      for (const peer of peers.values()) {
        peer.transceiver.direction = 'sendrecv';           // triggers renegotiation
        peer.transceiver.sender.replaceTrack(track).catch(() => {});
      }
    } else {
      micOn = false;
      // Stop the track entirely so the browser's recording indicator turns off.
      for (const peer of peers.values()) {
        peer.transceiver.sender.replaceTrack(null).catch(() => {});
      }
      stopMicStream();
      if (!participating()) leaveMesh();
    }
    publishState();
    updateButtons();
  }

  async function toggleSpeaker() {
    if (!voiceRoomId) return;
    if (!speakerOn) {
      speakerOn = true;
      await joinMesh().catch(() => { speakerOn = false; });
      if (!speakerOn) { updateButtons(); return; }
      for (const peer of peers.values()) {
        if (peer.audioEl) {
          peer.audioEl.muted = false;
          peer.audioEl.play().catch(() => {});
        }
      }
    } else {
      speakerOn = false;
      for (const peer of peers.values()) {
        if (peer.audioEl) peer.audioEl.muted = true;
      }
      if (!participating()) leaveMesh();
    }
    publishState();
    updateButtons();
  }

  micBtn.addEventListener('click', toggleMic);
  spkBtn.addEventListener('click', toggleSpeaker);

  // ---------- Room lifecycle (called from app.js) ----------

  // Attach to a room's voice channel: listen to members (for the rings) and to
  // our signal inbox. Does NOT join the mesh — that happens when a toggle goes on.
  window.voiceEnterRoom = function (roomId) {
    if (voiceRoomId === roomId) return;
    window.voiceLeaveRoom();
    voiceRoomId = roomId;
    if (!backend()) return;
    backend().listenVoiceMembers(roomId, onMembersUpdate);
    backend().listenVoiceSignals(roomId, window.myPeerId, handleSignal);
    updateButtons();
  };

  // Full teardown when leaving the room.
  window.voiceLeaveRoom = function () {
    if (backend()) backend().stopVoiceListeners();
    leaveMesh();
    micOn = false;
    speakerOn = false;
    members = {};
    voiceRoomId = null;
    updateButtons();
  };

  // Best-effort presence cleanup on tab close (onDisconnect covers the rest).
  window.addEventListener('pagehide', () => {
    if (joined && voiceRoomId && backend()) {
      backend().voiceLeave(voiceRoomId, window.myPeerId).catch(() => {});
    }
  });

  updateButtons();
})();
