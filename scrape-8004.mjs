#!/usr/bin/env node
/**
 * Scrape ERC-8004 Identity Registry on Base for agents with .eth/.sol names
 * Cross-reference with x402 transaction history (USDC TransferWithAuthorization)
 *
 * Phase 1: Probe the registry — how many agents? what does the data look like?
 */

import https from 'https';

const BASE_RPC = 'https://mainnet.base.org';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ERC-721 function signatures
const TOTAL_SUPPLY_SIG = '0x18160ddd'; // totalSupply()
const TOKEN_BY_INDEX_SIG = '0x4f6ccce7'; // tokenByIndex(uint256)
const TOKEN_URI_SIG = '0xc87b56dd'; // tokenURI(uint256)
const OWNER_OF_SIG = '0x6352211e'; // ownerOf(uint256)
// ERC-8004 specific
const GET_AGENT_WALLET_SIG = '0x'; // need to compute this
const GET_METADATA_SIG = '0x'; // need to compute this

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

function decodeUint256(hex) {
  return parseInt(hex, 16);
}

function decodeString(hex) {
  // ABI-encoded string: offset (32 bytes) + length (32 bytes) + data
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 128) return ''; // too short for a string
  const offset = parseInt(clean.slice(0, 64), 16) * 2;
  const length = parseInt(clean.slice(offset, offset + 64), 16);
  const strHex = clean.slice(offset + 64, offset + 64 + length * 2);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

function decodeAddress(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return '0x' + clean.slice(24, 64);
}

// keccak256 for function selectors — use eth_call with a trivial contract
// Actually, let's just hardcode the ones we need
// getAgentWallet(uint256) = keccak256("getAgentWallet(uint256)")
// We'll compute it

function keccak256Selector(sig) {
  // Use the RPC to help us, or just hardcode known selectors
  // For now, let's try common approaches
}

async function main() {
  console.log('=== ERC-8004 Identity Registry Probe ===\n');
  console.log(`Registry: ${IDENTITY_REGISTRY}`);
  console.log(`Chain: Base mainnet (eip155:8453)\n`);

  // 1. Check totalSupply
  console.log('Checking totalSupply...');
  try {
    const result = await ethCall(IDENTITY_REGISTRY, TOTAL_SUPPLY_SIG);
    const total = decodeUint256(result.slice(2));
    console.log(`Total registered agents: ${total}\n`);

    if (total === 0) {
      console.log('No agents registered. Registry might be different address or not enumerable.');
      return;
    }

    // 2. Sample first few tokens
    const sampleSize = Math.min(5, total);
    console.log(`Sampling first ${sampleSize} agents...\n`);

    for (let i = 0; i < sampleSize; i++) {
      console.log(`--- Agent index ${i} ---`);

      // tokenByIndex(i)
      try {
        const tokenIdResult = await ethCall(IDENTITY_REGISTRY, TOKEN_BY_INDEX_SIG + encodeUint256(i));
        const tokenId = decodeUint256(tokenIdResult.slice(2));
        console.log(`  Token ID: ${tokenId}`);

        // ownerOf(tokenId)
        try {
          const ownerResult = await ethCall(IDENTITY_REGISTRY, OWNER_OF_SIG + encodeUint256(tokenId));
          const owner = decodeAddress(ownerResult);
          console.log(`  Owner: ${owner}`);
        } catch (e) {
          console.log(`  Owner: error - ${e.message}`);
        }

        // tokenURI(tokenId)
        try {
          const uriResult = await ethCall(IDENTITY_REGISTRY, TOKEN_URI_SIG + encodeUint256(tokenId));
          const uri = decodeString(uriResult);
          console.log(`  URI: ${uri}`);

          // Fetch the URI if it's HTTP/IPFS
          if (uri.startsWith('http')) {
            try {
              const metadata = await fetchJSON(uri);
              console.log(`  Name: ${metadata.name || 'N/A'}`);
              console.log(`  Description: ${(metadata.description || 'N/A').substring(0, 100)}`);
              if (metadata.services) {
                console.log(`  Services: ${JSON.stringify(metadata.services.slice(0, 3))}`);
              }
            } catch (e) {
              console.log(`  Metadata fetch failed: ${e.message}`);
            }
          }
        } catch (e) {
          console.log(`  URI: error - ${e.message}`);
        }
      } catch (e) {
        // tokenByIndex not available — try sequential token IDs
        console.log(`  tokenByIndex not available (${e.message}), trying direct ID ${i + 1}...`);

        const tokenId = i + 1;
        try {
          const ownerResult = await ethCall(IDENTITY_REGISTRY, OWNER_OF_SIG + encodeUint256(tokenId));
          const owner = decodeAddress(ownerResult);
          console.log(`  Token ID: ${tokenId}, Owner: ${owner}`);

          const uriResult = await ethCall(IDENTITY_REGISTRY, TOKEN_URI_SIG + encodeUint256(tokenId));
          const uri = decodeString(uriResult);
          console.log(`  URI: ${uri}`);

          if (uri.startsWith('http')) {
            try {
              const metadata = await fetchJSON(uri);
              console.log(`  Name: ${metadata.name || 'N/A'}`);
              console.log(`  Description: ${(metadata.description || 'N/A').substring(0, 100)}`);
              if (metadata.services) {
                console.log(`  Services: ${JSON.stringify(metadata.services.slice(0, 3))}`);
              }
            } catch (e) {
              console.log(`  Metadata fetch failed: ${e.message}`);
            }
          }
        } catch (e2) {
          console.log(`  Direct ID ${tokenId} also failed: ${e2.message}`);
        }
      }
      console.log('');
    }

    // 3. Also check our own token
    console.log('--- Orac (Token #6588) ---');
    try {
      const uriResult = await ethCall(IDENTITY_REGISTRY, TOKEN_URI_SIG + encodeUint256(6588));
      const uri = decodeString(uriResult);
      console.log(`  URI: ${uri}`);
      if (uri.startsWith('http')) {
        const metadata = await fetchJSON(uri);
        console.log(`  Name: ${metadata.name || 'N/A'}`);
        console.log(`  Services: ${JSON.stringify(metadata.services || [])}`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }

  } catch (e) {
    console.log(`totalSupply failed: ${e.message}`);
    console.log('Registry may not implement ERC721Enumerable. Trying direct token IDs...\n');

    // Fallback: try sequential IDs
    for (let id = 1; id <= 10; id++) {
      try {
        const ownerResult = await ethCall(IDENTITY_REGISTRY, OWNER_OF_SIG + encodeUint256(id));
        const owner = decodeAddress(ownerResult);
        const uriResult = await ethCall(IDENTITY_REGISTRY, TOKEN_URI_SIG + encodeUint256(id));
        const uri = decodeString(uriResult);
        console.log(`Token ${id}: owner=${owner}, uri=${uri.substring(0, 80)}`);
      } catch (e) {
        console.log(`Token ${id}: does not exist`);
        break;
      }
    }
  }
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : require('http');
    lib.get(url, { headers: { 'Accept': 'application/json' } }, res => {
      // Follow redirects
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
        catch (e) { reject(new Error(`JSON parse: ${data.substring(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

main().catch(e => console.error('Fatal:', e));
