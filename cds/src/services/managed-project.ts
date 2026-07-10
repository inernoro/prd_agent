import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BranchEntry,
  BuildProfile,
  ManagedAppSpec,
  ManagedCapabilityBinding,
  Project,
} from '../types.js';
import type { StateService } from './state.js';
import { detectModules, detectStack, type StackDetection } from './stack-detector.js';

export interface ManagedProjectPlan {
  mode: 'managed';
  projectId: string;
  branchId: string;
  profiles: BuildProfile[];
  capabilities: Array<{ kind: string; bindingId: string; fingerprint?: string }>;
  generatedAt: string;
}

export class ManagedProjectService {
  constructor(
    private readonly stateService: StateService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  planForBranch(branch: BranchEntry, commitSha?: string): ManagedProjectPlan | null {
    const project = this.stateService.getProject(branch.projectId || 'default');
    if (!project || project.deliveryMode !== 'managed') return null;
    const profiles = this.generateProfiles(project, branch, commitSha);
    const capabilities = this.resolveCapabilities(project);
    return {
      mode: 'managed',
      projectId: project.id,
      branchId: branch.id,
      profiles,
      capabilities,
      generatedAt: this.now().toISOString(),
    };
  }

  ensurePlanForBranch(branch: BranchEntry): ManagedProjectPlan | null {
    const plan = this.planForBranch(branch);
    if (plan) this.persistPlan(plan);
    return plan;
  }

  persistPlan(plan: ManagedProjectPlan): void {
    const project = this.stateService.getProject(plan.projectId);
    if (!project || project.deliveryMode !== 'managed') return;
    project.managedProfiles = plan.profiles;
    project.managedPlanUpdatedAt = plan.generatedAt;
    this.stateService.save();
  }

  resolveCapabilities(project: Project): ManagedProjectPlan['capabilities'] {
    return (project.managedSpec?.capabilities || []).map((binding) => {
      if (binding.kind === 'database' || binding.kind === 'cache') {
        const infra = this.stateService.getInfraServicesForProject(project.id)
          .find((candidate) => candidate.id === binding.bindingId);
        if (!infra) throw new Error(`managed capability "${binding.id}" 引用的资源不存在: ${binding.bindingId}`);
        return {
          kind: binding.kind,
          bindingId: binding.bindingId,
          fingerprint: fingerprint({
            id: infra.id,
            image: infra.dockerImage,
            containerPort: infra.containerPort,
            dbName: infra.dbName || '',
          }),
        };
      }
      if (binding.kind === 'secrets') {
        const env = this.stateService.getCustomEnv(project.id);
        const missing = (binding.envKeys || []).filter((key) => !env[key]);
        if (missing.length > 0) {
          throw new Error(`managed secrets capability "${binding.id}" 缺少环境变量: ${missing.join(', ')}`);
        }
      }
      return { kind: binding.kind, bindingId: binding.bindingId };
    });
  }

  private generateProfiles(project: Project, branch: BranchEntry, commitSha?: string): BuildProfile[] {
    const root = path.resolve(branch.worktreePath);
    const declaredApps = project.managedSpec?.apps || [];
    const apps = declaredApps.length > 0 ? declaredApps : this.detectApps(root);
    if (apps.length === 0) {
      throw new Error('managed 模式未识别出可部署应用，请声明 managedSpec.apps 或切换 compose 模式');
    }
    const bindings = new Map((project.managedSpec?.capabilities || []).map((binding) => [binding.id, binding]));
    return apps.map((app) => this.profileForApp(project, branch, root, app, bindings, commitSha));
  }

  private detectApps(root: string): ManagedAppSpec[] {
    return detectModules(root).map((module, index) => ({
      id: managedId(module.subPath === '.' ? module.detection.stack : module.subPath, index),
      name: module.subPath === '.' ? module.detection.stack : module.subPath,
      appPath: module.subPath,
      workload: inferWorkload(module.detection),
    }));
  }

  private profileForApp(
    project: Project,
    branch: BranchEntry,
    root: string,
    app: ManagedAppSpec,
    bindings: Map<string, ManagedCapabilityBinding>,
    commitSha?: string,
  ): BuildProfile {
    const appPath = normalizeAppPath(app.appPath);
    const absoluteAppPath = path.resolve(root, appPath);
    if (absoluteAppPath !== root && !absoluteAppPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`managed appPath 越出 worktree: ${app.appPath}`);
    }
    if (!fs.existsSync(absoluteAppPath)) throw new Error(`managed appPath 不存在: ${app.appPath}`);
    const detection = detectStack(absoluteAppPath);
    if (detection.stack === 'unknown' && (!app.dockerImage || !app.startCommand)) {
      throw new Error(`managed 应用 "${app.id}" 技术栈无法识别，需填写 dockerImage 与 startCommand`);
    }
    const startCommand = app.startCommand || detection.suggestedRunCommand || detection.runCommand;
    const installCommand = app.installCommand ?? detection.installCommand;
    const buildCommand = app.buildCommand ?? detection.suggestedBuildCommand ?? detection.buildCommand;
    const dockerImage = app.dockerImage || detection.dockerImage;
    const capabilityIds = app.capabilityIds || [...bindings.keys()];
    const selectedBindings = capabilityIds.map((id) => {
      const binding = bindings.get(id);
      if (!binding) throw new Error(`managed 应用 "${app.id}" 引用了未知 capability: ${id}`);
      return binding;
    });
    const dependsOn = selectedBindings
      .filter((binding) => binding.kind === 'database' || binding.kind === 'cache')
      .map((binding) => binding.bindingId);
    const env = managedCapabilityEnv(selectedBindings);
    const identity = fingerprint({
      projectId: project.id,
      branchId: branch.id,
      commitSha: commitSha || branch.githubCommitSha || 'worktree-head',
      app,
      detection: detection.stack,
      dockerImage,
      installCommand,
      buildCommand,
      startCommand,
      capabilities: selectedBindings.map(({ id, kind, bindingId, envKeys }) => ({ id, kind, bindingId, envKeys })),
    }).slice(0, 40);
    const id = managedId(app.id, 0);
    const command = [installCommand, buildCommand, startCommand].filter(Boolean).join(' && ');
    return {
      id,
      projectId: project.id,
      name: app.name || app.id,
      dockerImage,
      workDir: appPath,
      containerWorkDir: '/app',
      command,
      containerPort: app.containerPort || detection.containerPort || 3000,
      env,
      dependsOn,
      pathPrefixes: app.workload === 'api' ? ['/api/'] : app.workload === 'worker' ? [] : undefined,
      readinessProbe: app.health?.type === 'http'
        ? { path: app.health.path, timeoutSeconds: 120, intervalSeconds: 2 }
        : app.health?.type === 'tcp' || app.workload === 'worker'
          ? { noHttp: true, timeoutSeconds: 120, intervalSeconds: 2 }
          : undefined,
      managedBuild: {
        stack: detection.stack,
        installCommand,
        buildCommand,
        startCommand,
        artifactImage: `cds-managed/${managedId(project.slug || project.id, 0)}-${id}:sha-${identity}`,
      },
    };
  }
}

function managedCapabilityEnv(bindings: ManagedCapabilityBinding[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const binding of bindings) {
    const token = binding.bindingId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    if (binding.kind === 'database') {
      env.DATABASE_HOST = `\${CDS_${token}_HOST}`;
      env.DATABASE_PORT = `\${CDS_${token}_PORT}`;
    } else if (binding.kind === 'cache') {
      env.CACHE_HOST = `\${CDS_${token}_HOST}`;
      env.CACHE_PORT = `\${CDS_${token}_PORT}`;
    } else if (binding.kind === 'secrets') {
      for (const key of binding.envKeys || []) env[key] = `\${${key}}`;
    }
  }
  return env;
}

function normalizeAppPath(value: string): string {
  const trimmed = value.trim();
  return !trimmed || trimmed === '.' ? '.' : trimmed.replace(/^\.\//, '').replace(/\/+$/, '');
}

function managedId(value: string, index: number): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || `app-${index + 1}`;
}

function inferWorkload(detection: StackDetection): ManagedAppSpec['workload'] {
  if (detection.framework && ['vite', 'react', 'vue', 'angular', 'svelte'].includes(detection.framework)) return 'web';
  return 'api';
}

function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
