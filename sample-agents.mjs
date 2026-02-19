#!/usr/bin/env node
import https from 'https';

const RPC = 'https://mainnet.base.org';
const REG = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

function rpc(body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'mainnet.base.org', path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function encId(n) { return n.toString(16).padStart(64, '0'); }

async function getMetadata(tokenId) {
  const r = await rpc(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:REG,data:'0xc87b56dd'+encId(tokenId)},'latest']}));
  if (r.error) return null;
  const hex = r.result.slice(2);
  const offset = parseInt(hex.slice(0,64),16)*2;
  const len = parseInt(hex.slice(offset,offset+64),16);
  const uri = Buffer.from(hex.slice(offset+64,offset+64+len*2),'hex').toString('utf8');
  if (uri.startsWith('data:')) {
    return JSON.parse(Buffer.from(uri.split(',')[1],'base64').toString());
  }
  return { _uri: uri.substring(0,120) };
}

async function main() {
  const results = { total: 0, withEth: 0, withSol: 0, withX402: 0, withWallet: 0 };

  for (const id of [2, 5, 10, 20, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 999]) {
    try {
      const m = await getMetadata(id);
      if (m === null) { console.log(`${id}: no data`); continue; }

      results.total++;
      const text = JSON.stringify(m).toLowerCase();
      const hasEth = text.includes('.eth');
      const hasSol = text.includes('.sol');
      const x402 = m.x402Support === true;
      const wallet = (m.services || []).find(s => s.name === 'agentWallet');
      const walletAddr = wallet ? wallet.endpoint : '';

      if (hasEth) results.withEth++;
      if (hasSol) results.withSol++;
      if (x402) results.withX402++;
      if (walletAddr) results.withWallet++;

      const flags = [];
      if (hasEth) flags.push('.eth');
      if (hasSol) flags.push('.sol');
      if (x402) flags.push('x402');
      if (walletAddr) flags.push('wallet');

      console.log(`${id}: ${(m.name || 'unnamed').substring(0, 30).padEnd(32)} [${flags.join(', ')}]`);
      if (hasEth || hasSol || x402) {
        console.log(`    → ${walletAddr}`);
        if (m.services) {
          for (const s of m.services.filter(s => s.name !== 'agentWallet').slice(0, 2)) {
            console.log(`    → ${s.name}: ${(s.endpoint || '').substring(0, 60)}`);
          }
        }
      }
    } catch(e) {
      console.log(`${id}: error — ${e.message.substring(0, 60)}`);
    }
  }

  console.log('\n=== Sample Summary ===');
  console.log(`Sampled: ${results.total}`);
  console.log(`With .eth: ${results.withEth}`);
  console.log(`With .sol: ${results.withSol}`);
  console.log(`With x402Support: ${results.withX402}`);
  console.log(`With agentWallet: ${results.withWallet}`);
}

main().catch(e => console.error('Fatal:', e));
