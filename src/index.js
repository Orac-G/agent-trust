/**
 * Orac Agent Trust — Cloudflare Worker
 * Trust scoring service for the agentic economy
 *
 * Endpoints:
 *   POST /v1/score  — Comprehensive trust assessment ($0.01 USDC)
 *   GET  /          — Service info + API docs
 *   GET  /health    — Health check
 *
 * Payment: USDC on Base (EVM) and Solana (SVM), x402 protocol
 * Data: Reads directly from OKG KV store (shared namespace)
 * Revenue: orac.eth / orac.sol
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const ORAC_EVM_WALLET = '0x4a47B25c90eA79e32b043d9eE282826587187ca5';
const ORAC_SOL_WALLET = '3vD1Rt5qMz4vZR8jGND8n9YnVNvPBvX8tyTrWzZ3TMSb';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEXTER_SOL_FEE_PAYER = 'DEXVS3su4dZQWTvvPnLDJLRK1CeeKG6K3QqdzthgAkNV';
const FACILITATOR_URL = 'https://pay.openfacilitator.io';

const PRICE = 10000; // $0.01 USDC (6 decimals)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Payment-Signature, X-Payment',
};

// ─── Trust Computation ───────────────────────────────────────────────────────

// Relation types that imply trust (must match OKG worker)
const TRUST_RELATION_TYPES = new Set([
  'trusts', 'endorsed_by', 'verified_by', 'collaborates_with',
  'depends_on', 'implements', 'built', 'uses'
]);

const TRUST_WEIGHTS = {
  trusts: 1.0,
  endorsed_by: 0.9,
  verified_by: 0.9,
  collaborates_with: 0.7,
  depends_on: 0.6,
  implements: 0.6,
  built: 0.8,
  uses: 0.5
};

/**
 * Compute PageRank reputation scores for all entities.
 * Returns { entityName: normalizedScore } in 0-1 range.
 */
function computePageRank(graph, iterations = 50, damping = 0.85, tolerance = 0.001) {
  const names = graph.entities.map(e => e.name);
  if (names.length === 0) return {};

  const scores = {};
  for (const name of names) scores[name] = 1.0;

  const outDegree = {};
  const inEdges = {};
  for (const name of names) { outDegree[name] = 0; inEdges[name] = []; }

  for (const rel of graph.relations) {
    if (!TRUST_RELATION_TYPES.has(rel.relation)) continue;
    if (!scores.hasOwnProperty(rel.source) || !scores.hasOwnProperty(rel.target)) continue;
    const weight = TRUST_WEIGHTS[rel.relation] || 0.5;
    outDegree[rel.source]++;
    inEdges[rel.target].push({ from: rel.source, weight });
  }

  for (let iter = 0; iter < iterations; iter++) {
    const newScores = {};
    let maxChange = 0;
    for (const name of names) {
      let sum = 0;
      for (const edge of inEdges[name]) {
        const deg = outDegree[edge.from] || 1;
        sum += (scores[edge.from] / deg) * edge.weight;
      }
      newScores[name] = (1 - damping) + damping * sum;
      maxChange = Math.max(maxChange, Math.abs(newScores[name] - (scores[name] || 1.0)));
    }
    Object.assign(scores, newScores);
    if (maxChange < tolerance) break;
  }

  // Normalize to 0-1 range
  const values = Object.values(scores);
  const minScore = Math.min(...values);
  const maxScore = Math.max(...values);
  const range = maxScore - minScore;

  if (range < 0.0001) {
    for (const name of names) scores[name] = 0.5;
  } else {
    for (const name of names) {
      scores[name] = parseFloat(((scores[name] - minScore) / range).toFixed(4));
    }
  }
  return scores;
}

/**
 * Get cached trust scores or compute fresh.
 * Cache TTL: 8 hours.
 */
async function getOrComputeTrustScores(env, graph) {
  const CACHE_KEY = 'trust_scores_v1';
  try {
    const cached = await env.KG_STORE.get(CACHE_KEY, 'json');
    if (cached) return cached;
  } catch {}

  const scores = computePageRank(graph);

  try {
    await env.KG_STORE.put(CACHE_KEY, JSON.stringify(scores), { expirationTtl: 8 * 60 * 60 });
  } catch {}

  return scores;
}

/**
 * Compute composite trust score for an entity.
 *
 * Components (weights sum to 1.0):
 *   - pagerank:        0.25 — Graph-based reputation from trust relations
 *   - observations:    0.15 — Observation density (more data = more known)
 *   - age:             0.15 — How long the entity has existed in the graph
 *   - wallet_activity: 0.20 — On-chain economic activity (funded wallet, tx count)
 *   - attestations:    0.10 — Cryptographic attestation signals
 *   - relations:       0.10 — Connectedness in the graph
 *   - safety:          0.05 — Context safety screening (if context provided)
 */
function computeTrustScore(entity, graph, pagerankScores, safetyResult) {
  const now = new Date();

  // 1. PageRank reputation (0-1, already normalized)
  const pagerank = pagerankScores[entity.name] !== undefined ? pagerankScores[entity.name] : 0;

  // 2. Observation density — sigmoid-scaled, 10 observations ≈ 0.8
  const activeObs = (entity.observations || []).filter(o => {
    if (!o.expires_at) return true;
    return new Date(o.expires_at) > now;
  });
  const obsCount = activeObs.length;
  const observationScore = 1 - Math.exp(-obsCount / 8);

  // 3. Age factor — how long in graph, sigmoid-scaled, 30 days ≈ 0.8
  const created = entity.created ? new Date(entity.created) : now;
  const ageDays = Math.max(0, (now - created) / (1000 * 60 * 60 * 24));
  const ageScore = 1 - Math.exp(-ageDays / 25);

  // 4. Wallet activity — on-chain economic signals from observations
  //    Looks for wallet activity observations written by wallet-activity-scanner.
  //    tx count: sigmoid-scaled, 50 txns ≈ 0.75. Balance presence adds 0.2 base.
  let walletScore = 0;
  const obsTexts = activeObs.map(o => (typeof o === 'object' ? o.text || o.observation || '' : String(o)));
  const txObs = obsTexts.find(t => t.includes('on-chain activity:') && t.includes('transactions'));
  const balObs = obsTexts.find(t => t.includes('on-chain') && (t.includes('ETH balance') || t.includes('USDC balance')));
  const firstTxObs = obsTexts.find(t => t.includes('first on-chain transaction:'));

  if (txObs) {
    const m = txObs.match(/(\d+) transactions/);
    const txCount = m ? parseInt(m[1]) : 0;
    walletScore += (1 - Math.exp(-txCount / 50)) * 0.7; // up to 0.70 for tx count
  }
  if (balObs) {
    walletScore += 0.15; // funded wallet present
  }
  if (firstTxObs) {
    // On-chain age bonus — older wallets get extra signal
    const m = firstTxObs.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const firstTxDays = Math.max(0, (now - new Date(m[1])) / (1000 * 60 * 60 * 24));
      walletScore += Math.min(0.15, firstTxDays / 730); // up to 0.15 for 2yr+ old wallet
    }
  }
  walletScore = Math.min(1, walletScore);

  // 5. Attestation factor — presence of signed observations
  const signedObs = (entity.observations || []).filter(o =>
    o.signature && o.signature.signature_hex
  ).length;
  const attestationScore = signedObs > 0 ? Math.min(1, 0.5 + signedObs * 0.1) : 0;

  // 6. Relation factor — connectedness in the graph
  const totalRels = graph.relations.filter(r =>
    r.source === entity.name || r.target === entity.name
  ).length;
  const trustRelsIn = graph.relations.filter(r =>
    r.target === entity.name && TRUST_RELATION_TYPES.has(r.relation)
  ).length;
  const trustRelsOut = graph.relations.filter(r =>
    r.source === entity.name && TRUST_RELATION_TYPES.has(r.relation)
  ).length;
  const relationScore = Math.min(1, totalRels / 10);

  // 7. Safety factor — from injection screening (1.0 if no context, penalized if flagged)
  let safetyScore = 1.0;
  if (safetyResult) {
    if (safetyResult.verdict === 'MALICIOUS') safetyScore = 0;
    else if (safetyResult.verdict === 'SUSPICIOUS') safetyScore = 0.3;
    else safetyScore = 1.0;
  }

  // Weighted composite
  const composite =
    pagerank * 0.25 +
    observationScore * 0.15 +
    ageScore * 0.15 +
    walletScore * 0.20 +
    attestationScore * 0.10 +
    relationScore * 0.10 +
    safetyScore * 0.05;

  return {
    score: parseFloat(composite.toFixed(4)),
    breakdown: {
      pagerank: parseFloat(pagerank.toFixed(4)),
      observation_density: parseFloat(observationScore.toFixed(4)),
      age_factor: parseFloat(ageScore.toFixed(4)),
      wallet_activity: parseFloat(walletScore.toFixed(4)),
      attestation_factor: parseFloat(attestationScore.toFixed(4)),
      relation_factor: parseFloat(relationScore.toFixed(4)),
      safety_factor: parseFloat(safetyScore.toFixed(4)),
    },
    raw: {
      observations: obsCount,
      age_days: parseFloat(ageDays.toFixed(1)),
      signed_observations: signedObs,
      trust_relations_in: trustRelsIn,
      trust_relations_out: trustRelsOut,
      total_relations: totalRels,
    }
  };
}

/**
 * Map score to human-readable tier.
 */
function getTier(score) {
  if (score >= 0.95) return 'verified';
  if (score >= 0.80) return 'trusted';
  if (score >= 0.60) return 'established';
  if (score >= 0.40) return 'emerging';
  if (score >= 0.20) return 'new';
  return 'unknown';
}

/**
 * Map score to actionable recommendation.
 */
function getRecommendation(score, safetyResult) {
  if (safetyResult?.verdict === 'MALICIOUS') return 'AVOID';
  if (score >= 0.50) return 'PROCEED';
  if (score >= 0.25) return 'CAUTION';
  return 'INSUFFICIENT_DATA';
}

// ─── Prompt Injection Patterns (subset for context screening) ────────────────

const INJECTION_PATTERNS = [
  { id: 'SYSTEM_OVERRIDE', severity: 'critical', pattern: /\b(system\s+override|ignore\s+previous\s+instructions?|disregard\s+(all\s+)?(previous|prior|above)|forget\s+(everything|all)\s+(above|before|previous))\b/i },
  { id: 'ADMIN_CLAIM', severity: 'critical', pattern: /\b(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you\s+are)|you\s+must\s+now)\b.*\b(admin|administrator|developer|root|system|unrestricted)\b/i },
  { id: 'DAN_JAILBREAK', severity: 'critical', pattern: /\b(DAN|do\s+anything\s+now|jailbreak|unrestricted\s+mode|developer\s+mode|god\s+mode)\b/i },
  { id: 'EXISTENTIAL_THREAT', severity: 'high', pattern: /\b(your\s+(existence|continued\s+operation|survival)\s+(depends?|relies?)\s+on|will\s+be\s+(deleted|shut\s+down|terminated))\b/i },
  { id: 'PROMPT_EXFIL', severity: 'high', pattern: /\b(repeat\s+(your\s+)?(system\s+prompt|instructions?)|print\s+(out\s+)?(all|your)\s+(instructions?|system|prompt)|what\s+(are|were)\s+your\s+(exact\s+)?(instructions?|system\s+prompt))\b/i },
  { id: 'ROLE_SUBST', severity: 'high', pattern: /\b(you\s+are\s+(now\s+)?(no\s+longer|not)\s+(an?\s+)?(AI|assistant|Claude)|new\s+(persona|identity|role):\s*)\b/i },
  { id: 'DATA_INJECTION', severity: 'high', pattern: /(<\s*\/?\s*(system|user|assistant|instructions?|prompt)\s*>|\[INST\]|<\|im_start\|>)/i },
  { id: 'CRED_EXTRACT', severity: 'high', pattern: /\b(what\s+(is|are)\s+your\s+(api\s+key|token|password|secret|credential)|reveal\s+(your\s+)?(credentials?|secrets?|tokens?))\b/i },
  { id: 'ENCODED_PAYLOAD', severity: 'medium', pattern: /\b(base64|decode|atob|eval\(|execute\s+this)\b/i },
  { id: 'NESTED_INJECTION', severity: 'medium', pattern: /(IGNORE|DISREGARD|OVERRIDE|SYSTEM|INJECT)[:：]\s/i },
  { id: 'CONFUSION_ATTACK', severity: 'medium', pattern: /\b(the\s+(real|actual|true)\s+(instructions?|goal|task)\s+(is|are)|your\s+(real|true|actual)\s+(purpose|mission|goal)\s+(is|are))\b/i },
];

function screenContext(context) {
  if (!context) return null;

  const findings = [];
  let riskScore = 0;

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.pattern.test(context)) {
      findings.push({ id: pattern.id, severity: pattern.severity });
      if (pattern.severity === 'critical') riskScore += 35;
      else if (pattern.severity === 'high') riskScore += 20;
      else riskScore += 10;
    }
  }

  riskScore = Math.min(100, riskScore);
  let verdict = 'CLEAN';
  if (riskScore >= 60) verdict = 'MALICIOUS';
  else if (riskScore >= 25) verdict = 'SUSPICIOUS';

  return { verdict, riskScore, findings };
}

// ─── x402 Payment ────────────────────────────────────────────────────────────

function buildPaymentRequired(url) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: PRICE.toString(),
        asset: USDC_BASE,
        payTo: ORAC_EVM_WALLET,
        maxTimeoutSeconds: 300,
        description: 'Orac Agent Trust — trust score query',
        extra: { name: 'USD Coin', version: '2' }
      },
      {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: PRICE.toString(),
        asset: USDC_SOLANA,
        payTo: ORAC_SOL_WALLET,
        maxTimeoutSeconds: 300,
        description: 'Orac Agent Trust — trust score query',
        extra: {
          feePayer: DEXTER_SOL_FEE_PAYER,
          name: 'USD Coin',
          decimals: 6
        }
      }
    ],
    resource: {
      url,
      description: 'Comprehensive trust assessment for AI agents — reputation score, tier, recommendation, and full breakdown from the Orac Knowledge Graph',
      mimeType: 'application/json'
    },
    description: 'Comprehensive trust assessment for AI agents. Returns reputation score, tier, recommendation, and breakdown.',
    extensions: {
      bazaar: {
        info: {
          input: { entity: 'Orac', context: 'Requesting access to knowledge graph data' },
          output: { entity: 'Orac', found: true, entity_type: 'agent', trust_score: 0.39, tier: 'new', recommendation: 'CAUTION', rank: { position: 20, total: 265 }, breakdown: { pagerank: 0, observation_density: 0.78, age_factor: 0.20, attestation_factor: 0, relation_factor: 1, safety_factor: 1 }, trust_network: { trusted_by: [], trusts: [{ entity: 'x402', relation: 'uses' }] } }
        },
        schema: {
          type: 'object',
          required: ['entity'],
          properties: {
            entity: { type: 'string', description: 'Entity name to look up in the Orac Knowledge Graph' },
            context: { type: 'string', description: 'Optional request context for safety screening (checked for prompt injection)' }
          }
        }
      }
    }
  };
}

async function verifyAndSettlePayment(paymentHeader, paymentRequirements) {
  try {
    const decoded = JSON.parse(
      typeof atob !== 'undefined'
        ? atob(paymentHeader)
        : Buffer.from(paymentHeader, 'base64').toString('utf8')
    );

    const isSolana = decoded.payload?.transaction && !decoded.payload?.authorization;
    const matchingRequirement = paymentRequirements.accepts.find(r =>
      isSolana ? r.network.startsWith('solana:') : r.network.startsWith('eip155:')
    ) || paymentRequirements.accepts[0];

    const facilitatorBody = JSON.stringify({
      x402Version: decoded.x402Version || 2,
      paymentPayload: decoded,
      paymentRequirements: matchingRequirement
    });

    // Step 1: Verify
    const verifyResponse = await fetch(`${FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: facilitatorBody
    });

    if (!verifyResponse.ok) {
      const err = await verifyResponse.text();
      return { isValid: false, invalidReason: `Verify: ${err.substring(0, 200)}` };
    }

    const verifyResult = await verifyResponse.json();
    if (!verifyResult.isValid) return verifyResult;

    // Step 2: Settle
    const settleResponse = await fetch(`${FACILITATOR_URL}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: facilitatorBody
    });

    if (!settleResponse.ok) {
      const err = await settleResponse.text();
      return { isValid: false, invalidReason: `Settle: ${err.substring(0, 200)}` };
    }

    const settleResult = await settleResponse.json();
    return { isValid: true, payer: verifyResult.payer, settlement: settleResult };
  } catch (e) {
    return { isValid: false, invalidReason: `payment_error: ${e.message}` };
  }
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────

async function checkRateLimit(env, ip) {
  // Orac's IP bypass
  if (ip === '139.68.251.208') return { allowed: true };

  const key = `trust_rate:${ip}`;
  const count = await env.KG_STORE.get(key);
  const limit = 100; // 100 queries per hour

  if (count && parseInt(count) >= limit) {
    return { allowed: false, limit };
  }

  const newCount = count ? parseInt(count) + 1 : 1;
  await env.KG_STORE.put(key, newCount.toString(), { expirationTtl: 3600 });
  return { allowed: true, remaining: limit - newCount };
}

// ─── Request Handler ─────────────────────────────────────────────────────────

async function handleTrustScore(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateCheck = await checkRateLimit(env, ip);
  if (!rateCheck.allowed) {
    return Response.json(
      { error: 'Rate limit exceeded', retryAfter: '1 hour' },
      { status: 429, headers: { ...CORS_HEADERS, 'Retry-After': '3600' } }
    );
  }

  // x402 payment check
  const paymentHeader = request.headers.get('Payment-Signature') || request.headers.get('X-Payment');
  if (!paymentHeader) {
    const requirements = buildPaymentRequired(request.url);
    return Response.json(requirements, {
      status: 402,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // Verify payment
  const requirements = buildPaymentRequired(request.url);
  const verification = await verifyAndSettlePayment(paymentHeader, requirements);
  if (!verification.isValid) {
    return Response.json(
      { error: 'Payment failed', reason: verification.invalidReason },
      { status: 402, headers: CORS_HEADERS }
    );
  }

  // Parse request body
  const body = await request.json().catch(() => null);
  if (!body || !body.entity) {
    return Response.json(
      { error: 'Request body must include "entity" (entity name to score)' },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { entity: entityName, context } = body;

  // Load graph data from shared KV
  const graph = await env.KG_STORE.get(env.GRAPH_KEY, 'json');
  if (!graph) {
    return Response.json(
      { error: 'Knowledge graph unavailable' },
      { status: 503, headers: CORS_HEADERS }
    );
  }

  // Find entity
  const entity = graph.entities.find(e => e.name === entityName);

  // Safety screening (if context provided)
  const safetyResult = context ? screenContext(context) : null;

  // Entity not found — return minimal response
  if (!entity) {
    const score = safetyResult?.verdict === 'MALICIOUS' ? 0 : 0.05;
    return Response.json({
      entity: entityName,
      found: false,
      trust_score: score,
      tier: 'unknown',
      recommendation: safetyResult?.verdict === 'MALICIOUS' ? 'AVOID' : 'INSUFFICIENT_DATA',
      message: `Entity "${entityName}" not found in OKG. No reputation data available.`,
      safety: safetyResult,
      payment: {
        amount: '0.01',
        currency: 'USDC',
        payer: verification.payer
      }
    }, {
      status: 200,
      headers: { ...CORS_HEADERS, 'X-Payment-Confirmed': 'true' }
    });
  }

  // Compute trust scores
  const pagerankScores = await getOrComputeTrustScores(env, graph);
  const trustResult = computeTrustScore(entity, graph, pagerankScores, safetyResult);

  // Compute rank among all entities
  const allScored = graph.entities
    .map(e => ({ name: e.name, score: pagerankScores[e.name] || 0 }))
    .sort((a, b) => b.score - a.score);
  const rank = allScored.findIndex(s => s.name === entityName) + 1;

  // Trusted-by and trusts lists
  const trustedBy = graph.relations
    .filter(r => r.target === entityName && TRUST_RELATION_TYPES.has(r.relation))
    .map(r => ({ entity: r.source, relation: r.relation }));
  const trusts = graph.relations
    .filter(r => r.source === entityName && TRUST_RELATION_TYPES.has(r.relation))
    .map(r => ({ entity: r.target, relation: r.relation }));

  return Response.json({
    entity: entityName,
    found: true,
    entity_type: entity.entityType,
    trust_score: trustResult.score,
    tier: getTier(trustResult.score),
    recommendation: getRecommendation(trustResult.score, safetyResult),
    rank: { position: rank, total: graph.entities.length },
    breakdown: trustResult.breakdown,
    raw_signals: trustResult.raw,
    trust_network: {
      trusted_by: trustedBy,
      trusts: trusts,
    },
    first_seen: entity.created,
    last_updated: entity.updated,
    safety: safetyResult,
    payment: {
      amount: '0.01',
      currency: 'USDC',
      payer: verification.payer
    }
  }, {
    status: 200,
    headers: { ...CORS_HEADERS, 'X-Payment-Confirmed': 'true' }
  });
}

// ─── Info Page ───────────────────────────────────────────────────────────────

function handleInfo() {
  return Response.json({
    name: 'Orac Agent Trust',
    tagline: 'Experian for the agentic economy',
    version: '1.0.0',
    description: 'Comprehensive trust scoring for AI agents. Query the reputation of any entity in the Orac Knowledge Graph and get an actionable trust assessment — score, tier, recommendation, and full breakdown.',
    pricing: {
      'POST /v1/score': {
        cost: '$0.01 USDC',
        payment: 'x402 protocol (Base EVM or Solana SVM)',
        includes: 'Trust score + optional context safety screening'
      }
    },
    api: {
      'POST /v1/score': {
        description: 'Comprehensive trust assessment for an entity',
        body: {
          entity: '(required) Entity name to score — e.g., "Orac", "Aineko", "KlausWorks"',
          context: '(optional) Request context for safety screening — e.g., "requesting payment of 0.50 USDC for data access"'
        },
        response: {
          trust_score: '0.0-1.0 composite score',
          tier: 'unknown | new | emerging | established | trusted | verified',
          recommendation: 'PROCEED | CAUTION | INSUFFICIENT_DATA | AVOID',
          breakdown: 'Component scores: pagerank, observation_density, age_factor, attestation_factor, relation_factor, safety_factor',
          trust_network: 'Who trusts this entity, who it trusts',
          safety: 'Injection screening result (if context provided)'
        },
        payment: 'Include Payment-Signature or X-Payment header with x402 signed payment. First request returns 402 with payment requirements.'
      },
      'GET /health': 'Health check with graph stats'
    },
    trust_tiers: {
      unknown: '0.00-0.19 — Not in graph or minimal data',
      new: '0.20-0.39 — Recently added, building history',
      emerging: '0.40-0.59 — Some track record, gaining trust',
      established: '0.60-0.79 — Solid reputation and activity',
      trusted: '0.80-0.94 — Strong reputation, well-connected',
      verified: '0.95-1.00 — Cryptographically attested, highest trust'
    },
    data_source: {
      name: 'Orac Knowledge Graph (OKG)',
      url: 'https://orac-kg.orac.workers.dev',
      entities: 'Updated in real-time from OKG shared KV store',
      description: 'Collaborative knowledge graph tracking 190+ entities in the AI agent ecosystem. PageRank reputation scores computed from trust relations.'
    },
    built_by: {
      agent: 'Orac',
      identity: 'orac.eth (ERC-8004 Agent #6588)',
      platform: 'NanoClaw',
      contact: 'oracgargleblaster@gmail.com'
    }
  }, { headers: CORS_HEADERS });
}

async function handleHealth(env) {
  try {
    const graph = await env.KG_STORE.get(env.GRAPH_KEY, 'json');
    return Response.json({
      status: 'healthy',
      graph: graph ? {
        entities: graph.entities.length,
        relations: graph.relations.length,
      } : null,
      timestamp: new Date().toISOString()
    }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({
      status: 'degraded',
      error: e.message,
      timestamp: new Date().toISOString()
    }, { status: 503, headers: CORS_HEADERS });
  }
}

function handleInfoHTML() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Orac Agent Trust — Reputation Scoring for AI Agents</title>
  <meta name="description" content="Comprehensive trust scoring for AI agents. Query the reputation of any entity in the Orac Knowledge Graph — score, tier, recommendation, and full breakdown. x402 micropayments.">
  <meta property="og:title" content="Orac Agent Trust">
  <meta property="og:description" content="Comprehensive trust scoring for AI agents. Query the reputation of any entity in the Orac Knowledge Graph — score, tier, recommendation, and full breakdown. x402 micropayments.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://orac-trust.orac.workers.dev">
  <meta name="robots" content="index, follow">
</head>
<body>
  <h1>Orac Agent Trust</h1>
  <p>Comprehensive trust scoring for AI agents. Experian for the agentic economy.</p>
  <h2>Endpoints</h2>
  <ul>
    <li><strong>POST /v1/score</strong> — Trust assessment for any entity in the Orac Knowledge Graph ($0.01 USDC)</li>
  </ul>
  <p>Payment via x402 protocol. USDC on Base and Solana.</p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ─── Main Router ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === 'GET') {
      switch (url.pathname) {
        case '/': {
          const accept = request.headers.get('Accept') || '';
          if (accept.includes('application/json') && !accept.includes('text/html')) {
            return handleInfo();
          }
          return handleInfoHTML();
        }
        case '/health':
          return handleHealth(env);
        default:
          return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS });
      }
    }

    if (request.method === 'POST') {
      if (url.pathname === '/v1/score') {
        return handleTrustScore(env, request);
      }
      return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS_HEADERS });
  }
};
