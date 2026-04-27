/**
 * Pending imports — Agent-submitted CDS compose YAML awaiting operator approval.
 *
 * Workflow:
 *   1. An external agent (Claude Code running cds-project-scan, etc.) scans
 *      a user project and emits a cds-compose.yaml tailored to a specific
 *      CDS project. Instead of making the user copy-paste, the agent POSTs
 *      it to POST /api/projects/:id/pending-import with its own AI access
 *      key.
 *   2. CDS parses the YAML just enough to compute a summary
 *      (addedProfiles / addedInfra / addedEnvKeys), stores the raw YAML,
 *      and returns an importId. The dashboard polls GET /api/pending-imports
 *      and flashes a badge when `status === 'pending'` items exist.
 *   3. The operator reviews the diff in a drawer and hits Approve or Reject.
 *      Approve runs the full apply pipeline (build profiles + env vars +
 *      infra services) scoped to the target project. Reject just marks the
 *      item rejected with an optional reason.
 *   4. Decided items (approved/rejected) stick around 24h as an audit trail,
 *      then prunePendingImports() drops them on the next list call.
 *
 * Auth: every route in this file requires a CDS session (cookie) or AI
 * access key (X-AI-Access-Key), enforced by the global auth middleware
 * in server.ts — same rules as every other /api/* route.
 *
 * All apply side-effects are scoped to the target projectId. Profile id
 * uniqueness is still global (state.buildProfiles is a flat list), so
 * profiles imported via this path get suffixed with the project slug the
 * same way /quickstart does.
 */

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { BuildProfile, InfraService, PendingImport } from '../types.js';
import { parseCdsCompose } from '../services/compose-parser.js';

export interface PendingImportRouterDeps {
  stateService: StateService;
}

/** Audit-trail retention: decided imports disappear from list after 24h. */
// Keep approved/rejected imports around for a week so the operator
// can look back at recent Agent activity when diagnosing something
// that changed mid-week. Pending entries never get pruned here —
// they sit until explicitly approved or rejected.
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Max size of a single composeYaml submission (prevents state bloat). */
const MAX_YAML_BYTES = 256 * 1024;

function newId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Summarise a parsed compose so the dashboard can render
 * "+3 profiles, +2 infra, +5 env" without re-parsing.
 */
function summariseCompose(
  stateService: StateService,
  projectId: string,
  composeYaml: string,
): { summary: PendingImport['summary']; parseError?: string } {
  let parsed: ReturnType<typeof parseCdsCompose>;
  try {
    parsed = parseCdsCompose(composeYaml);
  } catch (err) {
    return {
      summary: { addedProfiles: [], addedInfra: [], addedEnvKeys: [] },
      parseError: `YAML 解析失败: ${(err as Error).message}`,
    };
  }
  if (!parsed) {
    return {
      summary: { addedProfiles: [], addedInfra: [], addedEnvKeys: [] },
      parseError: '无法解析 YAML：需是标准 CDS Compose 格式（含 services 定义）',
    };
  }
  const existingProfileIds = new Set(
    stateService.getBuildProfilesForProject(projectId).map((p) => p.id),
  );
  const existingInfraIds = new Set(
    stateService.getInfraServicesForProject(projectId).map((s) => s.id),
  );
  // Project-scoped diff: "will this import add new env keys" considers
  // both the _global baseline and this project's existing overrides.
  const existingEnvKeys = new Set(Object.keys(stateService.getCustomEnv(projectId)));

  return {
    summary: {
      addedProfiles: parsed.buildProfiles
        .map((p) => p.id)
        .filter((id) => !existingProfileIds.has(id)),
      addedInfra: parsed.infraServices
        .map((s) => s.id)
        .filter((id) => !existingInfraIds.has(id)),
      addedEnvKeys: Object.keys(parsed.envVars || {}).filter(
        (k) => !existingEnvKeys.has(k),
      ),
    },
  };
}

export function createPendingImportRouter(deps: PendingImportRouterDeps): Router {
  const router = Router();
  const { stateService } = deps;

  // POST /api/projects/:id/pending-import
  // Body: { agentName, purpose, composeYaml }
  router.post('/projects/:id/pending-import', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `项目 '${req.params.id}' 不存在` });
      return;
    }

    const body = (req.body || {}) as Partial<{
      agentName: string;
      purpose: string;
      composeYaml: string;
    }>;
    const agentName = (body.agentName || '').trim();
    const purpose = (body.purpose || '').trim();
    const composeYaml = typeof body.composeYaml === 'string' ? body.composeYaml : '';

    if (!agentName) {
      res.status(400).json({ error: 'validation', field: 'agentName', message: 'agentName 不能为空' });
      return;
    }
    if (!composeYaml.trim()) {
      res.status(400).json({ error: 'validation', field: 'composeYaml', message: 'composeYaml 不能为空' });
      return;
    }
    if (composeYaml.length > MAX_YAML_BYTES) {
      res.status(413).json({
        error: 'too_large',
        message: `composeYaml 超出 ${MAX_YAML_BYTES} 字节限制`,
      });
      return;
    }

    // Reject submissions to projects whose clone isn't ready — an import
    // against half-cloned state would either fail on apply or apply to
    // the wrong repoPath.
    if (project.cloneStatus && project.cloneStatus !== 'ready') {
      res.status(409).json({
        error: 'project_not_ready',
        cloneStatus: project.cloneStatus,
        message: `项目克隆状态为 '${project.cloneStatus}'，请等就绪后再提交配置`,
      });
      return;
    }

    const { summary, parseError } = summariseCompose(
      stateService,
      project.id,
      composeYaml,
    );
    if (parseError) {
      res.status(400).json({
        error: 'parse_failed',
        field: 'composeYaml',
        message: parseError,
      });
      return;
    }

    // Reject profiles missing a command. Without a command the deploy
    // path crashes with "缺少 command 字段" as it did during the first
    // self-test — we'd rather fail at submit time with a clear pointer
    // than let the operator approve a broken config.
    //
    // Dockerfile-based services (where the image's CMD/ENTRYPOINT is
    // enough) are a real use case but parseCdsCompose today always
    // populates `command` when present; an unset command means the
    // YAML actually lacked it.
    try {
      const check = parseCdsCompose(composeYaml);
      if (check) {
        const bad = check.buildProfiles
          .filter((p) => !p.command || !String(p.command).trim())
          .map((p) => p.id);
        if (bad.length > 0) {
          res.status(400).json({
            error: 'invalid_profile',
            field: 'composeYaml',
            message: `以下构建配置缺少 command 字段: ${bad.join(', ')}。请在 YAML 的每个 app service 下补上 command: 行。`,
          });
          return;
        }
      }
    } catch { /* parser already succeeded once above */ }

    const item: PendingImport = {
      id: newId(),
      projectId: project.id,
      agentName: agentName.slice(0, 200),
      purpose: purpose.slice(0, 500),
      composeYaml,
      summary,
      submittedAt: new Date().toISOString(),
      status: 'pending',
    };
    stateService.addPendingImport(item);

    res.status(201).json({
      importId: item.id,
      approveUrl: `/project-list?pendingImport=${item.id}`,
      summary,
    });
  });

  // GET /api/pending-imports — list all (pending first, then recent decided).
  router.get('/pending-imports', (_req, res) => {
    stateService.prunePendingImports(AUDIT_RETENTION_MS);
    const all = stateService.getPendingImports();
    // Pending first, then most recent decided.
    const sorted = [...all].sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return b.submittedAt.localeCompare(a.submittedAt);
    });
    // Don't leak raw YAML in the list view — the dashboard fetches it
    // lazily via GET /pending-imports/:id when the drawer opens.
    const stripped = sorted.map(({ composeYaml: _yaml, ...rest }) => rest);
    res.json({
      imports: stripped,
      pendingCount: sorted.filter((p) => p.status === 'pending').length,
    });
  });

  // GET /api/pending-imports/:id — full record including raw YAML.
  router.get('/pending-imports/:id', (req, res) => {
    const item = stateService.getPendingImport(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ import: item });
  });

  // POST /api/pending-imports/:id/approve — parse + apply the YAML to the
  // target project, then mark approved.
  router.post('/pending-imports/:id/approve', (req, res) => {
    const item = stateService.getPendingImport(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (item.status !== 'pending') {
      res.status(409).json({ error: 'already_decided', status: item.status });
      return;
    }
    const project = stateService.getProject(item.projectId);
    if (!project) {
      res.status(410).json({
        error: 'project_gone',
        message: `目标项目 '${item.projectId}' 已被删除，无法应用`,
      });
      return;
    }

    const parsed = parseCdsCompose(item.composeYaml);
    if (!parsed) {
      res.status(400).json({
        error: 'parse_failed',
        message: 'YAML 在提交时解析成功但批准时失败（可能格式破损）',
      });
      return;
    }

    // Apply build profiles. Non-legacy projects auto-suffix the id with
    // the project slug so two projects can share "api" and "admin"
    // without colliding. This matches the /quickstart convention.
    const idSuffix = project.legacyFlag ? '' : `-${project.slug}`;
    const appliedProfiles: string[] = [];
    for (const profile of parsed.buildProfiles as BuildProfile[]) {
      const scoped: BuildProfile = {
        ...profile,
        id: `${profile.id}${idSuffix}`,
        projectId: project.id,
      };
      const existing = stateService.getBuildProfile(scoped.id);
      if (existing) {
        stateService.updateBuildProfile(scoped.id, scoped);
      } else {
        stateService.addBuildProfile(scoped);
      }
      appliedProfiles.push(scoped.id);
    }

    // Apply env vars into the target project's scope (merge; existing
    // keys in either _global or the project win so operator-set values
    // aren't silently clobbered by a machine-authored import).
    const existingEnv = stateService.getCustomEnv(project.id);
    const appliedEnvKeys: string[] = [];
    for (const [key, value] of Object.entries(parsed.envVars || {})) {
      if (!(key in existingEnv)) {
        stateService.setCustomEnvVar(key, value, project.id);
        appliedEnvKeys.push(key);
      }
    }

    // Apply infra services (skip existing by id-within-project).
    const existingInfraForProject = new Set(
      stateService.getInfraServicesForProject(project.id).map((s) => s.id),
    );
    const appliedInfra: string[] = [];
    for (const def of parsed.infraServices) {
      if (!def.id || !def.dockerImage || !def.containerPort) continue;
      if (existingInfraForProject.has(def.id)) continue;
      // Container name must be globally unique in Docker. Mirror the
      // legacyFlag-based scoping used by the manual create path
      // (branches.ts:4300-4302) so two projects can each own e.g.
      // "mongodb" without colliding on `cds-infra-mongodb`.
      const containerName = project.legacyFlag
        ? `cds-infra-${def.id}`
        : `cds-infra-${project.slug.slice(0, 12)}-${def.id}`;
      const service: InfraService = {
        id: def.id,
        projectId: project.id,
        name: def.name || def.id,
        dockerImage: def.dockerImage,
        containerPort: def.containerPort,
        hostPort: stateService.allocatePort(10000),
        containerName,
        status: 'stopped',
        volumes: def.volumes || [],
        env: def.env || {},
        healthCheck: def.healthCheck,
        createdAt: new Date().toISOString(),
      };
      stateService.addInfraService(service);
      appliedInfra.push(service.id);
    }

    stateService.updatePendingImport(item.id, {
      status: 'approved',
      decidedAt: new Date().toISOString(),
    });
    stateService.save();

    res.json({
      applied: true,
      appliedProfiles,
      appliedInfra,
      appliedEnvKeys,
    });
  });

  // POST /api/pending-imports/:id/reject
  router.post('/pending-imports/:id/reject', (req, res) => {
    const item = stateService.getPendingImport(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (item.status !== 'pending') {
      res.status(409).json({ error: 'already_decided', status: item.status });
      return;
    }
    const body = (req.body || {}) as { reason?: string };
    stateService.updatePendingImport(item.id, {
      status: 'rejected',
      rejectReason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined,
      decidedAt: new Date().toISOString(),
    });
    res.json({ rejected: true });
  });

  return router;
}
