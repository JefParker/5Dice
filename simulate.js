const API_BASE = 'https://5dice-backend.jeffreyrobertparker.workers.dev';

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const peerA = 'peer-A';
  const peerB = 'peer-B';

  // 1. Peer A becomes leader
  console.log('A claiming leadership...');
  await fetch(`${API_BASE}/api/lobby/leader`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: peerA, weight: 100 })
  });

  // 2. Peer B announces
  console.log('B announcing presence...');
  await fetch(`${API_BASE}/api/lobby/new_peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: peerB })
  });

  // 3. Peer A polls new peers
  console.log('A polling new peers...');
  let res = await fetch(`${API_BASE}/api/lobby/new_peers`);
  let newPeers = await res.json();
  console.log('A got new peers:', newPeers);

  if (newPeers.includes(peerB)) {
    // 4. A sends offer to B
    console.log('A sending offer to B...');
    await fetch(`${API_BASE}/api/lobby/signal/${peerB}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: peerA, type: 'offer', sdp: 'fake-offer' })
    });
  }

  // 5. B polls inbox
  console.log('B polling inbox...');
  res = await fetch(`${API_BASE}/api/lobby/signal/${peerB}`);
  let signals = await res.json();
  console.log('B got signals:', signals);

  if (signals.length > 0) {
    // 6. B sends answer to A
    console.log('B sending answer to A...');
    await fetch(`${API_BASE}/api/lobby/signal/${peerA}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: peerB, type: 'answer', sdp: 'fake-answer' })
    });
  }

  // 7. A polls inbox
  console.log('A polling inbox...');
  res = await fetch(`${API_BASE}/api/lobby/signal/${peerA}`);
  signals = await res.json();
  console.log('A got signals:', signals);
}

run().catch(console.error);
