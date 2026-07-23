const API_BASE = 'https://5dice-backend.jeffreyrobertparker.workers.dev';

async function fetchLeader() { const res = await fetch(`${API_BASE}/api/lobby/leader`); return await res.json(); }
async function claimLeadership(peerId, weight) { await fetch(`${API_BASE}/api/lobby/leader`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peerId, weight }) }); }
async function announcePeer(peerId) { await fetch(`${API_BASE}/api/lobby/new_peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peerId }) }); }
async function getNewPeers() { const res = await fetch(`${API_BASE}/api/lobby/new_peers`); return await res.json(); }
async function sendSignal(targetId, payload) { await fetch(`${API_BASE}/api/lobby/signal/${targetId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
async function getSignals(peerId) { const res = await fetch(`${API_BASE}/api/lobby/signal/${peerId}`); return await res.json(); }

async function run() {
  console.log('--- RESETTING ---');
  await sendSignal('peer-A', { reset: true });
  await sendSignal('peer-B', { reset: true });

  // Distinct weights so leader election is deterministic (equal weights left the
  // winner undefined / last-write-wins).
  console.log('1. A claims leadership (weight 200)');
  await claimLeadership('peer-A', 200);
  console.log('1. B claims leadership (weight 100)');
  await claimLeadership('peer-B', 100);

  const leaderResp = await fetchLeader();
  const leaderId = leaderResp && (leaderResp.peerId || leaderResp.id || leaderResp.leader || leaderResp);
  console.log('Elected leader:', leaderId);

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

  // Only the elected leader initiates the offer; the other peer answers. This avoids
  // WebRTC "glare", where both peers send offers to each other simultaneously.
  if (leaderId === 'peer-A' && aNew.includes('peer-B')) {
    console.log('4. A (leader) sends offer to B');
    await sendSignal('peer-B', { from: 'peer-A', type: 'offer' });
  }
  if (leaderId === 'peer-B' && bNew.includes('peer-A')) {
    console.log('4. B (leader) sends offer to A');
    await sendSignal('peer-A', { from: 'peer-B', type: 'offer' });
  }

  console.log('5. A polls inbox');
  const aInbox = await getSignals('peer-A');
  console.log('A signals:', aInbox);
  console.log('5. B polls inbox');
  const bInbox = await getSignals('peer-B');
  console.log('B signals:', bInbox);

  // The non-leader responds to the offer with an answer (instead of offering too).
  if (leaderId !== 'peer-A' && aInbox.some(s => s.type === 'offer')) {
    console.log('6. A (non-leader) answers B');
    await sendSignal('peer-B', { from: 'peer-A', type: 'answer' });
  }
  if (leaderId !== 'peer-B' && bInbox.some(s => s.type === 'offer')) {
    console.log('6. B (non-leader) answers A');
    await sendSignal('peer-A', { from: 'peer-B', type: 'answer' });
  }
}
run().catch(console.error);
