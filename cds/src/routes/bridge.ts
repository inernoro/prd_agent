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
import type { StateService } from '../services/state.js';

export interface BridgeRouterDeps {
  bridgeService: BridgeService;
  /** PR_C.3: 注入 stateService 用于 AI 占用计数 / activity log。
   *  老版本 deps 调用方未传 → 计数静默跳过，行为兼容。 */
  stateService?: StateService;
}

export function createBridgeRouter(deps: BridgeRouterDeps): Router {
  const { bridgeService, stateService } = deps;
  const router = Router();

  // 从请求 header 推 actor，跟 routes/branches.ts:resolveActorForActivity 同语义。
  // X-AI-Impersonate 优先（带具体 username），否则 X-AI-Access-Key 给 'ai'，
  // 没 AI header 兜底 'user'（cookie 登录的真人）。
  const resolveActorForBridge = (req: unknown): string => {
    const headers = (req as { headers?: Record<string, string | string[] | undefined> })
      ?.headers || {};
    const impersonate = headers['x-ai-impersonate'];
    if (typeof impersonate === 'string' && impersonate) return `ai:${impersonate}`;
    if (Array.isArray(impersonate) && impersonate[0]) return `ai:${impersonate[0]}`;
    const aiKey = headers['x-ai-access-key'] || headers['x-cds-ai-token'];
    if (aiKey) return 'ai';
    return 'user';
  };

  // PR_C.3 helper：在 AI 占用 / 释放时给 branch + project 加计数 + 写 activity log。
  // stateService 未注入时静默 noop（向后兼容）。
  // 2026-04-27 (Bugbot review): 加 actor 字段，跟其它 activity log 入口统一。
  // 之前缺失导致 ai-occupy/release 事件 actor=undefined，PR 设计的"actor 归因"
  // 在这条路径上失效。
  const recordAiActivity = (
    req: unknown,
    branchId: string,
    type: 'ai-occupy' | 'ai-release',
    note?: string,
  ): void => {
    if (!stateService) return;
    const branch = stateService.getBranch(branchId);
    if (!branch) return;
    if (type === 'ai-occupy') {
      stateService.incrementBranchStat(branchId, 'aiOpCount');
      stateService.stampBranchTimestamp(branchId, 'lastAiOccupantAt');
    }
    stateService.appendActivityLog(branch.projectId, {
      type,
      branchId,
      branchName: branch.branch,
      actor: resolveActorForBridge(req),
      note,
    });
    stateService.save();
  };

  // ── Widget endpoints ──

  // POST /api/bridge/heartbeat — Widget heartbeat (fast polling, 500ms interval)
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

  // GET /api/bridge/check/:branchId — Widget lightweight activation check (no body, no auth needed)
  router.get('/check/:branchId', (req, res) => {
    res.json({ active: bridgeService.isSessionActive(req.params.branchId) });
  });

  // POST /api/bridge/start-session — Agent activates Bridge for a branch
  router.post('/start-session', (req, res) => {
    const { branchId } = req.body || {};
    if (!branchId) {
      res.status(400).json({ error: 'branchId is required' });
      return;
    }
    bridgeService.startSession(branchId);
    recordAiActivity(req, branchId, 'ai-occupy', 'Bridge session 激活');
    res.json({ success: true, message: 'Session 已激活，Widget 将在 10s 内开始轮询' });
  });

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

    const validActions = ['click', 'type', 'scroll', 'navigate', 'spa-navigate', 'evaluate', 'snapshot'];
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

  // ── Handshake endpoints (user-approval flow) ──
  // Flow: AI creates request → Widget shows panel → User approves/rejects →
  //       auto-activates session if approved → AI polls status to begin operation

  // POST /api/bridge/handshake-request — AI asks user to approve a Bridge session
  router.post('/handshake-request', (req, res) => {
    const { branchId, reason, agentName } = req.body || {};
    if (!branchId) {
      res.status(400).json({ error: 'branchId is required' });
      return;
    }
    const request = bridgeService.addHandshakeRequest(
      branchId,
      reason || '',
      agentName || 'Claude Code',
    );
    res.json({
      requestId: request.id,
      message: '握手请求已发送，请用户在浏览器左下角点击「同意」批准',
      expiresIn: 300,
    });
  });

  // GET /api/bridge/handshake-requests/:branchId — Widget polls for pending handshake
  router.get('/handshake-requests/:branchId', (req, res) => {
    res.json({ requests: bridgeService.getPendingHandshakeRequests(req.params.branchId) });
  });

  // POST /api/bridge/handshake-requests/:id/approve — User approves (from Widget)
  router.post('/handshake-requests/:id/approve', (req, res) => {
    const approved = bridgeService.approveHandshake(req.params.id);
    if (!approved) {
      res.status(404).json({ error: '握手请求不存在或已过期' });
      return;
    }
    res.json({ success: true, branchId: approved.branchId });
  });

  // POST /api/bridge/handshake-requests/:id/reject — User rejects (from Widget)
  router.post('/handshake-requests/:id/reject', (req, res) => {
    const rejected = bridgeService.rejectHandshake(req.params.id);
    if (!rejected) {
      res.status(404).json({ error: '握手请求不存在或已过期' });
      return;
    }
    res.json({ success: true });
  });

  // GET /api/bridge/handshake-status/:id — AI polls for approval status
  router.get('/handshake-status/:id', (req, res) => {
    const status = bridgeService.getHandshakeStatus(req.params.id);
    if (!status) {
      res.json({ status: 'expired' });
      return;
    }
    res.json({
      status: status.status,
      branchId: status.branchId,
      approvedAt: status.approvedAt,
    });
  });

  // POST /api/bridge/end-session — AI signals it's done operating
  router.post('/end-session', (req, res) => {
    const { branchId, summary } = req.body || {};
    if (!branchId) {
      res.status(400).json({ error: 'branchId is required' });
      return;
    }
    // Send end command to widget so it can show "AI 操作完成" and stop polling.
    // Use sendCommand so it goes through the queue and gets picked up on next poll.
    // Widget will stop polling when it processes __end_session.
    const endCmd = {
      id: crypto.randomBytes(4).toString('hex'),
      action: 'snapshot' as const,
      params: { __end_session: true, summary: summary || '' },
      description: summary || 'AI 操作完成',
    };
    bridgeService.sendCommand(branchId, endCmd)
      .then(() => {
        // Widget picked up and responded — safe to clean up now
        bridgeService.endSession(branchId);
      })
      .catch(() => {
        // Timeout or error — clean up anyway
        bridgeService.endSession(branchId);
      });
    recordAiActivity(req, branchId, 'ai-release', summary || 'AI 操作完成');
    res.json({ success: true });
  });

  return router;
}
