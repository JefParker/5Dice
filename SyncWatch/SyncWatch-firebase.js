// SyncWatch ↔ Firebase Realtime Database.
//
// A watch lives at syncwatch/{id}:
//   state      { mode, type, startAt, elapsed, seq, by }  — the one shared truth
//   title      the label shown on every device
//   presence/  one entry per open window, removed by onDisconnect
//   pings/     short-lived ping/pong messages (the sender deletes its own)
//   lastActive server time of the last join, for future housekeeping
//
// Every time value is in SERVER milliseconds (Date.now() + the offset Firebase
// measures), so two devices whose clocks disagree still show the same reading.
//
// This file is loaded with a dynamic import() so the stopwatch still works as a
// plain local stopwatch if it fails to load (offline, before first cache).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, set, push, remove, runTransaction, onDisconnect, serverTimestamp, query, orderByChild, startAt, endAt, get, onChildAdded } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

let serverOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), snap => { serverOffset = snap.val() || 0; });

export const serverNow = () => Date.now() + serverOffset;

export const onConnection = (cb) => onValue(ref(db, '.info/connected'), snap => cb(snap.val() === true));

// Auth is shared with 5 Dice (same origin, same Firebase project). Wait for the
// restored session before signing in anonymously — signing in unconditionally
// would replace an admin's 5 Dice session with a fresh anonymous one.
const authReady = new Promise(resolve => {
    const unsubscribe = onAuthStateChanged(auth, user => {
        unsubscribe();
        if (user) {
            resolve(user);
            return;
        }
        let delay = 2000;
        const attempt = () => signInAnonymously(auth).then(cred => resolve(cred.user), err => {
            console.warn('SyncWatch: sign-in failed, retrying', err.code || err);
            setTimeout(attempt, delay);
            delay = Math.min(delay * 2, 30000);
        });
        attempt();
    });
});

const PING_LIFETIME_MS = 20000;
const STALE_PING_MS = 120000;

// Join watch `id`. `me` is { id, label } for this window; `on` receives
// onState(state|null), onTitle(string), onPresence({clientId: {label}}),
// onPing(key, message). Returns a session handle.
export async function joinWatch(id, me, on) {
    await authReady;

    const base = `syncwatch/${id}`;
    const presenceRef = ref(db, `${base}/presence/${me.id}`);
    const pingsRef = ref(db, `${base}/pings`);
    const unsubs = [];
    const myPings = [];
    let left = false;

    unsubs.push(onValue(ref(db, `${base}/state`), snap => on.onState(snap.val())));
    unsubs.push(onValue(ref(db, `${base}/title`), snap => on.onTitle(snap.val() || '')));
    unsubs.push(onValue(ref(db, `${base}/presence`), snap => on.onPresence(snap.val() || {})));

    // Re-announce after every reconnect: the server already ran our
    // onDisconnect when the connection dropped.
    unsubs.push(onValue(ref(db, '.info/connected'), snap => {
        if (snap.val() !== true || left) return;
        onDisconnect(presenceRef).remove()
            .then(() => set(presenceRef, { label: me.label, at: serverTimestamp() }))
            .catch(err => console.warn('SyncWatch: presence failed', err));
    }));

    // Only messages sent from now on; earlier ones are history.
    const joinedAt = serverNow() - 5000;
    unsubs.push(onChildAdded(query(pingsRef, orderByChild('at'), startAt(joinedAt)),
        snap => on.onPing(snap.key, snap.val())));

    // Pings whose sender closed before deleting them.
    get(query(pingsRef, orderByChild('at'), endAt(serverNow() - STALE_PING_MS)))
        .then(snap => snap.forEach(child => { remove(child.ref).catch(() => {}); }))
        .catch(() => {});

    set(ref(db, `${base}/lastActive`), serverTimestamp()).catch(() => {});

    const sendPing = (message) => {
        const msgRef = push(pingsRef);
        set(msgRef, { ...message, from: me.id, label: me.label, at: serverTimestamp() }).catch(() => {});
        return msgRef;
    };

    return {
        // `fn(current)` returns the next state, or undefined to leave it alone.
        // It may run more than once if another device writes at the same time,
        // so it must only depend on `current` and values captured beforehand.
        change(fn) {
            return runTransaction(ref(db, `${base}/state`), current => {
                const next = fn(current);
                if (!next) return undefined;
                return { ...next, seq: ((current && current.seq) || 0) + 1, by: me.id };
            }).catch(err => console.warn('SyncWatch: update failed', err));
        },

        setTitle(title) {
            return set(ref(db, `${base}/title`), title).catch(err => console.warn('SyncWatch: label failed', err));
        },

        ping() {
            const pingRef = sendPing({ type: 'ping' });
            myPings.push(pingRef);
            setTimeout(() => this.clearPing(pingRef), PING_LIFETIME_MS);
            return pingRef.key;
        },

        pong(pingKey) {
            sendPing({ type: 'pong', to: pingKey });
        },

        clearPing(pingRef) {
            remove(pingRef).catch(() => {});
            // Pongs addressed to it go too.
            get(query(pingsRef, orderByChild('at'), endAt(serverNow() + 60000)))
                .then(snap => snap.forEach(child => {
                    if (child.val().to === pingRef.key) remove(child.ref).catch(() => {});
                }))
                .catch(() => {});
        },

        leave() {
            left = true;
            unsubs.forEach(unsubscribe => unsubscribe());
            myPings.forEach(pingRef => remove(pingRef).catch(() => {}));
            onDisconnect(presenceRef).cancel().catch(() => {});
            remove(presenceRef).catch(() => {});
        }
    };
}
