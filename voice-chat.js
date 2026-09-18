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

  // ---------- ICE servers ----------
  // STUN alone can't connect two phones that are both behind carrier-grade NAT
  // (most LTE), so the push Worker also hands out short-lived Cloudflare TURN
  // credentials once a TURN key has been configured there (push-worker/README).
  // Until then it answers { iceServers: null } and we stay on STUN.
  const STUN_ONLY = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const TURN_URL = 'https://5dice.app/push/turn';
  let iceServers = STUN_ONLY;
  let iceExpiresAt = 0;      // when the credentials we hold stop being worth using
  let iceFetch = null;       // in-flight refresh, so callers share one request

  function refreshIceServers() {
    if (Date.now() < iceExpiresAt) return Promise.resolve(iceServers);
    if (iceFetch) return iceFetch;
    iceFetch = (async () => {
      try {
        const opts = { method: 'POST' };
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(4000);
        const res = await fetch(TURN_URL, opts);
        if (!res.ok) throw new Error('turn endpoint ' + res.status);
        const j = await res.json();
        if (j && Array.isArray(j.iceServers) && j.iceServers.length) {
          iceServers = j.iceServers;
          // Ask again well before the credentials lapse.
          iceExpiresAt = Date.now() + Math.max(60, (j.ttl || 3600) - 300) * 1000;
        } else {
          iceServers = STUN_ONLY;                       // TURN not set up yet
          iceExpiresAt = Date.now() + 10 * 60 * 1000;
        }
      } catch (e) {
        iceServers = STUN_ONLY;
        iceExpiresAt = Date.now() + 60 * 1000;
      } finally {
        iceFetch = null;
      }
      return iceServers;
    })();
    return iceFetch;
  }

  // ---------- Reconnect backoff ----------
  // A failed connection used to be torn down and rebuilt immediately, by both
  // sides, forever: a new offer, an answer, a fresh round of candidates, ~15s
  // of ICE, fail, repeat — dozens of Firebase writes a minute for as long as
  // the two phones stayed in the room. Now: a few spaced attempts, then stop
  // and say so. A member leaving and coming back starts the count over.
  const MAX_ICE_ATTEMPTS = 3;
  const iceFails = new Map();   // remoteId -> { count, timer, gaveUp }

  function backoffActive(remoteId) {
    const f = iceFails.get(remoteId);
    return !!(f && (f.timer || f.gaveUp));
  }

  function clearBackoff(remoteId) {
    const f = iceFails.get(remoteId);
    if (f && f.timer) clearTimeout(f.timer);
    iceFails.delete(remoteId);
  }

  function memberName(remoteId) {
    const m = members[remoteId];
    if (m && m.name) return m.name;
    return (typeof window.getDisplayName === 'function') ? window.getDisplayName(remoteId) : 'a player';
  }

  function scheduleRebuild(remoteId) {
    closePeer(remoteId);
    const f = iceFails.get(remoteId) || { count: 0, timer: null, gaveUp: false };
    f.count++;
    iceFails.set(remoteId, f);
    if (f.count > MAX_ICE_ATTEMPTS) {
      f.gaveUp = true;
      console.warn('voice: giving up on', remoteId, 'after', MAX_ICE_ATTEMPTS, 'attempts');
      if (window.showToast) window.showToast(`Couldn't connect voice with ${memberName(remoteId)}.`, '#dc3545');
      return;
    }
    const delay = 1000 * Math.pow(2, f.count);   // 2s, 4s, 8s
    f.timer = setTimeout(async () => {
      f.timer = null;
      if (!participating() || !members[remoteId] || peers.has(remoteId)) return;
      await refreshIceServers();   // credentials may have lapsed meanwhile
      if (participating() && members[remoteId] && !peers.has(remoteId)) createPeer(remoteId);
    }, delay);
  }

  const micBtn = document.getElementById('btn-toggle-mic');
  const spkBtn = document.getElementById('btn-toggle-speaker');
  if (!micBtn || !spkBtn) return;

  let voiceRoomId = null;   // room whose voice channel we're attached to
  let micOn = false;
  let speakerOn = false;
  let joined = false;       // are we advertised in voice/members?
  let localStream = null;   // mic MediaStream (exists only while mic is on)
  let micPending = false;   // getUserMedia prompt is up
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
    await refreshIceServers();   // bounded (4s); STUN-only if it fails
    if (!voiceRoomId) { joined = false; return; }   // room left during the wait
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
    for (const id of [...iceFails.keys()]) clearBackoff(id);
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

    const pc = new RTCPeerConnection({ iceServers });
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
        el.setAttribute('playsinline', '');
        el.dataset.voicePeer = remoteId;
        document.body.appendChild(el);
        peer.audioEl = el;
      }
      peer.audioEl.srcObject = streams[0] || new MediaStream([track]);
      peer.audioEl.muted = !speakerOn;
      // Outside a user gesture iOS Safari rejects this (NotAllowedError);
      // unlockAudio() below retries on the next tap anywhere on the page.
      peer.audioEl.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { clearBackoff(remoteId); return; }
      if (pc.connectionState === 'failed') scheduleRebuild(remoteId);
    };

    return peer;
  }

  // iOS Safari only lets an <audio> start from inside a user gesture. A peer
  // whose track arrives AFTER the Speaker tap (anyone who joins voice later)
  // therefore stays silent until the listener toggles Speaker off and on
  // again. So: on every tap, nudge any remote audio that is still paused.
  function unlockAudio() {
    if (!speakerOn) return;
    for (const peer of peers.values()) {
      const el = peer.audioEl;
      if (el && el.paused && el.srcObject) el.play().catch(() => {});
    }
  }
  document.addEventListener('touchend', unlockAudio, { capture: true, passive: true });
  document.addEventListener('click', unlockAudio, { capture: true, passive: true });

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
    if (backoffActive(remoteId)) return;   // we're waiting, or we've given up
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
      if (id !== window.myPeerId && members[id] && !backoffActive(id)) createPeer(id);
    }
    for (const id of [...peers.keys()]) {
      if (!members[id]) closePeer(id);
    }
    // Someone who left gets a clean slate if they come back.
    for (const id of [...iceFails.keys()]) {
      if (!members[id]) clearBackoff(id);
    }
  }

  // ---------- Toggles ----------

  async function toggleMic() {
    if (!voiceRoomId || micPending) return;
    if (!micOn) {
      // Need the microphone before we advertise it as on.
      if (!localStream) {
        // The permission prompt can sit open for a while. If the room was
        // left in the meantime (or Mic was tapped again), the stream that
        // finally arrives belongs to nobody: stop it, or the browser's
        // recording light stays on with no one listening — and the next room
        // would silently offer that track to everyone.
        const room = voiceRoomId;
        micPending = true;
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        } catch (e) {
          micPending = false;
          console.error('Microphone access failed:', e);
          if (window.showToast) window.showToast('Microphone access was blocked. Allow it in your browser to talk.', '#dc3545');
          return;
        }
        micPending = false;
        if (voiceRoomId !== room || localStream) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        localStream = stream;
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
    refreshIceServers();   // warm the TURN credentials before anyone taps a toggle
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
