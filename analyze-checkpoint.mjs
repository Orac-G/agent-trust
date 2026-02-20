#!/usr/bin/env node
import { readFileSync } from 'fs';

const cp = JSON.parse(readFileSync('/workspace/group/agent-trust/8004-checkpoint.json', 'utf8'));
console.log('Chain:', cp.chain);
console.log('Max token:', cp.maxToken);
console.log('Existing IDs:', cp.existingIds?.length);
console.log('Agents with metadata:', cp.agents?.length);
console.log('Meta scan from:', cp.metaScanFrom);

const agents = cp.agents || [];

const withRealEth = agents.filter(a => {
  if (!a.hasEth) return false;
  const ethName = (a.ethName || '').toLowerCase();
  return ethName !== 'eips.eth' && !ethName.includes('eips');
});
const withRealSol = agents.filter(a => a.hasSol && a.solName && !a.solName.includes('eips'));
const withX402 = agents.filter(a => a.x402Support);
const withWallet = agents.filter(a => a.walletAddress);
const withServices = agents.filter(a => a.services && a.services.length > 0);
const named = agents.filter(a => a.name);
const olas = agents.filter(a => (a.name || '').includes('by Olas'));

console.log('\n=== Analysis ===');
console.log('Total metadata:', agents.length);
console.log('Named:', named.length);
console.log('Olas Protocol agents:', olas.length);
console.log('Non-Olas agents:', named.length - olas.length);
console.log('With REAL .eth (excl eips.eth):', withRealEth.length);
console.log('With .sol:', withRealSol.length);
console.log('With x402Support:', withX402.length);
console.log('With agentWallet:', withWallet.length);
console.log('With services:', withServices.length);

const nonOlas = agents.filter(a => a.name && !(a.name || '').includes('by Olas'));
console.log('\n=== Non-Olas Agents (' + nonOlas.length + ' total) ===');
for (const a of nonOlas.slice(0, 30)) {
  const flags = [];
  if (a.x402Support) flags.push('x402');
  if (a.walletAddress) flags.push('wallet');
  console.log('  #' + a.tokenId + ': ' + a.name + (flags.length ? ' [' + flags.join(', ') + ']' : ''));
  if (a.description) console.log('    ' + a.description.substring(0, 120));
  if (a.services?.length) {
    for (const s of a.services.slice(0, 2)) {
      console.log('    ' + s.name + ': ' + s.endpoint);
    }
  }
}

if (withRealEth.length > 0) {
  console.log('\n=== Agents with real .eth names ===');
  for (const a of withRealEth) {
    console.log('  #' + a.tokenId + ': ' + a.name + ' — ' + a.ethName);
  }
}

if (withX402.length > 0) {
  console.log('\n=== Agents with x402Support ===');
  for (const a of withX402) {
    console.log('  #' + a.tokenId + ': ' + a.name);
  }
}

if (withWallet.length > 0) {
  console.log('\n=== Agents with wallets (first 20) ===');
  for (const a of withWallet.slice(0, 20)) {
    console.log('  #' + a.tokenId + ': ' + a.name + ' -> ' + a.walletAddress);
  }
}

if (olas.length > 0) {
  console.log('\n=== Sample Olas agent ===');
  const sample = olas[0];
  console.log('  Name: ' + sample.name);
  console.log('  Description: ' + (sample.description || '').substring(0, 150));
  console.log('  Services: ' + (sample.services?.length || 0));
  if (sample.services?.length) {
    for (const s of sample.services) {
      console.log('    ' + s.name + ': ' + (s.endpoint || '').substring(0, 80));
    }
  }
}

const olasIds = olas.map(a => a.tokenId);
if (olasIds.length > 0) {
  console.log('\nOlas ID range: ' + Math.min(...olasIds) + ' to ' + Math.max(...olasIds));
  console.log('Olas density: ' + (olas.length / agents.length * 100).toFixed(1) + '%');
}
