#!/usr/bin/env node
/**
 * ERC-8004 Registry probe — find exact token count + sample metadata
 * Check both Base and Ethereum mainnet
 */

import https from 'https';

const REGISTRIES = {
  base: {
    rpc: 'https://mainnet.base.org',
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    name: 'Base Mainnet'
  },
  ethereum: {
    rpc: 'https://eth.llamarpc.com',
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', // same address? ERC-8004 uses CREATE2
    name: 'Ethereum Mainnet'
  }
};

function rpcCall(rpcUrl, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const parsed = new URL(rpcUrl);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(j.error.message));
          else resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function ethCall(rpcUrl, to, data) {
  return rpcCall(rpcUrl, 'eth_call', [{ to, data }, 'latest']);
}

function encodeUint256(n) { return n.toString(16).padStart(64, '0'); }

function decodeString(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 128) return '';
  const offset = parseInt(clean.slice(0, 64), 16) * 2;
  const length = parseInt(clean.slice(offset, offset + 64), 16);
  const strHex = clean.slice(offset + 64, offset + 64 + length * 2);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

const OWNER_OF = '0x6352211e';
const TOKEN_URI = '0xc87b56dd';

function parseDataURI(uri) {
  if (!uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma === -1) return null;
  const meta = uri.substring(5, comma);
  const data = uri.substring(comma + 1);
  if (meta.includes('base64')) {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  }
  return JSON.parse(decodeURIComponent(data));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : require('http');
    lib.get(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error`)); }
      });
    }).on('error', reject);
  });
}

async function probeRegistry(chain, config) {
  console.log(`\n=== ${config.name} ===`);
  console.log(`Registry: ${config.identity}\n`);

  // Binary search for max token ID
  let low = 1, high = 50000, maxFound = 0;

  // Quick probes first
  for (const id of [1, 10, 100, 500, 1000, 2000, 5000, 10000, 20000, 30000]) {
    try {
      const result = await ethCall(config.rpc, config.identity, OWNER_OF + encodeUint256(id));
      const owner = '0x' + result.slice(26);
      if (owner !== '0x0000000000000000000000000000000000000000') {
        maxFound = Math.max(maxFound, id);
        process.stdout.write(`  Token ${id}: ✓  `);
      } else {
        process.stdout.write(`  Token ${id}: ✗  `);
      }
    } catch (e) {
      process.stdout.write(`  Token ${id}: ✗  `);
    }
  }
  console.log('');

  if (maxFound === 0) {
    console.log('No tokens found at this registry address.');
    return { chain, count: 0, agents: [] };
  }

  // Binary search for exact max
  low = maxFound;
  high = maxFound * 2;
  // Verify high is too high
  try {
    await ethCall(config.rpc, config.identity, OWNER_OF + encodeUint256(high));
    // If this works, double again
    high = high * 2;
  } catch {}

  while (low < high - 1) {
    const mid = Math.floor((low + high) / 2);
    try {
      const result = await ethCall(config.rpc, config.identity, OWNER_OF + encodeUint256(mid));
      const owner = '0x' + result.slice(26);
      if (owner !== '0x0000000000000000000000000000000000000000') {
        low = mid;
      } else {
        high = mid;
      }
    } catch {
      high = mid;
    }
  }

  console.log(`\nApprox max token ID: ${low}`);
  console.log(`Estimated agents: ~${low} (some IDs may be burned/sparse)\n`);

  // Sample metadata from a few agents
  const sampleIds = [1, 2, Math.floor(low / 4), Math.floor(low / 2), Math.floor(low * 3 / 4), low];
  const uniqueSamples = [...new Set(sampleIds)].filter(id => id >= 1);

  const agents = [];

  console.log('Sampling metadata...\n');
  for (const tokenId of uniqueSamples) {
    try {
      const uriResult = await ethCall(config.rpc, config.identity, TOKEN_URI + encodeUint256(tokenId));
      const uri = decodeString(uriResult);

      let metadata;
      if (uri.startsWith('data:')) {
        metadata = parseDataURI(uri);
      } else if (uri.startsWith('http')) {
        try { metadata = await fetchJSON(uri); } catch (e) {
          console.log(`  Token ${tokenId}: URI unreachable (${uri.substring(0, 60)})`);
          continue;
        }
      } else if (uri.startsWith('ipfs:')) {
        const ipfsHash = uri.replace('ipfs://', '');
        try { metadata = await fetchJSON(`https://ipfs.io/ipfs/${ipfsHash}`); } catch (e) {
          console.log(`  Token ${tokenId}: IPFS unreachable`);
          continue;
        }
      } else {
        console.log(`  Token ${tokenId}: unknown URI scheme: ${uri.substring(0, 40)}`);
        continue;
      }

      if (metadata) {
        const fullText = JSON.stringify(metadata).toLowerCase();
        const hasEth = fullText.includes('.eth');
        const hasSol = fullText.includes('.sol');
        const hasName = hasEth || hasSol;

        console.log(`  Token ${tokenId}: ${metadata.name || 'unnamed'}${hasName ? ' ★ HAS .eth/.sol' : ''}`);
        if (metadata.services) {
          for (const svc of metadata.services.slice(0, 3)) {
            console.log(`    ${svc.type || svc.id || 'service'}: ${(svc.endpoint || svc.url || '').substring(0, 80)}`);
          }
        }

        agents.push({
          tokenId,
          name: metadata.name,
          description: metadata.description?.substring(0, 200),
          services: metadata.services || [],
          hasEth,
          hasSol,
          raw: metadata
        });
      }
    } catch (e) {
      // Token might not exist (sparse)
    }
  }

  // Also check Orac
  if (chain === 'ethereum') {
    console.log('\n  Checking Orac #6588...');
    try {
      const uriResult = await ethCall(config.rpc, config.identity, TOKEN_URI + encodeUint256(6588));
      const uri = decodeString(uriResult);
      let metadata;
      if (uri.startsWith('data:')) metadata = parseDataURI(uri);
      else if (uri.startsWith('http')) metadata = await fetchJSON(uri);
      if (metadata) {
        console.log(`  Token 6588: ${metadata.name || 'unnamed'}`);
        if (metadata.services) {
          for (const svc of metadata.services) {
            console.log(`    ${svc.type || svc.id}: ${(svc.endpoint || svc.url || '').substring(0, 80)}`);
          }
        }
      }
    } catch (e) {
      console.log(`  Token 6588: ${e.message}`);
    }
  }

  return { chain, maxTokenId: low, agents };
}

async function main() {
  console.log('=== ERC-8004 Multi-Chain Registry Scan ===');

  const results = {};

  for (const [chain, config] of Object.entries(REGISTRIES)) {
    try {
      results[chain] = await probeRegistry(chain, config);
    } catch (e) {
      console.log(`\n${config.name}: Error — ${e.message}`);
    }
  }

  console.log('\n=== Summary ===');
  for (const [chain, result] of Object.entries(results)) {
    if (result) {
      console.log(`${chain}: ~${result.maxTokenId || 0} agents, ${result.agents?.filter(a => a.hasEth || a.hasSol).length || 0} with .eth/.sol names in sample`);
    }
  }
}

main().catch(e => console.error('Fatal:', e));
