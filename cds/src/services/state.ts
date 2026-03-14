import fs from 'node:fs';
import path from 'node:path';
import type { CdsState, BranchEntry, BuildProfile, RoutingRule, OperationLog } from '../types.js';

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

  addBranch(entry: BranchEntry): void {
    if (this.state.branches[entry.id]) {
      throw new Error(`分支 "${entry.id}" 已存在`);
    }
    this.state.branches[entry.id] = entry;
  }

  updateBranchMeta(id: string, updates: { isFavorite?: boolean; notes?: string; tags?: string[] }): void {
    const branch = this.state.branches[id];
    if (!branch) throw new Error(`分支 "${id}" 不存在`);
    if (updates.isFavorite !== undefined) branch.isFavorite = updates.isFavorite;
    if (updates.notes !== undefined) branch.notes = updates.notes;
    if (updates.tags !== undefined) branch.tags = updates.tags;
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
}
