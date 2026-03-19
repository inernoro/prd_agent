import fs from 'node:fs';
import path from 'node:path';
import type { CdsState, BranchEntry, BuildProfile, RoutingRule, OperationLog, InfraService, ExecutorNode } from '../types.js';

const MAX_LOGS_PER_BRANCH = 10;

function emptyState(): CdsState {
  return {
    routingRules: [],
    buildProfiles: [],
    branches: {},
    nextPortIndex: 0,
    logs: {},
    defaultBranch: null,
    customEnv: {},
    infraServices: [],
  };
}

export class StateService {
  private state: CdsState = emptyState();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static slugify(branch: string): string {
    return branch
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  }

  load(): void {
    if (fs.existsSync(this.filePath)) {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.state = JSON.parse(raw) as CdsState;
      // Migrate older state files
      if (!this.state.logs) this.state.logs = {};
      if (!this.state.routingRules) this.state.routingRules = [];
      if (!this.state.buildProfiles) this.state.buildProfiles = [];
      if (this.state.defaultBranch === undefined) this.state.defaultBranch = null;
      if (!this.state.customEnv) this.state.customEnv = {};
      if (!this.state.infraServices) this.state.infraServices = [];
      if (this.state.mirrorEnabled === undefined) this.state.mirrorEnabled = false;
      if (!this.state.executors) this.state.executors = {};
    } else {
      this.state = emptyState();
    }
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getState(): Readonly<CdsState> {
    return this.state;
  }

  // ── Branch management ──

  getBranch(id: string): BranchEntry | undefined {
    return this.state.branches[id];
  }

  getAllBranches(): BranchEntry[] {
    return Object.values(this.state.branches);
  }

  addBranch(entry: BranchEntry): void {
    if (this.state.branches[entry.id]) {
      throw new Error(`分支 "${entry.id}" 已存在`);
    }
    this.state.branches[entry.id] = entry;
  }

  updateBranchMeta(id: string, updates: { isFavorite?: boolean; notes?: string; tags?: string[]; isColorMarked?: boolean }): void {
    const branch = this.state.branches[id];
    if (!branch) throw new Error(`分支 "${id}" 不存在`);
    if (updates.isFavorite !== undefined) branch.isFavorite = updates.isFavorite;
    if (updates.notes !== undefined) branch.notes = updates.notes;
    if (updates.tags !== undefined) branch.tags = updates.tags;
    if (updates.isColorMarked !== undefined) branch.isColorMarked = updates.isColorMarked;
  }

  removeBranch(id: string): void {
    if (!this.state.branches[id]) {
      throw new Error(`分支 "${id}" 不存在`);
    }
    delete this.state.branches[id];
    if (this.state.defaultBranch === id) {
      this.state.defaultBranch = null;
    }
  }

  setDefaultBranch(id: string | null): void {
    this.state.defaultBranch = id;
  }

  // ── Port allocation ──

  allocatePort(portStart: number): number {
    const usedPorts = new Set<number>();
    for (const b of Object.values(this.state.branches)) {
      for (const svc of Object.values(b.services)) {
        if (svc.hostPort) usedPorts.add(svc.hostPort);
      }
    }
    let port = portStart + this.state.nextPortIndex;
    while (usedPorts.has(port)) port++;
    this.state.nextPortIndex++;
    return port;
  }

  // ── Routing rules ──

  getRoutingRules(): RoutingRule[] {
    return this.state.routingRules;
  }

  addRoutingRule(rule: RoutingRule): void {
    this.state.routingRules.push(rule);
    this.state.routingRules.sort((a, b) => a.priority - b.priority);
  }

  updateRoutingRule(id: string, updates: Partial<RoutingRule>): void {
    const idx = this.state.routingRules.findIndex(r => r.id === id);
    if (idx === -1) throw new Error(`路由规则 "${id}" 不存在`);
    Object.assign(this.state.routingRules[idx], updates);
    this.state.routingRules.sort((a, b) => a.priority - b.priority);
  }

  removeRoutingRule(id: string): void {
    this.state.routingRules = this.state.routingRules.filter(r => r.id !== id);
  }

  // ── Build profiles ──

  getBuildProfiles(): BuildProfile[] {
    return this.state.buildProfiles;
  }

  getBuildProfile(id: string): BuildProfile | undefined {
    return this.state.buildProfiles.find(p => p.id === id);
  }

  addBuildProfile(profile: BuildProfile): void {
    if (this.state.buildProfiles.some(p => p.id === profile.id)) {
      throw new Error(`构建配置 "${profile.id}" 已存在`);
    }
    this.state.buildProfiles.push(profile);
  }

  updateBuildProfile(id: string, updates: Partial<BuildProfile>): void {
    const idx = this.state.buildProfiles.findIndex(p => p.id === id);
    if (idx === -1) throw new Error(`构建配置 "${id}" 不存在`);
    Object.assign(this.state.buildProfiles[idx], updates);
  }

  removeBuildProfile(id: string): void {
    this.state.buildProfiles = this.state.buildProfiles.filter(p => p.id !== id);
  }

  // ── Operation logs ──

  appendLog(branchId: string, log: OperationLog): void {
    if (!this.state.logs[branchId]) {
      this.state.logs[branchId] = [];
    }
    this.state.logs[branchId].push(log);
    if (this.state.logs[branchId].length > MAX_LOGS_PER_BRANCH) {
      this.state.logs[branchId] = this.state.logs[branchId].slice(-MAX_LOGS_PER_BRANCH);
    }
  }

  getLogs(branchId: string): OperationLog[] {
    return this.state.logs[branchId] || [];
  }

  removeLogs(branchId: string): void {
    delete this.state.logs[branchId];
  }

  // ── Custom environment variables ──

  getCustomEnv(): Record<string, string> {
    return this.state.customEnv;
  }

  setCustomEnv(env: Record<string, string>): void {
    this.state.customEnv = env;
  }

  setCustomEnvVar(key: string, value: string): void {
    this.state.customEnv[key] = value;
  }

  removeCustomEnvVar(key: string): void {
    delete this.state.customEnv[key];
  }

  // ── Infrastructure services ──

  getInfraServices(): InfraService[] {
    return this.state.infraServices;
  }

  getInfraService(id: string): InfraService | undefined {
    return this.state.infraServices.find(s => s.id === id);
  }

  addInfraService(service: InfraService): void {
    if (this.state.infraServices.some(s => s.id === service.id)) {
      throw new Error(`基础设施服务 "${service.id}" 已存在`);
    }
    this.state.infraServices.push(service);
  }

  updateInfraService(id: string, updates: Partial<InfraService>): void {
    const idx = this.state.infraServices.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`基础设施服务 "${id}" 不存在`);
    Object.assign(this.state.infraServices[idx], updates);
  }

  removeInfraService(id: string): void {
    this.state.infraServices = this.state.infraServices.filter(s => s.id !== id);
  }

  // ── Mirror acceleration ──

  isMirrorEnabled(): boolean {
    return this.state.mirrorEnabled === true;
  }

  setMirrorEnabled(enabled: boolean): void {
    this.state.mirrorEnabled = enabled;
  }

  /**
   * Get mirror env vars to inject into Node.js containers.
   * Accelerates: corepack download, pnpm/npm/yarn install.
   */
  getMirrorEnvVars(): Record<string, string> {
    if (!this.state.mirrorEnabled) return {};
    return {
      // npm/pnpm/yarn registry mirror
      NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
      // Corepack uses this to download package manager tarballs
      COREPACK_NPM_REGISTRY: 'https://registry.npmmirror.com',
      // Yarn specific
      YARN_NPM_REGISTRY_SERVER: 'https://registry.npmmirror.com',
    };
  }

  // ── Executor management ──

  getExecutors(): Record<string, ExecutorNode> {
    return this.state.executors || {};
  }

  getExecutor(id: string): ExecutorNode | undefined {
    return this.state.executors?.[id];
  }

  setExecutor(node: ExecutorNode): void {
    if (!this.state.executors) this.state.executors = {};
    this.state.executors[node.id] = node;
  }

  removeExecutor(id: string): void {
    if (this.state.executors) {
      delete this.state.executors[id];
    }
  }

  /**
   * Resolve the Docker host IP for infra services.
   * Priority: customEnv.CDS_DOCKER_HOST > process.env.CDS_DOCKER_HOST > default 172.17.0.1
   */
  private resolveDockerHost(): string {
    return this.state.customEnv['CDS_DOCKER_HOST']
      || process.env.CDS_DOCKER_HOST
      || '172.17.0.1';
  }

  /**
   * Build CDS_* env vars from all running infra services.
   * Auto-generates predictable env var names based on service ID:
   *   CDS_HOST               — Docker host IP
   *   CDS_<SERVICE>_PORT     — Allocated host port (e.g., CDS_MONGODB_PORT=37821)
   *   CDS_<SERVICE>_HOST     — Per-service host (currently same as CDS_HOST)
   *
   * These can be referenced in app service environments as ${CDS_MONGODB_PORT} etc.
   */
  getCdsEnvVars(): Record<string, string> {
    const dockerHost = this.resolveDockerHost();
    const result: Record<string, string> = {
      CDS_HOST: dockerHost,
    };
    for (const svc of this.state.infraServices) {
      if (svc.status !== 'running') continue;
      const envKey = `CDS_${svc.id.toUpperCase().replace(/-/g, '_')}_PORT`;
      result[envKey] = String(svc.hostPort);
      // Per-service host (allows future per-service host override)
      const hostKey = `CDS_${svc.id.toUpperCase().replace(/-/g, '_')}_HOST`;
      result[hostKey] = dockerHost;
    }
    return result;
  }
}
