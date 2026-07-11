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

    if (path === '/api/rooms' && method === 'GET') {
      // List active rooms
      const list = await env.FIVEDICE_KV.list({ prefix: 'room:' });
      const rooms = [];
      for (const key of list.keys) {
        const roomData = await env.FIVEDICE_KV.get(key.name, { type: 'json' });
        if (roomData && roomData.status === 'open') {
          rooms.push(roomData);
        }
      }
      return new Response(JSON.stringify(rooms), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
        // Return current signaling state (polling)
        return new Response(JSON.stringify(room), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (action === 'signal' && method === 'POST') {
        // Update signaling state (SDP offers/answers, ICE candidates)
        const body = await request.json();
        const role = body.role; // 'host' or 'guest'
        let updated = false;

        if (body.sdp) {
          if (role === 'host') { room.host_sdp = body.sdp; room.host_ice = []; updated = true; }
          if (role === 'guest') { room.guest_sdp = body.sdp; room.guest_ice = []; updated = true; }
        }
        if (body.ice) {
          if (role === 'host') { room.host_ice.push(body.ice); updated = true; }
          if (role === 'guest') { room.guest_ice.push(body.ice); updated = true; }
        }

        if (updated) {
          await env.FIVEDICE_KV.put(roomId, JSON.stringify(room), { expirationTtl: 3600 });
        }
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
};
