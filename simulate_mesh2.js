const API_BASE = 'https://5dice-backend.jeffreyrobertparker.workers.dev';

async function fetchLeader() { const res = await fetch(`${API_BASE}/api/lobby/leader`); return await res.json(); }
async function claimLeadership(peerId) { await fetch(`${API_BASE}/api/lobby/leader`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peerId, weight: 100 }) }); }
async function announcePeer(peerId) { await fetch(`${API_BASE}/api/lobby/new_peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peerId }) }); }
async function getNewPeers() { const res = await fetch(`${API_BASE}/api/lobby/new_peers`); return await res.json(); }
async function sendSignal(targetId, payload) { await fetch(`${API_BASE}/api/lobby/signal/${targetId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
async function getSignals(peerId) { const res = await fetch(`${API_BASE}/api/lobby/signal/${peerId}`); return await res.json(); }

async function run() {
  console.log('--- RESETTING ---');
  await sendSignal('peer-A', { reset: true });
  await sendSignal('peer-B', { reset: true });

  console.log('1. A claims leadership');
  await claimLeadership('peer-A');
  console.log('1. B claims leadership');
  await claimLeadership('peer-B');

  console.log('2. A announces presence');
  await announcePeer('peer-A');
  console.log('2. B announces presence');
  await announcePeer('peer-B');

  console.log('3. A polls new_peers');
  const aNew = await getNewPeers();
  console.log('A found:', aNew);
  
  console.log('3. B polls new_peers');
  const bNew = await getNewPeers();
  console.log('B found:', bNew);

  if (aNew.includes('peer-B')) {
    console.log('4. A sends offer to B');
    await sendSignal('peer-B', { from: 'peer-A', type: 'offer' });
  }
  if (bNew.includes('peer-A')) {
    console.log('4. B sends offer to A');
    await sendSignal('peer-A', { from: 'peer-B', type: 'offer' });
  }

  console.log('5. A polls inbox');
  console.log('A signals:', await getSignals('peer-A'));
  console.log('5. B polls inbox');
  console.log('B signals:', await getSignals('peer-B'));
}
run().catch(console.error);
