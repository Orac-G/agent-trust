#!/usr/bin/env node
/**
 * Smart sample of Ethereum mainnet ERC-8004 registry.
 * Check ~50 tokens across the full range to understand composition.
 * If interesting agents exist, we can do a deeper scan.
 */

import https from 'https';

const INFURA_KEY = 'e4bc08b946d54b8c9144800c1eb3b454';
const ETH_RPC = `https://mainnet.infura.io/v3/${INFURA_KEY}`;
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

const TOKEN_URI = '0xc87b56dd';
const OWNER_OF = '0x6352211e';

function encUint(n) { return n.toString(16).padStart(64, '0'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function rpcCall(url, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

async function ethCall(rpcUrl, to, data) {
  const r = await rpcCall(rpcUrl, { jsonrpc:'2.0', id:1, method:'eth_call', params:[{to, data},'latest'] });
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

function decodeString(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 128) return '';
  const offset = parseInt(clean.slice(0, 64), 16) * 2;
  if (offset + 64 > clean.length) return '';
  const length = parseInt(clean.slice(offset, offset + 64), 16);
  if (length === 0 || offset + 64 + length * 2 > clean.length) return '';
  return Buffer.from(clean.slice(offset + 64, offset + 64 + length * 2), 'hex').toString('utf8');
}

function parseDataURI(uri) {
  if (!uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma === -1) return null;
  const meta = uri.substring(5, comma);
  const data = uri.substring(comma + 1);
  if (meta.includes('base64')) return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  return JSON.parse(decodeURIComponent(data));
}

function fetchJSON(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' }, timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  console.log('=== Ethereum Mainnet ERC-8004 Smart Sample ===\n');

  // Sample 50 points across the range 1-25500
  const samplePoints = [];
  for (let i = 1; i <= 25500; i += 500) samplePoints.push(i);
  // Add some specific points
  samplePoints.push(2, 3, 5, 10, 50, 100, 250, 6588); // 6588 was Orac
  samplePoints.sort((a, b) => a - b);

  let olasCount = 0;
  let nonOlasCount = 0;
  let noMetaCount = 0;
  let errorCount = 0;
  let withWallet = 0;
  let withX402 = 0;
  let withServices = 0;
  let withRealName = 0;

  const interesting = [];

  for (const tokenId of samplePoints) {
    try {
      // Check if exists
      const ownerResult = await ethCall(ETH_RPC, REGISTRY, OWNER_OF + encUint(tokenId));
      const owner = '0x' + ownerResult.slice(26);
      if (owner === '0x0000000000000000000000000000000000000000') {
        console.log(`  #${tokenId}: empty`);
        continue;
      }

      // Get metadata
      const uriResult = await ethCall(ETH_RPC, REGISTRY, TOKEN_URI + encUint(tokenId));
      const uri = decodeString(uriResult);

      if (!uri) {
        noMetaCount++;
        console.log(`  #${tokenId}: exists, no URI`);
        continue;
      }

      let meta = null;
      if (uri.startsWith('data:')) {
        meta = parseDataURI(uri);
      } else if (uri.startsWith('http')) {
        try { meta = await fetchJSON(uri); } catch { noMetaCount++; }
      } else if (uri.startsWith('ipfs:')) {
        try { meta = await fetchJSON(`https://ipfs.io/ipfs/${uri.replace('ipfs://','')}`); } catch { noMetaCount++; }
      }

      if (!meta) {
        console.log(`  #${tokenId}: URI unreachable (${uri.substring(0, 60)})`);
        continue;
      }

      const name = meta.name || 'unnamed';
      const isOlas = name.includes('by Olas') || name.includes('Olas ');
      const x402 = meta.x402Support === true;
      const wallet = meta.services?.find(s => s.name === 'agentWallet');
      const svcList = meta.services?.map(s => s.name) || [];
      const hasName = meta.name && meta.name.length > 0;

      if (isOlas) olasCount++; else nonOlasCount++;
      if (x402) withX402++;
      if (wallet) withWallet++;
      if (svcList.length > 0) withServices++;
      if (hasName) withRealName++;

      // Check for actual .eth or .sol in name
      const nameLC = name.toLowerCase();
      const hasEth = /[\w-]+\.eth/.test(nameLC) && !nameLC.includes('eips.eth');
      const hasSol = /[\w-]+\.sol/.test(nameLC);

      const marker = isOlas ? '(Olas)' : '*** NON-OLAS ***';
      const extras = [
        x402 ? '[x402]' : '',
        wallet ? '[wallet]' : '',
        hasEth ? '[.eth]' : '',
        hasSol ? '[.sol]' : '',
        svcList.length > 0 ? `svcs:[${svcList.join(',')}]` : ''
      ].filter(Boolean).join(' ');

      console.log(`  #${tokenId}: ${name} ${marker} ${extras}`);

      if (!isOlas || x402 || wallet || hasEth || hasSol) {
        interesting.push({
          tokenId, name, owner, isOlas, x402Support: x402,
          walletAddress: wallet?.endpoint || null,
          hasEth, hasSol,
          services: svcList,
          description: (meta.description || '').substring(0, 200)
        });
      }
    } catch (e) {
      errorCount++;
      console.log(`  #${tokenId}: error — ${e.message}`);
    }

    await sleep(400); // Conservative — Ethereum mainnet
  }

  console.log('\n=== Ethereum Mainnet Sample Summary ===');
  console.log(`Sampled: ${samplePoints.length} token IDs`);
  console.log(`Olas agents: ${olasCount}`);
  console.log(`Non-Olas agents: ${nonOlasCount}`);
  console.log(`No metadata: ${noMetaCount}`);
  console.log(`With real name: ${withRealName}`);
  console.log(`With x402Support: ${withX402}`);
  console.log(`With agentWallet: ${withWallet}`);
  console.log(`With services: ${withServices}`);
  console.log(`Errors: ${errorCount}`);

  console.log('\n=== Interesting Agents ===');
  for (const a of interesting) {
    console.log(`  #${a.tokenId}: ${a.name}`);
    if (a.description) console.log(`    ${a.description.substring(0, 100)}`);
    if (a.walletAddress) console.log(`    wallet: ${a.walletAddress}`);
    if (a.services.length) console.log(`    services: ${a.services.join(', ')}`);
  }
}

main().catch(e => console.error('Fatal:', e));
