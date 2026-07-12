const API_BASE = 'https://5dice-backend.jeffreyrobertparker.workers.dev';

async function fetchLeader() {
  const res = await fetch(`${API_BASE}/api/lobby/leader`);
  return await res.json();
}

async function claimLeadership(peerId) {
  await fetch(`${API_BASE}/api/lobby/leader`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId, weight: 100 })
  });
}

async function announcePeer(peerId) {
  await fetch(`${API_BASE}/api/lobby/new_peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId })
  });
}

async function getNewPeers() {
  const res = await fetch(`${API_BASE}/api/lobby/new_peers`);
  return await res.json();
}

async function sendSignal(targetId, payload) {
  await fetch(`${API_BASE}/api/lobby/signal/${targetId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function getSignals(peerId) {
  const res = await fetch(`${API_BASE}/api/lobby/signal/${peerId}`);
  return await res.json();
}

async function run() {
  console.log('--- RESETTING ---');
  await sendSignal('peer-A', { reset: true });
  await sendSignal('peer-B', { reset: true });

  console.log('1. A claims leadership');
  await claimLeadership('peer-A');

  console.log('2. B announces presence');
  await announcePeer('peer-B');

  console.log('3. A polls new_peers');
  const newPeers = await getNewPeers();
  console.log('A found:', newPeers);

  if (newPeers.includes('peer-B')) {
    console.log('4. A sends offer to B via HTTP');
    await sendSignal('peer-B', { from: 'peer-A', type: 'offer', sdp: 'fake-offer' });
  }

  console.log('5. B polls inbox');
  const bSignals = await getSignals('peer-B');
  console.log('B found signals:', bSignals);

  if (bSignals.length > 0 && bSignals[bSignals.length-1].type === 'offer') {
    console.log('6. B sends answer to A via HTTP');
    await sendSignal('peer-A', { from: 'peer-B', type: 'answer', sdp: 'fake-answer' });
  }

  console.log('7. A polls inbox');
  const aSignals = await getSignals('peer-A');
  console.log('A found signals:', aSignals);
}

run().catch(console.error);
