// 5dice-push — turn-reminder relay for 5Dice.app.
//
// The app can't send a Web Push itself: pushes must be signed with the VAPID
// private key, which can't live in browser JS. So the player who just finished
// a turn POSTs the next player's push subscription (read from Firebase) plus
// the message here, and this Worker encrypts, signs, and hands it to Apple /
// Google's push service.
//
//   POST https://5dice.app/push/notify
//   { "sub": { endpoint, keys: { p256dh, auth } },
//     "game": "5 Dice", "from": "Jake", "roomId": "abc123xyz" }
//
//   201  delivered to the push service
//   410  the subscription is dead — the caller should delete it from Firebase
//   4xx  bad request
//
// There is deliberately no API key: anything in app.js is public anyway. What
// limits abuse is that a push endpoint only accepts messages signed by the
// VAPID key it was subscribed with, so this relay can only ever reach devices
// that opted in to 5Dice — and only if the caller knows their endpoint.
//
// The caller does NOT get to write the notification text. Subscriptions are
// readable by any signed-in client (player uuids are visible in the lobby),
// so a free-text relay would let a stranger put any message they liked on a
// player's lock screen. The Worker composes the banner itself from a game
// name it recognises, a short sender name, and a room id; the worst an abuser
// can do is send a genuine-looking turn reminder.

import { buildPushPayload } from '@block65/webcrypto-web-push';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (request.method !== 'POST' || !url.pathname.endsWith('/notify')) {
      return json(404, { error: 'POST /notify' });
    }

    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'invalid JSON' }); }

    const sub = body && body.sub;
    if (!sub || !str(sub.endpoint, 2048) || !sub.endpoint.startsWith('https://') ||
        !sub.keys || !str(sub.keys.p256dh, 200) || !str(sub.keys.auth, 100)) {
      return json(400, { error: 'invalid subscription' });
    }
    const GAMES = ['5 Dice', 'Backgammon', 'Tic-Tac-Toe'];
    const game = GAMES.includes(body.game) ? body.game : '5Dice';
    // Sender name: printable characters only, short enough for one line.
    const from = (str(body.from, 100) ? body.from : '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .trim()
      .slice(0, 24) || 'Your opponent';
    // Room ids are what app.js mints (base36); anything else gets no deep link.
    const roomId = str(body.roomId, 40) && /^[a-z0-9_-]+$/i.test(body.roomId) ? body.roomId : null;

    const data = {
      title: `Your turn in ${game}`,
      body: `${from} just played. Tap to jump back in.`,
      url: roomId ? `./?join=${encodeURIComponent(roomId)}` : './',
      tag: roomId ? `turn-${roomId}` : 'turn',
    };

    const vapid = {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    };

    let payload;
    try {
      payload = await buildPushPayload(
        // A turn reminder is stale after an hour; topic collapses a burst of
        // them for the same room into one delivery.
        { data, options: { ttl: 3600, topic: data.tag.slice(0, 32), urgency: 'high' } },
        { endpoint: sub.endpoint, expirationTime: null, keys: sub.keys },
        vapid,
      );
    } catch (err) {
      return json(500, { error: 'encrypt failed: ' + (err && err.message) });
    }

    const res = await fetch(sub.endpoint, payload);
    // 404/410 from the push service mean the device unsubscribed (or the app
    // was deleted). Tell the caller so it can prune the stale entry.
    if (res.status === 404 || res.status === 410) return json(410, { gone: true });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return json(502, { error: 'push service ' + res.status, detail: text.slice(0, 300) });
    }
    return json(201, { ok: true });
  },
};
