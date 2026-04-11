/**
 * Scheduler API routes — manages executor registration, heartbeats, and dispatch.
 *
 * Handles the cluster bootstrap flow (see `doc/design.cds-cluster-bootstrap.md`):
 *  - A fresh executor posts to /register with `X-Bootstrap-Token`. On success
 *    we mint a permanent executor token and return it in the response body.
 *  - The first successful registration triggers `onFirstRegister`, which the
 *    server wires to mode upgrade (standalone → scheduler) + nginx reload.
 *  - Subsequent heartbeats authenticate with `X-Executor-Token` (permanent).
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import type { CdsConfig } from '../types.js';
import type { ExecutorRegistry } from './executor-registry.js';
import type { BranchDispatcher, DispatchStrategy } from './dispatcher.js';

export interface SchedulerRouterDeps {
  registry: ExecutorRegistry;
  config: CdsConfig;
  /** Optional branch dispatcher (Phase 3). Absent = dispatch endpoint returns 503. */
  dispatcher?: BranchDispatcher;
  /**
   * Called after the very first successful register call. Used by the
   * bootstrap flow to trigger `standalone → scheduler` mode upgrade
   * (persist .cds.env, reload nginx, self-register master).
   */
  onFirstRegister?: (executorId: string) => Promise<void> | void;
  /**
   * Called after a bootstrap token is consumed so the server can mint +
   * persist a permanent executor token and clear the bootstrap token from
   * `.cds.env`. Return value is sent back to the executor in the register
   * response body.
   *
   * If absent, the route falls back to returning the already-configured
   * `config.executorToken` (which may be undefined for open clusters).
   */
  onBootstrapConsumed?: () => Promise<string> | string;
}

/**
 * Timestamp-comparison tolerance for the bootstrap token expiry check.
 * Small clock drift between master and executor shouldn't cause a legitimate
 * token to be rejected — 60 seconds is well below the 15-minute TTL but
 * enough to absorb unsynchronized clocks.
 */
const TOKEN_CLOCK_SKEW_MS = 60_000;

/**
 * Allowed shape for executor-supplied `id` strings. Restricts to
 * alphanumerics + dot/underscore/dash, max 64 chars. This blocks log
 * forgery (newlines, ANSI escapes) and database key injection while still
 * accepting realistic ids like `executor-host01.example.com-9901`.
 */
const EXECUTOR_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

export function createSchedulerRouter(deps: SchedulerRouterDeps): Router {
  const { registry, config, dispatcher, onFirstRegister, onBootstrapConsumed } = deps;
  const router = Router();

  // ── Auth middleware: verify permanent executor token ──
  // Bootstrap registration is handled separately on /register so we can
  // accept a one-shot token there.
  function verifyPermanentToken(
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ): void {
    if (config.executorToken) {
      const token = req.headers['x-executor-token'] as string | undefined;
      if (token !== config.executorToken) {
        res.status(401).json({ error: 'Invalid executor token' });
        return;
      }
    }
    next();
  }

  /**
   * Validate bootstrap token from request headers. Returns ok=true if either:
   *   - A valid non-expired bootstrap token matches, OR
   *   - A permanent executor token already matches (re-register case)
   *
   * The error messages are deliberately specific so the operator can tell
   * the difference between "wrong token" and "token already consumed by a
   * previous (possibly-failed-mid-flight) request — please re-issue".
   */
  function verifyBootstrapOrPermanent(
    req: import('express').Request,
  ): { ok: boolean; consumedBootstrap: boolean; error?: string } {
    const bootstrapHeader = req.headers['x-bootstrap-token'] as string | undefined;
    const executorHeader = req.headers['x-executor-token'] as string | undefined;

    // Path 1: already-registered executor re-registering (e.g., after restart)
    if (config.executorToken && executorHeader === config.executorToken) {
      return { ok: true, consumedBootstrap: false };
    }

    // Path 2: fresh executor with bootstrap token
    if (config.bootstrapToken && bootstrapHeader) {
      if (bootstrapHeader !== config.bootstrapToken.value) {
        return { ok: false, consumedBootstrap: false, error: 'Invalid bootstrap token' };
      }
      const expiresAt = new Date(config.bootstrapToken.expiresAt).getTime();
      if (Number.isNaN(expiresAt)) {
        return { ok: false, consumedBootstrap: false, error: 'Bootstrap token has no valid expiry' };
      }
      if (Date.now() > expiresAt + TOKEN_CLOCK_SKEW_MS) {
        return { ok: false, consumedBootstrap: false, error: 'Bootstrap token expired' };
      }
      return { ok: true, consumedBootstrap: true };
    }

    // Path 3: client sent a bootstrap header but server has no bootstrap token
    // configured. This is the "previously consumed" case — most commonly the
    // result of a successful consume on the server side whose HTTP response
    // failed to reach the client. The client retries, but the token is gone.
    // Return a specific error so the operator knows to re-issue, not assume
    // a typo.
    if (bootstrapHeader && !config.bootstrapToken) {
      return {
        ok: false,
        consumedBootstrap: false,
        error: 'Bootstrap token already consumed or never issued. Run `./exec_cds.sh issue-token` on the master and retry.',
      };
    }

    // Path 4: backward-compat — no auth required (same as pre-bootstrap behavior)
    if (!config.executorToken && !config.bootstrapToken) {
      return { ok: true, consumedBootstrap: false };
    }

    return { ok: false, consumedBootstrap: false, error: 'Missing bootstrap or executor token' };
  }

  // ── POST /api/executors/register — executor registers itself ──
  // Accepts either a bootstrap token (first-time join) or a permanent token
  // (re-register after restart). On first successful bootstrap consume,
  // triggers the onFirstRegister callback which handles mode upgrade.
  //
  // The "is this the first remote executor?" decision is derived from the
  // registry at request time, not a closure flag — that way a master process
  // restart correctly recognizes a previously-bootstrapped cluster and
  // doesn't re-trigger the upgrade path. Embedded (master self-)executors
  // are excluded from the count.
  router.post('/register', async (req, res) => {
    const auth = verifyBootstrapOrPermanent(req);
    if (!auth.ok) {
      res.status(401).json({ error: auth.error || 'Unauthorized' });
      return;
    }

    const { id, host, port, capacity, labels, role } = req.body;
    if (!id || !host || !port) {
      res.status(400).json({ error: 'id, host, and port are required' });
      return;
    }
    // Hardening: reject ids with control chars or excessive length so a
    // malicious or buggy executor can't forge log lines or DOS the registry.
    if (typeof id !== 'string' || !EXECUTOR_ID_PATTERN.test(id)) {
      res.status(400).json({
        error: 'invalid id: must match /^[a-zA-Z0-9._-]{1,64}$/',
      });
      return;
    }

    // Snapshot "is this a fresh cluster" before mutating the registry.
    // We only count remote nodes — the master always self-registers as
    // embedded so its presence shouldn't suppress the upgrade.
    const remoteCountBefore = registry
      .getAll()
      .filter(n => n.role !== 'embedded').length;

    const node = registry.register({ id, host, port, capacity, labels, role });
    console.log(`  [scheduler] Executor registered: ${id} (${host}:${port})`);

    // If a bootstrap token was consumed, mint a permanent token and persist
    // it. Subsequent calls from this executor will use the permanent token.
    let permanentToken: string | undefined;
    if (auth.consumedBootstrap) {
      if (onBootstrapConsumed) {
        try {
          permanentToken = await onBootstrapConsumed();
        } catch (err) {
          console.error(`  [scheduler] onBootstrapConsumed failed: ${(err as Error).message}`);
        }
      }
      if (!permanentToken) {
        // Generate a minimal fallback token so the executor still has
        // something to authenticate with. The server-side persistence is
        // the caller's responsibility.
        permanentToken = crypto.randomBytes(32).toString('hex');
      }
    } else if (config.executorToken) {
      // Re-register case: return the already-configured permanent token
      // so the client can self-heal a missing .cds.env entry.
      permanentToken = config.executorToken;
    }

    // Trigger mode upgrade on the very first remote registration. The check
    // is "remoteCountBefore === 0", meaning *before this register call* there
    // were no non-embedded executors. This is robust against process restart:
    // when a master with an existing remote executor restarts, the registry
    // is rehydrated from state.json so remoteCountBefore > 0 and onFirstRegister
    // is not re-triggered.
    //
    // Best-effort: a failure here does not rollback the registration itself,
    // because the executor is already in the registry and the next heartbeat
    // will succeed.
    if (remoteCountBefore === 0 && onFirstRegister) {
      try {
        await onFirstRegister(id);
      } catch (err) {
        console.error(`  [scheduler] onFirstRegister failed: ${(err as Error).message}`);
      }
    }

    res.json({
      node,
      permanentToken,
      masterInfo: {
        mode: config.mode,
        schedulerUrl: config.schedulerUrl,
      },
    });
  });

  // ── POST /api/executors/:id/heartbeat — executor heartbeat ──
  router.post('/:id/heartbeat', verifyPermanentToken, (req, res) => {
    const { id } = req.params;
    const { load, branches } = req.body;
    const ok = registry.heartbeat(id, { load, branches });
    if (!ok) {
      res.status(404).json({ error: `Executor "${id}" not registered` });
      return;
    }
    res.json({ ok: true });
  });

  // ── GET /api/executors/capacity — aggregated cluster capacity ──
  // Public (no auth) so lightweight monitoring tools can poll it.
  // See `doc/design.cds-cluster-bootstrap.md` §4.3.
  router.get('/capacity', (_req, res) => {
    res.json(registry.getTotalCapacity());
  });

  // ── GET /api/executors — list all executors ──
  router.get('/', (_req, res) => {
    const executors = registry.getAll();
    res.json({ executors });
  });

  // ── GET /api/executors/:id — get single executor info ──
  router.get('/:id', (req, res) => {
    const { id } = req.params;
    const executors = registry.getAll();
    const node = executors.find(n => n.id === id);
    if (!node) {
      res.status(404).json({ error: `Executor "${id}" not found` });
      return;
    }
    res.json({ node });
  });

  // ── DELETE /api/executors/:id — remove an executor ──
  router.delete('/:id', verifyPermanentToken, (req, res) => {
    const { id } = req.params;
    registry.remove(id);
    console.log(`  [scheduler] Executor removed: ${id}`);
    res.json({ message: `Executor "${id}" removed` });
  });

  // ── POST /api/executors/:id/drain — mark executor as draining (no new deployments) ──
  router.post('/:id/drain', verifyPermanentToken, (req, res) => {
    const { id } = req.params;
    const executors = registry.getAll();
    const node = executors.find(n => n.id === id);
    if (!node) {
      res.status(404).json({ error: `Executor "${id}" not found` });
      return;
    }
    node.status = 'draining';
    res.json({ node });
  });

  // ── POST /api/executors/dispatch/:branch — capacity-aware branch dispatch (Phase 3) ──
  // Body: { strategy?: 'capacity-aware' | 'least-branches' }
  // Returns the selected executor (does NOT trigger deploy — caller is responsible)
  router.post('/dispatch/:branch', async (req, res) => {
    if (!dispatcher) {
      res.status(503).json({ error: 'Dispatcher not available (scheduler mode not enabled)' });
      return;
    }
    const { branch } = req.params;
    const strategy = ((req.body as { strategy?: DispatchStrategy })?.strategy) || 'capacity-aware';
    try {
      const result = await dispatcher.selectExecutorForBranch(branch, strategy);
      if (!result.executor) {
        res.status(503).json({ error: result.reason, snapshots: result.snapshots });
        return;
      }
      res.json({
        branch,
        strategy,
        selected: result.executor,
        reason: result.reason,
        snapshots: result.snapshots?.map(p => ({
          executorId: p.executor.id,
          host: p.executor.host,
          snapshot: p.snapshot,
          fetchError: p.fetchError,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
