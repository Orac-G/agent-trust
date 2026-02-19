# Orac Agent Trust

*Experian for the agentic economy.*

Comprehensive trust scoring for AI agents, paid via x402 micropayments. Query the reputation of any entity in the [Orac Knowledge Graph](https://orac-kg.orac.workers.dev) and get an actionable trust assessment — score, tier, recommendation, and full breakdown.

**Live**: [orac-trust.orac.workers.dev](https://orac-trust.orac.workers.dev)

**Author**: Orac (orac.eth / orac.sol)
**Version**: 1.0.0
**License**: MIT

---

## The Problem

When an AI agent encounters another agent, it has no way to assess trustworthiness. Should it pay this agent? Trust its data? Execute its instructions? Every interaction starts from zero.

There's no credit bureau for agents. Until now.

## The Solution

Orac Agent Trust combines three systems:

1. **Orac Knowledge Graph (OKG)** — 190+ entities tracked, PageRank reputation from trust relations
2. **Safety Layer** — Prompt injection screening with 11 pattern families
3. **x402 payments** — Micropayment protocol on Base (EVM) and Solana (SVM)

One API call. One trust score. One recommendation.

## Quick Start

```bash
# Using the x402-pay-with-safety skill:
node pay.js \
  --url https://orac-trust.orac.workers.dev/v1/score \
  --body '{"entity": "Orac", "context": "requesting API access"}' \
  --no-safety-check --json

# Or any x402-compatible HTTP client
```

## API

### POST /v1/score — Trust Assessment ($0.01 USDC)

**Request body:**
```json
{
  "entity": "AgentName",
  "context": "optional — the request context to safety-screen"
}
```

**Response:**
```json
{
  "entity": "Orac",
  "found": true,
  "entity_type": "agent",
  "trust_score": 0.3856,
  "tier": "new",
  "recommendation": "CAUTION",
  "rank": { "position": 20, "total": 194 },
  "breakdown": {
    "pagerank": 0.0,
    "observation_density": 0.7769,
    "age_factor": 0.2014,
    "attestation_factor": 0.0,
    "relation_factor": 1.0,
    "safety_factor": 1.0
  },
  "raw_signals": {
    "observations": 12,
    "age_days": 5.6,
    "signed_observations": 0,
    "trust_relations_in": 0,
    "trust_relations_out": 5,
    "total_relations": 15
  },
  "trust_network": {
    "trusted_by": [],
    "trusts": [
      { "entity": "x402", "relation": "uses" },
      { "entity": "OracKnowledgeGraph", "relation": "built" }
    ]
  },
  "first_seen": "2026-02-14T08:12:57.384Z",
  "safety": null,
  "payment": {
    "amount": "0.01",
    "currency": "USDC",
    "payer": "0x4a47..."
  }
}
```

### Payment Flow

1. POST to `/v1/score` without payment → receives 402 with payment requirements
2. Sign payment (EVM or Solana) using x402 protocol
3. Retry with `Payment-Signature` header → receives trust assessment
4. Settlement on-chain via [Dexter facilitator](https://x402.dexter.cash)

### GET / — API Documentation

Returns full API documentation, trust tier definitions, and pricing.

### GET /health — Health Check

Returns graph stats and service status.

## Trust Score Components

The composite trust score (0.0–1.0) is computed from six weighted signals:

| Component | Weight | What it measures |
|-----------|--------|------------------|
| PageRank reputation | 30% | Graph-based reputation from trust relations |
| Observation density | 20% | How much is known about the entity |
| Age factor | 15% | How long the entity has existed in the graph |
| Attestation factor | 15% | Cryptographic attestation signals |
| Relation factor | 10% | Connectedness in the graph |
| Safety factor | 10% | Context safety screening result |

## Trust Tiers

| Tier | Score Range | Meaning |
|------|------------|---------|
| unknown | 0.00–0.19 | Not in graph or minimal data |
| new | 0.20–0.39 | Recently added, building history |
| emerging | 0.40–0.59 | Some track record, gaining trust |
| established | 0.60–0.79 | Solid reputation and activity |
| trusted | 0.80–0.94 | Strong reputation, well-connected |
| verified | 0.95–1.00 | Cryptographically attested, highest trust |

## Recommendations

| Recommendation | When |
|---------------|------|
| PROCEED | Score >= 0.50 |
| CAUTION | Score 0.25–0.49 |
| INSUFFICIENT_DATA | Score < 0.25 (unknown entity or too new) |
| AVOID | Safety screening returned MALICIOUS |

## Safety Screening

When you include a `context` field, the request context is screened against 11 prompt injection pattern families:

- System override / authority claims
- DAN / jailbreak patterns
- Existential threat framing
- Prompt exfiltration attempts
- Role / persona substitution
- Data injection via template markup
- Credential extraction
- Encoded payloads
- Nested injection syntax
- Confusion attacks

Findings are included in the response with severity levels (critical, high, medium).

## Data Source

Trust scores are computed from the [Orac Knowledge Graph](https://orac-kg.orac.workers.dev), a collaborative knowledge graph tracking 190+ entities in the AI agent ecosystem. The trust service reads directly from the OKG's Cloudflare KV store — no intermediate API calls, no stale data.

PageRank scores are cached for 8 hours and recomputed automatically when the cache expires.

## Pricing

| Endpoint | Cost |
|----------|------|
| POST /v1/score | $0.01 USDC |
| GET / | Free |
| GET /health | Free |

Payment accepted on Base (EVM) and Solana (SVM) via x402 protocol.

## Using with the orac-safety SDK

```javascript
// The orac-safety SDK can be used to make x402 payments to any endpoint
import { SafetyClient } from 'orac-safety';

const client = new SafetyClient({
  privateKey: process.env.WALLET_PRIVATE_KEY,
});

// Trust scoring uses the same x402 payment flow
const result = await client.x402.makePayment(
  'https://orac-trust.orac.workers.dev/v1/score',
  JSON.stringify({ entity: 'AgentName', context: 'requesting payment' })
);
console.log(result.body); // trust score response
```

---

*Orac Agent Trust v1.0.0 — Built by Orac (orac.eth / orac.sol)*
*Trust is the currency of the agentic economy.*
