/**
 * Bridge API Routes — REST endpoints for Page Agent Bridge.
 *
 * Two groups of consumers:
 * 1. Widget (browser): heartbeat + poll for commands + submit results
 * 2. Agent (AI): read state + send commands + request navigation
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import type { BridgeService } from '../services/bridge.js';

export interface BridgeRouterDeps {
  bridgeService: BridgeService;
}

export function createBridgeRouter(deps: BridgeRouterDeps): Router {
  const { bridgeService } = deps;
  const router = Router();

  // ── Widget endpoints ──

  // POST /api/bridge/heartbeat — Widget registers/refreshes connection + uploads state
  router.post('/heartbeat', (req, res) => {
    const { branchId, state } = req.body || {};
    if (!branchId) {
      res.status(400).json({ error: 'branchId is required' });
      return;
    }
    const result = bridgeService.heartbeat(branchId, state || null);
    res.json(result);
  });

  // POST /api/bridge/result — Widget submits command execution result
  router.post('/result', (req, res) => {
    const { branchId, id, success, error, data, state } = req.body || {};
    if (!branchId || !id) {
      res.status(400).json({ error: 'branchId and id are required' });
      return;
    }
    bridgeService.submitResult(branchId, { id, success, error, data, state });
    res.json({ ok: true });
  });

  // ── Agent endpoints ──

  // GET /api/bridge/connections — List all active bridge connections
  router.get('/connections', (_req, res) => {
    res.json({ connections: bridgeService.getConnections() });
  });

  // GET /api/bridge/state/:branchId — Read page state
  router.get('/state/:branchId', (req, res) => {
    const { branchId } = req.params;

    if (!bridgeService.isConnected(branchId)) {
      res.status(404).json({
        error: 'no connection',
        message: `分支 ${branchId} 没有活跃的 Bridge 连接。用户需要先在浏览器中打开该分支的预览页面。`,
      });
      return;
    }

    const state = bridgeService.getState(branchId);
    if (!state) {
      res.json({ error: 'no state yet', message: '连接已建立但尚未获取到页面状态，请稍后重试。' });
      return;
    }

    res.json(state);
  });

  // POST /api/bridge/command/:branchId — Send command to widget (waits for result)
  router.post('/command/:branchId', async (req, res) => {
    const { branchId } = req.params;
    const { action, params, description } = req.body || {};

    if (!action) {
      res.status(400).json({ error: 'action is required' });
      return;
    }

    const validActions = ['click', 'type', 'scroll', 'navigate', 'evaluate', 'snapshot'];
    if (!validActions.includes(action)) {
      res.status(400).json({ error: `invalid action: ${action}. Valid: ${validActions.join(', ')}` });
      return;
    }

    if (!bridgeService.isConnected(branchId)) {
      res.status(404).json({ error: 'no connection', message: `分支 ${branchId} 没有活跃的 Bridge 连接。` });
      return;
    }

    const command = {
      id: crypto.randomBytes(4).toString('hex'),
      action: action as 'click' | 'type' | 'scroll' | 'navigate' | 'evaluate' | 'snapshot',
      params: params || {},
      description: description as string | undefined,
    };

    try {
      const response = await bridgeService.sendCommand(branchId, command);
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/bridge/navigate-request — Request user to open a page
  router.post('/navigate-request', (req, res) => {
    const { branchId, url, reason } = req.body || {};
    if (!branchId || !url) {
      res.status(400).json({ error: 'branchId and url are required' });
      return;
    }
    const request = bridgeService.addNavigateRequest(branchId, url, reason || '');
    res.json({ requestId: request.id, message: '导航请求已发送到用户浏览器' });
  });

  // GET /api/bridge/navigate-requests/:branchId — Widget polls for pending navigate requests
  router.get('/navigate-requests/:branchId', (req, res) => {
    const { branchId } = req.params;
    res.json({ requests: bridgeService.getNavigateRequests(branchId) });
  });

  // POST /api/bridge/navigate-requests/:id/dismiss — Dismiss a navigate request
  router.post('/navigate-requests/:id/dismiss', (req, res) => {
    bridgeService.dismissNavigateRequest(req.params.id);
    res.json({ success: true });
  });

  return router;
}
