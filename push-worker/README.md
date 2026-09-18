# 5dice-push

Cloudflare Worker that sends the "Your turn in …" push notifications for
5Dice.app. It is routed at `https://5dice.app/push/notify` (see `wrangler.jsonc`).

How it fits together:

1. A player turns on **Settings → Turn Alerts** on their device. app.js asks
   for notification permission, subscribes through `sw.js`, and stores the
   subscription at `pushSubs/{uuid}/{peerId}` in Firebase.
2. When an opponent finishes a turn, *their* device reads those subscriptions,
   skips any device that is on screen right now, and POSTs the rest here.
3. This Worker encrypts the message (RFC 8291), signs it with the VAPID key
   (RFC 8292), and hands it to Apple's / Google's push service. `sw.js` shows
   the notification; tapping it opens the room.

## Deploy

```bash
cd push-worker
npm install
npx wrangler secret put VAPID_PRIVATE_KEY   # paste the privateKey from vapid-keys.json
npx wrangler deploy
```

`vapid-keys.json` is git-ignored — keep a copy somewhere safe. If the key pair
is ever lost, generate a new one, update `VAPID_PUBLIC_KEY` in both
`wrangler.jsonc` and `app.js`, and every device has to switch Turn Alerts off
and on again.

## Voice chat TURN relay (optional)

`POST /push/turn` hands the app short-lived Cloudflare TURN credentials so two
phones behind carrier NAT can still hear each other. It is off until a TURN
key exists:

1. Cloudflare dashboard → **Realtime** → **TURN** → create a key. Note the
   *Key ID* and *API token*.
2. ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   npx wrangler deploy
   ```

Until then the endpoint answers `{"iceServers": null}` and voice chat uses
Google STUN only (works on Wi-Fi, usually not phone-to-phone on LTE). TURN
traffic is metered on the account, so the endpoint only serves browsers on the
app's own origins and credentials last two hours.

## Local test

```bash
npx wrangler dev                       # reads VAPID_PRIVATE_KEY from .dev.vars
curl -X POST http://127.0.0.1:8787/push/notify -H 'content-type: application/json' \
  -d '{"sub":{"endpoint":"https://…","keys":{"p256dh":"…","auth":"…"}},"game":"5 Dice","from":"Test","roomId":"abc123"}'
```

The Worker writes the notification text itself (`Your turn in <game>` /
`<from> just played…`); callers only supply the game, the sender's name and
the room id. See the note at the top of `src/index.js` for why.

Logs: `npx wrangler tail 5dice-push`.
