/**
 * Cluster router — one-click UI bootstrap for multi-node CDS clusters.
 *
 * This is the Dashboard-facing counterpart to `exec_cds.sh issue-token` and
 * `exec_cds.sh connect`. The CLI remains the scriptable path; this router
 * exists so that a human clicking around in the web Dashboard can form a
 * cluster without ever touching SSH.
 *
 * Flow (see doc/design.cds-cluster-bootstrap.md §4.1 for the CLI parallel):
 *
 *   Master side:
 *     POST /api/cluster/issue-token
 *       → Mints a 15-minute bootstrap token, persists to .cds.env, returns
 *         a single self-contained connection code (base64-encoded JSON with
 *         master URL + token + expiry) suitable for copy-paste or QR.
 *
 *   Slave side:
 *     POST /api/cluster/join  { connectionCode }
 *       → Decodes the payload, writes the executor config to .cds.env,
 *         creates an in-process ExecutorAgent, registers against the master,
 *         starts heartbeat. The current Node process stays running in a
 *         hybrid standalone+executor mode until the next restart, at which
 *         point the persisted CDS_MODE=executor takes the process to pure
 *         executor mode. This means the slave Dashboard remains usable for
 *         the current session and the response carries a `restartWarning`
 *         flag so the UI can show the caveat.
 *
 *     GET /api/cluster/status
 *       → Returns the current node's cluster-role view: standalone /
 *         scheduler / executor / hybrid, plus master URL and executorId if
 *         applicable. Used by the Dashboard to render the cluster settings
 *         panel contextually (show the right tab).
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import type { CdsConfig } from '../types.js';
import type { StateService } from '../services/state.js';
import type { ExecutorRegistry } from '../scheduler/executor-registry.js';
import { ExecutorAgent } from '../executor/agent.js';
import { updateEnvFile, defaultEnvFilePath } from '../services/env-file.js';

/**
 * Shape of a cluster connection code after base64+JSON decoding. The UI
 * generates it on the master and pastes it on the slave.
 */
export interface ConnectionPayload {
  master: string;
  token: string;
  expiresAt: string;
}

export interface ClusterRouterDeps {
  config: CdsConfig;
  stateService: StateService;
  registry: ExecutorRegistry;
  /**
   * In-process handle to the active ExecutorAgent (if any). Set by index.ts
   * when the node is running in executor mode, or populated by /join when
   * the Dashboard initiates a hot-switch. The router uses it both to report
   * status and to avoid creating a second agent if /join is called twice.
   */
  getExecutorAgent: () => ExecutorAgent | null;
  setExecutorAgent: (agent: ExecutorAgent | null) => void;
}

/**
 * Token lifetime — matches `BOOTSTRAP_TOKEN_TTL_SECONDS` in exec_cds.sh so
 * that UI and CLI produce tokens with the same freshness guarantee.
 */
const BOOTSTRAP_TTL_SECONDS = 900; // 15 minutes

export function createClusterRouter(deps: ClusterRouterDeps): Router {
  const { config, stateService, registry, getExecutorAgent, setExecutorAgent } = deps;
  const router = Router();

  // ── POST /api/cluster/issue-token — master-side token generation ──
  //
  // Dashboard-visible equivalent of `./exec_cds.sh issue-token`. Only
  // allowed when this node can plausibly act as a master — i.e. it is
  // currently in standalone or scheduler mode. Rejected with 409 if the
  // node is already an executor, because "issue a token from an executor"
  // is a nonsense request that would only confuse the operator.
  router.post('/issue-token', (req, res) => {
    if (config.mode === 'executor') {
      res.status(409).json({
        error: '本节点是 executor，不能生成 bootstrap token。请到主节点操作。',
        currentMode: config.mode,
      });
      return;
    }

    // 1. Generate the token and compute expiry.
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TTL_SECONDS * 1000).toISOString();

    // 2. Compute the master's public URL. Priority:
    //    (a) explicit CDS_MASTER_URL (if someone set it for reverse-proxy scenarios)
    //    (b) first entry in config.rootDomains (standard case, nginx fronts the port)
    //    (c) request Host header fallback (development / localhost)
    let masterUrl = config.masterUrl || '';
    if (!masterUrl && config.rootDomains && config.rootDomains.length > 0) {
      masterUrl = `https://${config.rootDomains[0]}`;
    }
    if (!masterUrl) {
      // Fallback to whatever Host the browser is using to reach us. This
      // is only useful for localhost / dev; production should set rootDomains.
      const host = (req.headers.host || '').split(':')[0];
      const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
      masterUrl = host ? `${proto}://${req.headers.host}` : '';
    }
    if (!masterUrl) {
      res.status(500).json({
        error: '无法确定主节点 URL。请在 .cds.env 中设置 CDS_ROOT_DOMAINS。',
      });
      return;
    }

    // 3. Persist the token to .cds.env so the master survives restarts and
    //    the `verifyBootstrapOrPermanent` middleware in scheduler/routes.ts
    //    can validate it on the executor's register call.
    try {
      updateEnvFile(defaultEnvFilePath(), {
        CDS_BOOTSTRAP_TOKEN: token,
        CDS_BOOTSTRAP_TOKEN_EXPIRES_AT: expiresAt,
      });
    } catch (err) {
      res.status(500).json({
        error: `无法写入 .cds.env: ${(err as Error).message}`,
      });
      return;
    }

    // 4. Update in-memory config so the very next register call sees the
    //    token without waiting for a process restart.
    config.bootstrapToken = { value: token, expiresAt };

    // 5. Build the connection code — a single base64 string the user can
    //    copy, paste, or embed in a QR code.
    const payload: ConnectionPayload = {
      master: masterUrl,
      token,
      expiresAt,
    };
    const connectionCode = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');

    console.log(`  [cluster] Bootstrap token issued via UI (expires ${expiresAt})`);

    res.json({
      connectionCode,
      masterUrl,
      expiresAt,
      ttlSeconds: BOOTSTRAP_TTL_SECONDS,
    });
  });

  // ── POST /api/cluster/join — slave-side one-click join ──
  //
  // The Dashboard calls this when the user pastes a connection code from
  // another node. Instead of spawning `./exec_cds.sh connect` (which would
  // kill the current process mid-request), we perform the flow inline:
  //
  //   1. Decode and validate the payload
  //   2. Persist executor config to .cds.env (so next restart is pure executor)
  //   3. Create an in-process ExecutorAgent and register against the master
  //   4. Start the heartbeat loop
  //
  // Side effect: the current process enters a "hybrid" state where the
  // Dashboard + Worker proxy continue to serve traffic AND an ExecutorAgent
  // reports back to the master. This keeps the user's current browser tab
  // alive. The caller is responsible for showing a warning that the next
  // process restart will drop the Dashboard (because CDS_MODE=executor in
  // .cds.env takes effect at boot).
  router.post('/join', async (req, res) => {
    const { connectionCode } = (req.body || {}) as { connectionCode?: string };

    if (!connectionCode || typeof connectionCode !== 'string') {
      res.status(400).json({ error: '缺少 connectionCode' });
      return;
    }

    // 1. Decode. Any parse/shape failure returns a clear 400 so the UI can
    //    render a helpful error instead of "invalid request".
    let payload: ConnectionPayload;
    try {
      const decoded = Buffer.from(connectionCode.trim(), 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      if (
        !parsed ||
        typeof parsed.master !== 'string' ||
        typeof parsed.token !== 'string' ||
        typeof parsed.expiresAt !== 'string'
      ) {
        throw new Error('connection code 缺少 master / token / expiresAt 字段');
      }
      payload = parsed as ConnectionPayload;
    } catch (err) {
      res.status(400).json({
        error: `connection code 无效: ${(err as Error).message}`,
      });
      return;
    }

    // Defense-in-depth: reject expired tokens before we touch anything.
    const expiresMs = new Date(payload.expiresAt).getTime();
    if (Number.isNaN(expiresMs)) {
      res.status(400).json({ error: 'connection code 的 expiresAt 不是合法时间' });
      return;
    }
    if (Date.now() > expiresMs + 60_000) {
      res.status(400).json({ error: 'connection code 已过期，请在主节点重新生成' });
      return;
    }

    // Refuse plain HTTP targets — the token in connectionCode is password-
    // level sensitive and would travel over the wire in cleartext. Allow
    // loopback for dev/test.
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)/.test(payload.master);
    if (payload.master.startsWith('http://') && !isLoopback) {
      res.status(400).json({
        error: '拒绝通过明文 HTTP 连接集群。请让主节点改用 https:// 后重新生成 connection code。',
      });
      return;
    }

    // Guard against double-join.
    if (getExecutorAgent() !== null) {
      res.status(409).json({
        error: '本节点已加入集群。如需切换主节点，请先 disconnect。',
      });
      return;
    }

    // 2. Persist executor config to .cds.env so the next restart is a pure
    //    executor startup. We clear any stale permanent token from a previous
    //    cluster membership.
    try {
      updateEnvFile(defaultEnvFilePath(), {
        CDS_MODE: 'executor',
        CDS_MASTER_URL: payload.master,
        CDS_SCHEDULER_URL: payload.master,
        CDS_BOOTSTRAP_TOKEN: payload.token,
        CDS_BOOTSTRAP_TOKEN_EXPIRES_AT: payload.expiresAt,
        CDS_EXECUTOR_TOKEN: null,
      });
    } catch (err) {
      res.status(500).json({
        error: `无法写入 .cds.env: ${(err as Error).message}`,
      });
      return;
    }

    // 3. Update in-memory config so the new ExecutorAgent sees the master
    //    URL and bootstrap token. We deliberately do NOT flip config.mode —
    //    leaving it as `standalone` keeps the existing Dashboard + Worker
    //    services running until the user chooses to restart.
    config.masterUrl = payload.master;
    config.schedulerUrl = payload.master;
    config.bootstrapToken = { value: payload.token, expiresAt: payload.expiresAt };
    config.executorToken = undefined;

    // 4. Instantiate the agent, register, start heartbeat. register() has
    //    its own error logging; we just need to convert its boolean result
    //    into an HTTP response the UI can react to.
    const agent = new ExecutorAgent(config, stateService);
    const success = await agent.register();
    if (!success) {
      // Revert in-memory changes so a retry isn't blocked by a stale config.
      // The .cds.env write stays — if the user retries successfully, the
      // existing values are the right ones.
      config.bootstrapToken = undefined;
      res.status(502).json({
        error: '注册到主节点失败。请查看 ./exec_cds.sh logs 的 [executor] 行确认原因。',
      });
      return;
    }
    agent.startHeartbeat();
    setExecutorAgent(agent);

    console.log(`  [cluster] Hot-joined cluster ${payload.master} as ${agent.executorId}`);

    res.json({
      success: true,
      executorId: agent.executorId,
      masterUrl: payload.master,
      restartWarning:
        '本节点已作为 executor 加入集群。当前 Dashboard 继续可用，但下次进程重启后 CDS 会进入纯 executor 模式，Dashboard 将停止服务。建议你把浏览器书签换成主节点 URL。',
    });
  });

  // ── POST /api/cluster/leave — slave-side graceful disconnect ──
  //
  // Counterpart to /join for UI parity. Stops the in-process heartbeat,
  // attempts an unregister call to the master, rewrites .cds.env back to
  // standalone. Safe to call when we never joined (no-op).
  router.post('/leave', async (_req, res) => {
    const agent = getExecutorAgent();

    // Best-effort DELETE against the master before we drop local state.
    if (agent) {
      try {
        await agent.unregister();
      } catch (err) {
        console.warn(`  [cluster] unregister warning: ${(err as Error).message}`);
      }
      agent.stopHeartbeat();
      setExecutorAgent(null);
    }

    // Reset local config regardless of whether we had an agent, so a stale
    // partial state from a crashed join gets cleaned up.
    try {
      updateEnvFile(defaultEnvFilePath(), {
        CDS_MODE: 'standalone',
        CDS_MASTER_URL: null,
        CDS_SCHEDULER_URL: null,
        CDS_EXECUTOR_TOKEN: null,
        CDS_BOOTSTRAP_TOKEN: null,
        CDS_BOOTSTRAP_TOKEN_EXPIRES_AT: null,
      });
    } catch (err) {
      res.status(500).json({
        error: `本地状态重置失败: ${(err as Error).message}`,
      });
      return;
    }

    config.masterUrl = undefined;
    config.schedulerUrl = undefined;
    config.bootstrapToken = undefined;
    config.executorToken = undefined;

    res.json({
      success: true,
      message: '已退出集群。建议运行 ./exec_cds.sh restart 让本节点回到纯 standalone 模式。',
    });
  });

  // ── GET /api/cluster/status — the Dashboard's "which tab to show" probe ──
  //
  // Returns a snapshot of the current node's cluster role. The Dashboard
  // uses this to decide whether to show the "我是主节点" or "我是从节点"
  // tab (or both, for standalone where either could apply).
  router.get('/status', (_req, res) => {
    const agent = getExecutorAgent();
    const hybrid = agent !== null && config.mode !== 'executor';
    const executors = registry.getAll();
    const remoteCount = executors.filter(n => n.role !== 'embedded').length;

    let effectiveRole: 'standalone' | 'scheduler' | 'executor' | 'hybrid';
    if (hybrid) {
      effectiveRole = 'hybrid';
    } else if (config.mode === 'executor') {
      effectiveRole = 'executor';
    } else if (remoteCount > 0) {
      effectiveRole = 'scheduler';
    } else {
      effectiveRole = 'standalone';
    }

    res.json({
      mode: config.mode,
      effectiveRole,
      masterUrl: config.masterUrl || null,
      executorId: agent?.executorId || null,
      hasBootstrapToken: !!config.bootstrapToken,
      bootstrapExpiresAt: config.bootstrapToken?.expiresAt || null,
      remoteExecutorCount: remoteCount,
      capacity: registry.getTotalCapacity(),
    });
  });

  return router;
}
