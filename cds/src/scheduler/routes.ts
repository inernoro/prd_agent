/**
 * Scheduler API routes — manages executor registration, heartbeats, and dispatch.
 */
import { Router } from 'express';
import type { CdsConfig } from '../types.js';
import type { ExecutorRegistry } from './executor-registry.js';

export interface SchedulerRouterDeps {
  registry: ExecutorRegistry;
  config: CdsConfig;
}

export function createSchedulerRouter(deps: SchedulerRouterDeps): Router {
  const { registry, config } = deps;
  const router = Router();

  // ── Auth middleware: verify executor token ──
  function verifyToken(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
    if (config.executorToken) {
      const token = req.headers['x-executor-token'] as string | undefined;
      if (token !== config.executorToken) {
        res.status(401).json({ error: 'Invalid executor token' });
        return;
      }
    }
    next();
  }

  // ── POST /api/executors/register — executor registers itself ──
  router.post('/register', verifyToken, (req, res) => {
    const { id, host, port, capacity, labels } = req.body;
    if (!id || !host || !port) {
      res.status(400).json({ error: 'id, host, and port are required' });
      return;
    }

    const node = registry.register({ id, host, port, capacity, labels });
    console.log(`  [scheduler] Executor registered: ${id} (${host}:${port})`);
    res.json({ node });
  });

  // ── POST /api/executors/:id/heartbeat — executor heartbeat ──
  router.post('/:id/heartbeat', verifyToken, (req, res) => {
    const { id } = req.params;
    const { load, branches } = req.body;
    const ok = registry.heartbeat(id, { load, branches });
    if (!ok) {
      res.status(404).json({ error: `Executor "${id}" not registered` });
      return;
    }
    res.json({ ok: true });
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
  router.delete('/:id', (req, res) => {
    const { id } = req.params;
    registry.remove(id);
    console.log(`  [scheduler] Executor removed: ${id}`);
    res.json({ message: `Executor "${id}" removed` });
  });

  // ── POST /api/executors/:id/drain — mark executor as draining (no new deployments) ──
  router.post('/:id/drain', (req, res) => {
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

  return router;
}
