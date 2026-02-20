#!/usr/bin/env node
/**
 * Scrape ERC-8004 Identity Registry on Base
 * Phase 2: Use Transfer events to enumerate all minted agents
 */

import https from 'https';

const BASE_RPC = 'https://mainnet.base.org';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// ERC-721 Transfer event: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
// Mint = Transfer from 0x0
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Function sigs
const TOKEN_URI_SIG = '0xc87b56dd';
const OWNER_OF_SIG = '0x6352211e';

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const parsed = new URL(BASE_RPC);
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

async function ethCall(to, data) {
  return rpcCall('eth_call', [{ to, data }, 'latest']);
}

function encodeUint256(n) {
  return n.toString(16).padStart(64, '0');
}

function decodeString(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 128) return '';
  const offset = parseInt(clean.slice(0, 64), 16) * 2;
  const length = parseInt(clean.slice(offset, offset + 64), 16);
  const strHex = clean.slice(offset + 64, offset + 64 + length * 2);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : require('http');
    lib.get(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error`)); }
      });
    }).on('error', reject);
  });
}

function parseDataURI(uri) {
  // data:application/json;base64,xxxxx
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

async function main() {
  console.log('=== ERC-8004 Registry Scan ===\n');

  // Step 1: Get all Transfer events from 0x0 (mints)
  console.log('Fetching mint events...');

  // Get current block
  const latestBlock = await rpcCall('eth_blockNumber', []);
  console.log(`Latest block: ${parseInt(latestBlock, 16)}`);

  // Query in chunks (10M blocks per query, Base has ~2s blocks)
  // Base launched around block ~1M, we need to cover from registry deployment
  // Start from a reasonable block — registry deployed Jan 2026-ish
  // Base block ~25M was around Jan 2026

  const START_BLOCK = 25000000; // ~Jan 2026
  const END_BLOCK = parseInt(latestBlock, 16);
  const CHUNK_SIZE = 10000000; // 10M blocks per query

  let allMints = [];

  for (let from = START_BLOCK; from <= END_BLOCK; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, END_BLOCK);
    console.log(`  Scanning blocks ${from} to ${to}...`);

    try {
      const logs = await rpcCall('eth_getLogs', [{
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        address: IDENTITY_REGISTRY,
        topics: [TRANSFER_TOPIC, ZERO_ADDRESS] // from = 0x0 = mint
      }]);

      if (logs && logs.length > 0) {
        console.log(`  Found ${logs.length} mint events`);
        for (const log of logs) {
          const tokenId = parseInt(log.topics[3], 16);
          const to = '0x' + log.topics[2].slice(26);
          allMints.push({ tokenId, mintedTo: to, block: parseInt(log.blockNumber, 16) });
        }
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
      // Try smaller chunks
      for (let subFrom = from; subFrom <= to; subFrom += 1000000) {
        const subTo = Math.min(subFrom + 999999, to);
        try {
          const logs = await rpcCall('eth_getLogs', [{
            fromBlock: '0x' + subFrom.toString(16),
            toBlock: '0x' + subTo.toString(16),
            address: IDENTITY_REGISTRY,
            topics: [TRANSFER_TOPIC, ZERO_ADDRESS]
          }]);
          if (logs && logs.length > 0) {
            for (const log of logs) {
              const tokenId = parseInt(log.topics[3], 16);
              const mintedTo = '0x' + log.topics[2].slice(26);
              allMints.push({ tokenId, mintedTo, block: parseInt(log.blockNumber, 16) });
            }
          }
        } catch (e2) {
          // Even smaller
        }
      }
    }
  }

  console.log(`\nTotal minted agents: ${allMints.length}`);

  if (allMints.length === 0) {
    console.log('No mints found. The contract might use a different event structure.');
    // Fallback: try checking individual IDs
    console.log('\nFallback: probing individual token IDs...');
    let maxFound = 0;
    // Binary search for max token ID - try some known IDs
    for (const id of [1, 2, 5, 10, 100, 1000, 5000, 6588, 10000, 20000, 25000]) {
      try {
        const result = await ethCall(IDENTITY_REGISTRY, OWNER_OF_SIG + encodeUint256(id));
        const owner = '0x' + result.slice(26);
        if (owner !== '0x0000000000000000000000000000000000000000') {
          console.log(`  Token ${id}: EXISTS (owner: ${owner})`);
          maxFound = Math.max(maxFound, id);
        }
      } catch (e) {
        console.log(`  Token ${id}: does not exist`);
      }
    }
    console.log(`\nHighest confirmed token ID: ${maxFound}`);
    return;
  }

  // Sort by tokenId
  allMints.sort((a, b) => a.tokenId - b.tokenId);
  console.log(`Token ID range: ${allMints[0].tokenId} to ${allMints[allMints.length - 1].tokenId}`);

  // Step 2: Sample some agents to understand the data
  console.log('\n=== Sampling agent metadata ===\n');

  const sampleIds = [
    allMints[0].tokenId,  // first
    allMints[Math.floor(allMints.length * 0.25)].tokenId, // 25th percentile
    allMints[Math.floor(allMints.length * 0.5)].tokenId,  // median
    6588, // Orac
    allMints[allMints.length - 1].tokenId, // last
  ].filter((v, i, a) => a.indexOf(v) === i); // dedupe

  for (const tokenId of sampleIds) {
    console.log(`--- Token ${tokenId} ---`);
    try {
      const uriResult = await ethCall(IDENTITY_REGISTRY, TOKEN_URI_SIG + encodeUint256(tokenId));
      const uri = decodeString(uriResult);

      let metadata;
      if (uri.startsWith('data:')) {
        metadata = parseDataURI(uri);
      } else if (uri.startsWith('http')) {
        metadata = await fetchJSON(uri);
      } else {
        console.log(`  URI scheme unknown: ${uri.substring(0, 60)}`);
        continue;
      }

      if (metadata) {
        console.log(`  Name: ${metadata.name || 'N/A'}`);
        console.log(`  Type: ${metadata.type || 'N/A'}`);
        const desc = (metadata.description || '').substring(0, 120);
        console.log(`  Description: ${desc}`);
        if (metadata.services) {
          for (const svc of metadata.services.slice(0, 5)) {
            console.log(`  Service: ${svc.type || svc.id} → ${svc.endpoint || svc.url || 'N/A'}`);
          }
        }
        // Check for .eth or .sol in name or services
        const fullText = JSON.stringify(metadata).toLowerCase();
        const hasEth = fullText.includes('.eth');
        const hasSol = fullText.includes('.sol');
        if (hasEth || hasSol) {
          console.log(`  *** HAS NAMED IDENTITY: ${hasEth ? '.eth' : ''} ${hasSol ? '.sol' : ''}`);
        }
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    console.log('');
  }
}

main().catch(e => console.error('Fatal:', e));
