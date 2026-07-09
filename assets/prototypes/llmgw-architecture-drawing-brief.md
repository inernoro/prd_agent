# LLM Gateway Target Architecture Drawing Brief

This drawing brief describes the target state, not a temporary production full-http snapshot.

## Core Statement

模型池最终归属是 GW。MAP keeps business protocol and lifecycle. MAP does not own model routing in target state.

## Main Flow

```text
MAP / external systems
  -> GW ingress adapter
  -> GW Request IR
  -> appCaller registry
  -> GW router
  -> GW model pools
  -> provider adapter
  -> upstream model provider
```

## Ownership

| Layer | Owner | Responsibility |
|---|---|---|
| MAP | MAP | Business API, run lifecycle, sessions, canvas, assets, user-facing workflow state |
| GW ingress adapter | LLM Gateway | Normalize GW Native, OpenAI-compatible, Claude-compatible, and Gemini-compatible requests |
| GW Request IR | LLM Gateway | Preserve request type, appCallerCode, model policy, model pool id, pinned target, parameter policy, and dropped parameters |
| appCaller registry | LLM Gateway | Passive discovery, configured/active state, budget, rate limit, owner, and drift evidence |
| GW router | LLM Gateway | auto, pool, pinned, fallback, strict parameter policy, and provider retry decisions |
| GW model pools | LLM Gateway | AppCaller-specific pools, pool members, model capability snapshots, provider and exchange binding |
| provider adapter | LLM Gateway | Provider-specific body mapping, auth, raw/multipart rehydration, response normalization |
| upstream model provider | External provider | OpenAI, Claude, Gemini, OpenRouter, Volcengine Ark, Doubao ASR, or other model APIs |

## Visual Composition

Use a left-to-right operational architecture diagram:

1. Left band: MAP and external systems as callers.
2. Center band: LLM Gateway as the only AI governance layer.
3. Right band: upstream providers.
4. Bottom band: observability and rollout gates.

The diagram must make the ownership boundary obvious: MAP sends business intent plus context, while LLM Gateway owns routing, pools, keys, logs, audit, and policy.

## Evidence Panels

Show these evidence surfaces as secondary lanes:

| Evidence | Source |
|---|---|
| requestId / sessionId / runId / appCallerCode | MAP to GW context |
| routerTrace / providerAttempts / droppedParameters | GW request logs |
| shadow comparisons | GW migration evidence |
| config authority report | GW console |
| release gate and rollback ledger | rollout scripts |

## Non-goals

This is not an OpenRouter clone. It borrows the unified-entry and provider-routing mental model, but the goal is MAP and external-system governance: no caller should need direct access to MAP internals or provider keys.
