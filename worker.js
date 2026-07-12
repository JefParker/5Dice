export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS Headers for local dev and cross-origin testing
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // GET /api/rooms
    if (path === '/api/rooms' && method === 'GET') {
      return new Response(JSON.stringify([]), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (path === '/api/rooms' && method === 'POST') {
      // Create room
      const body = await request.json();
      const roomId = 'room:' + Math.random().toString(36).substring(2, 9);
      const room = {
        id: roomId.replace('room:', ''),
        name: body.name || 'New Game',
        status: 'open',
        players: 1,
        max_players: 2,
        host: body.host || 'Player 1',
        host_sdp: null,
        guest: null,
        guest_sdp: null,
        host_ice: [],
        guest_ice: [],
        createdAt: Date.now()
      };
      await env.FIVEDICE_KV.put(roomId, JSON.stringify(room), { expirationTtl: 3600 });
      return new Response(JSON.stringify(room), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (path === '/api/chat' && method === 'GET') {
      let chat = await env.FIVEDICE_KV.get('global_chat', { type: 'json' }) || [];
      const now = Date.now();
      chat = chat.filter(m => (now - m.time) < 5 * 60 * 1000);
      return new Response(JSON.stringify(chat), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (path === '/api/chat' && method === 'POST') {
      const body = await request.json();
      let chat = await env.FIVEDICE_KV.get('global_chat', { type: 'json' }) || [];
      const now = Date.now();
      chat.push({ author: body.author || 'Anonymous', text: body.text, time: now });
      chat = chat.filter(m => (now - m.time) < 5 * 60 * 1000);
      if (chat.length > 20) chat = chat.slice(chat.length - 20); // Keep last 20 messages
      await env.FIVEDICE_KV.put('global_chat', JSON.stringify(chat), { expirationTtl: 3600 });
      return new Response(JSON.stringify(chat), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Dynamic routes for specific rooms
    const roomMatch = path.match(/^\/api\/rooms\/([a-zA-Z0-9]+)(\/(join|signal))?$/);
    if (roomMatch) {
      const roomId = 'room:' + roomMatch[1];
      const action = roomMatch[3];

      let room = await env.FIVEDICE_KV.get(roomId, { type: 'json' });
      if (!room) {
        return new Response('Room not found', { status: 404, headers: corsHeaders });
      }

      if (action === 'join' && method === 'POST') {
        const body = await request.json();
        if (room.status !== 'open') {
          return new Response('Room full or closed', { status: 400, headers: corsHeaders });
        }
        room.guest = body.guest || 'Player 2';
        room.players = 2;
        room.status = 'playing'; // Change status so it disappears from lobby
        await env.FIVEDICE_KV.put(roomId, JSON.stringify(room), { expirationTtl: 3600 });
        return new Response(JSON.stringify(room), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (action === 'signal' && method === 'GET') {
        return new Response(JSON.stringify(room), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (action === 'signal' && method === 'POST') {
        const body = await request.json();
        Object.assign(room, body);
        await env.FIVEDICE_KV.put(roomId, JSON.stringify(room), { expirationTtl: 3600 });
        return new Response(JSON.stringify(room), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // --- GLOBAL LOBBY MESH SIGNALING ---

    // Leader Election
    if (path === '/api/lobby/leader') {
      if (method === 'GET') {
        let leader = await env.FIVEDICE_KV.get('lobby_leader', { type: 'json' });
        const resObj = leader || {};
        resObj.serverTime = Date.now();
        return new Response(JSON.stringify(resObj), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (method === 'POST') {
        const body = await request.json();
        body.timestamp = Date.now();
        await env.FIVEDICE_KV.put('lobby_leader', JSON.stringify(body), { expirationTtl: 60 });
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
    }

    // POST /api/lobby/new_peers - Announce a new peer
    if (path === '/api/lobby/new_peers' && method === 'POST') {
      const body = await request.json();
      let newPeers = await env.FIVEDICE_KV.get('lobby_new_peers', { type: 'json' }) || [];
      if (!newPeers.includes(body.peerId)) {
        newPeers.push(body.peerId);
        await env.FIVEDICE_KV.put('lobby_new_peers', JSON.stringify(newPeers), { expirationTtl: 60 });
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // GET /api/lobby/new_peers - Leader polls for new peers
    if (path === '/api/lobby/new_peers' && method === 'GET') {
      let newPeers = await env.FIVEDICE_KV.get('lobby_new_peers', { type: 'json' }) || [];
      return new Response(JSON.stringify(newPeers), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Dynamic routing for peer signals: /api/lobby/signal/:peerId
    const peerSignalMatch = path.match(/^\/api\/lobby\/signal\/([a-zA-Z0-9_-]+)$/);
    if (peerSignalMatch) {
      const peerId = peerSignalMatch[1];

      if (method === 'POST') {
        const payload = await request.json();
        let signals = await env.FIVEDICE_KV.get('signal:' + peerId, { type: 'json' }) || [];
        signals.push(payload);
        await env.FIVEDICE_KV.put('signal:' + peerId, JSON.stringify(signals), { expirationTtl: 60 });
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (method === 'GET') {
        let signals = await env.FIVEDICE_KV.get('signal:' + peerId, { type: 'json' }) || [];
        if (signals.length > 0) {
          await env.FIVEDICE_KV.put('signal:' + peerId, JSON.stringify([]), { expirationTtl: 60 });
        }
        return new Response(JSON.stringify(signals), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
};
