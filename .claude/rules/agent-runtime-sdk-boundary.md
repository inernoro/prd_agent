# Agent Runtime SDK Boundary

When documenting or reviewing an agent runtime integration, do not let a historical runtime name imply a stronger vendor integration than the code actually provides.

## Required Checks

Before writing "official SDK", "Claude SDK", "Codex SDK", or similar wording, verify and document:

1. The exact package name and version in the repo.
2. The official API or SDK surface actually used.
3. The self-built adapter, sidecar, loop, protocol, tools, approval, and runtime layers.
4. Which behavior is MVP, which behavior is production-grade, and which behavior is only a smoke fallback.

## Wording Rule

Use precise names:

- "official `anthropic` Python SDK" when the code imports `anthropic` and calls Claude Messages APIs.
- "Claude Code SDK" only when the repo uses the official Claude Code SDK package and its agent runtime behavior directly.
- "Claude sidecar runtime" or "CDS Agent runtime" when MAP/CDS wraps an SDK with custom sidecar, tools, approval, events, and workspace logic.

Avoid writing "complete official SDK integration" unless the implementation delegates the agent loop, tool protocol, cancellation, resume, and runtime behavior to that official SDK.

## Documentation Must Include

Every agent runtime design doc should include an "official / self-built boundary" table with at least these rows:

- model/API client
- agent loop
- sidecar or transport protocol
- tool execution
- approval and audit
- workspace / repo / PR tools
- runtime pool / sandbox lifecycle

## Review Heuristic

If a feature can create a PR, that proves the workflow can work once. It does not prove production readiness. Still check:

- true streaming vs polling
- stop/cancel semantics
- event pagination and replay
- long command handling
- workspace/repository selection
- credential isolation
- draft/ready PR policy
- evidence package completeness
