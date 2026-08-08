// ===========================================================================
// DASHBOARD PASSKEY
//
// A passkey alternative to typing the admin email and password. There is no
// server here — the app is static files plus Firebase — so a WebAuthn assertion
// cannot be verified server-side and cannot be traded for a Firebase token.
// What it can do is act as a hardware-backed lock on this device:
//
//   register()      ask the platform authenticator for a credential, use it to
//                   derive an encryption key, and store the admin email and
//                   password encrypted under that key.
//   authenticate()  touch/glance at the authenticator, re-derive the key,
//                   decrypt, and hand the credentials to the normal Firebase
//                   email/password sign-in.
//
// The key comes from the WebAuthn PRF extension, so on a device that supports
// it the key material never leaves the authenticator and the stored blob is
// inert without a successful user-verified assertion. Devices without PRF fall
// back to a locally stored key: there the passkey is a user-verification gate
// rather than an encryption boundary. register() reports which one you got so
// the UI can say so plainly.
//
// Scope note: this is per-device. Registering on a phone does nothing for a
// laptop, and clearing site data removes it.
// ===========================================================================

(function () {
  'use strict';

  const LS_KEY = 'dice.dashPasskey.v1';
  const RP_NAME = '5 Dice Dashboard';
  const HKDF_SALT = '5dice-dash-passkey-v1';
  const HKDF_INFO = 'admin-credential-wrap';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // --- base64url <-> bytes -------------------------------------------------

  function b64uEncode(bytes) {
    let s = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64uDecode(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  // --- stored record -------------------------------------------------------

  function loadRecord() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      // Anything we don't recognise is treated as absent rather than thrown at
      // the user mid-login; forget() will clear it.
      if (!rec || rec.v !== 1 || !rec.credentialId || !rec.ct) return null;
      return rec;
    } catch (e) {
      return null;
    }
  }

  function saveRecord(rec) {
    localStorage.setItem(LS_KEY, JSON.stringify(rec));
  }

  // --- crypto --------------------------------------------------------------

  async function keyFromSecret(secretBytes) {
    const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HKDF_SALT), info: enc.encode(HKDF_INFO) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptJson(key, obj) {
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(JSON.stringify(obj))
    );
    return { iv: b64uEncode(iv), ct: b64uEncode(ct) };
  }

  async function decryptJson(key, ivB64, ctB64) {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64uDecode(ivB64) },
      key,
      b64uDecode(ctB64)
    );
    return JSON.parse(dec.decode(pt));
  }

  // Pull the PRF output out of whichever shape the platform returned it in.
  function prfFirst(extResults) {
    const prf = extResults && extResults.prf;
    const first = prf && prf.results && prf.results.first;
    if (!first) return null;
    return new Uint8Array(first);
  }

  // --- public API ----------------------------------------------------------

  function supported() {
    return !!(window.PublicKeyCredential &&
              window.isSecureContext &&
              navigator.credentials &&
              crypto.subtle);
  }

  // Is there a platform authenticator (Touch ID / Windows Hello / Android
  // screen lock) available? Resolves false rather than rejecting.
  async function platformAvailable() {
    if (!supported()) return false;
    try {
      if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      return false;
    }
  }

  function hasCredential() {
    return !!loadRecord();
  }

  function credentialLabel() {
    const rec = loadRecord();
    return rec ? (rec.label || null) : null;
  }

  // True when the stored blob is locked by the authenticator itself rather than
  // by a key sitting next to it in localStorage.
  function isHardwareBound() {
    const rec = loadRecord();
    return !!(rec && rec.prf);
  }

  function forget() {
    // The credential itself stays in the platform's passkey store — only the
    // browser's own settings can remove it there. All we own is the blob.
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  // Create a passkey and seal the admin credentials under it.
  // Returns { ok, prf, reason }.
  async function register(email, password) {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    if (!email || !password) return { ok: false, reason: 'missing-credentials' };

    const userHandle = randomBytes(16);
    const prfSalt = randomBytes(32);

    let cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          challenge: randomBytes(32),
          rp: { name: RP_NAME, id: location.hostname },
          user: { id: userHandle, name: email, displayName: email },
          // ES256 then RS256. We never verify a signature (no server), but the
          // authenticator still requires a credible algorithm list.
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'preferred',
            userVerification: 'required'
          },
          timeout: 60000,
          attestation: 'none',
          // Ask for PRF up front — newer Chrome hands back the output right
          // here, which saves the user a second prompt.
          extensions: { prf: { eval: { first: prfSalt } } }
        }
      });
    } catch (err) {
      return { ok: false, reason: errReason(err) };
    }
    if (!cred) return { ok: false, reason: 'cancelled' };

    const createExt = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    const prfEnabled = !!(createExt && createExt.prf && createExt.prf.enabled !== false &&
                          (createExt.prf.enabled === true || prfFirst(createExt)));

    let secret = prfFirst(createExt);

    // No output at creation time: do one assertion to collect it. Costs a
    // second prompt, which the caller warns about.
    if (!secret && prfEnabled) {
      try {
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: randomBytes(32),
            rpId: location.hostname,
            allowCredentials: [{ type: 'public-key', id: new Uint8Array(cred.rawId) }],
            userVerification: 'required',
            timeout: 60000,
            extensions: { prf: { eval: { first: prfSalt } } }
          }
        });
        secret = prfFirst(assertion && assertion.getClientExtensionResults
          ? assertion.getClientExtensionResults() : {});
      } catch (err) {
        return { ok: false, reason: errReason(err) };
      }
    }

    const usingPrf = !!secret;
    let wrapKeyB64 = null;
    if (!usingPrf) {
      // Fallback: a random key kept beside the blob. Weaker — see the header.
      const raw = randomBytes(32);
      wrapKeyB64 = b64uEncode(raw);
      secret = raw;
    }

    let sealed;
    try {
      const key = await keyFromSecret(secret);
      sealed = await encryptJson(key, { email, password });
    } catch (err) {
      return { ok: false, reason: 'crypto' };
    }

    saveRecord({
      v: 1,
      credentialId: b64uEncode(new Uint8Array(cred.rawId)),
      userHandle: b64uEncode(userHandle),
      prf: usingPrf,
      prfSalt: b64uEncode(prfSalt),
      wrapKey: wrapKeyB64,
      iv: sealed.iv,
      ct: sealed.ct,
      label: email,
      createdAt: Date.now()
    });

    return { ok: true, prf: usingPrf };
  }

  // Unlock the stored credentials. Returns { ok, email, password, reason }.
  async function authenticate() {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    const rec = loadRecord();
    if (!rec) return { ok: false, reason: 'no-credential' };

    const request = {
      challenge: randomBytes(32),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: b64uDecode(rec.credentialId) }],
      userVerification: 'required',
      timeout: 60000
    };
    if (rec.prf) {
      request.extensions = { prf: { eval: { first: b64uDecode(rec.prfSalt) } } };
    }

    let assertion;
    try {
      assertion = await navigator.credentials.get({ publicKey: request });
    } catch (err) {
      return { ok: false, reason: errReason(err) };
    }
    if (!assertion) return { ok: false, reason: 'cancelled' };

    // allowCredentials should make this impossible, but a mismatch would mean
    // we are about to decrypt with the wrong secret — bail loudly instead.
    if (b64uEncode(new Uint8Array(assertion.rawId)) !== rec.credentialId) {
      return { ok: false, reason: 'wrong-credential' };
    }

    let secret;
    if (rec.prf) {
      secret = prfFirst(assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {});
      if (!secret) return { ok: false, reason: 'prf-unavailable' };
    } else {
      if (!rec.wrapKey) return { ok: false, reason: 'corrupt' };
      secret = b64uDecode(rec.wrapKey);
    }

    try {
      const key = await keyFromSecret(secret);
      const creds = await decryptJson(key, rec.iv, rec.ct);
      if (!creds || !creds.email || !creds.password) return { ok: false, reason: 'corrupt' };
      return { ok: true, email: creds.email, password: creds.password };
    } catch (err) {
      return { ok: false, reason: 'decrypt-failed' };
    }
  }

  function errReason(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError') return 'cancelled';       // also: timed out
    if (name === 'InvalidStateError') return 'already-registered';
    if (name === 'NotSupportedError') return 'unsupported';
    if (name === 'SecurityError') return 'insecure-origin';
    return 'failed';
  }

  // Human-readable for the login box.
  function describeReason(reason) {
    switch (reason) {
      case 'cancelled':          return 'Passkey prompt was cancelled or timed out.';
      case 'unsupported':        return "This browser doesn't support passkeys.";
      case 'insecure-origin':    return 'Passkeys need a secure (https) connection.';
      case 'no-credential':      return 'No passkey is set up on this device.';
      case 'already-registered': return 'A passkey already exists for this device.';
      case 'prf-unavailable':    return 'The passkey could not produce its key. Set it up again.';
      case 'wrong-credential':   return 'That passkey does not match the stored one.';
      case 'decrypt-failed':
      case 'corrupt':            return 'The stored passkey data is unreadable. Set it up again.';
      case 'missing-credentials':return 'Enter the admin email and password first.';
      case 'crypto':             return 'This browser refused the encryption step.';
      default:                   return 'Passkey failed. Try the password instead.';
    }
  }

  window.dashPasskey = {
    supported,
    platformAvailable,
    hasCredential,
    credentialLabel,
    isHardwareBound,
    register,
    authenticate,
    forget,
    describeReason
  };
})();
