#!/usr/bin/env node
/**
 * Find commercially-active agents:
 * 1. Scan ERC-8004 for non-Olas agents with services/wallets (smarter sampling)
 * 2. Check which registered wallets have on-chain USDC activity
 * 3. Cross-reference x402scan buyer/merchant data
 *
 * This is the pivot from "enumerate everything" to "find the interesting ones."
 */

import https from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const INFURA_KEY = 'e4bc08b946d54b8c9144800c1eb3b454';
const BASE_RPC = `https://base-mainnet.infura.io/v3/${INFURA_KEY}`;
const ETH_RPC = `https://mainnet.infura.io/v3/${INFURA_KEY}`;
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// USDC on Base
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Transfer event signature: Transfer(address,address,uint256)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
        try {
          resolve(JSON.parse(data));
        } catch (e) { reject(new Error(`Parse: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

async function ethCall(rpcUrl, to, data) {
  const r = await rpcCall(rpcUrl, { jsonrpc:'2.0', id:1, method:'eth_call', params:[{to, data},'latest'] });
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

async function getBlockNumber(rpcUrl) {
  const r = await rpcCall(rpcUrl, { jsonrpc:'2.0', id:1, method:'eth_blockNumber', params:[] });
  return parseInt(r.result, 16);
}

async function getLogs(rpcUrl, filter) {
  const r = await rpcCall(rpcUrl, { jsonrpc:'2.0', id:1, method:'eth_getLogs', params:[filter] });
  if (r.error) throw new Error(r.error.message);
  return r.result || [];
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
  console.log('=== Finding Commercially Active ERC-8004 Agents ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // Step 1: Collect all wallets from checkpoint data
  const checkpoint = JSON.parse(readFileSync('/workspace/group/agent-trust/8004-checkpoint.json','utf8'));
  const knownWallets = new Map(); // address -> agent info

  for (const a of checkpoint.agents) {
    if (a.walletAddress) {
      // Extract raw address from eip155:8453:0x... format
      const addr = a.walletAddress.split(':').pop().toLowerCase();
      knownWallets.set(addr, { tokenId: a.tokenId, name: a.name, chain: 'base' });
    }
  }
  console.log(`Known wallets from Base checkpoint: ${knownWallets.size}`);

  // Step 2: Smart sample of higher token IDs for non-Olas agents
  // Token 1 is ClawNews. Tokens 3-200+ are Olas. Let's check recent tokens (higher IDs)
  // to see if the pattern changes at any point.
  console.log('\nSampling higher token IDs for non-Olas agents...');
  const samplePoints = [500, 1000, 1500, 2000, 3000, 5000, 7000, 9000, 10000, 12000, 15000, 18000];

  for (const tokenId of samplePoints) {
    try {
      const exists = await ethCall(BASE_RPC, REGISTRY, OWNER_OF + encUint(tokenId));
      const owner = '0x' + exists.slice(26);
      if (owner === '0x0000000000000000000000000000000000000000') {
        console.log(`  #${tokenId}: does not exist`);
        continue;
      }

      const uriResult = await ethCall(BASE_RPC, REGISTRY, TOKEN_URI + encUint(tokenId));
      const uri = decodeString(uriResult);
      let meta = null;
      if (uri?.startsWith('data:')) meta = parseDataURI(uri);
      else if (uri?.startsWith('http')) { try { meta = await fetchJSON(uri); } catch {} }

      const name = meta?.name || 'no-metadata';
      const isOlas = name.includes('by Olas');
      const x402 = meta?.x402Support ? '[x402]' : '';
      const wallet = meta?.services?.find(s => s.name === 'agentWallet');
      const svcCount = meta?.services?.length || 0;

      if (wallet) {
        const addr = wallet.endpoint.split(':').pop().toLowerCase();
        knownWallets.set(addr, { tokenId, name, chain: 'base' });
      }

      console.log(`  #${tokenId}: ${name} ${isOlas ? '(Olas)' : '*** NON-OLAS ***'} ${x402} svcs:${svcCount} ${wallet ? '[wallet]' : ''}`);
    } catch (e) {
      console.log(`  #${tokenId}: error (${e.message})`);
    }
    await sleep(300);
  }

  // Step 3: Scan ERC-8004 Transfer events to find ALL registrations (minting events)
  // Mint = Transfer from 0x0 to owner. The token ID is in the third topic.
  console.log('\nScanning ERC-8004 Transfer(0x0, ...) events for recent registrations...');
  const currentBlock = await getBlockNumber(BASE_RPC);
  console.log(`Current Base block: ${currentBlock}`);

  // Look at last ~30 days of registrations (Base ~2s blocks = ~1.3M blocks)
  const blocksBack = 1_300_000;
  const fromBlock = '0x' + Math.max(0, currentBlock - blocksBack).toString(16);

  try {
    const mintLogs = await getLogs(BASE_RPC, {
      address: REGISTRY,
      topics: [TRANSFER_TOPIC, '0x0000000000000000000000000000000000000000000000000000000000000000'],
      fromBlock,
      toBlock: 'latest'
    });

    console.log(`  Recent mint events: ${mintLogs.length}`);

    // Show some recent mints
    for (const log of mintLogs.slice(-20)) {
      const tokenId = parseInt(log.topics[3], 16);
      const to = '0x' + log.topics[2].slice(26);
      console.log(`  Minted #${tokenId} → ${to.substring(0,10)}...`);
    }
  } catch (e) {
    console.log(`  Transfer events scan error: ${e.message}`);
  }

  // Step 4: Check USDC activity for known wallets
  console.log('\n=== Checking USDC Activity for Known Agent Wallets ===');
  console.log(`Checking ${knownWallets.size} wallets for USDC transfers on Base...\n`);

  const activeWallets = [];

  for (const [addr, info] of knownWallets) {
    await sleep(300);
    const paddedAddr = '0x' + addr.replace('0x','').padStart(64, '0');

    try {
      // Check both incoming and outgoing USDC transfers
      // Incoming (as recipient)
      const inLogs = await getLogs(BASE_RPC, {
        address: USDC_BASE,
        topics: [TRANSFER_TOPIC, null, paddedAddr],
        fromBlock: '0x0',
        toBlock: 'latest'
      });

      await sleep(200);

      // Outgoing (as sender)
      const outLogs = await getLogs(BASE_RPC, {
        address: USDC_BASE,
        topics: [TRANSFER_TOPIC, paddedAddr],
        fromBlock: '0x0',
        toBlock: 'latest'
      });

      const totalIn = inLogs.length;
      const totalOut = outLogs.length;

      if (totalIn > 0 || totalOut > 0) {
        // Calculate total volume
        let volumeIn = 0n, volumeOut = 0n;
        for (const log of inLogs) volumeIn += BigInt(log.data);
        for (const log of outLogs) volumeOut += BigInt(log.data);

        const entry = {
          ...info,
          address: addr,
          usdcIn: totalIn,
          usdcOut: totalOut,
          volumeIn: Number(volumeIn) / 1e6,
          volumeOut: Number(volumeOut) / 1e6
        };
        activeWallets.push(entry);

        console.log(`  ★ #${info.tokenId} ${info.name}: ${totalIn} in (${entry.volumeIn.toFixed(2)} USDC), ${totalOut} out (${entry.volumeOut.toFixed(2)} USDC)`);
      } else {
        console.log(`  · #${info.tokenId} ${info.name}: no USDC activity`);
      }
    } catch (e) {
      console.log(`  ! #${info.tokenId} ${info.name}: error — ${e.message}`);
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Total wallets checked: ${knownWallets.size}`);
  console.log(`Wallets with USDC activity: ${activeWallets.length}`);

  if (activeWallets.length > 0) {
    console.log('\nCommercially active agents (sorted by volume):');
    activeWallets.sort((a, b) => (b.volumeIn + b.volumeOut) - (a.volumeIn + a.volumeOut));
    for (const w of activeWallets) {
      console.log(`  #${w.tokenId}: ${w.name}`);
      console.log(`    Address: ${w.address}`);
      console.log(`    USDC In: ${w.usdcIn} txns, $${w.volumeIn.toFixed(2)}`);
      console.log(`    USDC Out: ${w.usdcOut} txns, $${w.volumeOut.toFixed(2)}`);
    }
  }

  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    knownWallets: Object.fromEntries(knownWallets),
    activeWallets,
    summary: {
      totalRegistered: checkpoint.existingIds.length,
      metadataFetched: checkpoint.agents.length,
      walletsFound: knownWallets.size,
      walletsWithUSDC: activeWallets.length
    }
  };

  writeFileSync('/workspace/group/agent-trust/active-agents.json', JSON.stringify(output, null, 2));
  console.log('\nResults saved to active-agents.json');
  console.log(`Completed: ${new Date().toISOString()}`);
}

main().catch(e => console.error('Fatal:', e));
