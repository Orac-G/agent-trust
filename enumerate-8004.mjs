#!/usr/bin/env node
/**
 * ERC-8004 Full Enumeration via Infura
 *
 * Phase 2: Enumerate all registered agents on Base and Ethereum mainnet.
 * Extract .eth/.sol names, wallet addresses, x402Support flags.
 *
 * RATE LIMITING:
 *   - eth_call = 80 credits each
 *   - Free tier: 3-6M credits/day, 500-2000 credits/sec
 *   - We budget 2.5M credits total (conservative)
 *   - Max 400 credits/sec (5 eth_call/sec)
 *   - Checkpoint progress to disk for resume
 *
 * Usage:
 *   node enumerate-8004.mjs              # Run both chains
 *   node enumerate-8004.mjs --base-only  # Base only (quick)
 *   node enumerate-8004.mjs --eth-only   # Ethereum only
 *   node enumerate-8004.mjs --resume     # Resume from checkpoint
 */

import https from 'https';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const INFURA_KEY = 'e4bc08b946d54b8c9144800c1eb3b454';

const CHAINS = {
  base: {
    rpc: `https://base-mainnet.infura.io/v3/${INFURA_KEY}`,
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    name: 'Base'
  },
  ethereum: {
    rpc: `https://mainnet.infura.io/v3/${INFURA_KEY}`,
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    name: 'Ethereum'
  }
};

// Credit tracking
const CREDIT_PER_CALL = 80;
const MAX_CREDITS = 2_500_000; // Conservative: well under 3M free tier
const MAX_CREDITS_PER_SEC = 400; // 5 calls/sec
let creditsUsed = 0;
let lastSecondStart = Date.now();
let creditsThisSecond = 0;

const CHECKPOINT_FILE = '/workspace/group/agent-trust/8004-checkpoint.json';
const OUTPUT_FILE = '/workspace/group/agent-trust/8004-agents.json';

// ABI selectors
const OWNER_OF = '0x6352211e';
const TOKEN_URI = '0xc87b56dd';

function encUint(n) { return n.toString(16).padStart(64, '0'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Rate limiter: enforces credits/sec and total budget
async function rateLimitedCall(callCount = 1) {
  const creditCost = callCount * CREDIT_PER_CALL;

  // Check total budget
  if (creditsUsed + creditCost > MAX_CREDITS) {
    throw new Error(`BUDGET_EXCEEDED: ${creditsUsed} used + ${creditCost} needed > ${MAX_CREDITS} max`);
  }

  // Check per-second rate
  const now = Date.now();
  if (now - lastSecondStart > 1000) {
    lastSecondStart = now;
    creditsThisSecond = 0;
  }

  if (creditsThisSecond + creditCost > MAX_CREDITS_PER_SEC) {
    const wait = 1000 - (now - lastSecondStart) + 50; // Wait until next second + buffer
    await sleep(wait);
    lastSecondStart = Date.now();
    creditsThisSecond = 0;
  }

  creditsUsed += creditCost;
  creditsThisSecond += creditCost;
}

function rpcCall(url, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
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
          const j = JSON.parse(data);
          resolve(j);
        } catch (e) {
          reject(new Error(`Parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

async function ethCall(rpcUrl, to, data) {
  await rateLimitedCall(1);
  const result = await rpcCall(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
  if (result.error) throw new Error(result.error.message);
  return result.result;
}

// Batch eth_call — each call in batch costs 80 credits
async function batchEthCall(rpcUrl, calls) {
  if (calls.length === 0) return [];
  await rateLimitedCall(calls.length);

  const body = calls.map((c, i) => ({
    jsonrpc: '2.0', id: i + 1, method: 'eth_call',
    params: [{ to: c.to, data: c.data }, 'latest']
  }));

  const results = await rpcCall(rpcUrl, body);
  if (!Array.isArray(results)) {
    throw new Error(`Non-array batch response`);
  }
  return results.sort((a, b) => a.id - b.id);
}

function decodeString(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 128) return '';
  const offset = parseInt(clean.slice(0, 64), 16) * 2;
  if (offset + 64 > clean.length) return '';
  const length = parseInt(clean.slice(offset, offset + 64), 16);
  if (length === 0 || offset + 64 + length * 2 > clean.length) return '';
  const strHex = clean.slice(offset + 64, offset + 64 + length * 2);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

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

function fetchJSON(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const req = https.get(url, { headers: { Accept: 'application/json' }, timeout }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchJSON(res.headers.location, timeout).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('JSON parse')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    } catch (e) { reject(e); }
  });
}

async function getMetadata(rpcUrl, registry, tokenId) {
  try {
    const uriResult = await ethCall(rpcUrl, registry, TOKEN_URI + encUint(tokenId));
    const uri = decodeString(uriResult);
    if (!uri) return null;

    if (uri.startsWith('data:')) {
      return parseDataURI(uri);
    } else if (uri.startsWith('http')) {
      try { return await fetchJSON(uri); }
      catch { return { _unreachable: true, _uri: uri.substring(0, 200) }; }
    } else if (uri.startsWith('ipfs:')) {
      const hash = uri.replace('ipfs://', '');
      try { return await fetchJSON(`https://ipfs.io/ipfs/${hash}`); }
      catch { return { _unreachable: true, _uri: uri }; }
    }
    return { _unreachable: true, _uri: uri.substring(0, 200) };
  } catch {
    return null;
  }
}

function extractAgentData(tokenId, chain, meta) {
  if (!meta || meta._unreachable) {
    return { tokenId, chain, name: null, unreachable: true, uri: meta?._uri };
  }

  const fullText = JSON.stringify(meta).toLowerCase();
  const hasEth = fullText.includes('.eth');
  const hasSol = fullText.includes('.sol');
  const hasX402 = meta.x402Support === true;
  const wallet = (meta.services || []).find(s => s.name === 'agentWallet');

  return {
    tokenId,
    chain,
    name: meta.name || null,
    description: (meta.description || '').substring(0, 300),
    hasEth,
    hasSol,
    ethName: hasEth ? (fullText.match(/[\w-]+\.eth/)?.[0] || null) : null,
    solName: hasSol ? (fullText.match(/[\w-]+\.sol/)?.[0] || null) : null,
    x402Support: hasX402,
    walletAddress: wallet?.endpoint || null,
    services: (meta.services || []).map(s => ({
      name: s.name,
      endpoint: (s.endpoint || s.url || '').substring(0, 120)
    })),
    active: meta.active,
    supportedTrust: meta.supportedTrust || [],
  };
}

// Save checkpoint for resume
function saveCheckpoint(data) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
}

function loadCheckpoint() {
  if (existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8'));
  }
  return null;
}

async function findMaxToken(rpcUrl, registry) {
  let maxFound = 0;
  const probes = [1, 100, 500, 1000, 2000, 5000, 10000, 15000, 20000, 25000, 30000, 40000, 50000];

  for (const id of probes) {
    try {
      const result = await ethCall(rpcUrl, registry, OWNER_OF + encUint(id));
      const owner = '0x' + result.slice(26);
      if (owner !== '0x0000000000000000000000000000000000000000') {
        maxFound = id;
        process.stdout.write(`  ${id}: yes  `);
      } else {
        process.stdout.write(`  ${id}: no  `);
        if (id > maxFound * 3 && maxFound > 0) break;
      }
    } catch {
      process.stdout.write(`  ${id}: err  `);
      if (id > maxFound * 3 && maxFound > 0) break;
    }
    await sleep(200); // Extra conservative for probing
  }
  console.log('');

  if (maxFound === 0) return 0;

  // Binary search
  let low = maxFound, high = Math.min(maxFound * 2, 60000);
  try {
    const r = await ethCall(rpcUrl, registry, OWNER_OF + encUint(high));
    const o = '0x' + r.slice(26);
    if (o !== '0x0000000000000000000000000000000000000000') high *= 2;
  } catch {}

  while (low < high - 1) {
    const mid = Math.floor((low + high) / 2);
    try {
      const r = await ethCall(rpcUrl, registry, OWNER_OF + encUint(mid));
      const o = '0x' + r.slice(26);
      if (o !== '0x0000000000000000000000000000000000000000') low = mid;
      else high = mid;
    } catch { high = mid; }
    await sleep(100);
  }

  return low;
}

// Batch check which token IDs exist
async function batchOwnerCheck(rpcUrl, registry, ids) {
  const calls = ids.map(id => ({ to: registry, data: OWNER_OF + encUint(id) }));

  let results;
  try {
    results = await batchEthCall(rpcUrl, calls);
  } catch (e) {
    if (e.message.includes('BUDGET_EXCEEDED')) throw e;
    // On batch failure, try individual calls
    const existing = [];
    for (const id of ids) {
      try {
        const r = await ethCall(rpcUrl, registry, OWNER_OF + encUint(id));
        const o = '0x' + r.slice(26);
        if (o !== '0x0000000000000000000000000000000000000000') existing.push(id);
      } catch {}
    }
    return existing;
  }

  const existing = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].result) {
      const owner = '0x' + results[i].result.slice(26);
      if (owner !== '0x0000000000000000000000000000000000000000') {
        existing.push(ids[i]);
      }
    }
  }
  return existing;
}

async function enumerateChain(chainKey, config, checkpoint) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${config.name} — ERC-8004 Registry Enumeration`);
  console.log(`${'='.repeat(60)}\n`);
  console.log(`  Credits used so far: ${creditsUsed.toLocaleString()} / ${MAX_CREDITS.toLocaleString()}`);

  let maxToken = checkpoint?.maxToken || 0;
  let existingIds = checkpoint?.existingIds || [];
  let agents = checkpoint?.agents || [];
  let ownerScanDone = checkpoint?.ownerScanDone || false;
  let metaScanFrom = checkpoint?.metaScanFrom || 0;

  // Step 1: Find max token
  if (maxToken === 0) {
    console.log('\nFinding max token ID...');
    maxToken = await findMaxToken(config.rpc, config.registry);
    console.log(`Max token ID: ${maxToken}`);
    if (maxToken === 0) {
      console.log('No tokens found.');
      return [];
    }
    saveCheckpoint({ chain: chainKey, maxToken, existingIds: [], agents: [], ownerScanDone: false, metaScanFrom: 0 });
  }

  // Step 2: Enumerate existing token IDs (batched ownerOf)
  if (!ownerScanDone) {
    console.log(`\nScanning ${maxToken} token IDs for existence...`);
    const BATCH = 20; // Conservative batch size
    const startFrom = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

    for (let start = startFrom; start <= maxToken; start += BATCH) {
      const end = Math.min(start + BATCH - 1, maxToken);
      const ids = [];
      for (let i = start; i <= end; i++) ids.push(i);

      try {
        const found = await batchOwnerCheck(config.rpc, config.registry, ids);
        existingIds.push(...found);
      } catch (e) {
        if (e.message.includes('BUDGET_EXCEEDED')) {
          console.log(`\n\n  Budget limit reached at token ${start}. Saving checkpoint.`);
          saveCheckpoint({ chain: chainKey, maxToken, existingIds, agents, ownerScanDone: false, metaScanFrom: 0 });
          return agents;
        }
        console.log(`\n  Error at batch ${start}: ${e.message}. Waiting 3s...`);
        await sleep(3000);
        start -= BATCH; // retry
        continue;
      }

      if (start % 200 === 1 || end >= maxToken) {
        process.stdout.write(`  [${end}/${maxToken}] ${existingIds.length} tokens found | ${creditsUsed.toLocaleString()} credits\r`);
      }

      await sleep(250); // ~4 batches/sec = ~80 calls/sec budget = 6400 credits/sec — wait, that's too fast
      // With BATCH=20, each batch = 20*80 = 1600 credits
      // At 400 credits/sec, we need 4 sec between batches of 20
      // rateLimitedCall handles this, but let's add extra safety
    }

    ownerScanDone = true;
    console.log(`\n  Token scan complete: ${existingIds.length} tokens exist out of ${maxToken} max ID`);
    saveCheckpoint({ chain: chainKey, maxToken, existingIds, agents, ownerScanDone: true, metaScanFrom: 0 });
  }

  // Step 3: Fetch metadata for existing tokens
  console.log(`\nFetching metadata for ${existingIds.length} tokens (starting from index ${metaScanFrom})...`);
  let withName = 0, withEthSol = 0, withX402 = 0, withWallet = 0;
  let errors = 0;

  // Count existing stats
  for (const a of agents) {
    if (a.name) withName++;
    if (a.hasEth || a.hasSol) withEthSol++;
    if (a.x402Support) withX402++;
    if (a.walletAddress) withWallet++;
  }

  for (let i = metaScanFrom; i < existingIds.length; i++) {
    const tokenId = existingIds[i];

    try {
      const meta = await getMetadata(config.rpc, config.registry, tokenId);
      if (!meta) { errors++; continue; }

      const agent = extractAgentData(tokenId, chainKey, meta);
      agents.push(agent);

      if (agent.name) withName++;
      if (agent.hasEth || agent.hasSol) {
        withEthSol++;
        console.log(`\n  ★ #${tokenId}: ${agent.name || 'unnamed'} ${agent.ethName || ''} ${agent.solName || ''} ${agent.x402Support ? '[x402]' : ''}`);
      }
      if (agent.x402Support) withX402++;
      if (agent.walletAddress) withWallet++;
    } catch (e) {
      if (e.message.includes('BUDGET_EXCEEDED')) {
        console.log(`\n\n  Budget limit reached at token index ${i}. Saving checkpoint.`);
        saveCheckpoint({ chain: chainKey, maxToken, existingIds, agents, ownerScanDone: true, metaScanFrom: i });
        break;
      }
      errors++;
    }

    if ((i + 1) % 50 === 0 || i === existingIds.length - 1) {
      process.stdout.write(`  [${i + 1}/${existingIds.length}] meta: ${agents.length} ok, ${errors} err | .eth/.sol: ${withEthSol} | credits: ${creditsUsed.toLocaleString()}\r`);

      // Checkpoint every 200 tokens
      if ((i + 1) % 200 === 0) {
        saveCheckpoint({ chain: chainKey, maxToken, existingIds, agents, ownerScanDone: true, metaScanFrom: i + 1 });
      }
    }

    await sleep(300); // Extra throttle for metadata (includes URI fetch)
  }

  console.log(`\n\n  ${config.name} Summary:`);
  console.log(`  Max token ID: ${maxToken}`);
  console.log(`  Tokens exist: ${existingIds.length}`);
  console.log(`  Metadata fetched: ${agents.length}`);
  console.log(`  With name: ${withName}`);
  console.log(`  With .eth/.sol: ${withEthSol}`);
  console.log(`  With x402Support: ${withX402}`);
  console.log(`  With agentWallet: ${withWallet}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Credits used: ${creditsUsed.toLocaleString()}`);

  return agents;
}

async function main() {
  const args = process.argv.slice(2);
  const baseOnly = args.includes('--base-only');
  const ethOnly = args.includes('--eth-only');
  const resume = args.includes('--resume');

  console.log('=== ERC-8004 Full Registry Enumeration (Infura) ===');
  console.log(`Budget: ${MAX_CREDITS.toLocaleString()} credits (eth_call = ${CREDIT_PER_CALL} credits each)`);
  console.log(`Throttle: ${MAX_CREDITS_PER_SEC} credits/sec`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const allAgents = {};

  // Load checkpoint if resuming
  let checkpoint = null;
  if (resume) {
    checkpoint = loadCheckpoint();
    if (checkpoint) {
      console.log(`Resuming from checkpoint: chain=${checkpoint.chain}, ` +
        `${checkpoint.existingIds?.length || 0} tokens found, ` +
        `${checkpoint.agents?.length || 0} metadata fetched`);
    }
  }

  // Base (smaller — ~1,000 tokens)
  if (!ethOnly) {
    try {
      const cp = (resume && checkpoint?.chain === 'base') ? checkpoint : null;
      allAgents.base = await enumerateChain('base', CHAINS.base, cp);
    } catch (e) {
      console.error(`\nBase error: ${e.message}`);
      allAgents.base = [];
    }
  }

  // Ethereum mainnet (larger — ~25,500 tokens)
  if (!baseOnly) {
    try {
      const cp = (resume && checkpoint?.chain === 'ethereum') ? checkpoint : null;
      allAgents.ethereum = await enumerateChain('ethereum', CHAINS.ethereum, cp);
    } catch (e) {
      console.error(`\nEthereum error: ${e.message}`);
      allAgents.ethereum = [];
    }
  }

  // Save results
  writeFileSync(OUTPUT_FILE, JSON.stringify(allAgents, null, 2));
  console.log(`\nResults saved to ${OUTPUT_FILE}`);

  // Summary: agents with .eth/.sol names
  console.log('\n=== Agents with .eth/.sol Names ===');
  for (const [chain, agents] of Object.entries(allAgents)) {
    const named = (agents || []).filter(a => a.hasEth || a.hasSol);
    console.log(`\n${chain}: ${named.length} agents with blockchain names (out of ${agents?.length || 0} total)`);
    for (const a of named.slice(0, 80)) {
      console.log(`  #${a.tokenId}: ${a.name || 'unnamed'} — ${a.ethName || ''} ${a.solName || ''} ${a.x402Support ? '[x402]' : ''} ${a.walletAddress ? '[wallet]' : ''}`);
    }
    if (named.length > 80) console.log(`  ... and ${named.length - 80} more`);
  }

  // Cross-reference
  const all = [...(allAgents.base || []), ...(allAgents.ethereum || [])];
  const allNamed = all.filter(a => a.hasEth || a.hasSol);
  const withX402 = allNamed.filter(a => a.x402Support);
  const withWallet = allNamed.filter(a => a.walletAddress);

  console.log('\n=== Cross-Reference Summary ===');
  console.log(`Total agents scanned: ${all.length}`);
  console.log(`Total with .eth/.sol names: ${allNamed.length}`);
  console.log(`  + x402Support enabled: ${withX402.length}`);
  console.log(`  + agentWallet registered: ${withWallet.length}`);
  console.log(`  Both x402 + wallet: ${allNamed.filter(a => a.x402Support && a.walletAddress).length}`);
  console.log(`\nTotal Infura credits consumed: ${creditsUsed.toLocaleString()}`);
  console.log(`Completed: ${new Date().toISOString()}`);
}

main().catch(e => console.error('Fatal:', e));
