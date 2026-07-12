const API_BASE = 'https://5dice-backend.jeffreyrobertparker.workers.dev';

async function announcePeer(peerId) { await fetch(`${API_BASE}/api/lobby/new_peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peerId }) }); }
async function getNewPeers() { const res = await fetch(`${API_BASE}/api/lobby/new_peers`); return await res.json(); }
async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('1. A announces');
  await announcePeer('peer-A');
  await delay(1000);
  console.log('A polls:', await getNewPeers());

  console.log('2. B announces');
  await announcePeer('peer-B');
  await delay(1000);
  console.log('A polls:', await getNewPeers());
  console.log('B polls:', await getNewPeers());
}
run().catch(console.error);
