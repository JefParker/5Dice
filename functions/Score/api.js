export async function onRequestPost(context) {
    const { request, env } = context;
    const db = env.DB; // We will assume the D1 binding is named "DB"

    // Parse the form data
    const formData = await request.formData();

    if (formData.has('GetRoomData')) {
        const room = parseInt(formData.get('GetRoomData'), 10);
        if (isNaN(room)) return new Response(JSON.stringify([]), { status: 400 });

        const { results } = await db.prepare(
            `SELECT * FROM YahtzeeScore WHERE room = ?`
        ).bind(room).all();

        // Map results to match the original PHP output
        const formattedResults = results.map(row => ({
            id: row.id,
            room: row.room,
            player_id: row.player_id,
            score: row.score,
            ip: row.ip,
            lastdataset: new Date(row.lastdataset).getTime().toString()
        }));

        return new Response(JSON.stringify(formattedResults), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (formData.has('SetData')) {
        const jsonData = formData.get('SetData');
        let objSetData;
        try {
            objSetData = JSON.parse(jsonData);
        } catch (e) {
            return new Response("Invalid JSON", { status: 400 });
        }

        const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

        // Upsert
        await db.prepare(`
            INSERT INTO YahtzeeScore (room, player_id, score, ip)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(room, player_id) DO UPDATE SET
            score = excluded.score,
            ip = excluded.ip,
            lastdataset = CURRENT_TIMESTAMP
        `).bind(objSetData.room, objSetData.player_id, objSetData.score, ip).run();

        // Return GetRoomData logic
        const { results } = await db.prepare(
            `SELECT * FROM YahtzeeScore WHERE room = ?`
        ).bind(objSetData.room).all();

        const formattedResults = results.map(row => ({
            id: row.id,
            room: row.room,
            player_id: row.player_id,
            score: row.score,
            ip: row.ip,
            lastdataset: new Date(row.lastdataset).getTime().toString()
        }));

        return new Response(JSON.stringify(formattedResults), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (formData.has('ClearRoom')) {
        const room = parseInt(formData.get('ClearRoom'), 10);
        if (isNaN(room)) return new Response("Invalid room", { status: 400 });

        const { meta } = await db.prepare(`DELETE FROM YahtzeeScore WHERE room = ?`).bind(room).run();
        return new Response(`Successfully cleared ${meta.changes} entries for room ${room}.`, {
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    if (formData.has('ClearTable') && formData.get('ClearTable') === 'true') {
        await db.prepare(`DELETE FROM YahtzeeScore`).run();
        // Reset sqlite_sequence if we want identical TRUNCATE behavior
        try {
            await db.prepare(`DELETE FROM sqlite_sequence WHERE name='YahtzeeScore'`).run();
        } catch (e) {}
        
        return new Response("", { headers: { 'Content-Type': 'text/plain' } });
    }

    if (formData.has('GetRoomList') && formData.get('GetRoomList') === 'true') {
        const { results } = await db.prepare(`SELECT DISTINCT room FROM YahtzeeScore ORDER BY room ASC`).all();
        const roomNumbers = results.map(r => r.room).join(',');
        return new Response(roomNumbers, { headers: { 'Content-Type': 'text/plain' } });
    }

    return new Response("Invalid Request", { status: 400 });
}
