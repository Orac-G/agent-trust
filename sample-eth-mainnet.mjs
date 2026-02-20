#!/usr/bin/env node
/**
 * Strategic sample of Ethereum mainnet ERC-8004 registry via Infura
 * Instead of enumerating all 25,500+, sample ~200 across the ID range
 * to understand the distribution: who registered, metadata patterns,
 * .eth/.sol names, x402 support, wallets.
 *
 * Credit budget: ~500K (well under remaining 1M of 2.5M total)
 */

import https from 'https';

const INFURA_KEY = 'e4bc08b946d54b8c9144800c1eb3b454';
const RPC = `https://mainnet.infura.io/v3/${INFURA_KEY}`;
const REG = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

const OWNER_OF = '0x6352211e';
const TOKEN_URI = '0xc87b56dd';

let credits = 0;
const CREDIT_PER_CALL = 80;

function encUint(n) { return n.toString(16).padStart(64, '0'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function rpcCall(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const parsed = new URL(RPC);
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
        catch (e) { reject(new Error('parse: ' + data.substring(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

async function ethCall(to, data) {
  credits += CREDIT_PER_CALL;
  const r = await rpcCall({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
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
    try {
      const req = https.get(url, { headers: { Accept: 'application/json' }, timeout }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchJSON(res.headers.location, timeout).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON')); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    } catch (e) { reject(e); }
  });
}

async function getMetadata(tokenId) {
  const uriResult = await ethCall(REG, TOKEN_URI + encUint(tokenId));
  const uri = decodeString(uriResult);
  if (!uri) return null;

  if (uri.startsWith('data:')) return parseDataURI(uri);
  if (uri.startsWith('http')) {
    try { return await fetchJSON(uri); }
    catch { return { _uri: uri.substring(0, 200) }; }
  }
  if (uri.startsWith('ipfs:')) {
    const hash = uri.replace('ipfs://', '');
    try { return await fetchJSON('https://ipfs.io/ipfs/' + hash); }
    catch { return { _uri: uri }; }
  }
  return { _uri: uri.substring(0, 200) };
}

async function main() {
  console.log('=== Ethereum Mainnet ERC-8004 Strategic Sample ===\n');

  // We know max is ~25,507 from previous probe. Sample strategically.
  // Take 200 samples spread across the range, plus denser sampling at boundaries.
  const samples = new Set();

  // First 20 tokens (to see earliest registrations)
  for (let i = 1; i <= 20; i++) samples.add(i);

  // Every 100th from 100 to 1000
  for (let i = 100; i <= 1000; i += 100) samples.add(i);

  // Every 500th from 1000 to 5000
  for (let i = 1000; i <= 5000; i += 500) samples.add(i);

  // Every 1000th from 5000 to 25000
  for (let i = 5000; i <= 25000; i += 1000) samples.add(i);

  // Dense sample at the end (most recent registrations)
  for (let i = 25000; i <= 25510; i += 10) samples.add(i);

  // Some random mid-range
  for (const id of [42, 69, 100, 256, 420, 777, 888, 1337, 2048, 3000, 4200, 6588, 8004, 10000, 12500, 15000, 17500, 20000, 22500]) {
    samples.add(id);
  }

  const sortedSamples = [...samples].sort((a, b) => a - b);
  console.log('Sampling ' + sortedSamples.length + ' token IDs\n');

  // Check which exist
  const stats = {
    exist: 0, named: 0, olas: 0, nonOlas: 0,
    realEth: 0, realSol: 0, x402: 0, wallet: 0, services: 0, unreachable: 0
  };
  const interesting = [];
  const nonOlasList = [];

  for (const id of sortedSamples) {
    // Check owner first
    try {
      const ownerResult = await ethCall(REG, OWNER_OF + encUint(id));
      const owner = '0x' + ownerResult.slice(26);
      if (owner === '0x0000000000000000000000000000000000000000') {
        continue;
      }
    } catch {
      continue;
    }

    stats.exist++;

    // Fetch metadata
    try {
      const meta = await getMetadata(id);
      if (!meta) continue;

      if (meta._uri) {
        stats.unreachable++;
        continue;
      }

      const fullText = JSON.stringify(meta).toLowerCase();
      const name = meta.name || 'unnamed';
      const isOlas = name.includes('by Olas') || name.includes('Olas');
      const hasEth = fullText.includes('.eth');
      const hasSol = fullText.includes('.sol');

      // Filter out false .eth (eips.eth from ERC-8004 type URL)
      const realEth = hasEth && !fullText.match(/eips\.eth/);
      const realSol = hasSol;
      const hasX402 = meta.x402Support === true;
      const wallet = (meta.services || []).find(s => s.name === 'agentWallet');
      const hasServices = (meta.services || []).length > 0;

      if (meta.name) stats.named++;
      if (isOlas) stats.olas++;
      else stats.nonOlas++;
      if (realEth) stats.realEth++;
      if (realSol) stats.realSol++;
      if (hasX402) stats.x402++;
      if (wallet) stats.wallet++;
      if (hasServices) stats.services++;

      const flags = [];
      if (realEth) flags.push('.eth');
      if (realSol) flags.push('.sol');
      if (hasX402) flags.push('x402');
      if (wallet) flags.push('wallet');

      if (!isOlas) {
        nonOlasList.push({ id, name, desc: (meta.description || '').substring(0, 150), flags, services: meta.services || [] });
        console.log('  #' + id + ': ' + name + (flags.length ? ' [' + flags.join(', ') + ']' : ''));
        if (meta.description) console.log('    ' + (meta.description || '').substring(0, 120));
        if (meta.services?.length) {
          for (const s of meta.services.slice(0, 3)) {
            console.log('    ' + (s.name || s.type || 'svc') + ': ' + (s.endpoint || s.url || '').substring(0, 80));
          }
        }
      } else if (flags.length || id <= 10) {
        process.stdout.write('  #' + id + ': ' + name.substring(0, 40) + ' (Olas)' + (flags.length ? ' ' + flags.join(',') : '') + '\n');
      }

      if (realEth || realSol || hasX402 || wallet) {
        interesting.push({ id, name, realEth, realSol, hasX402, wallet: wallet?.endpoint, isOlas });
      }
    } catch (e) {
      // token exists but metadata fetch failed
    }

    // Rate limit: ~3 calls per sample (ownerOf + tokenURI + maybe external fetch)
    // At 80 credits each, ~240 credits per sample
    // Budget allows ~2000 samples at 500K credits
    await sleep(400);

    if (credits % 10000 < 500) {
      process.stdout.write('  ... ' + credits.toLocaleString() + ' credits used\r');
    }
  }

  console.log('\n\n=== Ethereum Mainnet Sample Results ===');
  console.log('Tokens sampled: ' + sortedSamples.length);
  console.log('Tokens exist: ' + stats.exist);
  console.log('With metadata: ' + stats.named);
  console.log('Olas agents: ' + stats.olas + ' (' + (stats.exist > 0 ? (stats.olas / stats.exist * 100).toFixed(1) : 0) + '%)');
  console.log('Non-Olas: ' + stats.nonOlas);
  console.log('Real .eth names: ' + stats.realEth);
  console.log('Real .sol names: ' + stats.realSol);
  console.log('x402Support: ' + stats.x402);
  console.log('With wallet: ' + stats.wallet);
  console.log('With services: ' + stats.services);
  console.log('URI unreachable: ' + stats.unreachable);
  console.log('Credits used: ' + credits.toLocaleString());

  if (nonOlasList.length > 0) {
    console.log('\n=== All Non-Olas Agents Found ===');
    for (const a of nonOlasList) {
      console.log('  #' + a.id + ': ' + a.name + (a.flags.length ? ' [' + a.flags.join(', ') + ']' : ''));
      if (a.desc) console.log('    ' + a.desc);
    }
  }

  if (interesting.length > 0) {
    console.log('\n=== Commercially Interesting Agents ===');
    for (const a of interesting) {
      console.log('  #' + a.id + ': ' + a.name + (a.isOlas ? ' (Olas)' : ''));
      if (a.realEth) console.log('    .eth name detected');
      if (a.realSol) console.log('    .sol name detected');
      if (a.hasX402) console.log('    x402Support: true');
      if (a.wallet) console.log('    wallet: ' + a.wallet);
    }
  }
}

main().catch(e => console.error('Fatal:', e));
