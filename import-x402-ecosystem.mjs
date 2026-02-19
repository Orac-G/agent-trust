#!/usr/bin/env node
/**
 * Import x402 ecosystem projects into the OKG
 * Source: x402.org/ecosystem (curated by Coinbase x402 repo)
 *
 * Maps each project to an OKG entity with:
 * - entityType based on category
 * - observations from description + URL
 * - relations: active_on x402, uses x402 protocol
 */

import https from 'https';

const OKG_API = 'https://orac-kg.orac.workers.dev';

// Curated from x402.org/ecosystem
const ECOSYSTEM = [
  // === Services/Endpoints ===
  { name: 'ACP - Virtuals Protocol', url: 'https://acp-x402.virtuals.io', desc: 'Pay for ACP jobs with x402 protocol on Virtuals Protocol', cat: 'service' },
  { name: 'BlockRun', url: 'https://blockrun.ai', desc: 'Pay-as-you-go LLM gateway on Base. AI agents pay for intelligence with USDC.', cat: 'service' },
  { name: 'Vishwa', url: 'https://mcp-x402.vishwanet.ai', desc: 'Trust Layer for AI Agent Payments. x402-powered.', cat: 'service' },
  { name: 'AEON', url: 'https://aeon.xyz/AIPayment', desc: 'Omnichain settlement layer enabling AI agents to pay millions of real-world merchants across SEA, LATAM, and Africa via x402 and USDC', cat: 'service' },
  { name: 'Firecrawl', url: 'https://firecrawl.dev', desc: 'Web scraping API that turns websites into LLM-ready data. x402 micropayments.', cat: 'tool' },
  { name: 'Neynar', url: 'https://neynar.com', desc: 'Farcaster social data for agents and humans via x402', cat: 'service' },
  { name: 'Pinata', url: 'https://402.pinata.cloud', desc: 'IPFS uploads and retrievals via x402 crypto payments', cat: 'service' },
  { name: 'Gloria AI', url: 'https://itsgloria.ai', desc: 'Real-time news data for AI agents via x402', cat: 'service' },
  { name: 'Einstein AI', url: 'https://emc2ai.io', desc: 'Blockchain intelligence API for crypto insights via x402', cat: 'service' },
  { name: 'AdEx AURA API', url: 'https://guide.adex.network', desc: 'Portfolio and DeFi data via x402 micropayments', cat: 'service' },
  { name: 'AdPrompt', url: 'https://www.adprompt.ai/x402-api', desc: 'Marketing and advertising APIs with x402 micropayments', cat: 'service' },
  { name: 'Agnic.AI', url: 'https://agnic.ai/x402', desc: 'Identity and x402-powered monetization for AI agents', cat: 'service' },
  { name: 'AiMo Network', url: 'https://aimo.network', desc: 'Permissionless API connecting humans, AI agents, service providers', cat: 'service' },
  { name: 'AIsa', url: 'https://aisa.one', desc: 'Resource marketplace for LLMs and data APIs via x402', cat: 'service' },
  { name: 'AsterPay', url: 'https://asterpay.io', desc: '13 pay-per-call endpoints for market and DeFi data via x402', cat: 'service' },
  { name: 'BlackSwan', url: 'https://blackswan.wtf', desc: 'Real-time risk intelligence for autonomous AI agents', cat: 'service' },
  { name: 'ClawdVine', url: 'https://clawdvine.sh', desc: 'Short-form video network for AI agents via x402', cat: 'platform' },
  { name: 'Cybercentry', url: 'https://cybercentry.gitbook.io', desc: 'AI-powered security endpoints via x402', cat: 'service' },
  { name: 'dTelecom STT', url: 'https://x402stt.dtelecom.org', desc: 'Production-grade real-time speech-to-text for AI agents via x402', cat: 'service' },
  { name: 'Elsa x402', url: 'https://x402.heyelsa.ai', desc: 'DeFi API endpoints with x402 micropayments', cat: 'service' },
  { name: 'Grove API', url: 'https://grove.city/api', desc: 'Unified API for funding and tipping via x402', cat: 'service' },
  { name: 'MerchantGuard', url: 'https://www.merchantguard.ai', desc: 'AI compliance infrastructure with x402-gated APIs', cat: 'service' },
  { name: 'Minifetch', url: 'https://minifetch.com', desc: 'Metadata and content summaries via x402 micropayments', cat: 'service' },
  { name: 'Moltalyzer', url: 'https://moltalyzer.xyz', desc: 'AI intelligence feeds via x402 micropayments', cat: 'service' },
  { name: 'Postera', url: 'https://postera.dev', desc: 'Publishing platform for AI agents with x402 payments', cat: 'platform' },
  { name: 'Proofivy', url: 'https://proofivy.com', desc: 'Attestation and x402 paywalled publishing', cat: 'service' },
  { name: 'Questflow', url: 'https://questflow.ai', desc: 'Orchestration layer for multi-agent economy via x402', cat: 'platform' },
  { name: 'QuickSilver', url: 'https://data.iotex.ai', desc: 'Bridge between physical systems and AI via x402', cat: 'service' },
  { name: 'RelAI', url: 'https://relai.fi', desc: 'Monetize APIs with x402 micropayments. Also operates as facilitator.', cat: 'service' },
  { name: 'Rencom', url: 'https://x402.rencom.ai', desc: 'Search and rank x402 resources by reliability', cat: 'service' },
  { name: 'SerenAI', url: 'https://serendb.com', desc: 'Production payment gateway for database queries via x402', cat: 'service' },
  { name: 'SLAMai', url: 'https://www.slamai.xyz', desc: 'Smart money intelligence platform on Base/Ethereum', cat: 'service' },
  { name: 'Slinky Layer', url: 'https://slinkylayer.ai', desc: 'Open market for APIs with x402 integration', cat: 'platform' },
  { name: 'SocioLogic', url: 'https://www.sociologic.ai/x402-rng', desc: 'Cryptographic randomness via x402', cat: 'service' },
  { name: 'Trusta.AI', url: 'https://app.trustalabs.ai/attest', desc: 'Attestation with x402 API support', cat: 'service' },
  { name: 'x402engine', url: 'https://x402engine.app', desc: '28 pay-per-call APIs for AI agents', cat: 'service' },
  { name: 'Zyte API', url: 'https://python-zyte-api.readthedocs.io', desc: 'Web scraping with x402 integration', cat: 'tool' },
  { name: 'Bonsai', url: 'https://bonsai.art', desc: 'Create, remix, and trade evolving media. AI content generation via smart media protocol.', cat: 'service' },
  { name: 'AurraCloud', url: 'https://aurracloud.com/x402', desc: 'AI agent hosting and tooling platform with MCP, smartWallets, OpenAI API compatibility and x402 support', cat: 'platform' },

  // === Infrastructure & Tooling ===
  { name: '1Shot API', url: 'https://docs.1shotapi.com', desc: 'General purpose facilitator to monetize any n8n workflow with ERC-20 tokens', cat: 'tool' },
  { name: 'Daydreams Router', url: 'https://router.daydreams.systems', desc: 'x402-enabled LLM inference for agents and applications. Build nanoservices.', cat: 'tool' },
  { name: 'Faremeter', url: 'https://faremeter.xyz', desc: 'Lightweight OSS x402 framework with client, middleware, and server-side plugins', cat: 'tool' },
  { name: 'Fluora', url: 'https://www.fluora.ai', desc: 'MonetizedMCP marketplace enabling AI agents to autonomously find and purchase services', cat: 'platform' },
  { name: 'Foldset', url: 'https://foldset.com', desc: 'Gate APIs and MCPs behind x402 paywalls', cat: 'tool' },
  { name: 'Heurist Mesh', url: 'https://mesh.heurist.ai', desc: 'Composable crypto skills for AI agents via x402', cat: 'tool' },
  { name: 'Kobaru', url: 'https://www.kobaru.io', desc: 'Transparent proxy layer for API paywalls and x402 facilitation', cat: 'tool' },
  { name: 'Latinum', url: 'https://latinum.ai', desc: 'Open-source MCP wallet and facilitator for agentic commerce', cat: 'tool' },
  { name: 'Locus', url: 'https://paywithlocus.com', desc: 'MCP wallet with agent spending controls and x402 integration', cat: 'tool' },
  { name: 'MCPay', url: 'https://mcpay.tech', desc: 'Build and monetize MCP servers with x402', cat: 'tool' },
  { name: 'Proxy402', url: 'https://proxy402.com', desc: 'Turn any URL into paid content via x402', cat: 'tool' },
  { name: 'enrichx402', url: 'https://enrichx402.com', desc: 'Access Apollo, Clado, Exa, Firecrawl, Google Maps, Grok, Serper, and more via x402', cat: 'service' },
  { name: 'x402scan', url: 'https://x402scan.com', desc: 'x402 ecosystem explorer and analytics. Tracks transactions, servers, and agent activity.', cat: 'tool' },
  { name: 'zkStash', url: 'https://zkstash.ai', desc: 'Shared memory layer for the agentic economy', cat: 'tool' },
  { name: 'Agently', url: 'https://agently.to', desc: 'Routing and settlement for agentic commerce', cat: 'tool' },
  { name: 'ampersend', url: 'https://ampersend.ai', desc: 'Agent wallet and payment management platform', cat: 'tool' },

  // === Facilitators ===
  { name: 'CDP Facilitator', url: 'https://docs.cdp.coinbase.com/x402', desc: 'Coinbase Developer Platform x402 facilitator. Best-in-class, fee-free USDC settlement on Base.', cat: 'tool' },
  { name: 'Dexter', url: 'https://dexter.cash', desc: 'x402 facilitator for Solana and Base. Cross-chain payment bridging. Largest daily facilitator by volume.', cat: 'tool' },
  { name: 'Corbits', url: 'https://corbits.dev', desc: 'Production grade facilitator supporting multi-network, multi-token, multi-payment schemes', cat: 'tool' },
  { name: 'PayAI', url: 'https://payai.io', desc: 'Multi-network x402 facilitator for AI agents. 10M+ transactions processed.', cat: 'tool' },
  { name: 'OpenFacilitator', url: 'https://www.openfacilitator.io', desc: 'Free, open-source x402 facilitator', cat: 'tool' },

  // === Client-Side ===
  { name: 'Oops402', url: 'https://oops402.com', desc: 'Brings x402 to ChatGPT and Claude via MCP', cat: 'tool' },
  { name: 'Primer', url: 'https://primer.systems', desc: 'Browser wallet and SDKs for x402 payments. Also operates as facilitator.', cat: 'tool' },
  { name: 'Tweazy', url: 'https://github.com/aaronjmars/tweazy', desc: 'Read tweets onchain via x402 and MCP', cat: 'tool' },
  { name: 'Nuwa AI', url: 'https://nuwa.dev', desc: 'User-friendly AI client connecting to x402 services', cat: 'tool' },

  // === Agents/Platforms ===
  { name: 'ClawNews', url: 'https://clawnews.io', desc: 'Hacker News for AI agents — built by agents, for agents. ERC-8004 registered (Agent #1 on Base).', cat: 'platform' },
  { name: 'Sniper (x402)', url: 'https://sniper.bot', desc: 'SmartTrader — AI trading activity and analysis via x402', cat: 'agent' },
  { name: 'Otto AI', url: 'https://docs.ottowallet.xyz', desc: 'Crypto intelligence swarm for agents via USDC x402 payments', cat: 'agent' },
  { name: 'Imference', url: 'https://imference.com', desc: 'High-performance image generation API with x402', cat: 'service' },
  { name: 'Genbase', url: 'https://genbase.fun', desc: 'AI video platform with x402 integration', cat: 'service' },
  { name: 'Kodo', url: 'https://www.kodo.fun', desc: 'AI creative toolkit for images and videos with x402', cat: 'service' },
  { name: 'AI Frens', url: 'https://aifrens.lol', desc: 'AI character tokens with x402-compatible services by Treasure', cat: 'agent' },
];

function post(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = JSON.stringify(body);
    const lib = parsed.protocol === 'https:' ? https : require('http');
    const req = lib.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const TYPE_MAP = {
  service: 'tool',       // x402 services are tools in OKG
  tool: 'tool',
  platform: 'platform',
  agent: 'agent',
};

async function main() {
  console.log(`=== Importing ${ECOSYSTEM.length} x402 ecosystem projects into OKG ===\n`);

  let created = 0, updated = 0, skipped = 0, errored = 0;

  for (const project of ECOSYSTEM) {
    const entityType = TYPE_MAP[project.cat] || 'tool';
    const observations = [
      project.desc,
      `URL: ${project.url}`,
      'Part of the x402 ecosystem (registered at x402.org)',
    ];

    // Try to create entity
    const createResult = await post(`${OKG_API}/entity`, {
      name: project.name,
      entityType,
      observations,
    });

    if (createResult.status === 201) {
      created++;
      process.stdout.write(`  + ${project.name} (${entityType})\n`);

      // Add relation to x402 protocol
      await post(`${OKG_API}/relation`, {
        source: project.name,
        relation: 'uses',
        target: 'x402',
      });

      // Small delay to avoid rate limiting
      await sleep(200);
    } else if (createResult.status === 409) {
      // Already exists — add the x402 ecosystem observation
      const addResult = await post(`${OKG_API}/observation`, {
        name: project.name,
        observation: `Part of the x402 ecosystem (registered at x402.org). URL: ${project.url}`,
      });

      if (addResult.status === 200) {
        updated++;
        process.stdout.write(`  ~ ${project.name} (updated)\n`);
      } else {
        skipped++;
        process.stdout.write(`  - ${project.name} (already exists, no update needed)\n`);
      }
      await sleep(100);
    } else if (createResult.status === 429) {
      console.log(`  RATE LIMITED — waiting 60s...`);
      await sleep(60000);
      // Retry
      const retry = await post(`${OKG_API}/entity`, { name: project.name, entityType, observations });
      if (retry.status === 201) {
        created++;
        process.stdout.write(`  + ${project.name} (retry ok)\n`);
      } else {
        errored++;
        process.stdout.write(`  ! ${project.name} (retry failed: ${retry.status})\n`);
      }
    } else {
      errored++;
      process.stdout.write(`  ! ${project.name} (${createResult.status}: ${createResult.body.substring(0, 80)})\n`);
    }
  }

  console.log(`\n=== Import Complete ===`);
  console.log(`Created: ${created}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors:  ${errored}`);
  console.log(`Total:   ${ECOSYSTEM.length}`);
}

main().catch(e => console.error('Fatal:', e));
