/**
 * 拓扑体检与服务关系图的对外接口（plan.cds.service-relations 第一批）。
 *
 *   POST /api/compose/lint            body { composeYaml } → 体检报告（cdscli verify、导入前预检）
 *   GET  /api/branches/:id/service-graph → 已部署分支的服务图 + 体检（cdscli topology、画布）
 *
 * 规则只在 services/topology-lint 里写一份；这里不做任何判定。
 */
import { Router, type Request } from 'express';
import type { StateService } from '../services/state.js';
import { buildServiceGraph } from '../services/service-graph.js';
import { lintComposeYaml, lintTopology } from '../services/topology-lint.js';

const MAX_YAML_BYTES = 512 * 1024;

export interface TopologyRouterDeps {
  stateService: StateService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
}

export function createTopologyRouter(deps: TopologyRouterDeps): Router {
  const router = Router();

  router.post('/compose/lint', (req, res) => {
    const body = (req.body ?? {}) as { composeYaml?: unknown; projectId?: unknown };
    const composeYaml = typeof body.composeYaml === 'string' ? body.composeYaml : '';
    if (!composeYaml.trim()) {
      res.status(400).json({ error: 'validation', field: 'composeYaml', message: 'composeYaml 不能为空' });
      return;
    }
    if (composeYaml.length > MAX_YAML_BYTES) {
      res.status(400).json({ error: 'validation', field: 'composeYaml', message: `composeYaml 超出 ${MAX_YAML_BYTES} 字节限制` });
      return;
    }
    if (typeof body.projectId === 'string' && body.projectId) {
      const denied = deps.assertProjectAccess(req, body.projectId);
      if (denied) { res.status(denied.status).json(denied.body); return; }
    }
    const lint = lintComposeYaml(composeYaml);
    if (!lint) {
      res.status(400).json({ error: 'parse_failed', message: 'compose 无法解析为 CDS 配置，体检未运行' });
      return;
    }
    res.json(lint);
  });

  router.get('/branches/:id/service-graph', (req, res) => {
    const branch = deps.stateService.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: 'not_found', message: `分支不存在: ${req.params.id}` }); return; }
    const denied = deps.assertProjectAccess(req, branch.projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    // env 用生效合并结果（与 replica-sets 的服务图同一口径），只暴露键名
    const projectEnv = deps.stateService.getCustomEnv(branch.projectId);
    const branchEnv = deps.stateService.getCustomEnvScope(branch.id);
    const profiles = deps.stateService.getEffectiveProfilesForBranch(branch)
      .map((p) => ({ ...p, env: { ...projectEnv, ...branchEnv, ...(p.env || {}) } }));
    const infra = (deps.stateService.getState().infraServices || [])
      .filter((s) => s.projectId === branch.projectId && (s.scope ?? 'project') === 'project');
    const graph = buildServiceGraph(profiles, infra);
    const lint = lintTopology(graph);
    res.json({ branchId: branch.id, projectId: branch.projectId, branch: branch.branch, graph, lint });
  });

  return router;
}
