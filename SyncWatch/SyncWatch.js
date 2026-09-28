// SyncWatch — a stopwatch / countdown shared by everyone on the same ID.
//
// The shared state is { mode, type, startAt, elapsed, seq, by }:
//   mode     'running' | 'stopped'
//   type     'up' (stopwatch) | 'down' (countdown)
//   startAt  server ms at which the reading was 0 (only meaningful when running)
//   elapsed  the frozen reading when stopped; a countdown starts negative and
//            runs up to zero
// Lap is deliberately local: it freezes this screen only, as it always has.

const VERSION = '2026.09.27c';

const $ = (id) => document.getElementById(id);

const COLORS = {
    up:   { running: 'darkgreen',     stopped: 'darkred',   lap: 'blue' },
    down: { running: 'DarkSlateGray', stopped: 'OrangeRed', lap: 'DarkSlateBlue' }
};
const FLASH_COLORS = ['Red', 'SeaGreen', 'RebeccaPurple', 'OrangeRed', 'Teal', 'MidnightBlue', 'DarkRed'];

const RESET = { mode: 'stopped', type: 'up', startAt: 0, elapsed: 0 };
const MAX_COUNTDOWN_MS = 100 * 3600000 - 1000;

const me = { id: randomId(), label: deviceLabel() };

let backend = null;        // the Firebase module, once loaded
let session = null;        // the joined watch
let joinToken = 0;         // guards against a slow join finishing after an ID change
let connected = null;       // null until Firebase reports either way
let backendFailed = false;
let presence = {};
let watchId = null;
let state = { ...RESET, seq: 0, by: '' };
let firstState = true;
let joinSeq = -1;          // seq of the first state seen after joining
let joining = null;        // id whose join is in flight
let lap = null;            // frozen reading while Lap is on
let finishedSeq = -1;      // countdown that already fired its alert
let zeroTimer = null;
let frame = null;
let shownText = '';
let flashing = false;
let installPrompt = null;
const myPings = new Map();  // ping key → number of answers

// ---------------------------------------------------------------- time

const now = () => backend ? backend.serverNow() : Date.now();

const reading = () => state.mode === 'running' ? now() - state.startAt : state.elapsed;

const formatTime = (ms) => {
    const total = Math.floor(Math.abs(ms) / 100);   // tenths
    const tenths = total % 10;
    const seconds = Math.floor(total / 10) % 60;
    const minutes = Math.floor(total / 600) % 60;
    const hours = Math.floor(total / 36000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${tenths}`;
};

const normalize = (s) => (s && (s.mode === 'running' || s.mode === 'stopped'))
    ? { mode: s.mode, type: s.type === 'down' ? 'down' : 'up', startAt: Number(s.startAt) || 0, elapsed: Number(s.elapsed) || 0 }
    : { ...RESET };

// ---------------------------------------------------------------- state changes

// Apply locally at once, then share. `fn` sees the current shared state; with
// no connection it is simply applied to ours.
const change = (fn) => {
    const next = fn(normalize(state));
    if (!next) return;
    setState({ ...next, seq: state.seq + 1, by: me.id }, true);
    if (session) session.change(current => fn(normalize(current)));
};

// The press means what the button said when it was pressed. It is not a
// toggle: if two people hit Stop at the same moment, the second transaction
// sees an already-stopped watch and must leave it alone, not restart it.
const startStop = () => {
    const t = now();
    const stopping = state.mode === 'running';
    change(s => stopping
        ? (s.mode === 'running' ? { ...s, mode: 'stopped', elapsed: t - s.startAt } : undefined)
        : (s.mode === 'stopped' ? { ...s, mode: 'running', startAt: t - s.elapsed } : undefined));
};

const lapReset = () => {
    if (state.mode === 'running') {
        lap = (lap === null) ? reading() : null;
        render();
    } else {
        change(() => ({ ...RESET }));
    }
};

const setCountdown = (ms) => {
    change(() => ms > 0 ? { mode: 'stopped', type: 'down', startAt: 0, elapsed: -ms } : { ...RESET });
};

const setState = (next, local) => {
    const prev = state;
    state = next;
    if (next.mode !== 'running' || prev.mode !== 'running' || next.startAt !== prev.startAt) lap = null;

    if (!local && firstState) {
        firstState = false;
        joinSeq = next.seq;
    } else if (!local && next.by !== me.id && next.seq !== prev.seq) {
        const isReset = next.mode === 'stopped' && next.type === 'up' && next.elapsed === 0;
        // Another device got to zero first (ours may be asleep in the
        // background). That's the end of the countdown, not a plain reset.
        const countdownEnded = isReset && prev.mode === 'running' && prev.type === 'down' && now() - prev.startAt > -1500;
        if (countdownEnded) alertZero(prev.seq);
        else notify(`SyncWatch ${next.mode === 'running' ? 'started' : isReset ? 'reset' : 'stopped'}`, true);
    }

    wakeLock(next.mode === 'running');
    scheduleZero();
    render();
};

// ---------------------------------------------------------------- countdown end

const scheduleZero = () => {
    clearTimeout(zeroTimer);
    if (state.mode === 'running' && state.type === 'down') {
        zeroTimer = setTimeout(checkZero, Math.max(0, -reading()));
    }
};

const checkZero = () => {
    if (state.mode !== 'running' || state.type !== 'down' || reading() < 0) return false;
    const seq = state.seq;
    // A countdown that was already over when we joined ended while nobody was
    // watching — reset it quietly. One we saw running gets its alert however
    // late our timer fires (a phone may have slept through zero).
    if (seq === joinSeq && reading() > 5000) finishedSeq = seq;
    else alertZero(seq);
    // Every device notices; the first to write wins, the rest see seq moved on.
    setState({ ...RESET, seq: seq + 1, by: me.id }, true);
    if (session) session.change(current => {
        const s = normalize(current);
        return (current && current.seq === seq && s.mode === 'running' && s.type === 'down') ? { ...RESET } : undefined;
    });
    return true;
};

const alertZero = (seq) => {
    if (finishedSeq === seq) return;
    finishedSeq = seq;
    flash();
    notify('SyncWatch countdown reached zero', false);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
};

const flash = () => {
    if (flashing) return;
    flashing = true;
    let i = 0;
    const step = () => {
        if (i >= FLASH_COLORS.length * 2) {
            flashing = false;
            render();
            return;
        }
        $('Display').style.backgroundColor = FLASH_COLORS[i++ % FLASH_COLORS.length];
        setTimeout(step, 200);
    };
    step();
};

// ---------------------------------------------------------------- rendering

const render = () => {
    const running = state.mode === 'running';
    const value = lap ?? reading();

    const display = $('Display');
    setDisplayText(value);
    if (!flashing) {
        const colors = COLORS[state.type];
        display.style.backgroundColor = running ? (lap !== null ? colors.lap : colors.running) : colors.stopped;
    }

    $('Start').textContent = running ? 'Stop' : 'Start';
    const lapBtn = $('Lap');
    lapBtn.textContent = running ? (lap !== null ? 'Lap off' : 'Lap') : 'Reset';
    lapBtn.disabled = !running && state.type === 'up' && state.elapsed === 0;

    cancelAnimationFrame(frame);
    if (running && lap === null) frame = requestAnimationFrame(tick);
};

const setDisplayText = (value) => {
    const text = formatTime(value);
    if (text !== shownText) {
        $('Display').textContent = text;
        shownText = text;
    }
};

const tick = () => {
    if (checkZero()) return;
    setDisplayText(reading());
    frame = requestAnimationFrame(tick);
};

const renderUsers = () => {
    const el = $('WhosHere');
    const count = Object.keys(presence).length;
    if (!backend) el.textContent = backendFailed ? 'Local only' : 'Connecting…';
    else if (connected === false) el.textContent = 'Offline';
    else if (!session) el.textContent = 'Connecting…';
    else el.textContent = `${count} ${count === 1 ? 'user' : 'users'}`;
};

const renderTitle = (title) => {
    $('WatchLabel').textContent = title;
    document.title = title || 'SyncWatch';
};

// ---------------------------------------------------------------- joining

const normalizeId = (raw) => {
    const digits = String(raw ?? '').trim();
    if (!/^[0-9]{1,9}$/.test(digits)) return null;
    return String(parseInt(digits, 10));
};

const openWatch = async (id) => {
    if (id === watchId && (session || joining === id)) {
        showScreen('WatchScreen');
        return;
    }
    if (session) session.leave();
    session = null;
    joinToken++;
    watchId = id;
    try { localStorage.setItem('SyncWatchID', id); } catch (e) { /* private mode */ }

    presence = {};
    firstState = true;
    joinSeq = -1;
    lap = null;
    renderTitle('');
    $('IDReadout').textContent = `ID: ${id}`;
    showScreen('WatchScreen');
    render();
    renderUsers();
    connectWatch();
};

// Join the shared watch — now, or as soon as the Firebase module has loaded.
const connectWatch = async () => {
    if (!backend || !watchId || session || joining === watchId) return;
    const id = watchId;
    const token = ++joinToken;
    joining = id;
    let joined;
    try {
        joined = await backend.joinWatch(id, me, {
            onState: (s) => { if (token === joinToken) setState({ ...normalize(s), seq: (s && s.seq) || 0, by: (s && s.by) || '' }, false); },
            onTitle: (t) => { if (token === joinToken) renderTitle(t); },
            onPresence: (p) => { if (token === joinToken) { presence = p; renderUsers(); } },
            onPing: (key, msg) => { if (token === joinToken) handlePing(key, msg); }
        });
    } finally {
        if (joining === id) joining = null;
    }
    if (token !== joinToken) {
        joined.leave();
        return;
    }
    session = joined;
    renderUsers();
};

// ---------------------------------------------------------------- ping

const ping = () => {
    if (!session) {
        toast('Not connected');
        return;
    }
    const key = session.ping();
    myPings.set(key, 0);
    toast('Ping sent');
    setTimeout(() => {
        if (myPings.get(key) === 0) toast('No one answered');
        myPings.delete(key);
    }, 4000);
};

const handlePing = (key, msg) => {
    if (!msg || msg.from === me.id) return;
    if (msg.type === 'ping') {
        toast(`Ping from ${msg.label || 'another device'}`);
        session.pong(key);
    } else if (msg.type === 'pong' && myPings.has(msg.to)) {
        myPings.set(msg.to, myPings.get(msg.to) + 1);
        toast(`Pong from ${msg.label || 'another device'}`);
    }
};

// ---------------------------------------------------------------- screens and dialogs

const showScreen = (id) => {
    for (const screen of ['EnterScreen', 'WatchScreen']) $(screen).hidden = screen !== id;
    $('MenuBtn').hidden = id !== 'WatchScreen';
    hideMenu();
    // Keyboard users land on Start; on touch screens the focus ring is just noise.
    if (id === 'WatchScreen' && matchMedia('(hover: hover)').matches) $('Start').focus();
};

const showEnterId = () => {
    const input = $('WatchId');
    input.value = watchId ?? randomWatchId();
    $('EnterCancel').hidden = !watchId;
    showScreen('EnterScreen');
    $('Go').focus();
};

const openCountdown = () => {
    const ms = state.type === 'down' && state.mode === 'stopped' ? -state.elapsed : 0;
    $('Hours').value = ms ? Math.floor(ms / 3600000) : '';
    $('Minutes').value = ms ? Math.floor(ms / 60000) % 60 : '';
    $('Seconds').value = ms ? Math.floor(ms / 1000) % 60 : '';
    $('CountDownDialog').returnValue = '';   // so Esc isn't read as last time's OK
    $('CountDownDialog').showModal();
    // The alert at zero is a notification when the app is in the background.
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
    }
};

const openLabel = () => {
    $('LabelInput').value = $('WatchLabel').textContent;
    $('LabelDialog').returnValue = '';
    $('LabelDialog').showModal();
};

const share = async () => {
    const url = new URL(`./?id=${watchId}`, location.href).href;
    const title = $('WatchLabel').textContent || 'SyncWatch';
    try {
        if (navigator.share) {
            await navigator.share({ title, text: `Join SyncWatch ${watchId}`, url });
            return;
        }
        await navigator.clipboard.writeText(url);
        toast('Link copied');
    } catch (e) {
        if (e.name !== 'AbortError') toast(url);
    }
};

const showAbout = () => {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    $('AboutVersion').textContent = `Version ${VERSION}`;
    $('AboutInstall').hidden = !(ios && !standalone);
    $('AboutDialog').showModal();
};

// ---------------------------------------------------------------- menu

const menuActions = {
    countdown: openCountdown,
    label: openLabel,
    share,
    id: showEnterId,
    ping,
    install: async () => {
        if (!installPrompt) return;
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        $('InstallItem').hidden = true;
    },
    about: showAbout
};

const showMenu = (x, y) => {
    const menu = $('Menu');
    menu.classList.add('open');
    const left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, x));
    const top = Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, y));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    $('MenuBtn').setAttribute('aria-expanded', 'true');
    menu.querySelector('li:not([hidden])').focus();
};

const hideMenu = () => {
    $('Menu').classList.remove('open');
    $('MenuBtn').setAttribute('aria-expanded', 'false');
};

const menuOpen = () => $('Menu').classList.contains('open');

// ---------------------------------------------------------------- toasts and notifications

const toast = (text) => {
    const el = document.createElement('div');
    el.className = 'ToastMsg';
    el.textContent = text;
    $('Toasts').append(el);
    setTimeout(() => el.remove(), 4700);
};

const notify = async (text, onlyIfHidden) => {
    if (onlyIfHidden && document.visibilityState === 'visible') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (!reg) return;
        await reg.showNotification('SyncWatch', {
            body: text,
            icon: 'img/SyncWatch192.png',
            badge: 'img/SyncWatch64.png',
            tag: 'syncwatch',
            renotify: true,
            vibrate: [100, 50, 100]
        });
    } catch (e) { /* notifications are a nicety */ }
};

// ---------------------------------------------------------------- wake lock

let wakeLockSentinel = null;
let wakeLockPending = false;   // a request is in flight; don't start a second
let wantWakeLock = false;

const wakeLock = async (want) => {
    wantWakeLock = want;
    if (!('wakeLock' in navigator)) return;
    if (!want) {
        const sentinel = wakeLockSentinel;
        wakeLockSentinel = null;
        sentinel?.release().catch(() => {});
        return;
    }
    if (wakeLockSentinel || wakeLockPending || document.visibilityState !== 'visible') return;
    wakeLockPending = true;
    try {
        const sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => { if (wakeLockSentinel === sentinel) wakeLockSentinel = null; });
        wakeLockSentinel = sentinel;
        if (!wantWakeLock) wakeLock(false);   // stopped while we were asking
    } catch (e) {
        /* battery saver or not allowed */
    } finally {
        wakeLockPending = false;
    }
};

// ---------------------------------------------------------------- helpers

function randomId() {
    return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

function randomWatchId() {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    return String(1000 + (n % 99000));
}

function deviceLabel() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android';
    if (/CrOS/.test(ua)) return 'Chromebook';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux PC';
    return 'Device';
}

// ---------------------------------------------------------------- wiring

const wireUp = () => {
    $('Start').addEventListener('click', startStop);
    $('Lap').addEventListener('click', lapReset);
    $('IDReadout').addEventListener('click', showEnterId);
    $('WhosHere').addEventListener('click', () => {
        const labels = Object.values(presence).map(p => p.label || 'Device');
        if (labels.length) toast(`Here: ${labels.join(', ')}`);
    });

    $('EnterForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const id = normalizeId($('WatchId').value);
        if (!id) {
            toast('Please enter a number');
            $('WatchId').focus();
            return;
        }
        openWatch(id);
    });
    $('EnterCancel').addEventListener('click', () => showScreen('WatchScreen'));

    $('CountDownDialog').addEventListener('close', () => {
        if ($('CountDownDialog').returnValue !== 'ok') return;
        const num = (id) => Math.max(0, parseInt($(id).value, 10) || 0);
        const ms = num('Hours') * 3600000 + num('Minutes') * 60000 + num('Seconds') * 1000;
        setCountdown(Math.min(ms, MAX_COUNTDOWN_MS));
    });

    $('LabelDialog').addEventListener('close', () => {
        if ($('LabelDialog').returnValue !== 'ok') return;
        const title = $('LabelInput').value.trim().slice(0, 100);
        renderTitle(title);
        session?.setTitle(title);
    });

    for (const dialog of document.querySelectorAll('dialog')) {
        // Tap outside the box to cancel.
        // (The dialog's own padding also targets the dialog, so check the box.)
        dialog.addEventListener('click', (ev) => {
            if (ev.target !== dialog) return;
            const r = dialog.getBoundingClientRect();
            const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
            if (!inside) dialog.close('cancel');
        });
    }

    $('MenuBtn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (menuOpen()) {
            hideMenu();
            return;
        }
        const r = ev.currentTarget.getBoundingClientRect();
        showMenu(r.right - $('Menu').offsetWidth, r.bottom + 4);
    });
    document.addEventListener('contextmenu', (ev) => {
        if ($('WatchScreen').hidden || ev.target.closest('input, dialog')) return;
        ev.preventDefault();
        showMenu(ev.clientX, ev.clientY);
    });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('#Menu')) hideMenu(); });
    $('Menu').addEventListener('click', (ev) => {
        const item = ev.target.closest('[data-action]');
        if (!item) return;
        hideMenu();
        menuActions[item.dataset.action]();
    });
    $('Menu').addEventListener('keydown', (ev) => {
        const items = [...$('Menu').querySelectorAll('li:not([hidden])')];
        const i = items.indexOf(document.activeElement);
        if (ev.key === 'ArrowDown') items[(i + 1) % items.length].focus();
        else if (ev.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
        else if (ev.key === 'Enter' || ev.key === ' ') document.activeElement.click();
        else if (ev.key === 'Escape') { hideMenu(); $('MenuBtn').focus(); }
        else return;
        ev.preventDefault();
    });

    // Space starts/stops, L laps/resets — when nothing else wants the keys.
    document.addEventListener('keydown', (ev) => {
        if ($('WatchScreen').hidden || menuOpen() || document.querySelector('dialog[open]')) return;
        if (ev.target.closest('input') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.key === ' ' && !ev.target.closest('button')) { ev.preventDefault(); startStop(); }
        else if (ev.key === 'l' || ev.key === 'L') { if (!$('Lap').disabled) lapReset(); }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        wakeLock(wantWakeLock);
        if (!checkZero()) render();
    });

    window.addEventListener('beforeinstallprompt', (ev) => {
        ev.preventDefault();
        installPrompt = ev;
        $('InstallItem').hidden = false;
    });
    window.addEventListener('appinstalled', () => {
        installPrompt = null;
        $('InstallItem').hidden = true;
    });
};

const loadBackend = async () => {
    try {
        backend = await import('./SyncWatch-firebase.js');
        backend.onConnection(isConnected => {
            connected = isConnected;
            renderUsers();
        });
        connectWatch();
    } catch (e) {
        console.warn('SyncWatch: sync unavailable, running as a local stopwatch', e);
        backendFailed = true;
        renderUsers();
    }
};

const start = () => {
    wireUp();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('SyncWatch-sw.js').catch(err => console.warn('SyncWatch: service worker not registered', err));
    }

    // A shared link (?id=12345) wins over the remembered ID. Tidy the address
    // afterwards so a reload or a home-screen shortcut doesn't keep it.
    const params = new URLSearchParams(location.search);
    const linked = normalizeId(params.get('id'));
    if (params.has('id')) history.replaceState(null, '', location.pathname);
    let saved = null;
    try { saved = normalizeId(localStorage.getItem('SyncWatchID')); } catch (e) { /* private mode */ }

    const id = linked || saved;
    if (id) openWatch(id);
    else showEnterId();
    loadBackend();
};

start();
